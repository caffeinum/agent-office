// STUB (W1) — owner W2. HTTP with UA, retries, content-type guard, and the raw cache.
// Final exported signatures; bodies are TODO. Spec: docs/city/spec.md.

export const USER_AGENT = "agent-office-city-build/0.1 (+https://github.com/caffeinum/agent-office)";
export const ACCEPTED_TYPES = Object.freeze(["application/json", "application/*+json", "image/png"]);

/** GET with USER_AGENT and exponential backoff. → Promise<{bytes: Buffer, contentType: string}> */
export async function fetchBytes(url, { retries = 5 } = {}) {
  throw new Error("not implemented: fetchBytes");
}

/** Throw unless contentType is accepted; the error carries the first 200 bytes. */
export function assertContentType(contentType, bytes, url) {
  throw new Error("not implemented: assertContentType");
}

/** source = {id, url, license, file}. Fetch into rawDir/file unless cached; record {id,url,license,fetchedAt,bytes,sha256} in raw/sources.json. → Promise<{path, entry}> */
export async function fetchCached(source, { rawDir, force = false }) {
  throw new Error("not implemented: fetchCached");
}
