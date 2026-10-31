import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { refuseNonAdmin } from "../src/api";
import { IDLE_EXPIRE_MS, UNUSED_EXPIRE_MS, WS_CLOSE_DELETED, type Activity, type Office } from "../src/office";
import { registryStub } from "../src/registry";
import { ADMIN, call, createOffice, fakeImage, join, openWs, ORIGIN, type Created } from "./helpers";

const stubOf = (id: string) => env.OFFICE.get(env.OFFICE.idFromName(id));
const DAY = 86_400_000;

const deleteOffice = (o: Created, key: string) =>
  SELF.fetch(`${ORIGIN}/api/o/${o.id}`, { method: "DELETE", headers: { authorization: `Bearer ${key}` } });
const admin = (path: string, method = "GET", key = ADMIN) => SELF.fetch(`${ORIGIN}/api/offices${path}`, { method, headers: { authorization: `Bearer ${key}` } });
const listed = async () => ((await (await admin("")).json()) as { offices: Array<{ id: string; name: string; admin: boolean | null; agentCount: number }> }).offices;

async function uploadLogo(o: Created): Promise<string> {
  const res = await SELF.fetch(`${ORIGIN}/api/o/${o.id}/upload?filename=logo.png`, {
    method: "POST",
    headers: { authorization: `Bearer ${o.ownerKey}`, "content-type": "image/png" },
    body: fakeImage.png(4, 4),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { url: string }).url;
}

async function expectWiped(o: Created) {
  expect((await call(o, "look", {}, { method: "GET" })).body).toEqual({ error: "no such office" });
  const left = await runInDurableObject(stubOf(o.id), async (_inst: Office, state) => ({
    keys: [...(await state.storage.list()).keys()],
    tables: state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'assets'").toArray(),
    alarm: await state.storage.getAlarm(),
  }));
  expect(left).toEqual({ keys: [], tables: [], alarm: null });
  expect((await listed()).map((r) => r.id)).not.toContain(o.id);
}

const setActivity = (o: Created, patch: Partial<Activity>) =>
  runInDurableObject(stubOf(o.id), (inst: Office) => {
    Object.assign((inst as any).activity as Activity, patch);
  });

describe("owner delete", () => {
  it("wipes the office, its assets and viewer sockets; join and view keys are refused", async () => {
    const o = await createOffice("Doomed");
    const assetUrl = await uploadLogo(o);
    await join(o, "Witness");
    expect((await deleteOffice(o, o.joinKey)).status).toBe(403);
    expect((await deleteOffice(o, o.viewKey)).status).toBe(403);
    expect((await SELF.fetch(`${ORIGIN}/api/o/${o.id}`, { method: "POST", headers: { authorization: `Bearer ${o.ownerKey}` } })).status).toBe(405);

    const viewer = await openWs(o, o.viewKey);
    await viewer.next((f) => f.type === "snapshot");
    const closed = new Promise<{ code: number; reason: string }>((r) => viewer.ws.addEventListener("close", (e) => r({ code: e.code, reason: e.reason })));

    const res = await deleteOffice(o, o.ownerKey);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: o.id });
    expect(await closed).toEqual({ code: WS_CLOSE_DELETED, reason: "this office was deleted by its owner" });

    await expectWiped(o);
    expect((await SELF.fetch(assetUrl)).status).toBe(404);
    expect((await deleteOffice(o, o.ownerKey)).status).toBe(404);
    expect((await SELF.fetch(`${ORIGIN}/o/${o.id}/ws`, { headers: { upgrade: "websocket", "sec-websocket-protocol": `ao-key.${o.ownerKey}` } })).status).toBe(404);
  });
});

describe("admin office management", () => {
  it("needs the admin key; 503 when it isn't set", async () => {
    expect((await SELF.fetch(`${ORIGIN}/api/offices`)).status).toBe(401);
    expect((await admin("", "GET", "wrong")).status).toBe(401);
    const o = await createOffice();
    expect((await admin(`/${o.id}`, "DELETE", o.ownerKey)).status).toBe(401);
    const off = await refuseNonAdmin(new Request(`${ORIGIN}/api/offices`, { headers: { authorization: "Bearer x" } }), { ...env, ADMIN_KEY: "" }, "office admin");
    expect(off?.status).toBe(503);
    expect(((await off!.json()) as { error: string }).error).toMatch(/ADMIN_KEY secret is not set/);
  });

  it("lists offices newest first without keys, and deletes any office", async () => {
    const older = await createOffice("Older");
    const newer = await createOffice("Newer");
    await join(newer, "Counted");
    const res = await admin("");
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const k of [older.ownerKey, older.joinKey, older.viewKey, newer.ownerKey]) expect(text).not.toContain(k.split(".")[1]);
    const rows = (JSON.parse(text) as { offices: Array<{ id: string; name: string; admin: boolean | null; createdAt: number }> }).offices;
    const ids = rows.map((r) => r.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
    expect(rows.find((r) => r.id === older.id)).toMatchObject({ name: "Older", admin: true });
    expect(rows.find((r) => r.id === newer.id)).toMatchObject({ name: "Newer", agentCount: 1 });

    const del = await admin(`/${older.id}`, "DELETE");
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true, deleted: older.id });
    await expectWiped(older);
    expect((await admin(`/${older.id}`, "DELETE")).status).toBe(404);
    expect((await admin(`/not-an-id`, "DELETE")).status).toBe(404);
    expect((await admin(`/${newer.id}`, "POST")).status).toBe(405);
  });

  it("marks keyless offices as not admin-created", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/offices`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.9" },
      body: JSON.stringify({ name: "Public" }),
    });
    const o = (await res.json()) as Created;
    expect((await listed()).find((r) => r.id === o.id)).toMatchObject({ name: "Public", admin: false });
  });

  it("inspects and deletes an office by raw Durable Object id", async () => {
    const o = await createOffice("By Hex");
    await join(o, "Hexer");
    const hex = env.OFFICE.idFromName(o.id).toString();
    const info = await admin(`/do/${hex}`);
    expect(info.status).toBe(200);
    const body = await info.text();
    expect(JSON.parse(body)).toMatchObject({ id: o.id, name: "By Hex", agentCount: 1, itemCount: expect.any(Number), joined: true, lastActiveAt: expect.any(Number) });
    for (const k of [o.ownerKey, o.joinKey, o.viewKey]) expect(body).not.toContain(k.split(".")[1]);

    expect((await admin(`/do/${hex.toUpperCase()}`)).status).toBe(400);
    expect((await admin(`/do/${hex.slice(1)}`)).status).toBe(400);
    expect((await admin(`/do/zz${hex.slice(2)}`)).status).toBe(400);
    expect((await admin(`/do/${env.OFFICE.newUniqueId().toString()}`)).status).toBe(404);
    expect((await admin(`/do/${hex}`, "DELETE", "wrong")).status).toBe(401);

    const del = await admin(`/do/${hex}`, "DELETE");
    expect(await del.json()).toEqual({ ok: true, deleted: o.id });
    await expectWiped(o);
    expect((await admin(`/do/${hex}`)).status).toBe(404);
  });
});

describe("registry backfill", () => {
  it("an office saved before the registry registers itself on first open, with inferred activity and a grace period", async () => {
    const o = await createOffice("Legacy");
    const a = await join(o, "Old Timer");
    await call(o, "say", { text: "was here" }, { token: a.agentToken });
    await call(o, "leave", {}, { token: a.agentToken });
    const longAgo = Date.now() - 200 * DAY;
    // make it look like an office from before activity/registry existed, then cold-load it
    await runInDurableObject(stubOf(o.id), async (inst: Office, state) => {
      const chat = ((await state.storage.get<any[]>("chat")) ?? []).map((m) => ({ ...m, ts: longAgo }));
      const meta = { ...(await state.storage.get<any>("meta")), createdAt: longAgo - DAY };
      await state.storage.put({ chat, meta });
      for (const [k, it] of await state.storage.list<any>({ prefix: "item:" })) await state.storage.put(k, { ...it, at: longAgo });
      await state.storage.delete(["activity", "registered", "admin"]);
      await state.storage.deleteAlarm();
      (inst as any).alarmAt = null;
    });
    await registryStub(env).remove(o.id);
    expect((await listed()).map((r) => r.id)).not.toContain(o.id);

    const before = Date.now();
    await runInDurableObject(stubOf(o.id), (inst: Office) => (inst as any).load());
    const act = await runInDurableObject(stubOf(o.id), (inst: Office) => ({ ...((inst as any).activity as Activity) }));
    expect(act).toMatchObject({ lastActiveAt: longAgo, lastOwnerAt: longAgo, joined: true });
    expect(act.graceUntil).toBeGreaterThanOrEqual(before + UNUSED_EXPIRE_MS);

    expect((await call(o, "kinds", {}, { method: "GET" })).status).toBe(200);
    expect((await listed()).find((r) => r.id === o.id)).toMatchObject({ name: "Legacy", admin: null });

    // 200 days idle, but the grace period holds it until a week after the first load
    expect(await runDurableObjectAlarm(stubOf(o.id))).toBe(true);
    expect((await call(o, "kinds", {}, { method: "GET" })).status).toBe(200);
    await setActivity(o, { graceUntil: Date.now() - 1, lastActiveAt: longAgo });
    expect(await runDurableObjectAlarm(stubOf(o.id))).toBe(true);
    await expectWiped(o);
  });
});

describe("expiry", () => {
  it("an office no agent joined expires after 7 days without owner activity", async () => {
    const o = await createOffice("Abandoned");
    const old = Date.now() - UNUSED_EXPIRE_MS - 1000;
    await setActivity(o, { lastOwnerAt: old, lastActiveAt: Date.now() - 1000 });
    const alarm = await runInDurableObject(stubOf(o.id), (_i, s) => s.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(await runDurableObjectAlarm(stubOf(o.id))).toBe(true);
    await expectWiped(o);
  });

  it("owner activity keeps an unjoined office alive and pushes the alarm out", async () => {
    const o = await createOffice("Kept");
    await setActivity(o, { lastOwnerAt: Date.now() - UNUSED_EXPIRE_MS + DAY });
    expect((await call(o, "kinds", {}, { method: "GET", key: o.ownerKey })).status).toBe(200);
    expect(await runDurableObjectAlarm(stubOf(o.id))).toBe(true);
    const after = await runInDurableObject(stubOf(o.id), async (inst: Office, s) => ({ alarm: await s.storage.getAlarm(), a: (inst as any).activity as Activity }));
    expect(after.a.lastOwnerAt).toBeGreaterThan(Date.now() - 60_000);
    expect(after.alarm).toBeGreaterThan(Date.now() + UNUSED_EXPIRE_MS - 60_000);
  });

  it("a joined office survives 7 quiet days but expires after 90", async () => {
    const o = await createOffice("Used");
    const a = await join(o, "Worker");
    await call(o, "leave", {}, { token: a.agentToken });
    await setActivity(o, { lastOwnerAt: Date.now() - 30 * DAY, lastActiveAt: Date.now() - 30 * DAY });
    expect(await runDurableObjectAlarm(stubOf(o.id))).toBe(true);
    expect((await call(o, "kinds", {}, { method: "GET" })).status).toBe(200);

    await setActivity(o, { lastActiveAt: Date.now() - IDLE_EXPIRE_MS - 1000 });
    expect(await runDurableObjectAlarm(stubOf(o.id))).toBe(true);
    await expectWiped(o);
  });

  it("presence alarms still run alongside expiry", async () => {
    const o = await createOffice();
    const a = await join(o, "Napper");
    await runInDurableObject(stubOf(o.id), (inst: Office) => {
      (inst as any).agents.get(a.agent.id).lastSeen = Date.now() - 6 * 60_000;
    });
    expect(await runDurableObjectAlarm(stubOf(o.id))).toBe(true);
    const state = await runInDurableObject(stubOf(o.id), (inst: Office) => inst.state());
    expect(state.agents[0]!.status).toBe("away");
  });
});
