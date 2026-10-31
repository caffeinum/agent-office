export const BODY_MAX = 16 * 1024;

export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-agent-token, x-filename, mcp-session-id, mcp-protocol-version, last-event-id",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version, retry-after, www-authenticate",
  "access-control-max-age": "86400",
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS, ...headers },
  });
}

export function errorResponse(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  const headers: Record<string, string> = {};
  if (typeof extra.retryAfter === "number") headers["retry-after"] = String(extra.retryAfter);
  return json(status, { error, ...extra }, headers);
}

export function withCors(res: Response): Response {
  if (res.status === 101) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
  return out;
}

/** Bodies that carry a base64 image (office_upload) or a voxel model (office_define_kind). */
export const BIG_BODY_MAX = 1024 * 1024;

/** Reads a JSON body of at most `max` bytes; empty body → undefined. Throws HttpError 413/400. */
export async function readJson(req: Request, max = BODY_MAX): Promise<unknown> {
  const buf = await readBytes(req, max);
  if (buf.length === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}

/** Reads a raw body of at most `max` bytes (streamed, so a lying content-length can't get past). Throws HttpError 413. */
export async function readBytes(req: Request, max: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > max) throw new HttpError(413, `request body too large: ${declared} bytes, max ${max}`);
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new HttpError(413, `request body too large: over ${max} bytes`);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return buf;
}
