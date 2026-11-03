// Workers Free gives Durable Objects ~13k GB-s of wall-clock a day: an office or city nobody is watching must sleep between
// real deadlines (away, remove, arrival), not on stream keepalives, heartbeats or viewer-only animation steps.
import { runInDurableObject, SELF } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { beforeEach, describe, expect, it } from "vitest";
import { AWAY_MS } from "../src/office";
import { GRAPH_CHECK_MS } from "../src/city/walkers";
import { city, clock, flushOffice, linkedOffice, officeStub, ownerAgent, setupCity, withCity } from "./city-harness";
import { ORIGIN } from "./helpers";

const selfFetch = (input: string | URL | Request, init?: RequestInit) => SELF.fetch(input as never, init as never) as unknown as Promise<Response>;

beforeEach(() => setupCity());

describe("an idle office and city sleep until a real deadline", () => {
  it("an office with an open MCP event stream and a city link wakes no sooner than its agent goes away", async () => {
    const o = await linkedOffice("example-robotics", "Idle Office");
    const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { fetch: selfFetch, requestInit: { headers: { authorization: `Bearer ${o.joinKey}` } } });
    const client = new Client({ name: "idle-test", version: "1.0.0" });
    await client.connect(transport);
    const joinedAt = Date.now();
    await client.callTool({ name: "office_join", arguments: { name: "Sleepy" } });
    const res = await SELF.fetch(`${ORIGIN}/mcp`, { headers: { authorization: `Bearer ${o.joinKey}`, "mcp-session-id": transport.sessionId!, accept: "text/event-stream" } });
    expect(res.status).toBe(200);
    await flushOffice(o); // the debounced city push after the join

    const { alarm, streams } = await runInDurableObject(officeStub(o), async (_i, s: DurableObjectState) => ({
      alarm: await s.storage.getAlarm(),
      streams: s.getWebSockets("mcp").length,
    }));
    expect(streams).toBeGreaterThanOrEqual(1); // streams are hibernatable sockets (the SDK client opens its own too), not responses the office holds open
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeGreaterThanOrEqual(joinedAt + AWAY_MS - 1000);

    await res.body!.cancel();
    await client.close().catch(() => {});
  });

  it("a walking agent nobody watches arms no leg, flush or graph-check alarm", async () => {
    const o = await linkedOffice("example-robotics", "Walkers");
    const far = await ownerAgent(o, "Unwatched Goer");
    const go = await city(o, far.agentToken, { op: "go", to: "Fixture Ferry" });
    expect(go.status).toBe(200);
    expect(go.body.etaSec * 1000).toBeGreaterThan(GRAPH_CHECK_MS);
    const alarm = await withCity((_c, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeGreaterThan(clock.now + GRAPH_CHECK_MS);
  });
});
