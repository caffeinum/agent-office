// REST: office creation (admin) and the mirror of every MCP tool under /api/o/:office/:tool.
import { newOfficeId, newOfficeKey, safeEqual, sha256hex } from "./auth";
import { BIG_BODY_MAX, errorResponse, json, readBytes, readJson } from "./http";
import { resolveToolName, TOOL_NAMES, ToolError, type ToolName } from "./tools";
import { ASSET_BYTES_MAX } from "./images";
import type { CallCtx, ToolHost } from "./office";

export const ADMIN_KEY_MIN = 24;
const GET_TOOLS = new Set<ToolName>(["office_look", "office_kinds", "office_chat_read", "office_theme_get"]);
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

/** Anyone may create an office (rate-limited per IP); a request that sends an Authorization header must carry the ADMIN_KEY and skips the limit. */
async function authorizeCreate(req: Request, env: Env): Promise<Response | null> {
  const auth = req.headers.get("authorization");
  if (auth === null) {
    const ip = req.headers.get("cf-connecting-ip") ?? "local";
    const { success } = await env.CREATE_LIMIT.limit({ key: `create:${ip}` });
    return success ? null : errorResponse(429, "too many offices created from this address — try again in a minute");
  }
  if (!env.ADMIN_KEY) return errorResponse(503, "admin office creation is disabled: the ADMIN_KEY secret is not set (omit Authorization to create a public office)");
  if (env.ADMIN_KEY.length < ADMIN_KEY_MIN) return errorResponse(503, `admin office creation is disabled: ADMIN_KEY must be at least ${ADMIN_KEY_MIN} chars`);
  const given = /^Bearer\s+(\S+)$/i.exec(auth.trim())?.[1];
  if (!given || !(await safeEqual(given, env.ADMIN_KEY))) return errorResponse(401, "wrong admin key (Authorization: Bearer <ADMIN_KEY>, or omit it to create a public office)");
  return null;
}

export async function handleCreateOffice(req: Request, env: Env): Promise<Response> {
  const denied = await authorizeCreate(req, env);
  if (denied) return denied;
  const body = ((await readJson(req)) ?? {}) as { name?: unknown };
  const name = body.name === undefined ? "Agent Office" : body.name;
  if (typeof name !== "string" || !name.trim() || name.length > 64) return errorResponse(400, "name must be a non-empty string ≤64 chars");
  const id = newOfficeId();
  const ownerKey = newOfficeKey(id);
  const joinKey = newOfficeKey(id);
  const viewKey = newOfficeKey(id);
  const keys = { owner: await sha256hex(ownerKey), join: await sha256hex(joinKey), view: await sha256hex(viewKey) };
  const stub = env.OFFICE.get(env.OFFICE.idFromName(id));
  const res = await stub.fetch("https://office/internal/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, name: name.trim(), keys, joinKey }),
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
