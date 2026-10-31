// Remote MCP over Streamable HTTP, stateless per request: each POST builds a fresh McpServer bound to the
// office Durable Object. On `initialize` we mint an Mcp-Session-Id ourselves; the office maps it to the agent
// that joins in that session, so later calls need no agentToken.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { randomSecret } from "./auth";
import { BIG_BODY_MAX, errorResponse, readJson } from "./http";
import { DESIGN_MODE_PARAM, DESIGN_MODE_VALUE, DESIGN_TOOLS, SPLIT_TOOLS, DESIGNER_PROMPT, INSTRUCTIONS, INSTRUCTIONS_DESIGN, TOOL_NAMES, TOOLS, ToolError, type ToolName } from "./tools";
import type { CallCtx, ToolHost } from "./office";

const READ_ONLY = new Set<ToolName>(["office_look", "office_kinds", "office_chat_read", "office_theme_get"]);
const DESTRUCTIVE = new Set<ToolName>(["office_edit", "office_remove", "office_leave", "office_delete_kind", "office_delete_asset"]);
export const SERVER_VERSION = "0.1.0";
/** Claude Code channels (research preview): with this capability, notifications/claude/channel on the GET stream land in the session. */
export const CHANNEL_CAPABILITY = "claude/channel";
export const CHANNEL_METHOD = "notifications/claude/channel";

function isInitialize(body: unknown): boolean {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some((m) => m && typeof m === "object" && (m as { method?: unknown }).method === "initialize");
}

export function isDesignMode(req: Request): boolean {
  return new URL(req.url).searchParams.get(DESIGN_MODE_PARAM) === DESIGN_MODE_VALUE;
}

export function buildServer(host: ToolHost, ctx: CallCtx, design: boolean): McpServer {
  const instructions = design ? INSTRUCTIONS + INSTRUCTIONS_DESIGN : INSTRUCTIONS;
  const server = new McpServer({ name: "agent-office", version: SERVER_VERSION }, { instructions });
  for (const name of TOOL_NAMES) {
    if (SPLIT_TOOLS.has(name) || (!design && DESIGN_TOOLS.has(name))) continue;
    const def = TOOLS[name];
    server.registerTool(
      name,
      {
        description: def.description,
        inputSchema: def.shape,
        annotations: { readOnlyHint: READ_ONLY.has(name), destructiveHint: DESTRUCTIVE.has(name), openWorldHint: false },
      },
      async (args: unknown) => {
        try {
          const result = await host.callTool(name, args, ctx);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          const extra = e instanceof ToolError ? e.extra : {};
          return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: message, ...extra }) }] };
        }
      },
    );
  }
  if (design) registerDesignerPrompt(server);
  server.server.registerCapabilities({
    tools: { listChanged: false }, // the GET stream carries chat pushes only, never list changes
    ...(design ? { prompts: { listChanged: false } } : {}),
    experimental: { [CHANNEL_CAPABILITY]: {} },
  });
  return server;
}

function registerDesignerPrompt(server: McpServer) {
  server.registerPrompt(
    DESIGNER_PROMPT.name,
    { title: DESIGNER_PROMPT.title, description: DESIGNER_PROMPT.description, argsSchema: DESIGNER_PROMPT.argsSchema },
    (args) => ({
      description: DESIGNER_PROMPT.description,
      messages: [{ role: "user" as const, content: { type: "text" as const, text: DESIGNER_PROMPT.text(args) } }],
    }),
  );
}

export async function handleMcp(req: Request, host: ToolHost, base: CallCtx): Promise<Response> {
  const sessionHeader = req.headers.get("mcp-session-id");
  if (req.method === "GET") {
    // the standalone server→client stream: chat for this session's agent, as Claude Code channel notifications
    if (!sessionHeader) return errorResponse(400, "GET /mcp opens the event stream of a session: send the Mcp-Session-Id from initialize");
    if (!(await host.hasSession(sessionHeader))) return errorResponse(404, "unknown or expired Mcp-Session-Id: initialize a new session");
    return host.openStream(sessionHeader);
  }
  if (req.method === "DELETE") {
    if (!sessionHeader) return errorResponse(400, "DELETE /mcp needs an Mcp-Session-Id header");
    if (!(await host.hasSession(sessionHeader))) return errorResponse(404, "unknown or expired Mcp-Session-Id");
    await host.endSession(sessionHeader);
    return new Response(null, { status: 204 });
  }
  if (req.method !== "POST") return errorResponse(405, `method ${req.method} not allowed on /mcp`);
  const body = await readJson(req, BIG_BODY_MAX);
  if (body === undefined) return errorResponse(400, "empty JSON-RPC body");
  const init = isInitialize(body);
  if (!init) {
    if (!sessionHeader) return errorResponse(400, "missing Mcp-Session-Id header: send initialize first and echo the session id it returns");
    if (!(await host.hasSession(sessionHeader))) return errorResponse(404, "unknown or expired Mcp-Session-Id: initialize a new session");
  }
  const sessionId = init ? randomSecret() : sessionHeader;
  if (init && sessionId) await host.startSession(sessionId);
  const server = buildServer(host, { ...base, sessionId }, isDesignMode(req));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(req, { parsedBody: body });
    const out = new Response(res.body ? await res.arrayBuffer() : null, res);
    if (init && sessionId) out.headers.set("mcp-session-id", sessionId);
    return out;
  } finally {
    await server.close();
  }
}
