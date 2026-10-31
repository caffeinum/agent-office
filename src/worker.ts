// Edge router: office creation and admin (list, delete), /mcp, the REST mirror and the viewer socket go to the office's Durable
// Object; everything else is the static viewer (Workers assets, SPA fallback for /o/:office).
import { keyFromRequest, OFFICE_ID_RE, officeOfKey } from "./auth";
import { handleAdmin, handleCreateOffice } from "./api";
import { CORS_HEADERS, errorResponse, HttpError, json, withCors } from "./http";
import { bearerOf, handleOAuth, isAccessToken, isOAuthPath, mcpViaOAuth, withChallenge, withoutGrantHeader } from "./oauth";

export { Office } from "./office";
export { Registry } from "./registry";
export { Auth } from "./oauth-store";

function officeStub(env: Env, id: string): DurableObjectStub {
  return env.OFFICE.get(env.OFFICE.idFromName(id));
}

/** /mcp/<joinKey> (for connector forms that drop query strings) becomes /mcp with that key as the bearer, query kept. */
function keyInPath(req: Request, raw: string): { office: string; req: Request } | null {
  let key: string;
  try {
    key = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const office = officeOfKey(key);
  if (!office) return null;
  const url = new URL(req.url);
  url.pathname = "/mcp";
  const headers = new Headers(req.headers);
  headers.set("authorization", `Bearer ${key}`);
  return { office, req: new Request(url, { method: req.method, headers, body: req.body, redirect: req.redirect }) };
}

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS" && (path === "/mcp" || path.startsWith("/mcp/") || path.startsWith("/api/"))) {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (path === "/health") return json(200, { ok: true });
  if (path === "/api/offices" && req.method === "POST") return handleCreateOffice(req, env);
  if (path === "/api/offices" || path.startsWith("/api/offices/")) return withCors(await handleAdmin(req, env, path.slice("/api/offices/".length)));
  const forward = (office: string, r: Request) => officeStub(env, office).fetch(r);
  if (isOAuthPath(path)) return handleOAuth(req, env, forward);
  if (path === "/mcp") {
    const bearer = bearerOf(req);
    if (isAccessToken(bearer)) return withCors(await mcpViaOAuth(req, env, bearer, forward));
    const office = officeOfKey(keyFromRequest(req));
    if (!office) return withCors(withChallenge(errorResponse(401, "MCP needs Authorization: Bearer <joinKey> (or ?key=<joinKey>)"), url.origin));
    const res = await forward(office, withoutGrantHeader(req));
    return withCors(res.status === 401 ? withChallenge(res, url.origin) : res);
  }
  if (path.startsWith("/mcp/")) {
    const keyed = keyInPath(req, path.slice("/mcp/".length).replace(/\/$/, ""));
    if (!keyed) return errorResponse(401, "the key in /mcp/<joinKey> is malformed (expected <officeId>.<secret>)");
    const res = await forward(keyed.office, withoutGrantHeader(keyed.req));
    return withCors(res.status === 401 ? withChallenge(res, url.origin) : res);
  }
  const api = /^\/api\/o\/([^/]+)(?:\/[a-z_-]+)?$/.exec(path);
  if (api) {
    const office = api[1]!;
    if (!OFFICE_ID_RE.test(office)) return errorResponse(404, "no such office");
    const keyOffice = officeOfKey(keyFromRequest(req));
    if (keyOffice !== office) return errorResponse(401, "missing or wrong key for this office (Authorization: Bearer <joinKey>)");
    return withCors(await officeStub(env, office).fetch(req));
  }
  if (path.startsWith("/api/")) return errorResponse(404, `no route ${path}`);
  const asset = /^\/o\/([^/]+)\/assets\/[^/]+$/.exec(path);
  if (asset) {
    // asset ids are content hashes nobody can guess, and <img>/texture loads can't send keys: no key needed
    if (!OFFICE_ID_RE.test(asset[1]!)) return errorResponse(404, "no such office");
    return officeStub(env, asset[1]!).fetch(req);
  }
  const ws = /^\/o\/([^/]+)\/ws$/.exec(path);
  if (ws) {
    const office = ws[1]!;
    if (!OFFICE_ID_RE.test(office) || officeOfKey(keyFromRequest(req)) !== office) {
      return errorResponse(401, "missing or wrong key for this office (subprotocol ao-key.<key>, Authorization: Bearer <key>, or ?k=<key>)");
    }
    return officeStub(env, office).fetch(req);
  }
  const page = await env.ASSETS.fetch(req);
  const out = new Response(page.body, page);
  out.headers.set("referrer-policy", "no-referrer");
  out.headers.set("x-content-type-options", "nosniff");
  return out;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) return errorResponse(e.status, e.message, e.extra);
      console.error("worker: unexpected error", e);
      return errorResponse(500, "internal error");
    }
  },
} satisfies ExportedHandler<Env>;
