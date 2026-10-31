import { SELF } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { DESIGN_TOOLS, SPLIT_TOOLS, TOOL_NAMES } from "../src/tools";
import { b64, createOffice, fakeImage, ORIGIN, type Created } from "./helpers";

const selfFetch = (input: string | URL | Request, init?: RequestInit) => SELF.fetch(input as never, init as never) as unknown as Promise<Response>;

async function connect(office: Created, opts: { viaQuery?: boolean; key?: string; design?: boolean } = {}) {
  const key = opts.key ?? office.joinKey;
  const url = new URL(`${ORIGIN}/mcp`);
  if (opts.viaQuery) url.searchParams.set("key", key);
  if (opts.design) url.searchParams.set("mode", "design");
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
  it("hides the design tools and prompt by default", async () => {
    const o = await createOffice();
    const { client } = await connect(o);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES.filter((n) => !DESIGN_TOOLS.has(n) && !SPLIT_TOOLS.has(n)).sort());
    expect(tools.length).toBe(7);
    expect(client.getInstructions()).toMatch(/office_join once/);
    expect(client.getInstructions()).toMatch(/\?mode=design/);
    expect(client.getInstructions()).not.toMatch(/office-designer/);
    expect(client.getServerCapabilities()?.prompts).toBeFalsy();
    expect(client.getServerVersion()?.name).toBe("agent-office");
    const hidden = (await client.callTool({ name: "office_theme_set", arguments: { brand: { primary: "#ff0000" } } })) as { isError?: boolean };
    expect(hidden.isError).toBe(true);
    await client.close();
  });

  it("design mode adds the design tools with the designer instructions and prompt", async () => {
    const o = await createOffice();
    const { client } = await connect(o, { design: true });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES.filter((n) => !SPLIT_TOOLS.has(n)).sort());
    expect(client.getInstructions()).toMatch(/office-designer/);
    expect(client.getServerCapabilities()?.prompts).toBeTruthy();
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
    expect((await tool(client, "office_chat", { op: "say", text: "hi all" })).body.msg.from).toBe(me);
    expect((await tool(client, "office_chat", { op: "send", text: "room msg" })).body.msg.to).toBeNull();
    const read = await tool(client, "office_chat", { op: "read", since: 0 });
    expect(read.body.messages.map((m: { text: string }) => m.text)).toEqual(["hi all", "room msg"]);
    const look = await tool(client, "office_look");
    expect(look.body.you.id).toBe(me);
    const add = await tool(client, "office_edit", { op: "add", kind: "sign", x: 22, z: 12, text: "mcp was here" });
    expect(add.isError).toBe(false);
    const id = add.body.item.id;
    expect((await tool(client, "office_edit", { op: "move", id, x: 21, z: 12 })).body.item.x).toBe(21);
    expect((await tool(client, "office_edit", { op: "rotate", id, rot: 180 })).body.item.rot).toBe(180);
    expect((await tool(client, "office_edit", { op: "text", id, text: "edited" })).body.item.text).toBe("edited");
    expect((await tool(client, "office_edit", { op: "remove", id })).body.removed).toBe(id);

    const bad = await tool(client, "office_edit", { op: "add", kind: "plant", x: 200, z: 1 });
    expect(bad.isError).toBe(true);
    expect(bad.body.error).toMatch(/out of bounds/);
    const stray = await tool(client, "office_edit", { op: "move", id, kind: "plant", x: 1, z: 1 });
    expect(stray.body.error).toMatch(/office_edit op "move" takes id, x, z — not kind/);
    const badArgs = await tool(client, "office_edit", { op: "move", x: 1, z: 1 });
    expect(badArgs.body.error).toMatch(/^office_edit op "move": bad arguments/);
    expect(((await client.callTool({ name: "office_add", arguments: { kind: "plant", x: 1, z: 1 } })) as { isError?: boolean }).isError).toBe(true);

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

  it("office-designer prompt: prompts/list + prompts/get", async () => {
    const o = await createOffice();
    const { client } = await connect(o, { design: true });
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(["office-designer"]);
    expect(prompts[0]!.arguments?.map((a) => a.name).sort()).toEqual(["company", "request"]);
    const got = await client.getPrompt({ name: "office-designer", arguments: { company: "Acme", request: "a lounge and an arcade corner" } });
    const text = (got.messages[0]!.content as { text: string }).text;
    expect(text).toMatch(/Brand: Acme/);
    expect(text).toMatch(/a lounge and an arcade corner/);
    for (const t of ["office_theme_set", "office_define_kind", "office_upload", "office_set_logo", "office_look"]) expect(text).toContain(t);
    const bare = await client.getPrompt({ name: "office-designer", arguments: {} });
    expect((bare.messages[0]!.content as { text: string }).text).toMatch(/Ask the human/);
    await client.close();
  });

  it("design tools over MCP: theme, custom kind, base64 upload, logo", async () => {
    const o = await createOffice();
    const { client } = await connect(o, { design: true });
    await tool(client, "office_join", { name: "Designer", client: "claude-code" });
    const theme = await tool(client, "office_theme_set", { brand: { primary: "#e94d3d", dark: "#141414", accent: "#d28f88" } });
    expect(theme.isError).toBe(false);
    expect(theme.body.theme.desk.rail).toBe("#e94d3d");
    const kind = await tool(client, "office_define_kind", {
      kind: "huddle-table",
      label: "Huddle table",
      footprint: { w: 2, d: 2 },
      boxes: [{ x: 4, y: 0, z: 4, w: 24, h: 12, d: 24, color: "#d28f88" }],
      seats: [{ x: 16, z: -6, rot: 0 }, { x: 16, z: 38, rot: 180 }],
      stations: [{ x: -6, z: 16, rot: 90, activity: "chat" }],
    });
    expect(kind.isError).toBe(false);
    expect((await tool(client, "office_edit", { op: "add", kind: "huddle-table", x: 2, z: 11 })).isError).toBe(false);
    const up = await tool(client, "office_upload", { filename: "logo.png", contentType: "image/png", base64: b64(fakeImage.png(512, 512, 2000)) });
    expect(up.isError).toBe(false);
    expect((await tool(client, "office_set_logo", { assetId: up.body.assetId })).body.theme.logo).toBe(up.body.assetId);
    const bad = await tool(client, "office_upload", { filename: "x.png", contentType: "image/png", base64: b64(new TextEncoder().encode("GIF89a, not a png at all")) });
    expect(bad.isError).toBe(true);
    expect(bad.body.error).toMatch(/magic bytes/);
    const look = await tool(client, "office_look");
    expect(look.body.design.stationsByActivity.chat).toBeGreaterThanOrEqual(1);
    expect(look.body.seats.some((s: string) => s.startsWith("huddle-table-1:s1"))).toBe(true);
    expect((await tool(client, "office_kinds")).body.custom["huddle-table"]).toMatchObject({ boxes: 1, seats: expect.any(Array) });
    expect((await tool(client, "office_theme_get")).body.assets).toHaveLength(1);
    await client.close();
  });
});
