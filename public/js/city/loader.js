// Manifest + chunk loading: nearest-first, 6 in flight, DecompressionStream, decodeChunk. Any failure shows a
// red banner and throws: a missing listed chunk (the SPA fallback answers with index.html), bad gzip magic,
// bad SFC1 magic or a version mismatch never turns into silent water.

import { assertGzip, chunkKey, decodeChunk, validateManifest } from "../../shared/city.js";
import { errorBanner } from "./banner.js";

export { errorBanner };

export const MAX_IN_FLIGHT = 6;

/** Show the banner, log, and hand the error back so the caller can `throw fail(e)`. */
export function fail(err) {
  const e = err instanceof Error ? err : new Error(String(err));
  errorBanner(e.message);
  console.error(e);
  return e;
}

async function fetchOk(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${res.statusText}`);
  return res;
}

/** Fetch + validateManifest. → Promise<Manifest> */
export async function loadManifest(url) {
  const res = await fetchOk(url);
  const text = await res.text();
  if (text.trimStart().startsWith("<")) throw new Error(`${url}: not a city manifest (got HTML?) — is there a city at this path?`);
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`${url}: manifest is not JSON (${e.message})`);
  }
  return validateManifest(doc);
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Fetch, assertGzip, inflate, decodeChunk. → Promise<Chunk> */
export async function fetchChunk(url) {
  const res = await fetchOk(url);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assertGzip(bytes, url);
  let raw;
  try {
    raw = await gunzip(bytes);
  } catch (e) {
    throw new Error(`${url}: gzip stream is corrupt (${e.message})`);
  }
  try {
    return decodeChunk(raw);
  } catch (e) {
    throw new Error(`${url}: ${e.message}`);
  }
}

/**
 * Every listed chunk is fetched once and kept decoded. request(cx, cz, priority) queues or re-prioritises a
 * chunk (lower = sooner); the pump keeps MAX_IN_FLIGHT fetches running. A chunk inside min/max but not in the
 * manifest list is "absent" (open water), and so is anything outside min/max.
 * → {get, status, request, pending, onLoad}
 */
export function createChunkStore(manifest, baseUrl) {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const listed = new Set(manifest.chunks.list.map(([cx, cz]) => chunkKey(cx, cz)));
  const chunks = new Map();
  const queued = new Map();
  const inFlight = new Set();
  const failed = new Map();
  const listeners = [];
  let inFlightCount = 0;

  const status = (cx, cz) => {
    const key = chunkKey(cx, cz);
    if (!listed.has(key)) return "absent";
    if (chunks.has(key)) return "loaded";
    if (failed.has(key)) return "error";
    if (queued.has(key) || inFlight.has(key)) return "pending";
    return "unknown";
  };

  async function load(key, cx, cz) {
    const url = `${base}chunks/${key}.bin`;
    try {
      const chunk = await fetchChunk(url);
      if (chunk.cx !== cx || chunk.cz !== cz) throw new Error(`${url}: holds chunk ${chunk.cx},${chunk.cz}, expected ${cx},${cz}`);
      chunks.set(key, chunk);
      for (const fn of listeners) fn(chunk);
    } catch (e) {
      failed.set(key, e);
      throw fail(e);
    } finally {
      inFlight.delete(key);
      inFlightCount--;
      pump();
    }
  }

  function pump() {
    while (inFlightCount < MAX_IN_FLIGHT && queued.size) {
      let best = null;
      for (const q of queued.values()) if (!best || q.priority < best.priority) best = q;
      queued.delete(best.key);
      inFlight.add(best.key);
      inFlightCount++;
      load(best.key, best.cx, best.cz);
    }
  }

  return {
    get: (cx, cz) => chunks.get(chunkKey(cx, cz)),
    status,
    request(cx, cz, priority) {
      if (!Number.isFinite(priority)) throw new Error(`chunk ${cx},${cz}: priority must be a finite number, got ${priority}`);
      const key = chunkKey(cx, cz);
      if (!listed.has(key) || chunks.has(key) || inFlight.has(key) || failed.has(key)) return;
      const q = queued.get(key);
      if (q) q.priority = priority;
      else queued.set(key, { key, cx, cz, priority });
      pump();
    },
    pending: () => queued.size + inFlightCount,
    /** fn(chunk) after each chunk lands in the store. */
    onLoad(fn) { listeners.push(fn); },
  };
}
