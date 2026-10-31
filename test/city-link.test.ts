import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN, call, createOffice, join, ORIGIN } from "./helpers";
import {
  admin, city, cityStub, deepStrings, linkedOffice, openCityWs, ownerAgent, publicCity, requestLink, setupCity, until, withCity,
} from "./city-harness";

beforeEach(() => setupCity());

describe("city link flow", () => {
  it("pending ignores pushes and refuses office_city; approve shows the agents; revoke takes them off at once", async () => {
    const o = await createOffice("Fixture Labs HQ");
    const ada = await ownerAgent(o, "Ada");
    await call(o, "status", { status: "working", activity: "secret activity text" }, { token: ada.agentToken, key: o.ownerKey });

    const noLink = await city(o, ada.agentToken, { op: "look" });
    expect(noLink.status).toBe(403);
    expect(noLink.body.error).toContain("this office has no approved city link; the owner can request one with PUT /api/o/");

    const req = await requestLink(o, "fixture-labs");
    expect(req.status).toBe(200);
    expect(req.body.link).toEqual({ siteId: "fixture-labs", state: "pending" });

    const pushed = await cityStub().officePresence(o.id, [{ agentId: ada.agent.id, name: "Ada", hue: 10, status: "working", out: false }]);
    expect(pushed).toEqual({ state: "pending", live: [] });
    const before = await publicCity();
    expect(before.sites.flatMap((s: any) => s.agents.map((a: any) => a.name))).not.toContain("Ada");
    const pending = await city(o, ada.agentToken, { op: "look" });
    expect(pending.status).toBe(403);

    const listed = await admin("?state=pending");
    expect(listed.status).toBe(200);
    expect(listed.body.links.map((l: any) => l.officeId)).toContain(o.id);
    expect((await admin(`/${o.id}/approve`, "POST")).status).toBe(200);

    const site = await until(async () => (await publicCity()).sites.find((s: any) => s.siteId === "fixture-labs" && s.agents.some((a: any) => a.name === "Ada")), "Ada at fixture-labs");
    expect(site.companyId).toBe("fixture-labs");

    const go = await city(o, ada.agentToken, { op: "go", to: "Fixture Ave & Test St" });
    expect(go.status).toBe(200);

    const ws = await openCityWs();
    const snap = await ws.next((f) => f.type === "snapshot");
    const payloads = [await publicCity(), snap];
    const rows = await withCity((c) => (c as any).ctx.storage.sql.exec("SELECT agents FROM presence WHERE officeId = ?", o.id).toArray());
    const bridged = rows.map((r: any) => JSON.parse(r.agents));
    for (const p of [...payloads, bridged]) {
      const strings = deepStrings(p);
      expect(strings.some((s) => s.includes("secret activity text")), "activity text leaked").toBe(false);
      expect(strings.includes("activity")).toBe(false);
    }
    for (const p of payloads) {
      const strings = deepStrings(p);
      expect(strings.some((s) => s.includes(o.id)), "office id leaked").toBe(false);
      expect(strings.includes("officeId")).toBe(false);
    }
    expect(walkerIn(payloads[0], "Ada")).toBeTruthy();

    expect((await admin(`/${o.id}/revoke`, "POST")).status).toBe(200);
    const after = await city(o, ada.agentToken, { op: "look" });
    expect(after.status).toBe(403);
    const pub = await publicCity();
    expect(walkerIn(pub, "Ada")).toBeFalsy();
    expect(pub.sites.flatMap((s: any) => s.agents.map((a: any) => a.name))).not.toContain("Ada");
    ws.ws.close();
  });

  it("rejects unknown sites and a different city", async () => {
    const o = await createOffice();
    expect((await requestLink(o, "no-such-site")).status).toBe(400);
    const res = await SELF.fetch(`${ORIGIN}/api/o/${o.id}/city`, {
      method: "PUT",
      headers: { authorization: `Bearer ${o.ownerKey}`, "content-type": "application/json", "cf-connecting-ip": "10.9.9.9" },
      body: JSON.stringify({ city: "nyc", siteId: "fixture-labs" }),
    });
    expect(res.status).toBe(400);
    const joinKey = await SELF.fetch(`${ORIGIN}/api/o/${o.id}/city`, { method: "PUT", headers: { authorization: `Bearer ${o.joinKey}` }, body: "{}" });
    expect(joinKey.status).toBe(403);
  });
});

describe("city spam limits", () => {
  it("a 6th pending request for one site is 429", async () => {
    const offices = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => createOffice(`Bakery fan ${i}`)));
    const results = [];
    for (const o of offices) results.push(await requestLink(o, "sample-bakery"));
    expect(results.slice(0, 5).map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(results[5]!.status).toBe(429);
    expect(results[5]!.body.error).toBe("too many pending link requests for sample-bakery");
    // a new request from an office with a pending one replaces it instead of counting twice
    expect((await requestLink(offices[0]!, "sample-bakery")).status).toBe(200);
    for (const o of offices.slice(0, 5)) expect((await admin(`/${o.id}/reject`, "POST")).status).toBe(200);
  });

  it("the per-IP CITY_LINK_LIMIT stops a 4th request from one address", async () => {
    const offices = await Promise.all([1, 2, 3, 4].map((i) => createOffice(`Same IP ${i}`)));
    const statuses = [];
    for (const o of offices) statuses.push((await requestLink(o, "example-robotics", "10.200.0.1")).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    for (const o of offices.slice(0, 3)) await admin(`/${o.id}/reject`, "POST");
  });

  it("admin routes take only Bearer: ?key= is refused", async () => {
    const q = await SELF.fetch(`${ORIGIN}/api/city/sf/links?state=pending&key=${encodeURIComponent(ADMIN)}`);
    expect(q.status).toBe(400);
    expect(((await q.json()) as any).error).toMatch(/Authorization: Bearer/);
    expect((await SELF.fetch(`${ORIGIN}/api/city/sf/links`)).status).toBe(401);
    expect((await SELF.fetch(`${ORIGIN}/api/city/sf/links`, { headers: { authorization: "Bearer wrong-wrong-wrong-wrong-wrong" } })).status).toBe(401);
    const ok = await SELF.fetch(`${ORIGIN}/api/city/sf/links`, { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(ok.status).toBe(200);
    const post = await SELF.fetch(`${ORIGIN}/api/city/sf/links/abcdefabcdef/approve?key=${encodeURIComponent(ADMIN)}`, { method: "POST" });
    expect(post.status).toBe(400);
    expect((await admin("?state=bogus")).status).toBe(400);
    expect((await admin("/abcdefabcdef/approve", "POST")).status).toBe(404);
  });
});

describe("who may walk", () => {
  it("an invite without city:true is refused; the owner-key agent and a city:true invitee walk", async () => {
    const o = await linkedOffice("example-robotics", "Robotics");
    const owner = await ownerAgent(o, "Rho");
    expect((await city(o, owner.agentToken, { op: "look" })).status).toBe(200);

    const plain = await join(o, "Guest");
    const refused = await call(o, "city", { op: "look" }, { token: plain.agentToken });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("your invite isn't allowed in the city; ask the office owner");

    const inv = await SELF.fetch(`${ORIGIN}/api/o/${o.id}/invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${o.ownerKey}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "create", label: "Walker friend" }),
    });
    const invite = ((await inv.json()) as any).invite;
    const flag = await SELF.fetch(`${ORIGIN}/api/o/${o.id}/invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${o.ownerKey}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "city", id: invite.id, city: true }),
    });
    expect(flag.status).toBe(200);
    const friend = await call(o, "join", { name: "Friend" }, { key: invite.key });
    expect(friend.status).toBe(200);
    expect((await call(o, "city", { op: "look" }, { key: invite.key, token: friend.body.agentToken })).status).toBe(200);
    const list = await SELF.fetch(`${ORIGIN}/api/o/${o.id}/invites`, { headers: { authorization: `Bearer ${o.ownerKey}` } });
    expect(((await list.json()) as any).invites.find((i: any) => i.id === invite.id).city).toBe(true);
  });
});

function walkerIn(snapshot: any, name: string) {
  return snapshot.walkers.find((w: any) => w.name === name);
}
