import { env, runInDurableObject, SELF } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { officeAuthStub } from "../src/oauth-store";
import { base64url } from "../src/auth";
import { call, createOffice, ORIGIN, type Created } from "./helpers";

const selfFetch = (input: string | URL | Request, init?: RequestInit) => SELF.fetch(input as never, init as never) as unknown as Promise<Response>;
const REDIRECT = "http://localhost:3333/callback";
const MCP_INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

async function pkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

async function register(redirectUris = [REDIRECT], name = "Test Client", ip?: string) {
  const res = await SELF.fetch(`${ORIGIN}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(ip ? { "cf-connecting-ip": ip } : {}) },
    body: JSON.stringify({ client_name: name, redirect_uris: redirectUris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

function authorizeUrl(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const u = new URL(`${ORIGIN}/oauth/authorize`);
  const params = { response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "st-123", resource: `${ORIGIN}/mcp`, ...extra };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u;
}

/** Opens the consent page, then submits it like the human would. Returns the final redirect response. */
async function consent(url: URL, fields: { key: string; name?: string; action?: string }) {
  const page = await SELF.fetch(url.toString(), { redirect: "manual" });
  expect(page.status).toBe(200);
  const cookie = page.headers.get("set-cookie")!.split(";")[0]!;
  const html = await page.text();
  const form = new URLSearchParams();
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    form.set(m[1]!, m[2]!.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
  }
  form.set("key", fields.key);
  form.set("name", fields.name ?? "Claude Web");
  form.set("action", fields.action ?? "approve");
  return SELF.fetch(`${ORIGIN}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: ORIGIN },
    body: form.toString(),
  });
}

async function tokenCall(params: Record<string, string>) {
  const res = await SELF.fetch(`${ORIGIN}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() });
  return { status: res.status, body: (await res.json()) as any, headers: res.headers };
}

/** DCR → consent → code → tokens, by hand. */
async function signIn(o: Created, key = o.joinKey) {
  const client = (await register()).body;
  const { verifier, challenge } = await pkce();
  const back = await consent(authorizeUrl(client.client_id, challenge), { key });
  expect(back.status).toBe(302);
  const loc = new URL(back.headers.get("location")!);
  const code = loc.searchParams.get("code")!;
  const t = await tokenCall({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${ORIGIN}/mcp` });
  expect(t.status).toBe(200);
  return { client, tokens: t.body as { access_token: string; refresh_token: string; expires_in: number } };
}

async function mcpInit(token: string) {
  return SELF.fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(MCP_INIT),
  });
}

class MemoryProvider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = "";
  authUrl?: URL;
  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata() {
    return { client_name: "SDK Client", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(i: OAuthClientInformationMixed) {
    this.info = i;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(t: OAuthTokens) {
    this.saved = t;
  }
  redirectToAuthorization(url: URL) {
    this.authUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

afterEach(() => vi.restoreAllMocks());

describe("OAuth metadata", () => {
  it("serves protected resource metadata (root and /mcp-suffixed) and authorization server metadata", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const prm = (await (await SELF.fetch(`${ORIGIN}${path}`)).json()) as any;
      expect(prm).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN], bearer_methods_supported: ["header"] });
    }
    const asm = (await (await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json()) as any;
    expect(asm).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });

  it("401 on /mcp carries the resource_metadata challenge and the old error body", async () => {
    const res = await SELF.fetch(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(MCP_INIT) });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource", scope="office"`);
    expect(((await res.json()) as any).error).toBe("MCP needs Authorization: Bearer <joinKey> (or ?key=<joinKey>)");
    const o = await createOffice();
    const wrong = await SELF.fetch(`${ORIGIN}/mcp`, { method: "POST", headers: { authorization: `Bearer ${o.id}.${"A".repeat(43)}`, "content-type": "application/json" }, body: JSON.stringify(MCP_INIT) });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toContain("resource_metadata=");
  });
});

describe("OAuth registration", () => {
  it("DCR is idempotent for the same metadata and refuses bad redirect URIs", async () => {
    const a = await register();
    const b = await register();
    expect(a.status).toBe(201);
    expect(a.body.client_id).toBe(b.body.client_id);
    expect(a.body.token_endpoint_auth_method).toBe("none");
    expect((await register([REDIRECT], "Other")).body.client_id).not.toBe(a.body.client_id);
    expect((await register(["http://evil.example/cb"])).status).toBe(400);
    expect((await register(["javascript:alert(1)"])).status).toBe(400);
    expect((await register(["https://ok.example/cb#frag"])).status).toBe(400);
    expect((await register(["cursor://anysphere.cursor-mcp/oauth/callback"])).status).toBe(201);
  });

  it("rate-limits registration per address", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) statuses.push((await register([REDIRECT], "Spammer", "203.0.113.77")).status);
    expect(statuses.slice(0, 30).every((s) => s === 201)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("supports Client ID Metadata Documents (https client_id)", async () => {
    const cimd = "https://client.example/oauth/metadata.json";
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === cimd) return Response.json({ client_id: cimd, client_name: "CIMD App", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
      return real(input as never, init);
    });
    const o = await createOffice();
    const { verifier, challenge } = await pkce();
    const page = await SELF.fetch(authorizeUrl(cimd, challenge).toString());
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("CIMD App");
    const back = await consent(authorizeUrl(cimd, challenge), { key: o.joinKey });
    const code = new URL(back.headers.get("location")!).searchParams.get("code")!;
    const t = await tokenCall({ grant_type: "authorization_code", code, client_id: cimd, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(t.status).toBe(200);
    const bad = await SELF.fetch(authorizeUrl(cimd, challenge, { redirect_uri: "https://evil.example/cb" }).toString(), { redirect: "manual" });
    expect(bad.status).toBe(400);
  });
});

describe("OAuth sign-in flow", () => {
  it("MCP SDK client: 401 → discovery → DCR → consent → PKCE token → tools/list", async () => {
    const o = await createOffice();
    const provider = new MemoryProvider();
    const url = new URL(`${ORIGIN}/mcp`);
    const first = new StreamableHTTPClientTransport(url, { fetch: selfFetch, authProvider: provider });
    await expect(new Client({ name: "sdk", version: "1" }).connect(first)).rejects.toThrow(/Unauthorized/i);
    expect(provider.authUrl).toBeTruthy();
    expect(provider.authUrl!.searchParams.get("code_challenge_method")).toBe("S256");
    expect(provider.authUrl!.searchParams.get("resource")).toBe(`${ORIGIN}/mcp`);
    const back = await consent(provider.authUrl!, { key: o.viewUrl.replace(/#k=.*/, `#k=${encodeURIComponent(o.joinKey)}`), name: "Webby" });
    expect(back.status).toBe(302);
    const loc = new URL(back.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
    expect(loc.searchParams.get("iss")).toBe(ORIGIN);
    await first.finishAuth(loc.searchParams.get("code")!);
    expect(provider.saved?.access_token).toMatch(new RegExp(`^aoat_${o.id}_`));

    const client = new Client({ name: "sdk", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(url, { fetch: selfFetch, authProvider: provider }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("office_join");
    const joined = (await client.callTool({ name: "office_join", arguments: { name: "Webby" } })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(joined.isError).toBeFalsy();
    expect(JSON.parse(joined.content[0]!.text).agent.name).toBe("Webby");
    await client.close();
  });

  it("the owner link signs in through the join key; a view link and a junk key are refused on the consent page", async () => {
    const o = await createOffice();
    const owner = await signIn(o, `${ORIGIN}/o/${o.id}#k=${encodeURIComponent(o.ownerKey)}`);
    expect((await mcpInit(owner.tokens.access_token)).status).toBe(200);
    const client = (await register()).body;
    const { challenge } = await pkce();
    for (const key of [o.viewKey, "garbage"]) {
      const res = await consent(authorizeUrl(client.client_id, challenge), { key });
      expect(res.status).toBe(400);
      expect(await res.text()).toMatch(/watch-only|look like a join link/);
    }
  });

  it("refuses a wrong PKCE verifier, and the code is single-use", async () => {
    const o = await createOffice();
    const client = (await register()).body;
    const { verifier, challenge } = await pkce();
    const back = await consent(authorizeUrl(client.client_id, challenge), { key: o.joinKey });
    const code = new URL(back.headers.get("location")!).searchParams.get("code")!;
    const other = await pkce();
    const bad = await tokenCall({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: other.verifier });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_grant");
    const again = await tokenCall({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(again.status).toBe(400);
  });

  it("authorize refuses requests without S256 PKCE (redirecting with an error) and unregistered redirect URIs (no redirect)", async () => {
    const client = (await register()).body;
    const { challenge } = await pkce();
    const plain = await SELF.fetch(authorizeUrl(client.client_id, challenge, { code_challenge_method: "plain" }).toString(), { redirect: "manual" });
    expect(plain.status).toBe(302);
    const loc = new URL(plain.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("invalid_request");
    expect(loc.searchParams.get("state")).toBe("st-123");
    const evil = await SELF.fetch(authorizeUrl(client.client_id, challenge, { redirect_uri: "http://localhost:3333/other" }).toString(), { redirect: "manual" });
    expect(evil.status).toBe(400);
    const loopbackPort = await SELF.fetch(authorizeUrl(client.client_id, challenge, { redirect_uri: "http://localhost:51234/callback" }).toString(), { redirect: "manual" });
    expect(loopbackPort.status).toBe(200);
  });

  it("the consent form needs its CSRF cookie", async () => {
    const o = await createOffice();
    const client = (await register()).body;
    const { challenge } = await pkce();
    const form = new URLSearchParams({ ...Object.fromEntries(authorizeUrl(client.client_id, challenge).searchParams), key: o.joinKey, name: "x", action: "approve", csrf: "forged" });
    const res = await SELF.fetch(`${ORIGIN}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: "__Host-ao_oauth_csrf=other" }, body: form.toString() });
    expect(res.status).toBe(403);
  });

  it("cancel redirects back with access_denied", async () => {
    const o = await createOffice();
    const client = (await register()).body;
    const { challenge } = await pkce();
    const res = await consent(authorizeUrl(client.client_id, challenge), { key: o.joinKey, action: "deny" });
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  });

  it("refresh rotates: the new pair works, replaying the old refresh token revokes the grant", async () => {
    const o = await createOffice();
    const { client, tokens } = await signIn(o);
    const r1 = await tokenCall({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(r1.status).toBe(200);
    expect(r1.headers.get("cache-control")).toBe("no-store");
    expect(r1.body.refresh_token).not.toBe(tokens.refresh_token);
    expect(r1.body.access_token).not.toBe(tokens.access_token);
    expect((await mcpInit(r1.body.access_token)).status).toBe(200);
    const replay = await tokenCall({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
    expect((await mcpInit(r1.body.access_token)).status).toBe(401);
    expect((await tokenCall({ grant_type: "refresh_token", refresh_token: r1.body.refresh_token })).status).toBe(400);
  });

  it("a token for office A never opens office B", async () => {
    const a = await createOffice("A");
    const b = await createOffice("B");
    const { tokens } = await signIn(a);
    const restB = await SELF.fetch(`${ORIGIN}/api/o/${b.id}/look`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(restB.status).toBe(401);
    const forged = tokens.access_token.replace(`aoat_${a.id}_`, `aoat_${b.id}_`);
    const res = await mcpInit(forged);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    const asQuery = await SELF.fetch(`${ORIGIN}/mcp?key=${tokens.access_token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(MCP_INIT) });
    expect(asQuery.status).toBe(401);
  });

  it("expired access tokens get 401 invalid_token; refresh still works", async () => {
    const o = await createOffice();
    const { client, tokens } = await signIn(o);
    expect(tokens.expires_in).toBe(3600);
    await runInDurableObject(officeAuthStub(env, o.id), (_inst, state) => {
      state.storage.sql.exec("UPDATE tokens SET expires_at = 0 WHERE kind = 'aoat'");
    });
    const res = await mcpInit(tokens.access_token);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    const r = await tokenCall({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(r.status).toBe(200);
    expect((await mcpInit(r.body.access_token)).status).toBe(200);
  });

  it("revoking the join key behind a sign-in kills its tokens", async () => {
    const o = await createOffice();
    const { tokens } = await signIn(o);
    const rotated = await SELF.fetch(`${ORIGIN}/api/o/${o.id}/rotate-keys`, { method: "POST", headers: { authorization: `Bearer ${o.ownerKey}`, "content-type": "application/json" }, body: JSON.stringify({ which: "join" }) });
    expect(rotated.status).toBe(200);
    const res = await mcpInit(tokens.access_token);
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error).toMatch(/sign in again/);
    const r = await tokenCall({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    expect(r.status).toBe(400);
  });

  it("a sign-in through an invite shows as via <label>, and revoking that invite cuts the token off", async () => {
    const o = await createOffice();
    const owner = { key: o.ownerKey };
    const bob = (await call(o, "invites", { op: "create", label: "Bob" }, owner)).body.invite as { id: string; key: string };
    const { tokens } = await signIn(o, bob.key);
    const grants = await runInDurableObject(officeAuthStub(env, o.id), (_inst, state) => state.storage.sql.exec<{ invite_id: string; name: string }>("SELECT invite_id, name FROM grants").toArray());
    expect(grants).toEqual([{ invite_id: bob.id, name: "Claude Web" }]);
    const client = new Client({ name: "sdk", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { fetch: selfFetch, requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
    const joined = (await client.callTool({ name: "office_join", arguments: { name: "bobbot" } })) as { content: Array<{ text: string }> };
    expect(JSON.parse(joined.content[0]!.text).agent.via).toBe("Bob");
    await client.close();
    expect((await call(o, "invites", { op: "revoke", id: bob.id }, owner)).status).toBe(200);
    expect((await mcpInit(tokens.access_token)).status).toBe(401);
    expect((await tokenCall({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status).toBe(400);
  });

  it("the grant header can't be spoofed by a join-key client", async () => {
    const o = await createOffice();
    const res = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${o.joinKey}`, "x-ao-oauth-grant": "not json", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(MCP_INIT),
    });
    expect(res.status).toBe(200);
  });
});
