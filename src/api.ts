// REST: office creation (admin) and the mirror of every MCP tool under /api/o/:office/:tool.
import { newOfficeId, newOfficeKey, safeEqual, sha256hex } from "./auth";
import { errorResponse, json, readJson } from "./http";
import { resolveToolName, ToolError, type ToolName } from "./tools";
import type { CallCtx, ToolHost } from "./office";

export const ADMIN_KEY_MIN = 24;
const GET_TOOLS = new Set<ToolName>(["office_look", "office_kinds", "office_chat_read"]);

export async function handleRest(req: Request, host: ToolHost, ctx: CallCtx, rawTool: string): Promise<Response> {
  const name = resolveToolName(rawTool);
  if (!name) throw new ToolError(404, `unknown tool "${rawTool}" (try kinds, look, join, status, say, chat_send, chat_read, add, remove, move, rotate, text, leave)`);
  let args: Record<string, unknown>;
  if (req.method === "GET") {
    if (!GET_TOOLS.has(name)) throw new ToolError(405, `${name} needs POST with a JSON body`);
    const q = new URL(req.url).searchParams;
    args = {};
    const since = q.get("since");
    if (since !== null) args.since = Number(since);
  } else if (req.method === "POST") {
    const body = (await readJson(req)) ?? {};
    if (typeof body !== "object" || Array.isArray(body) || body === null) throw new ToolError(400, "body must be a JSON object of tool arguments");
    args = body as Record<string, unknown>;
  } else {
    throw new ToolError(405, `method ${req.method} not allowed`);
  }
  return json(200, await host.callTool(name, args, ctx));
}

export async function handleCreateOffice(req: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_KEY) return errorResponse(503, "office creation is disabled: the ADMIN_KEY secret is not set");
  if (env.ADMIN_KEY.length < ADMIN_KEY_MIN) return errorResponse(503, `office creation is disabled: ADMIN_KEY must be at least ${ADMIN_KEY_MIN} chars`);
  const auth = req.headers.get("authorization") ?? "";
  const given = /^Bearer\s+(\S+)$/i.exec(auth.trim())?.[1];
  if (!given || !(await safeEqual(given, env.ADMIN_KEY))) return errorResponse(401, "creating offices needs Authorization: Bearer <ADMIN_KEY>");
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
    body: JSON.stringify({ id, name: name.trim(), keys }),
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
