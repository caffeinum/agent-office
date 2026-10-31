// OAuth 2.1 sign-in for the remote MCP server (MCP authorization spec 2025-06-18 … 2026-07-28): this origin is both the
// protected resource (/mcp) and its authorization server. A human approves on /oauth/authorize by pasting a join link;
// the client gets an opaque access token bound to that ONE office. On /mcp the token stands in for the join key.
import { base64url, OFFICE_ID_RE, officeOfKey, randomSecret, sha256hex } from "./auth";
import { CORS_HEADERS, errorResponse, HttpError, readBytes } from "./http";
import { ACCESS_PREFIX, CHALLENGE_RE, constantTimeEqual, officeOfToken, REFRESH_PREFIX } from "./oauth-crypto";
import { consentPage, errorPage } from "./oauth-page";
import { clientsStub, officeAuthStub, SCOPE, type ClientRecord, type TokenResult } from "./oauth-store";

export const PRM_PATH = "/.well-known/oauth-protected-resource";
export const ASM_PATH = "/.well-known/oauth-authorization-server";
/** Set by the worker (never by a client: stripped on the way in) when /mcp was authorized by an OAuth access token. */
export const GRANT_HEADER = "x-ao-oauth-grant";
const CSRF_COOKIE = "__Host-ao_oauth_csrf";
const CONSENT_TTL_S = 15 * 60;
const NAME_MAX = 40;
const MAX_REDIRECT_URIS = 10;
const URI_MAX = 2000;
const CIMD_BYTES_MAX = 8 * 1024;
const CIMD_TTL_DEFAULT_MS = 60 * 60_000;
const CIMD_TTL_RANGE_MS = [60_000, 24 * 60 * 60_000] as const;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const BANNED_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "ws:", "wss:", "ftp:"]);

/** Identity of an OAuth sign-in, as the office sees it in CallCtx. */
export interface OAuthGrant {
  id: string;
  name: string;
  /** The invite it signs in through; the office also resolves it from the join key, so "via <label>" works as for keys. */
  inviteId: string | null;
}

export function isOAuthPath(path: string): boolean {
  return path.startsWith("/oauth/") || path === PRM_PATH || path === `${PRM_PATH}/mcp` || path === ASM_PATH;
}

export function resourceOf(origin: string): string {
  return `${origin}/mcp`;
}

/** The bearer token from the Authorization header only (OAuth tokens never travel in the URL). */
export function bearerOf(req: Request): string | null {
  return /^Bearer\s+(\S+)$/i.exec((req.headers.get("authorization") ?? "").trim())?.[1] ?? null;
}

export function isAccessToken(token: string | null): token is string {
  return officeOfToken(token, ACCESS_PREFIX) !== null;
}

export function grantFromRequest(req: Request): OAuthGrant | null {
  const raw = req.headers.get(GRANT_HEADER);
  if (!raw) return null;
  const parsed = JSON.parse(decodeURIComponent(raw)) as OAuthGrant;
  if (typeof parsed.id !== "string" || typeof parsed.name !== "string" || (parsed.inviteId !== null && typeof parsed.inviteId !== "string")) throw new Error(`malformed ${GRANT_HEADER} header`);
  return parsed;
}

export function withoutGrantHeader(req: Request): Request {
  if (!req.headers.has(GRANT_HEADER)) return req;
  const headers = new Headers(req.headers);
  headers.delete(GRANT_HEADER);
  return new Request(req, { headers });
}

/** Adds the RFC 9728 / RFC 6750 challenge so MCP clients can discover how to sign in. */
export function withChallenge(res: Response, origin: string, error?: { code: string; description: string }): Response {
  const out = new Response(res.body, res);
  let value = `Bearer resource_metadata="${origin}${PRM_PATH}", scope="${SCOPE}"`;
  if (error) value += `, error="${error.code}", error_description="${error.description.replace(/["\\]/g, "")}"`;
  out.headers.set("www-authenticate", value);
  return out;
}

/** /mcp with an OAuth access token: resolve it to its office and forward with the join key it stands for. */
export async function mcpViaOAuth(req: Request, env: Env, token: string, forward: (office: string, req: Request) => Promise<Response>): Promise<Response> {
  const origin = new URL(req.url).origin;
  const office = officeOfToken(token, ACCESS_PREFIX);
  if (!office) throw new Error("mcpViaOAuth: not an access token");
  const store = officeAuthStub(env, office);
  const info = await store.verifyAccess(token);
  if (!info || info.resource !== resourceOf(origin)) {
    return withChallenge(errorResponse(401, "invalid or expired OAuth access token: refresh it or sign in again"), origin, { code: "invalid_token", description: "invalid or expired access token" });
  }
  const headers = new Headers(req.headers);
  headers.set("authorization", `Bearer ${info.joinKey}`);
  headers.set(GRANT_HEADER, encodeURIComponent(JSON.stringify({ id: info.grantId, name: info.name, inviteId: info.inviteId } satisfies OAuthGrant)));
  const res = await forward(office, new Request(req, { headers }));
  if (res.status === 401 || (res.status === 404 && (await res.clone().json().catch(() => null) as { error?: string } | null)?.error === "no such office")) {
    await store.revokeGrant(info.grantId); // the join key behind this sign-in was revoked, or the office is gone
    return withChallenge(errorResponse(401, "the join link behind this sign-in no longer works (revoked, or the office is gone): sign in again"), origin, {
      code: "invalid_token",
      description: "the join link behind this sign-in was revoked",
    });
  }
  return res;
}

// ---------- routing ----------

export async function handleOAuth(req: Request, env: Env, forward: (office: string, req: Request) => Promise<Response>): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (path === PRM_PATH || path === `${PRM_PATH}/mcp`) return metadata(protectedResourceMetadata(url.origin));
  if (path === ASM_PATH) return metadata(authorizationServerMetadata(url.origin));
  if (path === "/oauth/register") return register(req, env);
  if (path === "/oauth/token") return token(req, env);
  if (path === "/oauth/authorize") {
    if (req.method === "GET") return authorizeGet(req, env);
    if (req.method === "POST") return authorizePost(req, env, forward);
    return errorResponse(405, "GET or POST /oauth/authorize");
  }
  return errorResponse(404, `no route ${path}`);
}

export function protectedResourceMetadata(origin: string) {
  return {
    resource: resourceOf(origin),
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "agent-office",
    resource_documentation: `${origin}/#oauth`,
  };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}/#oauth`,
  };
}

function metadata(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600", ...CORS_HEADERS } });
}

function oauthError(status: number, error: string, description: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS_HEADERS, ...headers },
  });
}

async function limited(env: Env, req: Request, what: string): Promise<Response | null> {
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  const { success } = await env.OAUTH_LIMIT.limit({ key: `${what}:${ip}` });
  return success ? null : oauthError(429, "slow_down", `too many ${what} requests from this address; try again in a minute`, { "retry-after": "60" });
}

// ---------- client registration (RFC 7591, deprecated in MCP but what most clients still use) ----------

function isLoopback(u: URL): boolean {
  return u.protocol === "http:" && LOOPBACK.has(u.hostname);
}

/** null when fine, else why the redirect URI is refused. */
function redirectUriProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > URI_MAX) return `redirect URIs must be strings of 1-${URI_MAX} chars`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `redirect URI ${JSON.stringify(raw)} is not an absolute URL`;
  }
  if (u.hash || raw.includes("#")) return `redirect URI ${raw} must not have a fragment`;
  if (BANNED_SCHEMES.has(u.protocol)) return `redirect URI scheme ${u.protocol} is not allowed`;
  if (u.protocol === "http:" && !isLoopback(u)) return `redirect URI ${raw} must use https (plain http only for localhost / 127.0.0.1 / [::1])`;
  if (u.username || u.password) return `redirect URI ${raw} must not carry credentials`;
  return null;
}

/** RFC 8252 §7.3: a loopback redirect may use any port; everything else matches exactly. */
function redirectAllowed(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let r: URL;
  try {
    r = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopback(r)) return false;
  return registered.some((raw) => {
    const g = new URL(raw);
    return isLoopback(g) && g.hostname === r.hostname && g.pathname === r.pathname && g.search === r.search;
  });
}

async function register(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return oauthError(405, "invalid_request", "POST client metadata JSON to /oauth/register");
  const slow = await limited(env, req, "register");
  if (slow) return slow;
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(await readBytes(req, 16 * 1024)));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof HttpError) return oauthError(e.status, "invalid_client_metadata", e.message);
    return oauthError(400, "invalid_client_metadata", "body must be a JSON object of client metadata");
  }
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return oauthError(400, "invalid_redirect_uri", `redirect_uris must be an array of 1-${MAX_REDIRECT_URIS} URIs`);
  }
  for (const u of uris) {
    const problem = redirectUriProblem(u);
    if (problem) return oauthError(400, "invalid_redirect_uri", problem);
  }
  // public clients only: whatever token_endpoint_auth_method was asked for, we answer "none" (RFC 7591 §3.2.1 lets the server
  // replace requested values); clients that still send a secret at /oauth/token are not refused, the secret is just ignored
  const grantTypes = body.grant_types;
  if (grantTypes !== undefined && (!Array.isArray(grantTypes) || !grantTypes.includes("authorization_code"))) {
    return oauthError(400, "invalid_client_metadata", 'grant_types must include "authorization_code"');
  }
  const name = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : "an MCP client";
  const redirectUris = [...new Set(uris as string[])].sort();
  // the same metadata always maps to the same client_id, so clients that re-register on every reconnect don't pile up rows
  const id = `dcr_${(await sha256hex(JSON.stringify({ name, redirectUris }))).slice(0, 32)}`;
  await clientsStub(env).putClient({ id, name, redirectUris, kind: "dcr" }, null);
  return new Response(
    JSON.stringify({
      client_id: id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    }),
    { status: 201, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS_HEADERS } },
  );
}

// ---------- Client ID Metadata Documents ----------

function cimdUrlProblem(clientId: string): string | null {
  let u: URL;
  try {
    u = new URL(clientId);
  } catch {
    return "client_id is not a URL";
  }
  if (u.protocol !== "https:") return "a URL client_id must use https";
  if (u.pathname === "/" || u.pathname === "") return "a URL client_id must have a path";
  if (u.hash || u.username || u.password) return "a URL client_id must not have a fragment or credentials";
  if (LOOPBACK.has(u.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) || u.hostname.startsWith("[") || !u.hostname.includes(".")) {
    return "a URL client_id must name a public host";
  }
  return null;
}

function cimdTtl(res: Response): number {
  const m = /max-age=(\d+)/i.exec(res.headers.get("cache-control") ?? "");
  const ms = m ? Number(m[1]) * 1000 : CIMD_TTL_DEFAULT_MS;
  return Math.min(Math.max(ms, CIMD_TTL_RANGE_MS[0]), CIMD_TTL_RANGE_MS[1]);
}

async function fetchCimd(clientId: string): Promise<{ client: ClientRecord; ttl: number } | string> {
  const problem = cimdUrlProblem(clientId);
  if (problem) return problem;
  let res: Response;
  try {
    res = await fetch(clientId, { redirect: "manual", headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
  } catch (e) {
    return `could not fetch the client metadata document at ${clientId}: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (res.status !== 200) return `the client metadata document at ${clientId} answered HTTP ${res.status} (redirects are not followed)`;
  const text = await res.text();
  if (text.length > CIMD_BYTES_MAX) return `the client metadata document at ${clientId} is over ${CIMD_BYTES_MAX} bytes`;
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return `the client metadata document at ${clientId} is not JSON`;
  }
  if (doc.client_id !== clientId) return "the client metadata document's client_id does not match its URL";
  if (typeof doc.client_name !== "string" || !doc.client_name.trim()) return "the client metadata document has no client_name";
  if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0) return "the client metadata document has no redirect_uris";
  for (const u of doc.redirect_uris) {
    const p = redirectUriProblem(u);
    if (p) return `client metadata document: ${p}`;
  }
  if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== "none") {
    return `token_endpoint_auth_method ${String(doc.token_endpoint_auth_method)} is not supported here (public clients only: "none")`;
  }
  return { client: { id: clientId, name: doc.client_name.trim().slice(0, 80), redirectUris: doc.redirect_uris as string[], kind: "cimd" }, ttl: cimdTtl(res) };
}

async function resolveClient(env: Env, clientId: string): Promise<ClientRecord | string> {
  const store = clientsStub(env);
  const known = await store.getClient(clientId);
  if (known) return known;
  if (!clientId.startsWith("https://")) return `unknown client_id ${JSON.stringify(clientId.slice(0, 80))}: register at /oauth/register first`;
  const fetched = await fetchCimd(clientId);
  if (typeof fetched === "string") return fetched;
  await store.putClient(fetched.client, fetched.ttl);
  return fetched.client;
}

// ---------- authorization endpoint ----------

interface AuthzRequest {
  client: ClientRecord;
  redirectUri: string;
  state: string | null;
  challenge: string;
  resource: string;
  /** The request's parameters as the consent form echoes them back. */
  echo: Record<string, string>;
}

type Parsed = { ok: AuthzRequest } | { fatal: string } | { redirect: Response };

/** RFC 8707 resource: this server's /mcp (any query, e.g. ?mode=design, maps to the same resource), or the bare origin. */
export function canonicalResource(raw: string | null, origin: string): string | null {
  if (raw === null || raw === "") return resourceOf(origin);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.origin !== origin || u.hash) return null;
  return u.pathname === "/mcp" || u.pathname === "/" || u.pathname === "/mcp/" ? resourceOf(origin) : null;
}

function errorRedirect(redirectUri: string, origin: string, state: string | null, error: string, description: string): Response {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  u.searchParams.set("error_description", description);
  if (state !== null) u.searchParams.set("state", state);
  u.searchParams.set("iss", origin);
  return new Response(null, { status: 302, headers: { location: u.toString(), "cache-control": "no-store" } });
}

async function parseAuthz(p: URLSearchParams, env: Env, origin: string): Promise<Parsed> {
  const clientId = p.get("client_id");
  if (!clientId) return { fatal: "the app sent no client_id" };
  const client = await resolveClient(env, clientId);
  if (typeof client === "string") return { fatal: client };
  const requested = p.get("redirect_uri");
  const redirectUri = requested ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : null);
  if (!redirectUri) return { fatal: "the app sent no redirect_uri" };
  if (!redirectAllowed(client.redirectUris, redirectUri)) return { fatal: `redirect_uri ${redirectUri} is not registered for ${client.name}` };
  const state = p.get("state");
  const fail = (error: string, description: string): Parsed => ({ redirect: errorRedirect(redirectUri, origin, state, error, description) });
  if (p.get("response_type") !== "code") return fail("unsupported_response_type", 'response_type must be "code"');
  const challenge = p.get("code_challenge");
  if (!challenge || !CHALLENGE_RE.test(challenge)) return fail("invalid_request", "PKCE is required: send a code_challenge (43 base64url chars)");
  if (p.get("code_challenge_method") !== "S256") return fail("invalid_request", 'code_challenge_method must be "S256"');
  const resource = canonicalResource(p.get("resource"), origin);
  if (!resource) return fail("invalid_target", `resource must be ${resourceOf(origin)}`);
  const echo: Record<string, string> = { response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", resource };
  if (state !== null) echo.state = state;
  const scope = p.get("scope");
  if (scope !== null) echo.scope = scope;
  return { ok: { client, redirectUri, state, challenge, resource, echo } };
}

function htmlResponse(status: number, html: string, nonce: string | null, extra: Record<string, string> = {}): Response {
  const script = nonce ? `'nonce-${nonce}'` : "'none'";
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src ${script}; frame-ancestors 'none'; base-uri 'none'`,
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
      ...extra,
    },
  });
}

function cookieOf(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function renderConsent(status: number, a: AuthzRequest, csrf: string, extra: { key?: string; name?: string; error?: string } = {}, setCookie = false): Response {
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const html = consentPage({ clientName: a.client.name, clientId: a.client.id, redirectHost: new URL(a.redirectUri).host || a.redirectUri, params: a.echo, csrf, nonce, ...extra });
  const headers: Record<string, string> = setCookie ? { "set-cookie": `${CSRF_COOKIE}=${csrf}; Max-Age=${CONSENT_TTL_S}; Path=/; Secure; HttpOnly; SameSite=Strict` } : {};
  return htmlResponse(status, html, nonce, headers);
}

async function authorizeGet(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const parsed = await parseAuthz(url.searchParams, env, url.origin);
  if ("fatal" in parsed) return htmlResponse(400, errorPage(parsed.fatal), null);
  if ("redirect" in parsed) return parsed.redirect;
  return renderConsent(200, parsed.ok, randomSecret(), {}, true);
}

/** A pasted join link (".../o/<id>#k=<key>"), an MCP url with ?key=, or a bare key → the key. */
export function keyFromPaste(raw: string): string {
  const s = raw.trim();
  const m = /[#?&]k(?:ey)?=([^&#\s]+)/.exec(s);
  if (!m) return s;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

/** Checks a pasted key against its office: returns the join key to sign in with, or why it can't be used. */
async function joinKeyFor(key: string, origin: string, ip: string, forward: (office: string, req: Request) => Promise<Response>): Promise<{ office: string; joinKey: string; inviteId: string | null } | string> {
  const office = officeOfKey(key);
  if (!office || !OFFICE_ID_RE.test(office)) return "that doesn't look like a join link or join key (it should look like https://…/o/<office>#k=<key>)";
  const res = await forward(office, new Request(`${origin}/api/o/${office}/connect`, { headers: { authorization: `Bearer ${key}`, "cf-connecting-ip": ip } }));
  if (res.status === 404) return "no such office (it may have been deleted)";
  if (res.status === 401) return "that key doesn't open this office (it may have been revoked or rotated)";
  if (res.status === 403) return "that's a watch-only link: paste a join link (or the owner link) instead";
  if (res.status !== 200) return `the office answered HTTP ${res.status}; try again`;
  const info = (await res.json()) as { joinKey?: string | null; invites?: unknown; inviteId?: string | null };
  // the owner link signs agents in through the office's general join key, never as the owner
  if (info.invites !== undefined) {
    if (!info.joinKey) return "this office has no shareable join link on file: create an invite in the room and paste its link";
    return { office, joinKey: info.joinKey, inviteId: info.inviteId ?? null };
  }
  return { office, joinKey: key, inviteId: info.inviteId ?? null };
}

async function authorizePost(req: Request, env: Env, forward: (office: string, req: Request) => Promise<Response>): Promise<Response> {
  const url = new URL(req.url);
  const slow = await limited(env, req, "authorize");
  if (slow) return slow;
  const form = new URLSearchParams(new TextDecoder().decode(await readBytes(req, 16 * 1024)));
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== "null" && origin !== url.origin) return htmlResponse(403, errorPage("this form was submitted from another site"), null);
  const cookie = cookieOf(req, CSRF_COOKIE);
  const csrf = form.get("csrf") ?? "";
  if (!cookie || !csrf || !constantTimeEqual(cookie, csrf)) {
    return htmlResponse(403, errorPage("this sign-in form expired or was opened in another browser; start again from the app"), null);
  }
  const parsed = await parseAuthz(form, env, url.origin);
  if ("fatal" in parsed) return htmlResponse(400, errorPage(parsed.fatal), null);
  if ("redirect" in parsed) return parsed.redirect;
  const a = parsed.ok;
  if (form.get("action") !== "approve") return errorRedirect(a.redirectUri, url.origin, a.state, "access_denied", "the human cancelled the sign-in");
  const pasted = form.get("key") ?? "";
  const name = (form.get("name") ?? "").trim();
  const again = (error: string) => renderConsent(400, a, csrf, { name, error });
  if (!name || name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) return again(`pick an agent name of 1-${NAME_MAX} characters`);
  const resolved = await joinKeyFor(keyFromPaste(pasted), url.origin, req.headers.get("cf-connecting-ip") ?? "local", forward);
  if (typeof resolved === "string") return again(resolved);
  const code = await officeAuthStub(env, resolved.office).authorize({
    officeId: resolved.office,
    clientId: a.client.id,
    redirectUri: a.redirectUri,
    challenge: a.challenge,
    resource: a.resource,
    name,
    joinKey: resolved.joinKey,
    inviteId: resolved.inviteId,
  });
  const back = new URL(a.redirectUri);
  back.searchParams.set("code", code);
  if (a.state !== null) back.searchParams.set("state", a.state);
  back.searchParams.set("iss", url.origin);
  return new Response(null, {
    status: 302,
    headers: { location: back.toString(), "cache-control": "no-store", "set-cookie": `${CSRF_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict` },
  });
}

// ---------- token endpoint ----------

async function tokenParams(req: Request): Promise<URLSearchParams> {
  const text = new TextDecoder().decode(await readBytes(req, 16 * 1024));
  const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return new URLSearchParams(text);
  const obj = JSON.parse(text) as Record<string, unknown>;
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (typeof v === "string") p.set(k, v);
  return p;
}

async function token(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return oauthError(405, "invalid_request", "POST to /oauth/token");
  const slow = await limited(env, req, "token");
  if (slow) return slow;
  const origin = new URL(req.url).origin;
  let p: URLSearchParams;
  try {
    p = await tokenParams(req);
  } catch (e) {
    return oauthError(400, "invalid_request", e instanceof HttpError ? e.message : "body must be application/x-www-form-urlencoded");
  }
  const rawResource = p.get("resource");
  const resource = rawResource === null ? null : canonicalResource(rawResource, origin);
  if (rawResource !== null && !resource) return oauthError(400, "invalid_target", `resource must be ${resourceOf(origin)}`);
  const grant = p.get("grant_type");
  let result: TokenResult;
  if (grant === "authorization_code") {
    const code = p.get("code");
    const clientId = p.get("client_id");
    const redirectUri = p.get("redirect_uri");
    const verifier = p.get("code_verifier");
    if (!code || !clientId || !redirectUri || !verifier) return oauthError(400, "invalid_request", "authorization_code needs code, client_id, redirect_uri and code_verifier");
    const office = officeOfToken(code, "aoac");
    if (!office) return oauthError(400, "invalid_grant", "unknown authorization code");
    result = await officeAuthStub(env, office).exchangeCode({ code, clientId, redirectUri, verifier, resource });
  } else if (grant === "refresh_token") {
    const refresh = p.get("refresh_token");
    if (!refresh) return oauthError(400, "invalid_request", "refresh_token grant needs refresh_token");
    const office = officeOfToken(refresh, REFRESH_PREFIX);
    if (!office) return oauthError(400, "invalid_grant", "unknown or revoked refresh token");
    result = await officeAuthStub(env, office).refresh({ refreshToken: refresh, clientId: p.get("client_id"), resource });
  } else {
    return oauthError(400, "unsupported_grant_type", 'grant_type must be "authorization_code" or "refresh_token"');
  }
  if (!result.ok) return oauthError(400, result.error, result.description);
  return new Response(JSON.stringify(result.tokens), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", pragma: "no-cache", ...CORS_HEADERS } });
}

