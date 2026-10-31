// OAuth token formats and the crypto behind them. Every code/token is "<kind>_<officeId>_<secret>" so it routes to its
// office's Auth shard without a global index. Only SHA-256 hashes are looked up; the join key a grant stands for is stored
// sealed (AES-GCM) under a key derived from the code/token itself, so the Auth store alone never reveals a join key.
import { base64url, OFFICE_ID_RE, randomSecret, sha256hex } from "./auth";

export const ACCESS_PREFIX = "aoat";
export const REFRESH_PREFIX = "aort";
export const CODE_PREFIX = "aoac";
type Kind = typeof ACCESS_PREFIX | typeof REFRESH_PREFIX | typeof CODE_PREFIX;

const TOKEN_RE = /^(aoat|aort|aoac)_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;

export function mintToken(kind: Kind, officeId: string): string {
  if (!OFFICE_ID_RE.test(officeId)) throw new Error(`mintToken: bad office id ${JSON.stringify(officeId)}`);
  return `${kind}_${officeId}_${randomSecret()}`;
}

/** The office a well-formed code/token of `kind` belongs to, else null. */
export function officeOfToken(token: string | null | undefined, kind: Kind): string | null {
  if (!token) return null;
  const m = TOKEN_RE.exec(token);
  return m && m[1] === kind ? m[2]! : null;
}

export const hashToken = sha256hex;

async function sealKey(token: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`agent-office oauth seal\n${token}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(plain: string, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealKey(token), new TextEncoder().encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return base64url(out);
}

export async function unseal(sealed: string, token: string): Promise<string> {
  const bin = atob(sealed.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await sealKey(token), bytes.slice(12));
  return new TextDecoder().decode(plain);
}

const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
export const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

/** RFC 7636 S256: base64url(sha256(verifier)) === challenge, compared in constant time. */
export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  if (!VERIFIER_RE.test(verifier) || !CHALLENGE_RE.test(challenge)) return false;
  const digest = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return constantTimeEqual(digest, challenge);
}

export function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
