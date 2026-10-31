// STUB (W1) — owner W5. Manifest + chunk loading: nearest-first, 6 in flight, DecompressionStream, red banner + throw on any error.
// Final exported signatures; bodies are TODO. Spec: docs/city/spec.md.

/** Fetch + validateManifest. → Promise<Manifest> */
export async function loadManifest(url) {
  throw new Error("not implemented: loadManifest");
}

/** Fetch, assertGzip, inflate, decodeChunk. → Promise<Chunk> */
export async function fetchChunk(url) {
  throw new Error("not implemented: fetchChunk");
}

/** → {get(cx, cz) → Chunk | undefined, status(cx, cz) → "loaded"|"absent"|"pending"|"unknown", request(cx, cz, priority), pending() → number} */
export function createChunkStore(manifest, baseUrl) {
  throw new Error("not implemented: createChunkStore");
}
