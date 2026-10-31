import { SELF } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { DESIGN_TOOLS, SPLIT_TOOLS, TOOL_NAMES } from "../src/tools";
import { createOffice, ORIGIN } from "./helpers";

const selfFetch = (input: string | URL | Request, init?: RequestInit) => SELF.fetch(input as never, init as never) as unknown as Promise<Response>;

async function connectPath(key: string, query = "") {
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp/${encodeURIComponent(key)}${query}`), { fetch: selfFetch });
  const client = new Client({ name: "path-key-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function tool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
  return { isError: !!res.isError, body: JSON.parse(res.content[0]!.text) };
}

const initBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } });
const rpcHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };

describe("MCP with the key in the path (/mcp/<joinKey>)", () => {
  it("works like ?key=: session remembers the agent across calls", async () => {
    const o = await createOffice();
    const { client, transport } = await connectPath(o.joinKey);
    expect(transport.sessionId).toBeTruthy();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES.filter((n) => !DESIGN_TOOLS.has(n) && !SPLIT_TOOLS.has(n)).sort());
    const joined = await tool(client, "office_join", { name: "PathAgent" });
    expect(joined.isError).toBe(false);
    const status = await tool(client, "office_status", { status: "working", activity: "no token passed" });
    expect(status.body.agent.id).toBe(joined.body.agent.id);
    expect((await tool(client, "office_look")).body.you.id).toBe(joined.body.agent.id);
    await client.close();
  });

  it("?mode=design still adds the design tools", async () => {
    const o = await createOffice();
    const { client } = await connectPath(o.joinKey, "?mode=design");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES.filter((n) => !SPLIT_TOOLS.has(n)).sort());
    expect(client.getServerCapabilities()?.prompts).toBeTruthy();
    await client.close();
  });

  it("a trailing slash is fine", async () => {
    const o = await createOffice();
    const res = await SELF.fetch(`${ORIGIN}/mcp/${o.joinKey}/`, { method: "POST", headers: rpcHeaders, body: initBody });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("rejects malformed, wrong and view keys without echoing the key", async () => {
    const o = await createOffice();
    const wrong = `${o.id}.${"B".repeat(43)}`;
    for (const [key, status] of [
      ["not-a-key-at-all-secretish", 401],
      [wrong, 401],
      [o.viewKey, 403],
    ] as const) {
      const res = await SELF.fetch(`${ORIGIN}/mcp/${key}`, { method: "POST", headers: rpcHeaders, body: initBody });
      expect(res.status).toBe(status);
      const text = await res.text();
      expect(text).not.toContain(key);
      expect(text).not.toContain(key.split(".").pop()!);
    }
    await expect(connectPath(o.viewKey)).rejects.toThrow();
  });

  it("an unknown session id on the keyed path is refused like on /mcp", async () => {
    const o = await createOffice();
    const res = await SELF.fetch(`${ORIGIN}/mcp/${o.joinKey}`, {
      method: "POST",
      headers: { ...rpcHeaders, "mcp-session-id": "nope" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(o.joinKey);
  });

  it("CORS preflight is answered", async () => {
    const o = await createOffice();
    const res = await SELF.fetch(`${ORIGIN}/mcp/${o.joinKey}`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
