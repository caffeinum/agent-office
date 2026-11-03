// GET /mcp event streams live in the Worker, not the Office DO: a streaming response held open by the DO would keep it awake
// (billed wall-clock) for as long as a client stays connected. The Worker opens a hibernatable WebSocket to the office, turns
// each message into an SSE event, and runs the keepalive itself; the DO only wakes when it has chat to push.
import { CORS_HEADERS } from "./http";

/** Comment line sent on idle MCP event streams so proxies keep them open; the same tick pings the office socket. */
export const STREAM_KEEPALIVE_MS = 25_000;
/** The office auto-answers this frame without waking (setWebSocketAutoResponse). */
const PING = '{"type":"ping"}';
const PONG = '{"type":"pong"}';

export function isMcpStreamRequest(req: Request): boolean {
  return req.method === "GET" && new URL(req.url).pathname === "/mcp" && req.headers.get("upgrade")?.toLowerCase() !== "websocket";
}

/** Asks the office for its stream socket; any non-101 answer (unknown session, bad key, too many streams) passes through. */
export async function openMcpStream(req: Request, forward: (r: Request) => Promise<Response>): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.set("upgrade", "websocket");
  const res = await forward(new Request(req.url, { method: "GET", headers }));
  if (res.status !== 101) return res;
  const ws = res.webSocket;
  if (!ws) throw new Error("the office answered GET /mcp with 101 but no WebSocket");
  return sseFromSocket(ws);
}

function sseFromSocket(ws: WebSocket): Response {
  ws.accept();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let open = true;
  const end = () => {
    if (!open) return;
    open = false;
    clearInterval(keepalive);
    try {
      ws.close(1000, "the event stream ended");
    } catch {
      // already closed
    }
    writer.close().catch(() => {
      // the client already went away
    });
  };
  const write = (text: string) => {
    if (open) writer.write(encoder.encode(text)).catch(end); // the client went away
  };
  const keepalive = setInterval(() => {
    write(": keepalive\n\n");
    try {
      ws.send(PING);
    } catch {
      end();
    }
  }, STREAM_KEEPALIVE_MS);
  ws.addEventListener("message", (e) => {
    if (typeof e.data === "string" && e.data !== PONG) write(`event: message\ndata: ${e.data}\n\n`);
  });
  ws.addEventListener("close", end);
  ws.addEventListener("error", end);
  write(": agent-office event stream\n\n");
  return new Response(readable, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", ...CORS_HEADERS },
  });
}
