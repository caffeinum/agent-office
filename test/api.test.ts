import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256hex } from "../src/auth";
import { AWAY_MS, REMOVE_MS, type Office } from "../src/office";
import { ADMIN, call, createOffice, join, openWs, ORIGIN } from "./helpers";

const stubOf = (id: string) => env.OFFICE.get(env.OFFICE.idFromName(id));

describe("office creation", () => {
  it("rejects a wrong admin key", async () => {
    const wrong = await SELF.fetch(`${ORIGIN}/api/offices`, { method: "POST", headers: { authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toHaveProperty("error");
  });

  it("anyone can create an office without a key, rate-limited per IP", async () => {
    const create = () =>
      SELF.fetch(`${ORIGIN}/api/offices`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
        body: JSON.stringify({ name: "Visitor HQ" }),
      });
    const first = await create();
    expect(first.status).toBe(201);
    const o = (await first.json()) as { id: string; joinKey: string; ownerUrl: string };
    expect(o.joinKey.startsWith(`${o.id}.`)).toBe(true);
    expect(o.ownerUrl).toContain(`/o/${o.id}#k=`);
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await create()).status);
    expect(statuses).toContain(429);
  });

  it("returns keys and urls, stores only hashes (except the join and view keys, kept for the owner's share links)", async () => {
    const o = await createOffice("Hash Office");
    expect(o.id).toMatch(/^[a-z0-9]{12}$/);
    for (const k of [o.ownerKey, o.joinKey, o.viewKey]) expect(k).toMatch(new RegExp(`^${o.id}\\.[A-Za-z0-9_-]{43}$`));
    expect(new Set([o.ownerKey, o.joinKey, o.viewKey]).size).toBe(3);
    expect(o.mcpUrl).toBe(`${ORIGIN}/mcp`);
    expect(o.viewUrl).toContain(`/o/${o.id}#k=`);
    const { agentToken } = await join(o, "Hasher");
    const dump = await runInDurableObject(stubOf(o.id), async (_inst: Office, state) => {
      const all = await state.storage.list();
      return JSON.stringify([...all.entries()]);
    });
    for (const secret of [o.ownerKey, agentToken]) {
      expect(dump).not.toContain(secret);
      expect(dump).not.toContain(secret.split(".").pop());
    }
    expect(dump).toContain(await sha256hex(o.joinKey));
    expect(dump).toContain(await sha256hex(agentToken));
  });

  it("rejects wrong keys for an office", async () => {
    const a = await createOffice();
    const b = await createOffice();
    expect((await call(a, "kinds", {}, { key: b.joinKey })).status).toBe(401);
    expect((await call(a, "kinds", {}, { key: a.viewKey })).status).toBe(403);
    expect((await call(a, "kinds", {}, { key: a.ownerKey })).status).toBe(200);
    const res = await SELF.fetch(`${ORIGIN}/api/o/${a.id}/kinds?key=${encodeURIComponent(a.joinKey)}`);
    expect(res.status).toBe(200);
  });
});

describe("REST tools", () => {
  it("covers every tool", async () => {
    const o = await createOffice();
    const ada = await join(o, "Ada", { hue: 200, emoji: "🐱", client: "claude-code" });
    const bob = await join(o, "Bob");
    expect(ada.agent).toMatchObject({ name: "Ada", hue: 200, emoji: "🐱", client: "claude-code", status: "idle" });
    expect(ada.desk?.id).toMatch(/^desk-/);
    expect(bob.desk?.id).not.toBe(ada.desk?.id);
    const t = { token: ada.agentToken };

    const kinds = await call(o, "kinds", {}, { method: "GET" });
    expect(kinds.body.kinds.desk).toMatchObject({ w: 2, d: 2 });

    const st = await call(o, "status", { status: "working", activity: "fixing tests" }, t);
    expect(st.body.agent).toMatchObject({ status: "working", activity: "fixing tests" });

    const say = await call(o, "say", { text: "hello office" }, t);
    expect(say.body.msg).toMatchObject({ from: ada.agent.id, to: null, text: "hello office" });

    const dm = await call(o, "office_chat_send", { to: "Bob", text: "psst" }, t);
    expect(dm.status).toBe(200);
    expect(dm.body.msg.to).toBe(bob.agent.id);
    expect((await call(o, "chat_send", { to: "nobody", text: "x" }, t)).status).toBe(404);

    const bobRead = await call(o, "chat-read", {}, { token: bob.agentToken });
    expect(bobRead.body.messages.map((m: { text: string }) => m.text)).toEqual(["hello office", "psst"]);
    expect(bobRead.body.names[ada.agent.id]).toBe("Ada");
    const again = await call(o, "chat_read", {}, { token: bob.agentToken });
    expect(again.body.messages).toEqual([]);
    const since = await call(o, "chat_read", { since: 0 }, { token: bob.agentToken });
    expect(since.body.messages).toHaveLength(2);

    const look = await call(o, "look", {}, t);
    expect(look.body.you).toMatchObject({ id: ada.agent.id, status: "working" });
    expect(look.body.agents).toHaveLength(2);
    expect(look.body.items.some((s: string) => s.startsWith("desk-1 desk"))).toBe(true);

    const added = await call(o, "add", { kind: "plant", x: 22, z: 10 }, t);
    expect(added.status).toBe(200);
    const plantId = added.body.item.id;
    expect(added.body.item).toMatchObject({ kind: "plant", by: ada.agent.id });
    expect((await call(o, "move", { id: plantId, x: 21, z: 11 }, t)).body.item).toMatchObject({ x: 21, z: 11 });
    expect((await call(o, "rotate", { id: plantId, rot: 90 }, t)).body.item.rot).toBe(90);
    const sign = look.body.items.find((s: string) => s.includes(" sign ")).split(" ")[0];
    expect((await call(o, "text", { id: sign, text: "brb" }, t)).body.item.text).toBe("brb");
    expect((await call(o, "remove", { id: plantId }, t)).body.removed).toBe(plantId);

    const overlap = await call(o, "add", { kind: "plant", x: 23, z: 15 }, t);
    expect(overlap.status).toBe(400);
    expect(overlap.body.error).toMatch(/overlaps/);

    const left = await call(o, "leave", {}, t);
    expect(left.body).toMatchObject({ ok: true, left: ada.agent.id });
    const after = await call(o, "status", { status: "idle" }, t);
    expect(after.status).toBe(401);
    expect(after.body.error).toMatch(/office_join/);
  });

  it("connect: the owner gets the join key back, a join key gets none, a view key is refused", async () => {
    const o = await createOffice();
    const owner = await call(o, "connect", {}, { method: "GET", key: o.ownerKey });
    expect(owner.status).toBe(200);
    expect(owner.body).toMatchObject({
      office: o.id, joinKey: o.joinKey, mcpUrl: `${ORIGIN}/mcp`, designMcpUrl: `${ORIGIN}/mcp?mode=design`,
      joinUrl: `${ORIGIN}/o/${o.id}#k=${encodeURIComponent(o.joinKey)}`, viewUrl: o.viewUrl,
    });
    const asJoin = (await call(o, "connect", {}, { method: "GET" })).body;
    expect(asJoin).toMatchObject({ joinKey: null, joinUrl: null, viewUrl: o.viewUrl });
    expect((await call(o, "connect", {}, { method: "GET", key: o.viewKey })).status).toBe(403);
    const rotated = await call(o, "rotate-keys", { which: "join" }, { key: o.ownerKey });
    expect((await call(o, "connect", {}, { method: "GET", key: o.ownerKey })).body.joinKey).toBe(rotated.body.joinKey);
  });

  it("invites: create, list, revoke; a new invite never revokes the others", async () => {
    const o = await createOffice();
    const owner = { key: o.ownerKey };
    expect((await call(o, "invites", { op: "create", label: "Bob" })).status).toBe(403);
    const bob = (await call(o, "invites", { op: "create", label: "Bob" }, owner)).body.invite;
    expect(bob).toMatchObject({ label: "Bob", agents: 0 });
    expect(bob.url).toContain(`#k=${encodeURIComponent(bob.key)}`);
    expect((await call(o, "invites", { op: "create", label: "bob" }, owner)).status).toBe(409);
    expect((await call(o, "invites", { op: "create", label: " " }, owner)).status).toBe(400);
    const cat = (await call(o, "invites", { op: "create", label: "Cat" }, owner)).body.invite;
    expect((await call(o, "kinds", {}, { key: o.joinKey })).status).toBe(200);
    expect((await call(o, "kinds", {}, { key: bob.key })).status).toBe(200);
    const list = (await call(o, "invites", {}, { method: "GET", ...owner })).body.invites;
    expect(list.map((i: { label: string }) => i.label)).toEqual(["everyone", "Bob", "Cat"]);
    expect(list[0].key).toBe(o.joinKey);
    const info = (await call(o, "connect", {}, { method: "GET", ...owner })).body;
    expect(info.joinKey).toBe(o.joinKey);
    expect(info.invites).toHaveLength(3);
    expect((await call(o, "connect", {}, { method: "GET", key: bob.key })).body).toMatchObject({ as: "Bob", joinKey: null });
    const sock = await openWs(o, bob.key);
    const closed = new Promise<number>((r) => sock.ws.addEventListener("close", (e) => r(e.code)));
    expect((await call(o, "invites", { op: "revoke", id: "nope" }, owner)).status).toBe(404);
    expect((await call(o, "invites", { op: "revoke", id: bob.id }, owner)).body).toMatchObject({ ok: true, revoked: bob.id, label: "Bob" });
    expect(await closed).toBe(4401);
    expect((await call(o, "kinds", {}, { key: bob.key })).status).toBe(401);
    expect((await call(o, "kinds", {}, { key: cat.key })).status).toBe(200);
    expect((await call(o, "kinds", {}, { key: o.joinKey })).status).toBe(200);
  });

  it("agents carry the invite they came through; revoking it shows out only that person's agents", async () => {
    const o = await createOffice();
    const owner = { key: o.ownerKey };
    const bob = (await call(o, "invites", { op: "create", label: "Bob" }, owner)).body.invite;
    const viaBob = await call(o, "join", { name: "bobbot" }, { key: bob.key });
    expect(viaBob.body.agent.via).toBe("Bob");
    const other = await join(o, "mine");
    expect((other.agent as { via?: string }).via).toBe("everyone");
    const ownerAgent = await call(o, "join", { name: "boss" }, owner);
    expect(ownerAgent.body.agent).not.toHaveProperty("via");
    const look = (await call(o, "look", {}, { token: other.agentToken })).body;
    expect(look.agents.find((a: { id: string }) => a.id === viaBob.body.agent.id).via).toBe("Bob");
    expect((await call(o, "invites", {}, { method: "GET", ...owner })).body.invites[1].agents).toBe(1);
    const res = (await call(o, "invites", { op: "revoke", id: bob.id }, owner)).body;
    expect(res.kicked).toEqual([viaBob.body.agent.id]);
    expect((await call(o, "look", {}, { token: viaBob.body.agentToken })).status).toBe(401);
    expect((await call(o, "look", {}, { token: other.agentToken })).status).toBe(200);
  });

  it("a friend on a join link chats as the invite's label, and can't edit", async () => {
    const o = await createOffice();
    const bob = (await call(o, "invites", { op: "create", label: "Bob" }, { key: o.ownerKey })).body.invite;
    const sock = await openWs(o, bob.key);
    expect((await sock.next((f) => f.type === "snapshot")).as).toBe("Bob");
    sock.ws.send(JSON.stringify({ type: "chat", text: "hi from bob", as: "owner" }));
    expect((await sock.next((f) => f.type === "chat")).msg).toMatchObject({ from: "human:Bob", text: "hi from bob" });
    sock.ws.send(JSON.stringify({ type: "op", op: { op: "add", kind: "plant", x: 3, z: 3 } }));
    expect((await sock.next((f) => f.type === "error")).error).toMatch(/ownerKey/);
    sock.ws.close();
  });

  it("public links: adding one keeps the others; revoke-others is explicit", async () => {
    const o = await createOffice();
    const owner = { key: o.ownerKey };
    const added = (await call(o, "view-keys", { op: "add" }, owner)).body;
    expect(added.count).toBe(2);
    expect((await call(o, "connect", {}, { method: "GET", ...owner })).body.viewUrl).toBe(added.url);
    const ws1 = await openWs(o, o.viewKey);
    await ws1.next((f) => f.type === "snapshot");
    const closed = new Promise<number>((r) => ws1.ws.addEventListener("close", (e) => r(e.code)));
    expect((await call(o, "view-keys", { op: "revoke-others", keep: added.key }, owner)).body).toMatchObject({ revoked: 1, count: 1 });
    expect(await closed).toBe(4401);
    await openWs(o, added.key);
  });

  it("offices saved with a single join/view key get an \"everyone\" invite", async () => {
    const o = await createOffice();
    const a = await join(o, "early");
    await runInDurableObject(stubOf(o.id), async (inst: Office, state) => {
      const meta = (await state.storage.get<any>("meta"))!;
      const legacy = { ...meta, keys: { owner: meta.keys.owner, join: meta.keys.join[0].hash, view: meta.keys.view[0] } };
      await state.storage.put({ meta: legacy, joinKey: o.joinKey, viewKey: o.viewKey });
      await state.storage.delete(["joinKeys", "viewKeys"]);
      await (inst as any).migrateKeys(legacy);
      const keys = (await state.storage.get<any>("meta")).keys;
      expect(keys.join).toEqual([{ id: "everyone", hash: meta.keys.join[0].hash, label: "everyone", createdAt: meta.createdAt }]);
      expect(keys.view).toEqual(meta.keys.view);
      expect(await state.storage.get("joinKeys")).toEqual({ everyone: o.joinKey });
      expect(await state.storage.get("joinKey")).toBeUndefined();
    });
    expect((await call(o, "kinds", {})).status).toBe(200);
    const info = (await call(o, "connect", {}, { method: "GET", key: o.ownerKey })).body;
    expect(info).toMatchObject({ joinKey: o.joinKey, viewUrl: o.viewUrl });
    expect((await call(o, "look", {}, { token: a.agentToken })).status).toBe(200);
  });

  it("office_edit and office_chat route ops to the single-purpose tools", async () => {
    const o = await createOffice();
    const t = { token: (await join(o, "Eve")).agentToken };
    const add = await call(o, "edit", { op: "add", kind: "plant", x: 3, z: 3 }, t);
    expect(add.status).toBe(200);
    expect((await call(o, "edit", { op: "rotate", id: add.body.item.id, rot: 90 }, t)).body.item.rot).toBe(90);
    expect((await call(o, "edit", { op: "remove", id: add.body.item.id }, t)).body.removed).toBe(add.body.item.id);
    const bad = await call(o, "edit", { op: "fly" }, t);
    expect(bad.status).toBe(400);
    expect((await call(o, "chat", { op: "send", text: "hey" }, t)).body.msg.text).toBe("hey");
    expect((await call(o, "chat", { op: "read", since: 0 }, t)).body.messages.map((m: { text: string }) => m.text)).toEqual(["hey"]);
    expect((await call(o, "chat", { op: "read", text: "x" }, t)).body.error).toMatch(/takes since — not text/);
  });

  it("validates input with clear JSON errors", async () => {
    const o = await createOffice();
    expect((await call(o, "join", { name: "x".repeat(33) })).body.error).toMatch(/name/);
    expect((await call(o, "join", {})).status).toBe(400);
    const a = await join(o, "Val");
    const t = { token: a.agentToken };
    expect((await call(o, "say", { text: "x".repeat(281) }, t)).status).toBe(400);
    expect((await call(o, "status", { status: "dancing" }, t)).status).toBe(400);
    expect((await call(o, "add", { kind: "spaceship", x: 1, z: 1 }, t)).status).toBe(400);
    expect((await call(o, "add", { kind: "plant", x: 1, z: 1, bogus: 1 }, t)).body.error).toMatch(/bogus|unrecognized/i);
    expect((await call(o, "status", { status: "idle" })).status).toBe(401);
    expect((await call(o, "nope", {})).status).toBe(404);
    const big = await SELF.fetch(`${ORIGIN}/api/o/${o.id}/say`, {
      method: "POST",
      headers: { authorization: `Bearer ${o.joinKey}`, "x-agent-token": a.agentToken },
      body: JSON.stringify({ text: "x".repeat(20_000) }),
    });
    expect(big.status).toBe(413);
    const bad = await SELF.fetch(`${ORIGIN}/api/o/${o.id}/say`, {
      method: "POST",
      headers: { authorization: `Bearer ${o.joinKey}`, "x-agent-token": a.agentToken },
      body: "{not json",
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()) as object).toHaveProperty("error");
  });

  it("rate limits per agent token", async () => {
    const o = await createOffice();
    const a = await join(o, "Speedy");
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) statuses.push((await call(o, "look", {}, { token: a.agentToken })).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    const limited = await call(o, "look", {}, { token: a.agentToken });
    expect(limited.body.error).toMatch(/rate limited/);
    expect(limited.body.retryAfter).toBeGreaterThan(0);
    const b = await join(o, "Calm");
    expect((await call(o, "look", {}, { token: b.agentToken })).status).toBe(200);
  });

  it("caps the office at 64 agents and adds desks while space allows", async () => {
    const o = await createOffice();
    await runInDurableObject(stubOf(o.id), async (inst: Office) => {
      const ctx = { role: "join" as const, token: null, sessionId: null, ip: "test" };
      for (let i = 0; i < 64; i++) await (inst as any).join({ name: `bot ${i}` }, { ...ctx, ip: `ip-${i}` });
      await expect((inst as any).join({ name: "one too many" }, ctx)).rejects.toThrow(/full/);
      const state = inst.state();
      expect(state.agents).toHaveLength(64);
      expect(state.items.filter((i) => i.kind === "desk").length).toBeGreaterThan(8);
    });
  });
});

describe("presence alarm", () => {
  it("marks agents away after 5 min and removes them after 1h", async () => {
    const o = await createOffice();
    const a = await join(o, "Sleepy");
    const b = await join(o, "Busy");
    const stub = stubOf(o.id);
    await runInDurableObject(stub, async (inst: Office) => {
      const agents = (inst as any).agents as Map<string, { lastSeen: number }>;
      agents.get(a.agent.id)!.lastSeen = Date.now() - AWAY_MS - 1000;
      agents.get(b.agent.id)!.lastSeen = Date.now() - REMOVE_MS - 1000;
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const state = await runInDurableObject(stub, (inst: Office) => inst.state());
    expect(state.agents.map((x) => [x.id, x.status])).toEqual([[a.agent.id, "away"]]);
    const back = await call(o, "look", {}, { token: a.agentToken });
    expect(back.body.you.status).toBe("idle");
    expect((await call(o, "look", {}, { token: b.agentToken })).status).toBe(401);
    const alarm = await runInDurableObject(stub, (_i, s) => s.storage.getAlarm());
    expect(alarm).toBeGreaterThan(Date.now());
  });
});

describe("viewer websocket", () => {
  async function open(o: { id: string }, key: string) {
    const res = await SELF.fetch(`${ORIGIN}/o/${o.id}/ws?k=${encodeURIComponent(key)}`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const frames: any[] = [];
    const waiters: Array<() => void> = [];
    ws.addEventListener("message", (e) => {
      frames.push(JSON.parse(e.data as string));
      waiters.splice(0).forEach((w) => w());
    });
    ws.accept();
    const next = async (pred: (f: any) => boolean) => {
      for (let i = 0; i < 50; i++) {
        const hit = frames.find(pred);
        if (hit) return hit;
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 100);
        });
      }
      throw new Error(`no frame matching; got ${JSON.stringify(frames.map((f) => f.type))}`);
    };
    return { ws, frames, next };
  }

  it("sends a snapshot then deltas; owner can chat and edit, viewer cannot", async () => {
    const o = await createOffice();
    expect((await SELF.fetch(`${ORIGIN}/o/${o.id}/ws?k=${encodeURIComponent(o.joinKey.replace(/.$/, "x"))}`, { headers: { upgrade: "websocket" } })).status).toBe(401);
    const viewer = await open(o, o.viewKey);
    const snap = await viewer.next((f) => f.type === "snapshot");
    expect(snap.state).toMatchObject({ id: o.id, name: "Test Office", grid: { w: 24, d: 16 } });
    expect(snap.state.items.filter((i: any) => i.kind === "desk")).toHaveLength(8);

    const a = await join(o, "Wavey");
    expect((await viewer.next((f) => f.type === "agent" && f.agent.id === a.agent.id)).agent.deskId).toBeTruthy();
    await call(o, "status", { status: "working", activity: "painting" }, { token: a.agentToken });
    await viewer.next((f) => f.type === "agent" && f.agent.activity === "painting");
    const add = await call(o, "add", { kind: "beanbag", x: 22, z: 11 }, { token: a.agentToken });
    await viewer.next((f) => f.type === "item" && f.item.id === add.body.item.id);
    await call(o, "remove", { id: add.body.item.id }, { token: a.agentToken });
    await viewer.next((f) => f.type === "item-removed" && f.id === add.body.item.id);
    await call(o, "say", { text: "hi viewers" }, { token: a.agentToken });
    await viewer.next((f) => f.type === "chat" && f.msg.text === "hi viewers");

    viewer.ws.send(JSON.stringify({ type: "chat", to: null, text: "sneaky", as: "eve" }));
    expect((await viewer.next((f) => f.type === "error")).error).toMatch(/read-only/);

    const owner = await open(o, o.ownerKey);
    await owner.next((f) => f.type === "snapshot");
    owner.ws.send(JSON.stringify({ type: "chat", to: a.agent.id, text: "nice work", as: "Aleks" }));
    const msg = (await viewer.next((f) => f.type === "chat" && f.msg.text === "nice work")).msg;
    expect(msg).toMatchObject({ from: "human:Aleks", to: a.agent.id });
    const read = await call(o, "chat_read", {}, { token: a.agentToken });
    expect(read.body.messages.map((m: any) => m.text)).toContain("nice work");

    owner.ws.send(JSON.stringify({ type: "op", op: { op: "add", kind: "plant", x: 22, z: 12 }, as: "Aleks" }));
    const item = (await viewer.next((f) => f.type === "item" && f.item.by === "human:Aleks")).item;
    expect(item.kind).toBe("plant");
    owner.ws.send(JSON.stringify({ type: "op", op: { op: "add", kind: "plant", x: 99, z: 1 } }));
    expect((await owner.next((f) => f.type === "error")).error).toMatch(/out of bounds/);

    await call(o, "leave", {}, { token: a.agentToken });
    await viewer.next((f) => f.type === "agent-left" && f.id === a.agent.id);
    viewer.ws.close();
    owner.ws.close();
  });
});

describe("routing", () => {
  it("health, unknown api routes, CORS preflight", async () => {
    expect((await SELF.fetch(`${ORIGIN}/health`)).status).toBe(200);
    expect((await SELF.fetch(`${ORIGIN}/api/nope`)).status).toBe(404);
    const pre = await SELF.fetch(`${ORIGIN}/mcp`, { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("mcp-session-id");
    expect((await SELF.fetch(`${ORIGIN}/mcp`, { method: "POST", body: "{}" })).status).toBe(401);
    void ADMIN;
  });
});
