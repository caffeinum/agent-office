// Image uploads without image libraries: identify PNG / JPEG / WebP by magic bytes and read their pixel size
// from the headers. Anything else, truncated headers, or images over the limits fail with a clear ToolError.
import { ToolError } from "./tools";

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
export const ASSET_BYTES_MAX = 512 * 1024;
export const ASSET_DIM_MAX = 1024;
export const ASSETS_MAX = 32;
export const ASSETS_TOTAL_MAX = 8 * 1024 * 1024;
/** base64 length of ASSET_BYTES_MAX bytes */
export const ASSET_BASE64_MAX = Math.ceil(ASSET_BYTES_MAX / 3) * 4;

export interface ImageInfo {
  type: ImageType;
  w: number;
  h: number;
}

const bad = (msg: string): never => {
  throw new ToolError(415, msg);
};

const ascii = (b: Uint8Array, at: number, len: number) => String.fromCharCode(...b.subarray(at, at + len));
const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u32be = (b: Uint8Array, at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const u24le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(b: Uint8Array): ImageInfo {
  if (b.length < 33) bad("PNG is truncated before its IHDR header");
  if (u32be(b, 8) !== 13 || ascii(b, 12, 4) !== "IHDR") bad("PNG's first chunk is not IHDR");
  return { type: "image/png", w: u32be(b, 16), h: u32be(b, 20) };
}

function jpeg(b: Uint8Array): ImageInfo {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) bad(`JPEG marker expected at byte ${i}`);
    let m = b[i + 1]!;
    while (m === 0xff && i + 2 < b.length) m = b[++i + 1]!;
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    if (m === 0xd9 || m === 0xda) bad("JPEG has no frame header (SOF) before its image data");
    const len = u16be(b, i + 2);
    if (len < 2) bad("JPEG segment has a bad length");
    const sof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (sof) {
      if (i + 8 >= b.length) bad("JPEG is truncated inside its frame header");
      return { type: "image/jpeg", h: u16be(b, i + 5), w: u16be(b, i + 7) };
    }
    i += 2 + len;
  }
  return bad("JPEG is truncated before its frame header");
}

function webp(b: Uint8Array): ImageInfo {
  if (b.length < 30) bad("WebP is truncated before its image header");
  const chunk = ascii(b, 12, 4);
  const d = 20;
  if (chunk === "VP8 ") {
    if (b[d + 3] !== 0x9d || b[d + 4] !== 0x01 || b[d + 5] !== 0x2a) bad("WebP (VP8) has a bad start code");
    return { type: "image/webp", w: (b[d + 6]! | (b[d + 7]! << 8)) & 0x3fff, h: (b[d + 8]! | (b[d + 9]! << 8)) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (b[d] !== 0x2f) bad("WebP (VP8L) has a bad signature");
    const bits = (b[d + 1]! | (b[d + 2]! << 8) | (b[d + 3]! << 16) | (b[d + 4]! << 24)) >>> 0;
    return { type: "image/webp", w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") return { type: "image/webp", w: u24le(b, d + 4) + 1, h: u24le(b, d + 7) + 1 };
  return bad(`WebP has an unknown first chunk ${JSON.stringify(chunk)}`);
}

/** Generic content-types clients send when they don't know (curl --data-binary defaults to form-urlencoded): trust the bytes. */
const UNDECLARED = new Set(["application/octet-stream", "application/x-www-form-urlencoded", "binary/octet-stream"]);

/** Identifies the image by its bytes (never by name or declared type) and checks size and dimensions. */
export function sniffImage(bytes: Uint8Array, declared?: string): ImageInfo {
  if (bytes.length === 0) throw new ToolError(400, "the file is empty");
  if (bytes.length > ASSET_BYTES_MAX) throw new ToolError(413, `image is ${bytes.length} bytes, max ${ASSET_BYTES_MAX} (512 KB)`);
  let info: ImageInfo;
  if (PNG_SIG.every((v, i) => bytes[i] === v)) info = png(bytes);
  else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) info = jpeg(bytes);
  else if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") info = webp(bytes);
  else return bad("not a PNG, JPEG or WebP image (checked the file's magic bytes)");
  const type = declared?.split(";")[0]!.trim().toLowerCase();
  if (type && !UNDECLARED.has(type) && type !== info.type && !(type === "image/jpg" && info.type === "image/jpeg")) {
    bad(`contentType says ${type} but the bytes are ${info.type}`);
  }
  if (info.w < 1 || info.h < 1) bad(`image header says ${info.w}×${info.h} pixels`);
  if (info.w > ASSET_DIM_MAX || info.h > ASSET_DIM_MAX) bad(`image is ${info.w}×${info.h} pixels, max ${ASSET_DIM_MAX}×${ASSET_DIM_MAX} — scale it down first`);
  return info;
}

export function decodeBase64(s: string): Uint8Array {
  const clean = s.replace(/^data:[^;,]+;base64,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean)) throw new ToolError(400, "base64 is not valid base64");
  const std = clean.replace(/-/g, "+").replace(/_/g, "/");
  let bin: string;
  try {
    bin = atob(std);
  } catch {
    throw new ToolError(400, "base64 is not valid base64");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const EXT_OF: Record<ImageType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
