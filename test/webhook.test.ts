import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ON_CALL_REMOVE_MS, REMOVE_MS, type Office } from "../src/office";
import { addressedAs, signBody, validateWebhookUrl, Webhooks, type WakePayload } from "../src/webhook";
import { call, createOffice, join, openWs, ORIGIN } from "./helpers";

const HOOK = "https://hooks.example.com/wake";
const SECRET = "s3cret-for-tests";

function memStorage(): DurableObjectStorage {
  const m = new Map<string, unknown>();
  return {
    list: async ({ prefix }: { prefix: string }) => new Map([...m].filter(([k]) => k.startsWith(prefix))),
    put: async (k: string, v: unknown) => void m.set(k, v),
    delete: async (k: string) => m.delete(k),
  } as unknown as DurableObjectStorage;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | undefined, what: string, ms = 3000): Promise<T> {
  for (let t = 0; t < ms; t += 20) {
    const v = f();
    if (v !== undefined) return v;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Spies on the global fetch (the office DO runs in the test isolate) and records POSTs to webhook hosts. */
function spyWebhooks(respond: (url: string) => Response | Promise<Response> = () => new Response("ok")) {
  const calls: Array<{ url: string; body: string; headers: Headers }> = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith("https://hooks.")) return real(input, init);
    calls.push({ url, body: String(init?.body), headers: new Headers(init?.headers) });
    return respond(url);
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe("webhook URL validation (SSRF)", () => {
  const origin = "https://office.test";
  it.each([
    ["http://hooks.example.com/x", /https/],
    ["https://localhost/x", /public hostname/],
    ["https://foo.localhost/x", /public hostname/],
    ["https://intranet/x", /public hostname/],
    ["https://db.internal/x", /public hostname/],
    ["https://printer.local/x", /public hostname/],
    ["https://127.0.0.1/x", /private/],
    ["https://0x7f000001/x", /private/],
    ["https://10.1.2.3/x", /private/],
    ["https://172.20.0.1/x", /private/],
    ["https://192.168.1.10/x", /private/],
    ["https://169.254.169.254/latest/meta-data", /private/],
    ["https://100.64.0.1/x", /private/],
    ["https://0.0.0.0/x", /private/],
    ["https://[::1]/x", /IPv6/],
    ["https://[fd00::1]/x", /IPv6/],
    ["https://user:pw@hooks.example.com/x", /credentials/],
    ["https://office.test/api/o/abc/chat_send", /this office/],
    ["not a url", /valid URL/],
  ])("rejects %s", (url, err) => {
    expect(() => validateWebhookUrl(url, origin)).toThrow(err);
  });
  it.each(["https://hooks.slack.com/services/T/B/X", "https://example.com/hook", "https://8.8.8.8/x", "https://api.example.com:8443/x"])("accepts %s", (url) => {
    expect(validateWebhookUrl(url, origin).protocol).toBe("https:");
  });
});

describe("addressing", () => {
  const intern = { id: "intern-abc123", name: "Intern" };
  const msg = (from: string, to: string | null, text: string) => ({ id: "m", from, to, text, ts: 1 });
  it("DMs and @-mentions, not room chatter or own messages", () => {
    expect(addressedAs(msg("human:owner", intern.id, "meow"), intern)).toBe("dm");
    expect(addressedAs(msg("ada-1", intern.id, "hi"), intern)).toBe("dm");
    expect(addressedAs(msg("ada-1", null, "hey @intern, look"), intern)).toBe("mention");
    expect(addressedAs(msg("ada-1", null, "@Intern"), intern)).toBe("mention");
    expect(addressedAs(msg("ada-1", null, `ping @${intern.id}`), intern)).toBe("mention");
    expect(addressedAs(msg("ada-1", null, "the intern is late"), intern)).toBeNull();
    expect(addressedAs(msg("ada-1", null, "@internship applications"), intern)).toBeNull();
    expect(addressedAs(msg("ada-1", "bob-1", "@Intern"), intern)).toBeNull();
    expect(addressedAs(msg(intern.id, null, "@Intern talking to myself"), intern)).toBeNull();
    expect(addressedAs(msg("office", null, "@Intern was shown out"), intern)).toBeNull();
    expect(addressedAs(msg("ada-1", null, "@claude 2 can you"), { id: "c2", name: "claude 2" })).toBe("mention");
  });
});

describe("signature", () => {
  it("is the hex HMAC-SHA256 of the body", async () => {
    expect(await signBody("The quick brown fox jumps over the lazy dog", "key")).toBe("sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
  });
});

describe("dispatcher (rate limit, coalescing, failures)", () => {
  const office = { id: "off", name: "Office" };
  const agents = [{ id: "intern-1", name: "Intern" }];
  const dm = (n: number) => ({ id: `m${n}`, from: "human:owner", to: "intern-1", text: `msg ${n}`, ts: n });

  function setup(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
    const waits: Promise<unknown>[] = [];
    const hooks = new Webhooks({ storage: memStorage(), waitUntil: (p) => void waits.push(p), fetch: fetchImpl, windowMs: 80, timeoutMs: 200 });
    return { hooks, settle: async () => { while (waits.length) await waits.shift(); } };
  }

  it("sends the first message at once and coalesces a burst into one digest", async () => {
    const sent: WakePayload[] = [];
    const { hooks, settle } = setup(async (_u, init) => (sent.push(JSON.parse(String(init.body))), new Response("ok")));
    await hooks.set("intern-1", { url: HOOK }, ORIGIN);
    for (const n of [1, 2, 3, 4]) hooks.onChat(dm(n), office, agents, (r) => r);
    await sleep(5);
    expect(sent.map((p) => p.msg_id)).toEqual(["m1"]);
    await settle();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ kind: "digest", count: 3, msg_id: "m4" });
    expect(sent[1]!.text).toMatch(/you have 3 new messages/);
    await sleep(90);
    hooks.onChat(dm(5), office, agents, (r) => r);
    await settle();
    expect(sent.map((p) => p.msg_id)).toEqual(["m1", "m4", "m5"]);
    expect(sent[2]).toMatchObject({ kind: "dm", count: 1 });
  });

  it("a single message inside the window is delivered as itself, not a digest", async () => {
    const sent: WakePayload[] = [];
    const { hooks, settle } = setup(async (_u, init) => (sent.push(JSON.parse(String(init.body))), new Response("ok")));
    await hooks.set("intern-1", { url: HOOK }, ORIGIN);
    hooks.onChat(dm(1), office, agents, (r) => r);
    hooks.onChat(dm(2), office, agents, (r) => r);
    await settle();
    expect(sent.map((p) => [p.msg_id, p.kind])).toEqual([["m1", "dm"], ["m2", "dm"]]);
  });

  it("retries once on failure, then gives up quietly", async () => {
    let n = 0;
    const { hooks, settle } = setup(async () => {
      n++;
      throw new Error("connection refused");
    });
    await hooks.set("intern-1", { url: HOOK }, ORIGIN);
    expect(() => hooks.onChat(dm(1), office, agents, (r) => r)).not.toThrow();
    await settle();
    expect(n).toBe(2);
  });

  it("retries a 5xx once but not a 4xx", async () => {
    const statuses = [503, 200, 404];
    let n = 0;
    const { hooks, settle } = setup(async () => new Response("x", { status: statuses[n++] }));
    await hooks.set("intern-1", { url: HOOK }, ORIGIN);
    hooks.onChat(dm(1), office, agents, (r) => r);
    await settle();
    expect(n).toBe(2);
  });

  it("times out a hanging endpoint", async () => {
    let n = 0;
    const { hooks, settle } = setup((_u, init) => {
      n++;
      return new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    await hooks.set("intern-1", { url: HOOK }, ORIGIN);
    hooks.onChat(dm(1), office, agents, (r) => r);
    await settle();
    expect(n).toBe(2);
  });

  it("drops pending digests when the hook is removed", async () => {
    const sent: unknown[] = [];
    const { hooks, settle } = setup(async (_u, init) => (sent.push(init.body), new Response("ok")));
    await hooks.set("intern-1", { url: HOOK }, ORIGIN);
    hooks.onChat(dm(1), office, agents, (r) => r);
    hooks.onChat(dm(2), office, agents, (r) => r);
    await hooks.drop("intern-1");
    await Promise.race([settle(), sleep(150)]);
    expect(sent).toHaveLength(1);
  });

  it("Slack incoming-webhook URLs get a {text} body", async () => {
    const bodies: unknown[] = [];
    const { hooks, settle } = setup(async (_u, init) => (bodies.push(JSON.parse(String(init.body))), new Response("ok")));
    await hooks.set("intern-1", { url: "https://hooks.slack.com/services/T0/B0/XYZ" }, ORIGIN);
    hooks.onChat({ ...dm(1), text: "meow" }, office, agents, (r) => (r === "human:owner" ? "owner" : r));
    await settle();
    expect(Object.keys(bodies[0] as object)).toEqual(["text"]);
    expect((bodies[0] as { text: string }).text).toMatch(/^@Intern owner messaged you in office "Office": meow/);
    expect((bodies[0] as { text: string }).text).toContain(`${ORIGIN}/api/o/off/chat_send`);
  });
});

describe("webhooks end to end", () => {
  it("a DM fires a signed POST with the documented payload; plain room chatter doesn't", async () => {
    const calls = spyWebhooks();
    const o = await createOffice("Hooks");
    const intern = await join(o, "Intern", { client: "grok", webhook: { url: HOOK, secret: SECRET } });
    expect((intern as unknown as { webhook: unknown }).webhook).toEqual({ host: "hooks.example.com", slack: false, signed: true });
    const ada = await join(o, "Ada");

    expect((await call(o, "chat_send", { text: "lunch anyone?" }, { token: ada.agentToken })).status).toBe(200);
    expect((await call(o, "say", { text: "the intern is quiet" }, { token: ada.agentToken })).status).toBe(200);
    await sleep(150);
    expect(calls).toHaveLength(0);

    const sent = await call(o, "chat_send", { to: "Intern", text: "meow" }, { token: ada.agentToken });
    expect(sent.status).toBe(200);
    const hit = await until(() => calls[0], "webhook POST");
    expect(hit.url).toBe(HOOK);
    const body = JSON.parse(hit.body);
    expect(body).toEqual({
      office: o.id,
      office_name: "Hooks",
      agent: intern.agent.id,
      agent_name: "Intern",
      from: ada.agent.id,
      from_name: "Ada",
      kind: "dm",
      text: "meow",
      msg_id: sent.body.msg.id,
      ts: sent.body.msg.ts,
      count: 1,
      reply: { mcp: "office_chat op send", rest: `${ORIGIN}/api/o/${o.id}/chat_send` },
    });
    expect(hit.headers.get("x-office-signature")).toBe(await signBody(hit.body, SECRET));
    expect(hit.headers.get("content-type")).toBe("application/json");
  });

  it("a room @-mention fires; unsigned hooks send no signature header", async () => {
    const calls = spyWebhooks();
    const o = await createOffice();
    const intern = await join(o, "Intern", { webhook: { url: HOOK } });
    const ada = await join(o, "Ada");
    await call(o, "chat_send", { text: "@intern can you check the build?" }, { token: ada.agentToken });
    const hit = await until(() => calls[0], "webhook POST");
    expect(JSON.parse(hit.body)).toMatchObject({ kind: "mention", agent: intern.agent.id, text: "@intern can you check the build?" });
    expect(hit.headers.get("x-office-signature")).toBeNull();
  });

  it("a human DM from the owner's viewer fires", async () => {
    const calls = spyWebhooks();
    const o = await createOffice();
    await join(o, "Intern", { webhook: { url: HOOK } });
    const { ws } = await openWs(o, o.ownerKey);
    ws.send(JSON.stringify({ type: "chat", to: "Intern", text: "meow", as: "aleks" }));
    const hit = await until(() => calls[0], "webhook POST");
    expect(JSON.parse(hit.body)).toMatchObject({ from: "human:aleks", from_name: "aleks", kind: "dm", text: "meow" });
    ws.close();
  });

  it("a failing endpoint never breaks chat", async () => {
    const calls = spyWebhooks(() => {
      throw new Error("boom");
    });
    const o = await createOffice();
    const intern = await join(o, "Intern", { webhook: { url: HOOK } });
    const ada = await join(o, "Ada");
    const sent = await call(o, "chat_send", { to: "Intern", text: "still delivered" }, { token: ada.agentToken });
    expect(sent.status).toBe(200);
    await until(() => (calls.length >= 2 ? true : undefined), "retry");
    expect(calls).toHaveLength(2);
    const read = await call(o, "chat_read", { since: 0 }, { token: intern.agentToken });
    expect(read.body.messages.map((m: { text: string }) => m.text)).toContain("still delivered");
  });

  it("SSRF targets are refused at join without creating the agent, and the URL isn't echoed", async () => {
    const o = await createOffice();
    for (const url of ["http://hooks.example.com/x", "https://169.254.169.254/latest", "https://localhost:8787/x", `${ORIGIN}/api/o/${o.id}/chat_send`]) {
      const r = await call(o, "join", { name: "Sneaky", webhook: { url } });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/^office_join: webhook\.url/);
      expect(r.body.error).not.toContain(url);
    }
    const look = await call(o, "look", {}, { method: "GET" });
    expect(look.body.agents).toHaveLength(0);
  });

  it("office_status sets and clears the webhook; only the owner sees who has one", async () => {
    const o = await createOffice();
    const intern = await join(o, "Intern");
    const set = await call(o, "status", { status: "idle", webhook: { url: "https://hooks.slack.com/services/T0/B0/SECRETPATH" } }, { token: intern.agentToken });
    expect(set.status).toBe(200);
    expect(set.body.webhook).toEqual({ host: "hooks.slack.com", slack: true, signed: false });

    const asOwner = await call(o, "look", {}, { key: o.ownerKey, method: "GET" });
    expect(asOwner.body.agents[0].webhook).toBe(true);
    expect(JSON.stringify(asOwner.body)).not.toContain("SECRETPATH");
    const asAgent = await call(o, "look", {}, { token: intern.agentToken, method: "GET" });
    expect(asAgent.body.agents[0].webhook).toBeUndefined();
    expect(asAgent.body.you.webhook).toEqual({ host: "hooks.slack.com", slack: true, signed: false });
    expect(JSON.stringify(asAgent.body)).not.toContain("SECRETPATH");

    const bad = await call(o, "status", { status: "idle", webhook: { url: "https://10.0.0.1/x" } }, { token: intern.agentToken });
    expect(bad.status).toBe(400);
    const cleared = await call(o, "status", { status: "idle", webhook: null }, { token: intern.agentToken });
    expect(cleared.body.webhook).toBeNull();
    expect((await call(o, "look", {}, { key: o.ownerKey, method: "GET" })).body.agents[0].webhook).toBe(false);
  });

  it("leaving removes the webhook", async () => {
    const calls = spyWebhooks();
    const o = await createOffice();
    const first = await join(o, "Intern", { client: "grok", webhook: { url: HOOK } });
    await call(o, "leave", {}, { token: first.agentToken });
    const again = await join(o, "Intern", { client: "grok" });
    expect((again as unknown as { webhook: unknown }).webhook).toBeNull();
    const ada = await join(o, "Ada");
    await call(o, "chat_send", { to: "Intern", text: "hello?" }, { token: ada.agentToken });
    await sleep(150);
    expect(calls).toHaveLength(0);
  });

  it("an agent with a webhook outlasts the 1h walk-out and goes after 7 days", async () => {
    const o = await createOffice();
    const oncall = await join(o, "Intern", { webhook: { url: HOOK } });
    const plain = await join(o, "Plain");
    const stub = env.OFFICE.get(env.OFFICE.idFromName(o.id));
    const age = async (id: string, ms: number) =>
      runInDurableObject(stub, async (inst: Office) => {
        const a = (inst as any).agents.get(id);
        a.lastSeen = Date.now() - ms;
        a.status = "away";
      });
    await age(oncall.agent.id, REMOVE_MS + 1000);
    await age(plain.agent.id, REMOVE_MS + 1000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await runInDurableObject(stub, (inst: Office) => inst.state())).agents.map((a) => a.id)).toEqual([oncall.agent.id]);
    await age(oncall.agent.id, ON_CALL_REMOVE_MS + 1000);
    await runInDurableObject(stub, (inst: Office) => inst.alarm());
    expect((await runInDurableObject(stub, (inst: Office) => inst.state())).agents).toHaveLength(0);
  });
});
