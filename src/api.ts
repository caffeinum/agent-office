// REST: office creation, admin office management and the mirror of every MCP tool under /api/o/:office/:tool.
import { DEFAULT_INVITE, newOfficeId, newOfficeKey, OFFICE_ID_RE, safeEqual, sha256hex, type KeyHashes } from "./auth";
import { registryStub } from "./registry";
import { BIG_BODY_MAX, errorResponse, json, readBytes, readJson } from "./http";
import { resolveToolName, TOOL_NAMES, ToolError, type ToolName } from "./tools";
import { ASSET_BYTES_MAX } from "./images";
import type { CallCtx, ToolHost } from "./office";
import { CITY_ID, LINK_ACTIONS, LINK_STATES, type City, type CityResult, type LinkAction, type LinkRow, type LinkState } from "./city/do";

export const ADMIN_KEY_MIN = 24;
const GET_TOOLS = new Set<ToolName>(["office_look", "office_kinds", "office_chat_read", "office_chat_wait", "office_theme_get"]);
const BIG_TOOLS = new Set<ToolName>(["office_upload", "office_define_kind"]);
const SHORT_NAMES = TOOL_NAMES.map((n) => n.slice("office_".length)).join(", ");

export async function handleRest(req: Request, host: ToolHost, ctx: CallCtx, rawTool: string): Promise<Response> {
  const name = resolveToolName(rawTool);
  if (!name) throw new ToolError(404, `unknown tool "${rawTool}" (tools: ${SHORT_NAMES})`);
  let args: Record<string, unknown>;
  if (req.method === "GET") {
    if (!GET_TOOLS.has(name)) throw new ToolError(405, `${name} needs POST with a JSON body`);
    const q = new URL(req.url).searchParams;
    args = {};
    const since = q.get("since");
    if (since !== null) args.since = Number(since);
    const kind = q.get("kind");
    if (kind !== null) args.kind = kind;
    const timeoutSec = q.get("timeoutSec");
    if (timeoutSec !== null) args.timeoutSec = Number(timeoutSec);
  } else if (req.method === "POST") {
    const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (name === "office_upload" && type !== "application/json") {
      // raw image body: POST /api/o/:office/upload?filename=logo.png with content-type image/png
      const bytes = await readBytes(req, ASSET_BYTES_MAX);
      const filename = new URL(req.url).searchParams.get("filename") ?? req.headers.get("x-filename") ?? "image";
      return json(200, await host.upload(bytes, filename, type || undefined, ctx));
    }
    const body = (await readJson(req, BIG_TOOLS.has(name) ? BIG_BODY_MAX : undefined)) ?? {};
    if (typeof body !== "object" || Array.isArray(body) || body === null) throw new ToolError(400, "body must be a JSON object of tool arguments");
    args = body as Record<string, unknown>;
  } else {
    throw new ToolError(405, `method ${req.method} not allowed`);
  }
  return json(200, await host.callTool(name, args, ctx));
}

/** Checks Authorization: Bearer <ADMIN_KEY>; returns the refusal, or null when the caller is the admin. */
export async function refuseNonAdmin(req: Request, env: Env, what: string): Promise<Response | null> {
  if (!env.ADMIN_KEY) return errorResponse(503, `${what} is disabled: the ADMIN_KEY secret is not set`);
  if (env.ADMIN_KEY.length < ADMIN_KEY_MIN) return errorResponse(503, `${what} is disabled: ADMIN_KEY must be at least ${ADMIN_KEY_MIN} chars`);
  const given = /^Bearer\s+(\S+)$/i.exec((req.headers.get("authorization") ?? "").trim())?.[1];
  if (!given || !(await safeEqual(given, env.ADMIN_KEY))) return errorResponse(401, `${what} needs Authorization: Bearer <ADMIN_KEY> (missing or wrong)`);
  return null;
}

/** Anyone may create an office (rate-limited per IP); a request that sends an Authorization header must carry the ADMIN_KEY and skips the limit. */
async function authorizeCreate(req: Request, env: Env): Promise<Response | null> {
  if (req.headers.get("authorization") === null) {
    const ip = req.headers.get("cf-connecting-ip") ?? "local";
    const { success } = await env.CREATE_LIMIT.limit({ key: `create:${ip}` });
    return success ? null : errorResponse(429, "too many offices created from this address — try again in a minute");
  }
  const refused = await refuseNonAdmin(req, env, "admin office creation");
  if (!refused) return null;
  const body = (await refused.json()) as { error: string };
  return errorResponse(refused.status, `${body.error} — or omit Authorization to create a public office`);
}

export async function handleCreateOffice(req: Request, env: Env): Promise<Response> {
  const denied = await authorizeCreate(req, env);
  if (denied) return denied;
  const admin = req.headers.get("authorization") !== null;
  const body = ((await readJson(req)) ?? {}) as { name?: unknown };
  const name = body.name === undefined ? "Agent Office" : body.name;
  if (typeof name !== "string" || !name.trim() || name.length > 64) return errorResponse(400, "name must be a non-empty string ≤64 chars");
  const id = newOfficeId();
  const ownerKey = newOfficeKey(id);
  const joinKey = newOfficeKey(id);
  const viewKey = newOfficeKey(id);
  const keys: KeyHashes = {
    owner: await sha256hex(ownerKey),
    join: [{ id: DEFAULT_INVITE, hash: await sha256hex(joinKey), label: DEFAULT_INVITE, createdAt: Date.now() }],
    view: [await sha256hex(viewKey)],
  };
  const stub = env.OFFICE.get(env.OFFICE.idFromName(id));
  const res = await stub.fetch("https://office/internal/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, name: name.trim(), keys, joinKey, viewKey, admin }),
  });
  if (!res.ok) return errorResponse(500, `office init failed: ${res.status} ${await res.text()}`);
  const origin = new URL(req.url).origin;
  return json(201, {
    id,
    name: name.trim(),
    ownerKey,
    joinKey,
    viewKey,
    mcpUrl: `${origin}/mcp`,
    apiUrl: `${origin}/api/o/${id}`,
    viewUrl: `${origin}/o/${id}#k=${encodeURIComponent(viewKey)}`,
    ownerUrl: `${origin}/o/${id}#k=${encodeURIComponent(ownerKey)}`,
  });
}

const DO_ID_RE = /^[0-9a-f]{64}$/;

/** Admin office management: GET /api/offices (registry), DELETE /api/offices/:id, GET|DELETE /api/offices/do/:doId. */
export async function handleAdmin(req: Request, env: Env, rest: string): Promise<Response> {
  const refused = await refuseNonAdmin(req, env, "office admin");
  if (refused) return refused;
  if (rest === "") {
    if (req.method !== "GET") return errorResponse(405, "GET /api/offices lists offices (POST creates one)");
    return json(200, { offices: await registryStub(env).list() });
  }
  const byDo = /^do\/([^/]*)$/.exec(rest);
  if (byDo) {
    const hex = byDo[1]!;
    if (!DO_ID_RE.test(hex)) return errorResponse(400, "a Durable Object id is 64 lowercase hex chars");
    let doId: DurableObjectId;
    try {
      doId = env.OFFICE.idFromString(hex);
    } catch (e) {
      return errorResponse(400, `not an Office Durable Object id: ${e instanceof Error ? e.message : String(e)}`);
    }
    return adminOffice(req, env.OFFICE.get(doId), `GET|DELETE /api/offices/do/<doId>`);
  }
  const id = /^([^/]+)$/.exec(rest)?.[1];
  if (!id || !OFFICE_ID_RE.test(id)) return errorResponse(404, "no such office");
  const res = await adminOffice(req, env.OFFICE.get(env.OFFICE.idFromName(id)), `GET|DELETE /api/offices/<id>`);
  if (res.status === 404 && req.method === "DELETE") {
    // the office is gone but a stale registry row may remain
    const removedFromRegistry = await registryStub(env).remove(id);
    return errorResponse(404, "no such office", { removedFromRegistry });
  }
  return res;
}

/** City link admin (spec-v2 §7.4): GET /api/city/sf/links?state=pending, POST /api/city/sf/links/:officeId/{approve|reject|revoke}. */
export async function handleCityAdmin(req: Request, env: Env, officeId: string | null, action: string | null): Promise<Response> {
  const url = new URL(req.url);
  if (url.searchParams.has("key")) return errorResponse(400, "the admin key never goes in a query string: send Authorization: Bearer <ADMIN_KEY>");
  const refused = await refuseNonAdmin(req, env, "city link admin");
  if (refused) return refused;
  const city = env.CITY.get(env.CITY.idFromName(CITY_ID));
  if (officeId === null) {
    if (req.method === "POST") return rejectPendingLinks(req, city);
    if (req.method !== "GET") return errorResponse(405, `GET /api/city/${CITY_ID}/links?state=pending lists link requests; POST {action: "reject", siteId} rejects every pending one for a site`);
    const state = url.searchParams.get("state");
    if (state !== null && !(LINK_STATES as readonly string[]).includes(state)) return errorResponse(400, `state must be one of ${LINK_STATES.join(", ")}`);
    return json(200, { links: await city.listLinks(state as LinkState | null) });
  }
  if (req.method !== "POST") return errorResponse(405, `POST /api/city/${CITY_ID}/links/:officeId/{approve|reject|revoke}`);
  if (!OFFICE_ID_RE.test(officeId)) return errorResponse(404, "no such office");
  if (action === null || !Object.hasOwn(LINK_ACTIONS, action)) return errorResponse(400, `action must be one of ${Object.keys(LINK_ACTIONS).join(", ")}`);
  const res = (await city.decideLink(officeId, action as LinkAction)) as CityResult<LinkRow>;
  if (!res.ok) return errorResponse(res.status, res.error, res.extra);
  return json(200, { ok: true, link: res.value });
}

async function rejectPendingLinks(req: Request, city: DurableObjectStub<City>): Promise<Response> {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || body.action !== "reject" || typeof body.siteId !== "string" || !body.siteId) {
    return errorResponse(400, `POST /api/city/${CITY_ID}/links takes {action: "reject", siteId}: it rejects every pending link request for that site`);
  }
  const res = (await city.rejectPending(body.siteId)) as CityResult<LinkRow[]>;
  if (!res.ok) return errorResponse(res.status, res.error, res.extra);
  return json(200, { ok: true, rejected: res.value });
}

async function adminOffice(req: Request, stub: DurableObjectStub, usage: string): Promise<Response> {
  if (req.method === "GET") return stub.fetch("https://office/internal/admin/info");
  if (req.method === "DELETE") return stub.fetch("https://office/internal/admin/delete", { method: "POST" });
  return errorResponse(405, usage);
}
