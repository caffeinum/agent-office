import { env, SELF } from "cloudflare:test";

export const ORIGIN = "https://office.test";
export const ADMIN: string = env.ADMIN_KEY;

export interface Created {
  id: string;
  name: string;
  ownerKey: string;
  joinKey: string;
  viewKey: string;
  mcpUrl: string;
  apiUrl: string;
  viewUrl: string;
}

export async function createOffice(name = "Test Office"): Promise<Created> {
  const res = await SELF.fetch(`${ORIGIN}/api/offices`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (res.status !== 201) throw new Error(`createOffice: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function call(
  office: Created,
  tool: string,
  args: Record<string, unknown> = {},
  opts: { token?: string; key?: string; method?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { authorization: `Bearer ${opts.key ?? office.joinKey}`, "content-type": "application/json" };
  if (opts.token) headers["x-agent-token"] = opts.token;
  const method = opts.method ?? "POST";
  const res = await SELF.fetch(`${ORIGIN}/api/o/${office.id}/${tool}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(args) });
  return { status: res.status, body: await res.json() };
}

export async function join(office: Created, name: string, extra: Record<string, unknown> = {}) {
  const r = await call(office, "join", { name, ...extra });
  if (r.status !== 200) throw new Error(`join: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { agentToken: string; agent: { id: string; deskId?: string; name: string }; desk: { id: string } | null };
}

export async function openWs(o: Created, key: string) {
  const res = await SELF.fetch(`${ORIGIN}/o/${o.id}/ws`, { headers: { upgrade: "websocket", "sec-websocket-protocol": `agent-office, ao-key.${key}` } });
  if (res.status !== 101) throw new Error(`ws: ${res.status}`);
  const ws = res.webSocket!;
  const frames: any[] = [];
  ws.addEventListener("message", (e) => frames.push(JSON.parse(e.data as string)));
  ws.accept();
  const next = async (pred: (f: any) => boolean) => {
    for (let i = 0; i < 60; i++) {
      const hit = frames.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no frame matching; got ${JSON.stringify(frames.map((f) => f.type))}`);
  };
  return { ws, frames, next };
}

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** Smallest header-valid images (enough for the sniffer; not decodable pictures). */
export const fakeImage = {
  png: (w: number, h: number, pad = 0) =>
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 6, 0, 0, 0, 0, 0, 0, 0, ...new Array(pad).fill(0)]),
  jpeg: (w: number, h: number) =>
    new Uint8Array([
      0xff, 0xd8,
      0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
      0xff, 0xc0, 0, 17, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
      0xff, 0xd9,
    ]),
  webpX: (w: number, h: number) =>
    new Uint8Array([
      ...[..."RIFF"].map((c) => c.charCodeAt(0)), 22, 0, 0, 0, ...[..."WEBPVP8X"].map((c) => c.charCodeAt(0)), 10, 0, 0, 0,
      0, 0, 0, 0, (w - 1) & 255, ((w - 1) >> 8) & 255, 0, (h - 1) & 255, ((h - 1) >> 8) & 255, 0,
    ]),
  webpL: (w: number, h: number) => {
    const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
    return new Uint8Array([
      ...[..."RIFF"].map((c) => c.charCodeAt(0)), 22, 0, 0, 0, ...[..."WEBPVP8L"].map((c) => c.charCodeAt(0)), 10, 0, 0, 0,
      0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255, 0, 0, 0, 0, 0,
    ]);
  },
  webpLossy: (w: number, h: number) =>
    new Uint8Array([
      ...[..."RIFF"].map((c) => c.charCodeAt(0)), 22, 0, 0, 0, ...[..."WEBPVP8 "].map((c) => c.charCodeAt(0)), 10, 0, 0, 0,
      0, 0, 0, 0x9d, 0x01, 0x2a, w & 255, (w >> 8) & 0x3f, h & 255, (h >> 8) & 0x3f,
    ]),
};

export function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
