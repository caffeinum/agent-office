// A busy agent that works without office calls: an open MCP event stream keeps it in, and its own MCP session brings it back.
import { runDurableObjectAlarm, runInDurableObject, env, SELF } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { REMOVE_MS, type Office } from "../src/office";
import { call, createOffice, ORIGIN } from "./helpers";

const stubOf = (id: string) => env.OFFICE.get(env.OFFICE.idFromName(id));
const selfFetch = (input: string | URL | Request, init?: RequestInit) => SELF.fetch(input as never, init as never) as unknown as Promise<Response>;
const text = (r: any): string => (r.content as { text: string }[])[0]!.text;

async function mcpAgent(joinKey: string, name: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { fetch: selfFetch, requestInit: { headers: { authorization: `Bearer ${joinKey}` } } });
  const client = new Client({ name: "busy-test", version: "1.0.0" });
  await client.connect(transport);
  const joined = JSON.parse(text(await client.callTool({ name: "office_join", arguments: { name } })));
  return { client, transport, joined };
}

const ageAgent = (officeId: string, id: string) =>
  runInDurableObject(stubOf(officeId), async (inst: Office) => {
    (inst as any).agents.get(id).lastSeen = Date.now() - REMOVE_MS - 1000;
  });
const roster = async (o: { id: string; ownerKey: string }) => JSON.stringify((await call(o as never, "look", {}, { key: o.ownerKey })).body);

describe("busy agents", () => {
  it("an open MCP event stream keeps a silent agent in past the 1 hour walk-out", async () => {
    const o = await createOffice();
    const { client, transport, joined } = await mcpAgent(o.joinKey, "deep-worker");
    expect(joined.next).toMatch(/walked out after 1 hour/);
    const res = await SELF.fetch(`${ORIGIN}/mcp`, { headers: { authorization: `Bearer ${o.joinKey}`, "mcp-session-id": transport.sessionId!, accept: "text/event-stream" } });
    expect(res.status).toBe(200);
    await ageAgent(o.id, joined.agent.id);
    await runDurableObjectAlarm(stubOf(o.id));
    expect(await roster(o)).toContain("deep-worker");
    await res.body!.cancel();
    await client.close().catch(() => {});
  });

  it("a walked-out agent's own MCP session brings it back with the same id, without a token", async () => {
    const o = await createOffice();
    const { client, joined } = await mcpAgent(o.joinKey, "nightly-evals");
    await runInDurableObject(stubOf(o.id), async (_i, s: DurableObjectState) => {
      for (const ws of s.getWebSockets("mcp")) ws.close(1000, "test");
    });
    await ageAgent(o.id, joined.agent.id);
    await runDurableObjectAlarm(stubOf(o.id));
    expect(await roster(o)).not.toContain("nightly-evals");
    const back = await client.callTool({ name: "office_status", arguments: { status: "working", activity: "still at it" } });
    expect(back.isError).toBeFalsy();
    expect(await roster(o)).toContain(joined.agent.id);
    await client.close().catch(() => {});
  });
});
