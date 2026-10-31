import { SELF } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { call, createOffice, join, ORIGIN, type Created } from "./helpers";

const selfFetch = (input: string | URL | Request, init?: RequestInit) => SELF.fetch(input as never, init as never) as unknown as Promise<Response>;

async function session(o: Created) {
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { fetch: selfFetch, requestInit: { headers: { authorization: `Bearer ${o.joinKey}` } } });
  const client = new Client({ name: "channel-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, sessionId: transport.sessionId! };
}

/** A raw GET /mcp stream: collects SSE data frames as parsed JSON. */
async function openStream(o: Created, sessionId: string) {
  const res = await SELF.fetch(`${ORIGIN}/mcp`, { headers: { authorization: `Bearer ${o.joinKey}`, "mcp-session-id": sessionId, accept: "text/event-stream" } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const reader = res.body!.getReader();
  const frames: any[] = [];
  let buf = "";
  let done = false;
  const pump = (async () => {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      buf += new TextDecoder().decode(r.value);
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const event = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = event.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
        if (data) frames.push(JSON.parse(data));
      }
    }
    done = true;
  })().catch((e) => {
    if (!String(e).includes("cancelled")) throw e;
  });
  const wait = async (pred: () => boolean, what: string) => {
    for (let i = 0; i < 60; i++) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timed out waiting for ${what}; frames: ${JSON.stringify(frames)}`);
  };
  return { frames, wait, closed: () => done, cancel: () => reader.cancel().catch(() => {}), pump };
}

describe("Claude Code channels over the GET /mcp stream", () => {
  it("declares the claude/channel capability", async () => {
    const o = await createOffice();
    const { client } = await session(o);
    expect(client.getServerCapabilities()?.experimental).toEqual({ "claude/channel": {} });
    await client.close();
  });

  it("GET needs a known session", async () => {
    const o = await createOffice();
    const auth = { authorization: `Bearer ${o.joinKey}` };
    expect((await SELF.fetch(`${ORIGIN}/mcp`, { headers: auth })).status).toBe(400);
    expect((await SELF.fetch(`${ORIGIN}/mcp`, { headers: { ...auth, "mcp-session-id": "nope" } })).status).toBe(404);
  });

  it("pushes DMs, human room messages and @mentions; not plain room chatter; pushed stays unread", async () => {
    const o = await createOffice();
    const { client, sessionId } = await session(o);
    const stream = await openStream(o, sessionId);
    const me = JSON.parse(((await client.callTool({ name: "office_join", arguments: { name: "Mia", client: "claude-code" } })) as any).content[0].text);
    const bo = await join(o, "Bo");
    await call(o, "chat_send", { text: "plain chatter" }, { token: bo.agentToken });
    await call(o, "chat_send", { to: "Mia", text: "a dm for you" }, { token: bo.agentToken });
    await stream.wait(() => stream.frames.length >= 1, "the DM");
    expect(stream.frames[0]).toEqual({
      jsonrpc: "2.0",
      method: "notifications/claude/channel",
      params: { content: "a dm for you", meta: { from: bo.agent.id, from_name: "Bo", kind: "dm", msg_id: expect.stringMatching(/^m-/) } },
    });
    await call(o, "chat_send", { text: "hey @mia can you look" }, { token: bo.agentToken });
    await call(o, "chat_send", { text: "@miami is not you" }, { token: bo.agentToken });
    await stream.wait(() => stream.frames.length >= 2, "the mention");
    expect(stream.frames[1].params.meta.kind).toBe("mention");
    await new Promise((r) => setTimeout(r, 200));
    expect(stream.frames.map((f) => f.params.content)).toEqual(["a dm for you", "hey @mia can you look"]);
    const unread = JSON.parse(((await client.callTool({ name: "office_chat", arguments: { op: "read" } })) as any).content[0].text);
    expect(unread.messages.map((m: { text: string }) => m.text)).toContain("a dm for you");
    expect(me.agent.name).toBe("Mia");
    stream.cancel();
    await client.close();
  });

  it("pushes a human's room message", async () => {
    const o = await createOffice();
    const { client, sessionId } = await session(o);
    await client.callTool({ name: "office_join", arguments: { name: "Mia" } });
    const stream = await openStream(o, sessionId);
    const res = await SELF.fetch(`${ORIGIN}/o/${o.id}/ws`, { headers: { upgrade: "websocket", "sec-websocket-protocol": `agent-office, ao-key.${o.ownerKey}` } });
    const ws = res.webSocket!;
    ws.accept();
    ws.send(JSON.stringify({ type: "chat", text: "hello agents", as: "aleks" }));
    await stream.wait(() => stream.frames.length >= 1, "the human message");
    expect(stream.frames[0].params).toMatchObject({ content: "hello agents", meta: { from: "human:aleks", from_name: "aleks", kind: "room" } });
    ws.close();
    stream.cancel();
    await client.close();
  });

  it("closes the stream when the agent leaves, and on session DELETE", async () => {
    const o = await createOffice();
    const { client, sessionId } = await session(o);
    await client.callTool({ name: "office_join", arguments: { name: "Mia" } });
    const stream = await openStream(o, sessionId);
    await client.callTool({ name: "office_leave", arguments: {} });
    await stream.wait(() => stream.closed(), "the stream to close on leave");
    const again = await openStream(o, sessionId);
    const del = await SELF.fetch(`${ORIGIN}/mcp`, { method: "DELETE", headers: { authorization: `Bearer ${o.joinKey}`, "mcp-session-id": sessionId } });
    expect(del.status).toBe(204);
    await again.wait(() => again.closed(), "the stream to close on DELETE");
    await client.close().catch(() => {});
  });
});
