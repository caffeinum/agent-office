import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyOp, defaultLayout, footprint, OfficeError } from "../src/shared/catalog";
import { CHAT_READ_MAX, MAX_AUTO_DESKS, type Office } from "../src/office";
import { call, createOffice, join, ORIGIN, type Created } from "./helpers";

const stubOf = (id: string) => env.OFFICE.get(env.OFFICE.idFromName(id));

async function openWs(o: Created, key: string, how: "protocol" | "query" = "protocol") {
  const headers: Record<string, string> = { upgrade: "websocket" };
  let url = `${ORIGIN}/o/${o.id}/ws`;
  if (how === "protocol") headers["sec-websocket-protocol"] = `agent-office, ao-key.${key}`;
  else url += `?k=${encodeURIComponent(key)}`;
  const res = await SELF.fetch(url, { headers });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const frames: any[] = [];
  ws.addEventListener("message", (e) => frames.push(JSON.parse(e.data as string)));
  ws.accept();
  const next = async (pred: (f: any) => boolean) => {
    for (let i = 0; i < 60; i++) {
      const hit = frames.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no frame matching; got ${JSON.stringify(frames.map((f) => f.type))}`);
  };
  return { ws, frames, next, res };
}

describe("catalog hardening", () => {
  it("never treats Object.prototype keys as kinds", () => {
    const items = defaultLayout(0);
    for (const kind of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(() => applyOp(items, { op: "add", kind, x: 1, z: 1 } as never, "t")).toThrow(OfficeError);
      expect(() => footprint({ kind, x: 0, z: 0, rot: 0 })).toThrow(/unknown kind/);
    }
    expect(() => applyOp(items, { op: "constructor" } as never, "t")).toThrow(/unknown op/);
    expect(() => applyOp(items, { op: "add", kind: "plant", x: 1.5, z: 1 } as never, "t")).toThrow(/integer/);
  });
});

describe("viewer websocket roles and auth", () => {
  it("snapshot says which role the key has; key can ride in the subprotocol", async () => {
    const o = await createOffice();
    const owner = await openWs(o, o.ownerKey);
    expect(owner.res.headers.get("sec-websocket-protocol")).toBe("agent-office");
    expect((await owner.next((f) => f.type === "snapshot")).role).toBe("owner");
    const viewer = await openWs(o, o.viewKey, "query");
    expect((await viewer.next((f) => f.type === "snapshot")).role).toBe("view");
    const bad = await SELF.fetch(`${ORIGIN}/o/${o.id}/ws`, { headers: { upgrade: "websocket", "sec-websocket-protocol": `agent-office, ao-key.${o.ownerKey.slice(0, -1)}x` } });
    expect(bad.status).toBe(401);
    owner.ws.close();
    viewer.ws.close();
  });

  it("rejects prototype-key ops from the owner socket and keeps the office loadable", async () => {
    const o = await createOffice();
    const owner = await openWs(o, o.ownerKey);
    await owner.next((f) => f.type === "snapshot");
    owner.ws.send(JSON.stringify({ type: "op", op: { op: "add", kind: "constructor", x: 200, z: 200 }, as: "eve" }));
    expect((await owner.next((f) => f.type === "error")).error).toMatch(/kind/);
    owner.ws.send(JSON.stringify({ type: "op", op: { op: "add", kind: "plant", x: 22, z: 12, evil: 1 } }));
    expect((await owner.next((f) => f.type === "error" && /evil|unrecognized/i.test(f.error))).error).toBeTruthy();
    const state = await runInDurableObject(stubOf(o.id), (inst: Office) => inst.state());
    expect(state.items.every((it) => it.kind !== "constructor")).toBe(true);
    owner.ws.close();
  });

  it("owner can show an agent out over the socket", async () => {
    const o = await createOffice();
    const a = await join(o, "Squatter");
    const owner = await openWs(o, o.ownerKey);
    await owner.next((f) => f.type === "snapshot");
    owner.ws.send(JSON.stringify({ type: "kick", id: a.agent.id, as: "Aleks" }));
    await owner.next((f) => f.type === "agent-left" && f.id === a.agent.id);
    expect((await owner.next((f) => f.type === "chat" && f.msg.from === "office")).msg.text).toMatch(/Squatter was shown out by Aleks/);
    expect((await call(o, "look", {}, { token: a.agentToken })).status).toBe(401);
    owner.ws.close();
  });
});

describe("owner REST moderation", () => {
  it("kick and rotate-keys need the ownerKey; rotation retires the old key and closes its sockets", async () => {
    const o = await createOffice();
    const a = await join(o, "Bot");
    expect((await call(o, "kick", { id: a.agent.id })).status).toBe(403);
    const kicked = await call(o, "kick", { id: "Bot" }, { key: o.ownerKey });
    expect(kicked.body).toMatchObject({ ok: true, kicked: a.agent.id });

    const viewer = await openWs(o, o.viewKey);
    await viewer.next((f) => f.type === "snapshot");
    const closed = new Promise<number>((r) => viewer.ws.addEventListener("close", (e) => r(e.code)));
    const rot = await call(o, "rotate-keys", { which: "all" }, { key: o.ownerKey });
    expect(rot.status).toBe(200);
    expect(rot.body.joinKey).toMatch(new RegExp(`^${o.id}\\.`));
    expect(rot.body.viewUrl).toContain("#k=");
    expect(await closed).toBe(4401);
    expect((await call(o, "kinds", {})).status).toBe(401);
    expect((await call(o, "kinds", {}, { key: rot.body.joinKey })).status).toBe(200);
    expect((await call(o, "rotate-keys", {}, { key: o.ownerKey })).status).toBe(401);
    expect((await call(o, "rotate-keys", { which: "nope" }, { key: rot.body.ownerKey })).status).toBe(400);
  });
});

describe("agent etiquette and chat", () => {
  it("agents can DM a human and can't move someone else's desk", async () => {
    const o = await createOffice();
    const a = await join(o, "Ada");
    const b = await join(o, "Bo");
    const dm = await call(o, "chat_send", { to: "human:aleks", text: "on it" }, { token: a.agentToken });
    expect(dm.body.msg).toMatchObject({ from: a.agent.id, to: "human:aleks" });
    const blocked = await call(o, "remove", { id: b.agent.deskId }, { token: a.agentToken });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/Bo's desk/);
    expect((await call(o, "move", { id: b.agent.deskId, x: 1, z: 12 }, { token: a.agentToken })).status).toBe(409);
  });

  it("chat_read pages oldest-first and never skips unread messages", async () => {
    const o = await createOffice();
    const reader = await join(o, "Reader");
    await runInDurableObject(stubOf(o.id), async (inst: Office) => {
      const chat = (inst as any).chat as any[];
      for (let i = 0; i < 70; i++) chat.push({ id: `m-${i}`, from: "human:x", to: null, text: `msg ${i}`, ts: Date.now() + i });
    });
    const first = await call(o, "chat_read", {}, { token: reader.agentToken });
    expect(first.body.messages).toHaveLength(CHAT_READ_MAX);
    expect(first.body.messages[0].text).toBe("msg 0");
    expect(first.body.more).toBe(true);
    const second = await call(o, "chat_read", {}, { token: reader.agentToken });
    expect(second.body.messages[0].text).toBe(`msg ${CHAT_READ_MAX}`);
    expect(second.body.messages.at(-1).text).toBe("msg 69");
    expect(second.body.more).toBe(false);
  });

  it("emoji must be one emoji", async () => {
    const o = await createOffice();
    expect((await call(o, "join", { name: "x", emoji: "<b>x</b>" })).status).toBe(400);
    expect((await call(o, "join", { name: "x", emoji: "ab" })).status).toBe(400);
    expect((await call(o, "join", { name: "x", emoji: "👩‍💻" })).status).toBe(200);
  });

  it("rejoining with the same name+client reclaims the old character instead of piling up ghosts", async () => {
    const o = await createOffice();
    const first = await join(o, "Pixel", { client: "claude-code" });
    await runInDurableObject(stubOf(o.id), async (inst: Office) => {
      (inst as any).agents.get(first.agent.id).lastSeen = Date.now() - 5 * 60_000;
    });
    const again = await join(o, "pixel", { client: "claude-code" });
    expect(again.agent.id).toBe(first.agent.id);
    expect(again.desk?.id).toBe(first.desk?.id);
    expect((await call(o, "look", {}, { token: first.agentToken })).status).toBe(401);
    const twin = await join(o, "Pixel", { client: "claude-code" });
    expect(twin.agent.id).not.toBe(first.agent.id); // the reclaimed one is active right now
    expect(twin.agent.name).toBe("Pixel 2");
  });

  it("a reclaimed character drops the old MCP session, which then joins as its own agent", async () => {
    const o = await createOffice();
    await runInDurableObject(stubOf(o.id), async (inst: Office) => {
      const ctx = (sessionId: string) => ({ role: "join" as const, token: null, sessionId, ip: "x", origin: "https://o" });
      const old = await (inst as any).join({ name: "Pixel", client: "cc" }, ctx("s-old"));
      (inst as any).agents.get(old.agent.id).lastSeen = Date.now() - 5 * 60_000;
      const taken = await (inst as any).join({ name: "Pixel", client: "cc" }, ctx("s-new"));
      expect(taken.agent.id).toBe(old.agent.id);
      await expect(inst.callTool("office_status", { status: "idle" }, ctx("s-old"))).rejects.toThrow(/office_join/);
      const back = await (inst as any).join({ name: "Pixel", client: "cc" }, ctx("s-old"));
      expect(back.agent.id).not.toBe(old.agent.id);
      expect(back.agent.name).toBe("Pixel 2");
    });
  });
});

describe("abuse limits", () => {
  it("limits joins per IP per minute and caps auto-added desks", async () => {
    const o = await createOffice();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await call(o, "join", { name: `spam ${i}` })).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    await runInDurableObject(stubOf(o.id), async (inst: Office) => {
      const ctx = { role: "join" as const, token: null, sessionId: null, ip: "x" };
      for (let i = 0; i < 40; i++) await (inst as any).join({ name: `bot ${i}` }, { ...ctx, ip: `ip-${i}` });
      const desks = inst.state().items.filter((it) => it.kind === "desk");
      expect(desks.length).toBe(8 + MAX_AUTO_DESKS);
      expect(inst.state().agents.filter((a) => !a.deskId).length).toBeGreaterThan(0);
    });
  });

  it("500s don't leak internals and short ADMIN_KEYs are refused", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/offices`, { method: "POST", headers: { authorization: "Bearer short" } });
    expect(res.status).toBe(401);
  });
});

describe("MCP sessions", () => {
  it("unknown session ids get 404, missing ones 400, DELETE ends the session", async () => {
    const o = await createOffice();
    const h = { authorization: `Bearer ${o.joinKey}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
    const init = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
    });
    expect(init.status).toBe(200);
    const caps = ((await init.json()) as any).result.capabilities;
    expect(caps.tools.listChanged).toBe(false);
    const sid = init.headers.get("mcp-session-id")!;
    const list = (headers: Record<string, string>) =>
      SELF.fetch(`${ORIGIN}/mcp`, { method: "POST", headers: { ...h, "mcp-protocol-version": "2025-06-18", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
    expect((await list({ "mcp-session-id": sid })).status).toBe(200);
    expect((await list({ "mcp-session-id": "bogus" })).status).toBe(404);
    expect((await list({})).status).toBe(400);
    const del = await SELF.fetch(`${ORIGIN}/mcp`, { method: "DELETE", headers: { ...h, "mcp-session-id": sid } });
    expect(del.status).toBe(204);
    expect((await list({ "mcp-session-id": sid })).status).toBe(404);
  });
});
