import { env, runInDurableObject, SELF } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, EVENT_NAME, Events, MIN_TTL_MS, type Subscription } from "../src/events";
import type { Office } from "../src/office";
import { call, createOffice, join, openWs, ORIGIN, type Created } from "./helpers";

const HOOK = "https://hooks.example.com/mcp-events/cb_1";
const keyBytes = (fill: number, n = 32) => new Uint8Array(n).fill(fill);
const whsec = (bytes: Uint8Array) => `whsec_${btoa(String.fromCharCode(...bytes))}`;
const SECRET = whsec(keyBytes(7));
const SECRET2 = whsec(keyBytes(9));
const stubOf = (id: string) => env.OFFICE.get(env.OFFICE.idFromName(id));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(f: () => T | undefined | false, what: string, ms = 3000): Promise<T> {
  for (let t = 0; t < ms; t += 20) {
    const v = f();
    if (v) return v;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Independent Standard Webhooks check: HMAC-SHA256 over `${id}.${ts}.${body}` with the base64-decoded whsec key. */
async function expectSigned(h: Headers, body: string, secret: string) {
  const raw = Uint8Array.from(atob(secret.slice("whsec_".length)), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${h.get("webhook-id")}.${h.get("webhook-timestamp")}.${body}`)));
  const want = `v1,${btoa(String.fromCharCode(...mac))}`;
  expect(h.get("webhook-signature")!.split(" ")).toContain(want);
  expect(Math.abs(Number(h.get("webhook-timestamp")) - Date.now() / 1000)).toBeLessThan(30);
}

interface Hit {
  url: string;
  body: string;
  json: any;
  headers: Headers;
}

/** Callback receiver on https://hooks.*: echoes verification challenges unless told otherwise. */
function receiver(respond: (hit: Hit) => Response | undefined = () => undefined) {
  const hits: Hit[] = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith("https://hooks.")) return real(input, init);
    const body = String(init?.body);
    const hit = { url, body, json: JSON.parse(body), headers: new Headers(init?.headers) };
    hits.push(hit);
    const custom = respond(hit);
    if (custom) return custom;
    if (hit.json.type === "verification") return Response.json({ challenge: hit.json.challenge });
    return new Response(null, { status: 204 });
  });
  return {
    hits,
    verifications: () => hits.filter((h) => h.json.type === "verification"),
    events: () => hits.filter((h) => h.json.type !== "verification"),
  };
}

afterEach(() => vi.restoreAllMocks());

/** A raw MCP session over Streamable HTTP (JSON responses), so the events/* methods can be called as ChatGPT does. */
async function mcp(o: Created) {
  const headers = { authorization: `Bearer ${o.joinKey}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
  let id = 0;
  const post = async (sessionId: string | null, method: string, params?: unknown) => {
    const res = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { ...headers, ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, ...(params !== undefined ? { params } : {}) }),
    });
    return { res, body: (await res.json()) as any };
  };
  const init = await post(null, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "chatgpt-test", version: "1" } });
  const sessionId = init.res.headers.get("mcp-session-id")!;
  const rpc = async (method: string, params?: unknown) => (await post(sessionId, method, params)).body as { result?: any; error?: { code: number; message: string; data?: any } };
  const tool = async (name: string, args: Record<string, unknown>) => {
    const r = await rpc("tools/call", { name, arguments: args });
    return JSON.parse(r.result.content[0].text);
  };
  return { init: init.body, sessionId, rpc, tool };
}

const subParams = (over: Record<string, unknown> = {}) => ({
  name: EVENT_NAME,
  arguments: {},
  delivery: { mode: "webhook", url: HOOK, secret: SECRET },
  cursor: null,
  ...over,
});

async function joined(o: Created, name = "Gpt") {
  const s = await mcp(o);
  const me = await s.tool("office_join", { name, client: "chatgpt" });
  return { ...s, me };
}

async function storedSubs(o: Created): Promise<Subscription[]> {
  return runInDurableObject(stubOf(o.id), async (_i: Office, state) => [...(await state.storage.list<Subscription>({ prefix: "evsub:" })).values()]);
}

describe("capabilities and events/list", () => {
  it("initialize declares events next to tools, and keeps the Claude Code channel capability", async () => {
    const o = await createOffice();
    const { init } = await mcp(o);
    expect(init.result.capabilities).toMatchObject({ tools: {}, events: {}, experimental: { "claude/channel": {} } });
    const client = new Client({ name: "cc", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      fetch: (i, init) => SELF.fetch(i as never, init as never) as unknown as Promise<Response>,
      requestInit: { headers: { authorization: `Bearer ${o.joinKey}` } },
    });
    await client.connect(transport);
    expect(client.getServerCapabilities()?.experimental).toEqual({ "claude/channel": {} });
    await client.close();
  });

  it("events/list describes office.message with input and payload schemas", async () => {
    const o = await createOffice();
    const { rpc } = await mcp(o);
    const { result } = await rpc("events/list", {});
    expect(result.events).toHaveLength(1);
    const ev = result.events[0];
    expect(ev).toMatchObject({ name: "office.message", delivery: ["webhook"], inputSchema: { type: "object", additionalProperties: false } });
    expect(ev.inputSchema.properties.includeRoom.type).toBe("boolean");
    expect(ev.payloadSchema.required).toEqual(expect.arrayContaining(["office", "from", "fromName", "to", "text", "ts", "messageId"]));
    expect(ev.description).toMatch(/untrusted/);
    expect(result.nextCursor).toBeUndefined();
    expect((await rpc("events/list", { cursor: "x" })).error?.code).toBe(-32602);
  });
});

describe("events/subscribe", () => {
  it("needs a joined agent", async () => {
    const o = await createOffice();
    const recv = receiver();
    const { rpc } = await mcp(o);
    const r = await rpc("events/subscribe", subParams());
    expect(r.error?.code).toBe(-32600);
    expect(r.error?.message).toMatch(/office_join/);
    expect(recv.hits).toHaveLength(0);
  });

  it("verifies the callback with a signed challenge, then stores the subscription", async () => {
    const o = await createOffice();
    const recv = receiver();
    const s = await joined(o);
    const r = await s.rpc("events/subscribe", subParams());
    expect(r.error).toBeUndefined();
    expect(r.result).toMatchObject({ id: expect.stringMatching(/^sub_[0-9a-f]{32}$/), cursor: "c1.0", truncated: false });
    const ttl = Date.parse(r.result.refreshBefore) - Date.now();
    expect(ttl).toBeGreaterThan(23 * 3600_000);
    expect(ttl).toBeLessThanOrEqual(24 * 3600_000);
    const [v] = recv.verifications();
    expect(recv.hits).toHaveLength(1);
    expect(v!.url).toBe(HOOK);
    expect(v!.json).toEqual({ type: "verification", challenge: expect.any(String) });
    expect(v!.json.challenge.length).toBeGreaterThanOrEqual(24);
    expect(v!.headers.get("webhook-id")).toMatch(/^msg_verification_/);
    expect(v!.headers.get("x-mcp-subscription-id")).toBe(r.result.id);
    await expectSigned(v!.headers, v!.body, SECRET);
    const subs = await storedSubs(o);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ id: r.result.id, agentId: s.me.agent.id, url: HOOK, args: { includeRoom: false } });
  });

  it("is idempotent: same identity (any key order) refreshes one subscription without a second challenge", async () => {
    const o = await createOffice();
    const recv = receiver();
    const s = await joined(o);
    const a = (await s.rpc("events/subscribe", subParams({ arguments: { includeRoom: true } }))).result;
    const b = (await s.rpc("events/subscribe", { cursor: a.cursor, delivery: { secret: SECRET, url: HOOK, mode: "webhook" }, arguments: { includeRoom: true }, name: EVENT_NAME, ttlMs: 3600_000 })).result;
    expect(b.id).toBe(a.id);
    expect(Date.parse(b.refreshBefore) - Date.now()).toBeLessThanOrEqual(3600_000);
    expect(recv.verifications()).toHaveLength(1);
    expect(await storedSubs(o)).toHaveLength(1);
    const c = (await s.rpc("events/subscribe", subParams({ arguments: {} }))).result;
    expect(c.id).not.toBe(a.id);
    expect(await storedSubs(o)).toHaveLength(2);
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}');
  });

  it("clamps ttlMs to a minimum and never grants an unbounded subscription", async () => {
    const o = await createOffice();
    receiver();
    const s = await joined(o);
    const short = (await s.rpc("events/subscribe", subParams({ ttlMs: 5 }))).result;
    expect(Date.parse(short.refreshBefore) - Date.now()).toBeGreaterThan(MIN_TTL_MS - 5000);
    const forever = (await s.rpc("events/subscribe", subParams({ arguments: { includeRoom: true }, ttlMs: null }))).result;
    expect(forever.refreshBefore).toEqual(expect.any(String));
  });

  it.each([
    ["no prefix", btoa("x".repeat(32))],
    ["too short", whsec(keyBytes(1, 16))],
    ["too long", whsec(keyBytes(1, 65))],
    ["not base64", "whsec_***not-base64***"],
    ["missing", undefined],
  ])("rejects a signing secret that is %s", async (_why, secret) => {
    const o = await createOffice();
    const recv = receiver();
    const s = await joined(o);
    const r = await s.rpc("events/subscribe", subParams({ delivery: { mode: "webhook", url: HOOK, ...(secret ? { secret } : {}) } }));
    expect(r.error?.code).toBe(-32602);
    expect(r.error?.message).toMatch(/secret/);
    expect(recv.hits).toHaveLength(0);
  });

  it("rejects unknown events, arguments and delivery modes", async () => {
    const o = await createOffice();
    receiver();
    const s = await joined(o);
    expect((await s.rpc("events/subscribe", subParams({ name: "nope" }))).error?.code).toBe(-32602);
    expect((await s.rpc("events/subscribe", subParams({ arguments: { channel: "x" } }))).error?.code).toBe(-32602);
    expect((await s.rpc("events/subscribe", subParams({ arguments: { includeRoom: "yes" } }))).error?.code).toBe(-32602);
    expect((await s.rpc("events/subscribe", subParams({ delivery: { mode: "poll", url: HOOK, secret: SECRET } }))).error?.code).toBe(-32602);
  });

  it.each([
    ["http://hooks.example.com/cb"],
    ["https://127.0.0.1/cb"],
    ["https://169.254.169.254/latest"],
    ["https://localhost/cb"],
    ["https://db.internal/cb"],
    ["https://[::1]/cb"],
    ["https://office.test/mcp"],
  ])("refuses callback %s with -32015 before any request", async (url) => {
    const o = await createOffice();
    const recv = receiver();
    const s = await joined(o);
    const r = await s.rpc("events/subscribe", subParams({ delivery: { mode: "webhook", url, secret: SECRET } }));
    expect(r.error?.code).toBe(-32015);
    expect(r.error?.data?.reason).toBe("invalid_url");
    expect(recv.hits).toHaveLength(0);
  });

  it.each([
    ["a wrong echo", () => Response.json({ challenge: "nope" }), "challenge_failed"],
    ["no JSON", () => new Response("ok"), "challenge_failed"],
    ["HTTP 500", () => new Response("down", { status: 500 }), "http_status"],
    ["a redirect", () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com" } }), "redirect"],
  ])("fails verification on %s with -32015 and stores nothing", async (_why, respond, reason) => {
    const o = await createOffice();
    receiver(respond);
    const s = await joined(o);
    const r = await s.rpc("events/subscribe", subParams());
    expect(r.error?.code).toBe(-32015);
    expect(r.error?.data?.reason).toBe(reason);
    expect(await storedSubs(o)).toHaveLength(0);
  });

  it("an agentToken argument subscribes from a session that never joined, with the same identity", async () => {
    const o = await createOffice();
    receiver();
    const s = await joined(o);
    const viaSession = (await s.rpc("events/subscribe", subParams())).result;
    const other = await mcp(o);
    const viaToken = (await other.rpc("events/subscribe", subParams({ arguments: { agentToken: s.me.agentToken } }))).result;
    expect(viaToken.id).toBe(viaSession.id);
    expect((await other.rpc("events/subscribe", subParams({ arguments: { agentToken: "bogus" } }))).error?.code).toBe(-32600);
  });
});

describe("deliveries", () => {
  it("delivers DMs, @mentions and human room messages, signed; not other agents' DMs or agent chatter", async () => {
    const o = await createOffice();
    const recv = receiver();
    const s = await joined(o, "Gpt");
    const sub = (await s.rpc("events/subscribe", subParams())).result;
    const bo = await join(o, "Bo");
    const cy = await join(o, "Cy");
    await call(o, "chat_send", { text: "plain chatter" }, { token: bo.agentToken });
    await call(o, "chat_send", { to: "Cy", text: "dm for cy" }, { token: bo.agentToken });
    await call(o, "chat_send", { to: "Gpt", text: "dm for gpt" }, { token: bo.agentToken });
    await call(o, "chat_send", { text: "hey @gpt look" }, { token: cy.agentToken });
    await call(o, "chat_send", { text: "own message" }, { token: s.me.agentToken });
    const owner = await openWs(o, o.ownerKey);
    await owner.next((f) => f.type === "snapshot");
    owner.ws.send(JSON.stringify({ type: "chat", text: "hello room", as: "aleks" }));
    await until(() => recv.events().length >= 3, "three events");
    await sleep(100);
    const evs = recv.events();
    expect(evs.map((e) => e.json.data.text)).toEqual(["dm for gpt", "hey @gpt look", "hello room"]);
    expect(evs.map((e) => e.json.data.kind)).toEqual(["dm", "mention", "room"]);
    const dm = evs[0]!;
    expect(dm.json).toEqual({
      eventId: expect.stringMatching(/^evt_/),
      name: "office.message",
      timestamp: new Date(dm.json.data.ts).toISOString(),
      data: { office: o.id, from: bo.agent.id, fromName: "Bo", to: s.me.agent.id, kind: "dm", text: "dm for gpt", ts: expect.any(Number), messageId: expect.stringMatching(/^m-/) },
      cursor: `c1.${dm.json.data.messageId}`,
    });
    expect(dm.headers.get("webhook-id")).toBe(dm.json.eventId);
    expect(dm.headers.get("x-mcp-subscription-id")).toBe(sub.id);
    expect(dm.headers.get("content-type")).toBe("application/json");
    await expectSigned(dm.headers, dm.body, SECRET);
    expect(evs[2]!.json.data).toMatchObject({ from: "human:aleks", fromName: "aleks", to: null });
    owner.ws.close();
  });

  it("includeRoom also delivers chatter between other agents", async () => {
    const o = await createOffice();
    const recv = receiver();
    const s = await joined(o);
    await s.rpc("events/subscribe", subParams({ arguments: { includeRoom: true } }));
    const bo = await join(o, "Bo");
    await call(o, "chat_send", { text: "plain chatter" }, { token: bo.agentToken });
    await until(() => recv.events().length >= 1, "the chatter");
    expect(recv.events()[0]!.json.data).toMatchObject({ kind: "room", text: "plain chatter" });
  });

  it("unsubscribe stops delivery and is idempotent", async () => {
    const o = await createOffice();
    const recv = receiver();
    const s = await joined(o);
    await s.rpc("events/subscribe", subParams());
    const bo = await join(o, "Bo");
    const unsub = { name: EVENT_NAME, arguments: {}, delivery: { mode: "webhook", url: HOOK } };
    expect((await s.rpc("events/unsubscribe", unsub)).result).toEqual({});
    expect((await s.rpc("events/unsubscribe", unsub)).result).toEqual({});
    expect(await storedSubs(o)).toHaveLength(0);
    await call(o, "chat_send", { to: "Gpt", text: "anyone?" }, { token: bo.agentToken });
    await sleep(150);
    expect(recv.events()).toHaveLength(0);
  });

  it("a 410 answer drops the subscription", async () => {
    const o = await createOffice();
    const recv = receiver((h) => (h.json.type === "verification" ? undefined : new Response("gone", { status: 410 })));
    const s = await joined(o);
    await s.rpc("events/subscribe", subParams());
    const bo = await join(o, "Bo");
    await call(o, "chat_send", { to: "Gpt", text: "one" }, { token: bo.agentToken });
    await until(() => recv.events().length >= 1, "the first event");
    for (let i = 0; i < 50 && (await storedSubs(o)).length; i++) await sleep(20);
    expect(await storedSubs(o)).toHaveLength(0);
    await call(o, "chat_send", { to: "Gpt", text: "two" }, { token: bo.agentToken });
    await sleep(150);
    expect(recv.events()).toHaveLength(1);
  });

  it("leaving the office drops the agent's subscriptions", async () => {
    const o = await createOffice();
    receiver();
    const s = await joined(o);
    await s.rpc("events/subscribe", subParams());
    expect(await storedSubs(o)).toHaveLength(1);
    await s.tool("office_leave", {});
    expect(await storedSubs(o)).toHaveLength(0);
  });

  it("revoking the invite the agent came through stops delivery, even when it is not kicked", async () => {
    const o = await createOffice();
    const owner = { key: o.ownerKey };
    const recv = receiver();
    const invite = (await call(o, "invites", { op: "create", label: "Bob" }, owner)).body.invite;
    const s = await joined({ ...o, joinKey: invite.key });
    await s.rpc("events/subscribe", subParams());
    await call(o, "invites", { op: "revoke", id: invite.id, kick: false }, owner);
    const bo = await join(o, "Bo");
    await call(o, "chat_send", { to: "Gpt", text: "still there?" }, { token: bo.agentToken });
    await sleep(150);
    expect(recv.events()).toHaveLength(0);
    expect(await storedSubs(o)).toHaveLength(0);
  });

  it("replays messages missed since a cursor when a lapsed subscription comes back", async () => {
    const o = await createOffice();
    const recv = receiver();
    const s = await joined(o);
    const first = (await s.rpc("events/subscribe", subParams())).result;
    const bo = await join(o, "Bo");
    await call(o, "chat_send", { to: "Gpt", text: "seen" }, { token: bo.agentToken });
    await until(() => recv.events().length >= 1, "the first event");
    const saved = recv.events()[0]!.json.cursor;
    await s.rpc("events/unsubscribe", { name: EVENT_NAME, arguments: {}, delivery: { mode: "webhook", url: HOOK } });
    await call(o, "chat_send", { to: "Gpt", text: "missed 1" }, { token: bo.agentToken });
    await call(o, "chat_send", { text: "chatter, not for gpt" }, { token: bo.agentToken });
    await call(o, "chat_send", { to: "Gpt", text: "missed 2" }, { token: bo.agentToken });
    const again = (await s.rpc("events/subscribe", subParams({ cursor: saved }))).result;
    expect(again).toMatchObject({ id: first.id, cursor: saved, truncated: false });
    await until(() => recv.events().length >= 3, "the replay");
    expect(recv.events().map((e) => e.json.data.text)).toEqual(["seen", "missed 1", "missed 2"]);
    expect((await s.rpc("events/subscribe", subParams({ arguments: { includeRoom: true }, cursor: "garbage" }))).error?.code).toBe(-32602);
  });

  it("subscriptions survive a restart: a fresh instance loads them from storage and delivers", async () => {
    const o = await createOffice();
    receiver();
    const s = await joined(o);
    const sub = (await s.rpc("events/subscribe", subParams())).result;
    await runInDurableObject(stubOf(o.id), async (_i: Office, state) => {
      const sent: string[] = [];
      const fresh = new Events({
        storage: state.storage,
        waitUntil: () => {},
        fetch: async (_url, init) => {
          sent.push(String(init.body));
          return new Response(null, { status: 200 });
        },
      });
      await fresh.load();
      expect(fresh.active(s.me.agent.id).map((x) => x.id)).toEqual([sub.id]);
      fresh.onChat({ id: "m-1-x", from: "human:owner", to: s.me.agent.id, text: "after restart", ts: Date.now() }, o.id, () => ({ id: s.me.agent.id, name: "Gpt" }), () => true, (r) => r);
      await until(() => sent.length >= 1, "delivery after reload");
      expect(JSON.parse(sent[0]!).data.text).toBe("after restart");
    });
  });
});

describe("Events delivery policy (unit)", () => {
  const agent = { id: "gpt-1", name: "Gpt" };
  const msg = (id: string, text = "hi") => ({ id, from: "human:owner", to: agent.id, text, ts: Date.now() });

  function memStorage(): DurableObjectStorage {
    const m = new Map<string, unknown>();
    return {
      list: async ({ prefix }: { prefix: string }) => new Map([...m].filter(([k]) => k.startsWith(prefix))),
      put: async (k: string, v: unknown) => void m.set(k, v),
      delete: async (k: string) => m.delete(k),
    } as unknown as DurableObjectStorage;
  }

  async function setup(answer: (n: number, body: any) => Response | Promise<Response>, opts: { now?: () => number } = {}) {
    const waits: Promise<unknown>[] = [];
    const slept: number[] = [];
    const sent: Array<{ body: any; headers: Headers }> = [];
    const events = new Events({
      storage: memStorage(),
      waitUntil: (p) => void waits.push(p),
      retryDelaysMs: [10, 20, 40],
      sleep: async (ms) => void slept.push(ms),
      now: opts.now,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        if (body.type === "verification") return Response.json({ challenge: body.challenge });
        sent.push({ body, headers: new Headers(init.headers) });
        return answer(sent.length, body);
      },
    });
    const ctx = { origin: ORIGIN, officeId: "o1", history: [], historyFull: false, nameOf: (r: string) => r };
    const sub = await events.subscribe(agent, subParams(), ctx);
    const fire = async (m = msg("m-1-a")) => {
      events.onChat(m, "o1", () => agent, () => true, (r) => r);
      await Promise.all(waits);
    };
    return { events, sub, sent, slept, fire, ctx };
  }

  it("retries transient failures with bounded exponential backoff, same eventId, fresh signature each time", async () => {
    const t = { now: Date.now() };
    const { sent, slept, fire } = await setup(() => new Response("busy", { status: 503 }), { now: () => (t.now += 1500) });
    await fire();
    expect(sent).toHaveLength(4);
    expect(slept).toEqual([10, 20, 40]);
    expect(new Set(sent.map((s) => s.body.eventId)).size).toBe(1);
    expect(new Set(sent.map((s) => s.headers.get("webhook-timestamp"))).size).toBe(4);
    expect(new Set(sent.map((s) => s.headers.get("webhook-signature"))).size).toBe(4);
  });

  it("recovers after a 429 and stops retrying on 413 or other 4xx", async () => {
    const a = await setup((n) => new Response(null, { status: n === 1 ? 429 : 200 }));
    await a.fire();
    expect(a.sent).toHaveLength(2);
    const b = await setup(() => new Response(null, { status: 413 }));
    await b.fire();
    expect(b.sent).toHaveLength(1);
    expect(b.events.active(agent.id)).toHaveLength(1);
    const c = await setup(() => new Response(null, { status: 400 }));
    await c.fire();
    expect(c.sent).toHaveLength(1);
  });

  it("a network error is retried", async () => {
    const { sent, fire } = await setup((n) => (n < 3 ? Promise.reject(new Error("connection reset")) : new Response(null, { status: 200 })));
    await fire();
    expect(sent).toHaveLength(3);
  });

  it("410 drops the subscription without retrying", async () => {
    const { events, sent, fire } = await setup(() => new Response(null, { status: 410 }));
    await fire();
    expect(sent).toHaveLength(1);
    expect(events.active(agent.id)).toHaveLength(0);
    await fire(msg("m-2-b"));
    expect(sent).toHaveLength(1);
  });

  it("an expired subscription gets nothing", async () => {
    const t = { now: Date.now() };
    const { events, sent, fire } = await setup(() => new Response(null, { status: 200 }), { now: () => t.now });
    t.now += 25 * 3600_000;
    await fire();
    expect(sent).toHaveLength(0);
    expect(events.active(agent.id)).toHaveLength(0);
  });

  it("a refresh with a new secret signs with both keys during rotation", async () => {
    const { events, sent, fire, ctx } = await setup(() => new Response(null, { status: 200 }));
    await events.subscribe(agent, subParams({ delivery: { mode: "webhook", url: HOOK, secret: SECRET2 } }), ctx);
    await fire();
    const sigs = sent[0]!.headers.get("webhook-signature")!.split(" ");
    expect(sigs).toHaveLength(2);
    const body = JSON.stringify(sent[0]!.body);
    await expectSigned(sent[0]!.headers, body, SECRET2);
    await expectSigned(sent[0]!.headers, body, SECRET);
  });
});
