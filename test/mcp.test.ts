import { SELF } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../src/tools";
import { createOffice, ORIGIN, type Created } from "./helpers";

const selfFetch = (input: string | URL | Request, init?: RequestInit) => SELF.fetch(input as never, init as never) as unknown as Promise<Response>;

async function connect(office: Created, opts: { viaQuery?: boolean; key?: string } = {}) {
  const key = opts.key ?? office.joinKey;
  const url = new URL(`${ORIGIN}/mcp`);
  if (opts.viaQuery) url.searchParams.set("key", key);
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: selfFetch,
    requestInit: opts.viaQuery ? {} : { headers: { authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: "office-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function tool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
  return { isError: !!res.isError, body: JSON.parse(res.content[0]!.text) };
}

describe("MCP over Streamable HTTP", () => {
  it("lists all tools with instructions", async () => {
    const o = await createOffice();
    const { client } = await connect(o);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(client.getInstructions()).toMatch(/office_join once/);
    expect(client.getServerVersion()?.name).toBe("agent-office");
    await client.close();
  });

  it("every tool works, the session remembers the agent", async () => {
    const o = await createOffice();
    const { client, transport } = await connect(o);
    expect(transport.sessionId).toBeTruthy();

    const joined = await tool(client, "office_join", { name: "Mia", client: "claude-code" });
    expect(joined.isError).toBe(false);
    expect(joined.body.agentToken).toBeTruthy();
    expect(joined.body.desk.id).toMatch(/^desk-/);
    const me = joined.body.agent.id;

    expect((await tool(client, "office_kinds")).body.kinds.sofa).toMatchObject({ w: 3, d: 1 });
    expect((await tool(client, "office_status", { status: "working", activity: "writing docs" })).body.agent.activity).toBe("writing docs");
    expect((await tool(client, "office_say", { text: "hi all" })).body.msg.from).toBe(me);
    expect((await tool(client, "office_chat_send", { text: "room msg" })).body.msg.to).toBeNull();
    const read = await tool(client, "office_chat_read", { since: 0 });
    expect(read.body.messages.map((m: { text: string }) => m.text)).toEqual(["hi all", "room msg"]);
    const look = await tool(client, "office_look");
    expect(look.body.you.id).toBe(me);
    const add = await tool(client, "office_add", { kind: "sign", x: 22, z: 12, text: "mcp was here" });
    expect(add.isError).toBe(false);
    const id = add.body.item.id;
    expect((await tool(client, "office_move", { id, x: 21, z: 12 })).body.item.x).toBe(21);
    expect((await tool(client, "office_rotate", { id, rot: 180 })).body.item.rot).toBe(180);
    expect((await tool(client, "office_text", { id, text: "edited" })).body.item.text).toBe("edited");
    expect((await tool(client, "office_remove", { id })).body.removed).toBe(id);

    const bad = await tool(client, "office_add", { kind: "plant", x: 200, z: 1 });
    expect(bad.isError).toBe(true);
    expect(bad.body.error).toMatch(/out of bounds/);

    expect((await tool(client, "office_leave")).body.left).toBe(me);
    const gone = await tool(client, "office_status", { status: "idle" });
    expect(gone.isError).toBe(true);
    expect(gone.body.error).toMatch(/office_join/);
    await client.close();
  });

  it("stateless clients pass agentToken explicitly; ?key= auth works", async () => {
    const o = await createOffice();
    const first = await connect(o, { viaQuery: true });
    const joined = await tool(first.client, "office_join", { name: "Stateless" });
    await first.client.close();
    const second = await connect(o, { viaQuery: true });
    expect((await tool(second.client, "office_status", { status: "idle" })).isError).toBe(true);
    const ok = await tool(second.client, "office_status", { status: "waiting", agentToken: joined.body.agentToken });
    expect(ok.body.agent.status).toBe("waiting");
    await second.client.close();
  });

  it("rejects bad keys and the read-only viewKey", async () => {
    const o = await createOffice();
    await expect(connect(o, { key: o.viewKey })).rejects.toThrow();
    await expect(connect(o, { key: `${o.id}.${"A".repeat(43)}` })).rejects.toThrow();
  });
});
