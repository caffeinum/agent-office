// HTTP for the city build: fixed User-Agent, exponential-backoff retries, a content-type guard, and the
// raw cache with its provenance log (raw/sources.json). Spec: docs/city/spec.md section 2.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { dirname, join } from "node:path";

export const USER_AGENT = "agent-office-city-build/0.1 (+https://github.com/caffeinum/agent-office)";
export const ACCEPTED_TYPES = Object.freeze(["application/json", "application/*+json", "image/png"]);

const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_REDIRECTS = 5;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(message, { retryable }) {
    super(message);
    this.retryable = retryable;
  }
}

function getOnce(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { "user-agent": USER_AGENT, accept: "application/json, image/png" } }, (res) => {
      const status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new HttpError(`${url}: more than ${MAX_REDIRECTS} redirects`, { retryable: false }));
        return resolve(getOnce(new URL(res.headers.location, url).href, redirects + 1));
      }
      const parts = [];
      res.on("data", (d) => parts.push(d));
      res.on("error", (e) => reject(new HttpError(`${url}: ${e.message}`, { retryable: true })));
      res.on("end", () => {
        const bytes = Buffer.concat(parts);
        if (status !== 200) {
          const head = bytes.subarray(0, 200).toString("utf8");
          return reject(new HttpError(`${url}: HTTP ${status}: ${head}`, { retryable: RETRYABLE_STATUS.has(status) }));
        }
        resolve({ bytes, contentType: res.headers["content-type"] ?? "" });
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`timed out after ${REQUEST_TIMEOUT_MS / 1000}s`)));
    req.on("error", (e) => reject(e instanceof HttpError ? e : new HttpError(`${url}: ${e.message}`, { retryable: true })));
    req.end();
  });
}

/** GET with USER_AGENT and exponential backoff (2 s, 4 s, 8 s, …). Throws on a non-accepted content type. */
export async function fetchBytes(url, { retries = 5 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await getOnce(url);
      assertContentType(res.contentType, res.bytes, url);
      return res;
    } catch (e) {
      if (!e.retryable || attempt >= retries) throw e;
      const wait = 2000 * 2 ** attempt;
      console.warn(`  retry ${attempt + 1}/${retries} in ${wait / 1000}s: ${e.message.slice(0, 200)}`);
      await sleep(wait);
    }
  }
}

function typeAccepted(contentType) {
  const mime = String(contentType).split(";")[0].trim().toLowerCase();
  return mime === "application/json" || mime === "image/png" || /^application\/[a-z0-9.+-]+\+json$/.test(mime);
}

/** Throw unless contentType is accepted; the error carries the first 200 bytes. */
export function assertContentType(contentType, bytes, url) {
  if (typeAccepted(contentType)) return;
  const head = Buffer.from(bytes).subarray(0, 200).toString("utf8");
  throw new HttpError(`${url}: content-type ${JSON.stringify(contentType)} is not one of ${ACCEPTED_TYPES.join(", ")}; first 200 bytes: ${head}`, { retryable: false });
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function readSources(rawDir) {
  const p = join(rawDir, "sources.json");
  if (!existsSync(p)) return [];
  const list = JSON.parse(readFileSync(p, "utf8"));
  if (!Array.isArray(list)) throw new Error(`${p}: expected an array of source entries`);
  return list;
}

function writeAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** Insert or replace one entry (by id) in raw/sources.json. Synchronous, so concurrent fetches cannot interleave. */
export function recordSource(rawDir, entry) {
  const list = readSources(rawDir).filter((e) => e.id !== entry.id);
  list.push(entry);
  list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  writeAtomic(join(rawDir, "sources.json"), `${JSON.stringify(list, null, 2)}\n`);
}

/**
 * source = {id, url, license, file, cooldownH?, extra?}. Fetch into rawDir/file unless cached (file present,
 * recorded with a matching sha256, same URL). force re-downloads, except within cooldownH of the last fetch
 * of the same URL (Overpass). A changed URL is a different request and is fetched.
 * Records {id,url,license,fetchedAt,bytes,sha256,...extra} in raw/sources.json. → {path, entry, fetched}
 */
export async function fetchCached(source, { rawDir, force = false }) {
  for (const k of ["id", "url", "license", "file"]) {
    if (typeof source[k] !== "string" || !source[k]) throw new Error(`fetchCached: source.${k} must be a non-empty string`);
  }
  const path = join(rawDir, source.file);
  const cached = readSources(rawDir).find((e) => e.id === source.id);
  const fileOk = cached && existsSync(path) && sha256(readFileSync(path)) === cached.sha256;
  if (cached && existsSync(path) && !fileOk) throw new Error(`${path}: sha256 does not match raw/sources.json; delete it and re-fetch`);
  const sameUrl = fileOk && cached.url === source.url;
  if (fileOk && !sameUrl) console.warn(`  ${source.id}: the request changed since the cached fetch; fetching the new one`);
  if (sameUrl && !force) return { path, entry: cached, fetched: false };
  if (sameUrl && force && source.cooldownH) {
    const ageH = (Date.now() - Date.parse(cached.fetchedAt)) / 3.6e6;
    if (ageH < source.cooldownH) {
      console.warn(`  ${source.id}: cached ${ageH.toFixed(1)} h ago, inside the ${source.cooldownH} h cooldown; not re-fetching`);
      return { path, entry: cached, fetched: false };
    }
  }
  const { bytes } = await fetchBytes(source.url);
  writeAtomic(path, bytes);
  const entry = {
    id: source.id,
    url: source.url,
    license: source.license,
    fetchedAt: new Date().toISOString(),
    bytes: bytes.length,
    sha256: sha256(bytes),
    ...(source.extra ?? {}),
  };
  recordSource(rawDir, entry);
  return { path, entry, fetched: true };
}
