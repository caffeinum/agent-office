// Fixes from the v2 integration review: say ordering, alarm without a graph, link abuse, public limits, vanished
// sites, names, long routes and the presence bridge.
import { runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error the viewer's live client is untyped browser JS
import { createLiveState, createWireAdapter } from "../public/js/city/live.js";
import type { CityResult, LinkRow } from "../src/city/do";
import {
  GRAPH_RETRY_MS, MAX_OFFICE_WALKERS, MAX_PATH_POINTS, MAX_VIEWERS_PER_IP, PENDING_TTL_MS, PUBLIC_IP_LIMITS, REVOKED_COOLDOWN_MS, type Pt,
} from "../src/city/walkers";
import { ADMIN, call, createOffice, ORIGIN } from "./helpers";
import {
  admin, advance, city, cityStub, clock, flushOffice, linkedOffice, officeStub, openCityWs, ownerAgent, publicCity, requestLink, runCityAlarm,
  setupCity, until, walkerNamed, withCity,
} from "./city-harness";

beforeEach(() => setupCity());

let officeSeq = 0;
const fakeOffice = () => `rev${String(++officeSeq).padStart(9, "0")}`;
const asLink = (r: unknown) => r as CityResult<LinkRow>;

describe("say", () => {
  it("a first-call say reaches viewers after the walker's walk frame, and the live client applies the stream", async () => {
    const o = await linkedOffice("fixture-labs", "Labs Say");
    const ws = await openCityWs();
    await ws.next((f) => f.type === "snapshot");
    const sam = await ownerAgent(o, "Sam Say");
    expect((await city(o, sam.agentToken, { op: "chat", chat: "say", text: "hi street" })).status).toBe(200);
    const say = await ws.next((f) => f.type === "say" && f.text === "hi street");
    const walkAt = ws.frames.findIndex((f) => f.type === "walk" && f.walker.id === say.id);
    expect(walkAt).toBeGreaterThanOrEqual(0);
    expect(walkAt).toBeLessThan(ws.frames.indexOf(say));
    const live = createLiveState();
    const fromWire = createWireAdapter();
    for (const f of ws.frames) live.apply(fromWire(f));
    expect(live.walker(say.id)?.name).toBe("Sam Say");
    ws.ws.close();
  });

  it("say from inside the building is a 400", async () => {
    const o = await linkedOffice("example-robotics", "Robots Say");
    const ina = await ownerAgent(o, "Ina Inside");
    expect((await city(o, ina.agentToken, { op: "go", to: "inside" })).status).toBe(200);
    const refused = await city(o, ina.agentToken, { op: "chat", chat: "say", text: "anyone?" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/inside your building.*go \{to: "outside"\} first/);
  });

  it("the live client warns about (and skips) a say from a walker it doesn't show", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const live = createLiveState();
    live.apply({ type: "snapshot", now: 1000, walkers: [], presence: [], chatTail: [] }, 1000);
    expect(() => live.apply({ type: "say", id: "wgone", text: "boo", ts: 1000 }, 1000)).not.toThrow();
    expect(live.sayOf("wgone", 1000)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("wgone"));
    warn.mockRestore();
  });
});

describe("alarm without a graph", () => {
  let restore: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await restore?.();
    restore = null;
  });

  it("after an eviction the alarm loads the graph and the arrival still happens", async () => {
    const o = await linkedOffice("fixture-labs", "Labs Evicted");
    const eva = await ownerAgent(o, "Eva Evicted");
    const go = await city(o, eva.agentToken, { op: "go", to: "Fixture Ave & Test St" });
    expect(go.status).toBe(200);
    await withCity((c) => {
      (c as any).graph = null;
    });
    await advance(go.body.etaSec * 1000 + 100);
    await runCityAlarm();
    const w = await withCity((c) => [...(c as any).walkers.values()].find((x: any) => x.name === "Eva Evicted"));
    expect(w.path).toBeNull();
    expect(await withCity((c) => (c as any).graph !== null)).toBe(true);
  });

  it("a failed data load backs off instead of arming an alarm in the past", async () => {
    const o = await linkedOffice("fixture-labs", "Labs Broken");
    const bo = await ownerAgent(o, "Bo Broken");
    const go = await city(o, bo.agentToken, { op: "go", to: "Fixture Ave & Test St" });
    expect(go.status).toBe(200);
    const original = await withCity((c) => (c as any).env);
    restore = () => withCity((c) => {
      (c as any).env = original;
    });
    await withCity((c) => {
      (c as any).graph = null;
      (c as any).env = { ...original, CITY_SF_ASSETS: "broken" };
    });
    await advance(go.body.etaSec * 1000 + 100);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runCityAlarm();
    const first = await withCity(async (c, state) => ({ retryAt: (c as any).graphRetryAt as number, alarm: await state.storage.getAlarm() }));
    expect(first.retryAt).toBe(clock.now + GRAPH_RETRY_MS);
    expect(first.alarm).toBeGreaterThan(clock.now);
    await runCityAlarm();
    expect(await withCity((c) => (c as any).graphRetryAt)).toBe(clock.now + 2 * GRAPH_RETRY_MS);
    err.mockRestore();
    await restore();
    restore = null;
    await advance(2 * GRAPH_RETRY_MS);
    await runCityAlarm();
    const w = await withCity((c) => [...(c as any).walkers.values()].find((x: any) => x.name === "Bo Broken"));
    expect(w.path).toBeNull();
  });
});

describe("link abuse", () => {
  it("a rejected link sticks: asking again is a 409", async () => {
    const o = await createOffice("Rejected HQ");
    expect((await requestLink(o, "fixture-labs")).status).toBe(200);
    expect((await admin(`/${o.id}/reject`, "POST")).status).toBe(200);
    const again = await requestLink(o, "example-robotics");
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("link was rejected; ask the city admin");
    expect((await cityStub().listLinks("rejected")).map((l) => l.officeId)).toContain(o.id);
  });

  it("a revoked link may ask again only after 24 h", async () => {
    const id = fakeOffice();
    expect(asLink(await cityStub().requestLink(id, "sample-bakery", "Revoked")).ok).toBe(true);
    expect(asLink(await cityStub().decideLink(id, "approve")).ok).toBe(true);
    expect(asLink(await cityStub().decideLink(id, "revoke")).ok).toBe(true);
    const early = asLink(await cityStub().requestLink(id, "sample-bakery", "Revoked"));
    expect(early).toMatchObject({ ok: false, status: 429 });
    expect((early as unknown as { extra: { retryAfter: number } }).extra.retryAfter).toBe(REVOKED_COOLDOWN_MS / 1000);
    await advance(REVOKED_COOLDOWN_MS);
    const later = asLink(await cityStub().requestLink(id, "sample-bakery", "Revoked"));
    expect(later).toMatchObject({ ok: true, value: { state: "pending" } });
    expect(asLink(await cityStub().decideLink(id, "reject")).ok).toBe(true);
  });

  it("pending requests expire after 7 days", async () => {
    const id = fakeOffice();
    expect(asLink(await cityStub().requestLink(id, "example-robotics", "Patient")).ok).toBe(true);
    expect((await cityStub().listLinks("pending")).map((l) => l.officeId)).toContain(id);
    await advance(PENDING_TTL_MS);
    expect((await cityStub().listLinks("pending")).map((l) => l.officeId)).not.toContain(id);
    expect(asLink(await cityStub().decideLink(id, "approve"))).toMatchObject({ ok: false, status: 404 });
  });

  it("the admin rejects every pending request for a site at once", async () => {
    const ids = [fakeOffice(), fakeOffice(), fakeOffice()];
    for (const id of ids) expect(asLink(await cityStub().requestLink(id, "sample-bakery", "Flood")).ok).toBe(true);
    const other = fakeOffice();
    expect(asLink(await cityStub().requestLink(other, "fixture-labs", "Bystander")).ok).toBe(true);
    const post = (body: unknown) =>
      SELF.fetch(`${ORIGIN}/api/city/sf/links`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ action: "approve", siteId: "sample-bakery" })).status).toBe(400);
    expect((await SELF.fetch(`${ORIGIN}/api/city/sf/links`, { method: "POST", body: "{}" })).status).toBe(401);
    const res = await post({ action: "reject", siteId: "sample-bakery" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rejected: LinkRow[] };
    expect(body.rejected.map((l) => l.officeId).sort()).toEqual([...ids].sort());
    const pending = (await cityStub().listLinks("pending")).map((l) => l.officeId);
    for (const id of ids) expect(pending).not.toContain(id);
    expect(pending).toContain(other);
    expect(asLink(await cityStub().decideLink(other, "reject")).ok).toBe(true);
  });
});

describe("public endpoint limits", () => {
  it(`one address gets at most ${MAX_VIEWERS_PER_IP} city sockets`, async () => {
    const sockets = [];
    for (let i = 0; i < MAX_VIEWERS_PER_IP; i++) sockets.push(await openCityWs("203.0.113.50"));
    const over = await SELF.fetch(`${ORIGIN}/city/sf/ws`, { headers: { upgrade: "websocket", "cf-connecting-ip": "203.0.113.50" } });
    expect(over.status).toBe(429);
    const other = await openCityWs("203.0.113.51");
    for (const s of [...sockets, other]) s.ws.close();
  });

  it("GET /api/city/sf is rate limited per address", async () => {
    const max = PUBLIC_IP_LIMITS[0]!.max;
    for (let i = 0; i < max; i++) await publicCity("203.0.113.60");
    const res = await SELF.fetch(`${ORIGIN}/api/city/sf`, { headers: { "cf-connecting-ip": "203.0.113.60" } });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    await publicCity("203.0.113.61");
    expect((await SELF.fetch(`${ORIGIN}/api/city/sf`)).status).toBe(400);
  });

  it("repeated GETs reuse the snapshot until something changes or a second passes", async () => {
    const o = await linkedOffice("fixture-labs", "Labs Cache");
    const cy = await ownerAgent(o, "Cy Cache");
    await publicCity();
    const builds = await withCity((c) => {
      const counter = { n: 0 };
      const orig = (c as any).snapshot;
      (c as any).snapshot = function (...args: unknown[]) {
        counter.n++;
        return orig.apply(this, args);
      };
      (globalThis as any).__snapBuilds = counter;
      return counter.n;
    });
    expect(builds).toBe(0);
    const count = () => withCity(() => (globalThis as any).__snapBuilds.n as number);
    for (let i = 0; i < 5; i++) await publicCity();
    expect(await count()).toBe(0);
    expect((await city(o, cy.agentToken, { op: "look" })).status).toBe(200);
    expect(walkerNamed(await publicCity(), "Cy Cache")).toBeTruthy();
    expect(await count()).toBe(1);
    await advance(1001);
    await publicCity();
    expect(await count()).toBe(2);
  });
});

describe("vanished sites", () => {
  it("presence for a site a rebuild dropped is removed on load and skipped in summaries", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await withCity((c) => {
      const row = { officeId: "ghost0000001", siteId: "vanished-site", agents: [{ agentId: "g", name: "Ghost", hue: 1, status: "idle", out: false }], ts: clock.now };
      (c as any).ctx.storage.sql.exec("INSERT OR REPLACE INTO presence (officeId, siteId, agents, ts) VALUES (?, ?, ?, ?)", row.officeId, row.siteId, JSON.stringify(row.agents), row.ts);
      (c as any).presence.set(row.officeId, row);
    });
    const live = await publicCity();
    expect(live.sites.map((s: any) => s.siteId)).not.toContain("vanished-site");
    await withCity((c) => {
      (c as any).graph = null;
      (c as any).snapCache = null; // an eviction loses the cached body too
    });
    await publicCity();
    const rows = await withCity((c) => (c as any).ctx.storage.sql.exec("SELECT * FROM presence WHERE officeId = 'ghost0000001'").toArray());
    expect(rows).toHaveLength(0);
    expect(err.mock.calls.some((args) => String(args[0]).includes("vanished-site"))).toBe(true);
    err.mockRestore();
  });

  it("deleting an office still works when telling the city fails", async () => {
    const o = await linkedOffice("sample-bakery", "Bakery Gone");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const real = await withCity((c) => {
      const proto = Object.getPrototypeOf(c);
      const orig = proto.officeGone;
      proto.officeGone = async () => {
        throw new Error("city down");
      };
      return orig;
    });
    const res = await SELF.fetch(`${ORIGIN}/api/o/${o.id}`, { method: "DELETE", headers: { authorization: `Bearer ${o.ownerKey}` } });
    await withCity((c) => {
      Object.getPrototypeOf(c).officeGone = real;
    });
    expect(res.status).toBe(200);
    expect(err.mock.calls.some((args) => String(args[0]).includes("telling the city it is gone failed"))).toBe(true);
    err.mockRestore();
  });
});

describe("names and the bridge", () => {
  it("walker numbering compares normalised names", async () => {
    const o1 = await linkedOffice("fixture-labs", "Labs Norm");
    const o2 = await linkedOffice("example-robotics", "Robots Norm");
    const a = await ownerAgent(o1, "No.rm Walker");
    const b = await ownerAgent(o2, "norm walker");
    expect((await city(o1, a.agentToken, { op: "look" })).status).toBe(200);
    const second = await city(o2, b.agentToken, { op: "look" });
    expect(second.body.you.name).toBe("norm walker 2");
  });

  it("a bridged agent named like another company is renamed in public presence", async () => {
    const id = fakeOffice();
    expect(asLink(await cityStub().requestLink(id, "fixture-labs", "Lookalike")).ok).toBe(true);
    expect(asLink(await cityStub().decideLink(id, "approve")).ok).toBe(true);
    await cityStub().officePresence(id, [
      { agentId: "x1", name: "Sample Bakery Co", hue: 1, status: "idle", out: false },
      { agentId: "x2", name: "Fixture Labs", hue: 2, status: "idle", out: false },
    ]);
    const names = (await publicCity()).sites.find((s: any) => s.siteId === "fixture-labs").agents.map((a: any) => a.name);
    expect(names).toContain("Sample Bakery Co (agent)");
    expect(names).toContain("Fixture Labs");
    expect(names).not.toContain("Sample Bakery Co");
    await cityStub().officeGone(id);
  });

  it("a rejected office stops pushing presence", async () => {
    const o = await createOffice("Rejected Pusher");
    const ro = await ownerAgent(o, "Ro Rejected");
    expect((await requestLink(o, "example-robotics")).status).toBe(200);
    expect((await admin(`/${o.id}/reject`, "POST")).status).toBe(200);
    await until(async () => (await call(o, "look", {}, { token: ro.agentToken, key: o.ownerKey })).body.city?.state === "rejected", "office learns rejected");
    await call(o, "status", { status: "working", activity: "x" }, { token: ro.agentToken, key: o.ownerKey });
    await flushOffice(o);
    const stub: any = officeStub(o);
    const inside: (s: unknown, f: (off: any) => unknown) => Promise<unknown> = runInDurableObject as any;
    const state = await inside(stub, (off: any) => ({ due: off.cityPushDue() as number | null, dirty: off.cityDirty as boolean }));
    expect(state).toEqual({ due: null, dirty: false });
  });

  it("concurrent first calls never exceed the per-office walker cap", async () => {
    const id = fakeOffice();
    expect(asLink(await cityStub().requestLink(id, "fixture-labs", "Race")).ok).toBe(true);
    expect(asLink(await cityStub().decideLink(id, "approve")).ok).toBe(true);
    try {
      const calls: Promise<unknown>[] = [];
      for (let i = 0; i < MAX_OFFICE_WALKERS + 5; i++) calls.push(cityStub().call(id, { agentId: `r${i}`, name: `Racer ${i}`, hue: 1, status: "idle" }, { op: "look" }));
      const results = (await Promise.all(calls)) as CityResult<unknown>[];
      expect(results.filter((r) => r.ok)).toHaveLength(MAX_OFFICE_WALKERS);
      expect(await withCity((c) => [...(c as any).walkers.values()].filter((w: any) => w.officeId === id).length)).toBe(MAX_OFFICE_WALKERS);
    } finally {
      await cityStub().officeGone(id);
    }
  });

  it("removing a walker forgets its go, look and city-chat windows", async () => {
    const id = fakeOffice();
    expect(asLink(await cityStub().requestLink(id, "fixture-labs", "Windows")).ok).toBe(true);
    expect(asLink(await cityStub().decideLink(id, "approve")).ok).toBe(true);
    const caller = { agentId: "win", name: "Win Dow", hue: 1, status: "idle" };
    expect(((await cityStub().call(id, caller, { op: "look" })) as CityResult<unknown>).ok).toBe(true);
    expect(((await cityStub().call(id, caller, { op: "chat", chat: "send", scope: "city", text: "hi all" })) as CityResult<unknown>).ok).toBe(true);
    const keys = () => withCity((c) => [...(c as any).limits.hits.keys()].filter((k: string) => k.endsWith(`${id}:win`)));
    expect((await keys()).sort()).toEqual([`citychat:${id}:win`, `look:${id}:win`]);
    await cityStub().removeWalker(id, "win");
    expect(await keys()).toEqual([]);
    await cityStub().officeGone(id);
  });
});

describe("long routes", () => {
  it("a route over 256 points keeps every point: distance from the full route, viewers get it leg by leg", async () => {
    const o = await linkedOffice("fixture-labs", "Labs Long");
    const lo = await ownerAgent(o, "Lo Long");
    expect((await city(o, lo.agentToken, { op: "look" })).status).toBe(200);
    const door = walkerNamed(await publicCity(), "Lo Long").path[0] as Pt;
    const full: Pt[] = Array.from({ length: 600 }, (_, i) => [door[0] + i * 0.5, door[1] + (i % 2 ? 0.4 : 0), door[2]]);
    full[0] = [...door];
    const ws = await openCityWs();
    await ws.next((f) => f.type === "snapshot");
    await advance(2100);
    await withCity((c) => {
      c.nav = { ...c.nav, route: () => ({ nodes: [], path: full, lengthBlocks: 0, via: ["Test Way"] }) };
    });
    const go = await city(o, lo.agentToken, { op: "go", to: "Fixture Ferry" });
    expect(go.status).toBe(200);
    const length = full.slice(1).reduce((n, p, i) => n + Math.hypot(p[0] - full[i]![0], p[1] - full[i]![1]), 0);
    expect(go.body.distanceM).toBe(Math.round(length * 3));
    const w = walkerNamed(await publicCity(), "Lo Long");
    expect(w.path).toHaveLength(MAX_PATH_POINTS);
    expect(w.path).toEqual(full.slice(0, MAX_PATH_POINTS));
    const legMs = (w.path.slice(1).reduce((n: number, p: Pt, i: number) => n + Math.hypot(p[0] - w.path[i][0], p[1] - w.path[i][1]), 0) / w.speed) * 1000;
    await advance(w.t0 + legMs + 10 - clock.now);
    await runCityAlarm();
    const next = await ws.next((f) => f.type === "walk" && f.walker.id === w.id && f.walker.path[0][0] === full[MAX_PATH_POINTS - 1]![0]);
    expect(next.walker.t0).toBeCloseTo(w.t0 + legMs, 3);
    expect(next.walker.path).toEqual(full.slice(MAX_PATH_POINTS - 1, 2 * MAX_PATH_POINTS - 1));
    ws.ws.close();
  });
});
