// Keys and tokens. Every office key is "<officeId>.<secret>" where secret is 32 random bytes in base64url, so a
// joinKey alone routes to its office without a global index. Only SHA-256 hashes of keys/tokens are stored.

export type Role = "owner" | "join" | "view";

export const OFFICE_ID_RE = /^[a-z0-9]{12}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomSecret(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export const TRIPCODE_LEN = 10;
export const TRIP_SECRET_MIN = 8;
export const TRIP_SECRET_MAX = 128;

/** "name#secret" → a public tripcode: the same secret gives the same tripcode in every office; the secret itself is never stored. */
export async function tripcode(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`agent-office tripcode\n${secret}`));
  return base64url(new Uint8Array(digest)).slice(0, TRIPCODE_LEN);
}

export function newOfficeId(): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let id = "";
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return id;
}

export function newOfficeKey(officeId: string): string {
  return `${officeId}.${randomSecret()}`;
}

/** The office id a key routes to, or null if the key is malformed. */
export function officeOfKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const dot = key.indexOf(".");
  if (dot < 0) return null;
  const id = key.slice(0, dot);
  const secret = key.slice(dot + 1);
  return OFFICE_ID_RE.test(id) && SECRET_RE.test(secret) ? id : null;
}

export async function sha256hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare (via hashing both sides to equal-length digests). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256hex(a), sha256hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0 && a.length === b.length;
}

/** Browsers can't set headers on a WebSocket, so the viewer offers ["agent-office", "ao-key.<key>"] as subprotocols. */
export const WS_PROTOCOL = "agent-office";
const WS_KEY_PREFIX = "ao-key.";

/** Key from `Authorization: Bearer <key>`, else the `ao-key.<key>` WebSocket subprotocol, else `?key=`, else `?k=`. */
export function keyFromRequest(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    if (m) return m[1]!;
  }
  const proto = req.headers.get("sec-websocket-protocol");
  if (proto) {
    const offered = proto.split(",").map((p) => p.trim()).find((p) => p.startsWith(WS_KEY_PREFIX));
    if (offered) return offered.slice(WS_KEY_PREFIX.length);
  }
  const url = new URL(req.url);
  return url.searchParams.get("key") ?? url.searchParams.get("k");
}

function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** A join key handed to one person ("Bob"): agents that join through it show as "via Bob", and revoking it shows them out. */
export interface Invite {
  id: string;
  hash: string;
  label: string;
  createdAt: number;
}

/** One owner key, any number of named join keys (invites) and any number of view keys, so a new link never revokes the old ones. */
export interface KeyHashes {
  owner: string;
  join: Invite[];
  view: string[];
}

/** Id and label of the join key every office starts with (and that offices saved with a single join key get). */
export const DEFAULT_INVITE = "everyone";

/** Offices saved before invites hold one join hash and one view hash. */
export function normalizeKeyHashes(raw: { owner: string; join: string | Invite[]; view: string | string[] }, createdAt: number): KeyHashes {
  return {
    owner: raw.owner,
    join: typeof raw.join === "string" ? [{ id: DEFAULT_INVITE, hash: raw.join, label: DEFAULT_INVITE, createdAt }] : raw.join,
    view: typeof raw.view === "string" ? [raw.view] : raw.view,
  };
}

export interface KeyMatch {
  role: Role;
  hash: string;
  /** The invite a join key belongs to. */
  invite: Invite | null;
}

export async function roleOfKey(key: string | null, hashes: KeyHashes): Promise<KeyMatch | null> {
  if (!key) return null;
  const hash = await sha256hex(key);
  let found: KeyMatch | null = null;
  if (hexEqual(hash, hashes.owner)) found = { role: "owner", hash, invite: null };
  for (const inv of hashes.join) if (hexEqual(hash, inv.hash)) found = { role: "join", hash, invite: inv };
  for (const h of hashes.view) if (hexEqual(hash, h)) found = { role: "view", hash, invite: null };
  return found;
}
