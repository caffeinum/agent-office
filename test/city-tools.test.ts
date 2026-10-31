import { SELF } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { createOffice, ORIGIN } from "./helpers";

const selfFetch = (input: string | URL | Request, init?: RequestInit) => SELF.fetch(input as never, init as never) as unknown as Promise<Response>;

describe("office MCP tool list", () => {
  it("lists the 7 office tools byte-identical to the pre-city snapshot, plus office_city", async () => {
    const o = await createOffice();
    const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { fetch: selfFetch, requestInit: { headers: { authorization: `Bearer ${o.joinKey}` } } });
    const client = new Client({ name: "city-tools-test", version: "1.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close();
    const office = tools.filter((t) => t.name !== "office_city").sort((a, b) => a.name.localeCompare(b.name));
    await expect(JSON.stringify(office, null, 1) + "\n").toMatchFileSnapshot("./__snapshots__/office-tools-v1.json");
    expect(office.length).toBe(7);
  });
});
