// `npm run city:perf [-- --city fixture]`: mesher timings, report only (not part of check).
// Times meshChunk on chunk (56,26) (target ≤ 15 ms) and meshRegion at LOD1/LOD2 on its region.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { REGION, chunkKey, decodeChunk, regionOf, validateManifest } from "../../public/shared/city.js";
import { meshChunk, meshRegion } from "../../public/js/city/mesher.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TARGET = [56, 26];
const TARGET_MS = 15;
const RUNS = 30;

function load(city) {
  const dir = join(ROOT, "public/city", city);
  if (!existsSync(join(dir, "manifest.json"))) {
    throw new Error(`city:perf: ${dir}/manifest.json not found; run npm run city:build, or pass --city fixture`);
  }
  const manifest = validateManifest(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
  const chunks = new Map();
  for (const [cx, cz] of manifest.chunks.list) {
    chunks.set(chunkKey(cx, cz), decodeChunk(new Uint8Array(gunzipSync(readFileSync(join(dir, "chunks", `${chunkKey(cx, cz)}.bin`))))));
  }
  return { manifest, get: (cx, cz) => chunks.get(chunkKey(cx, cz)) ?? null };
}

function time(fn) {
  for (let k = 0; k < 3; k++) fn();
  const ms = [];
  let out;
  for (let k = 0; k < RUNS; k++) {
    const t = performance.now();
    out = fn();
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  return { out, median: ms[RUNS >> 1], p90: ms[Math.floor(RUNS * 0.9)] };
}

const tris = (m) => m.indices.length / 3;
const fmt = (t) => `median ${t.median.toFixed(2)} ms, p90 ${t.p90.toFixed(2)} ms`;

/** → Promise<{lod0Ms, lod0Tris, lod1Ms, lod2Ms}> */
export async function perf({ city = "sf" } = {}) {
  const { get } = load(city);
  const [cx, cz] = TARGET;
  const c = get(cx, cz);
  if (!c) throw new Error(`city:perf: ${city} has no chunk ${cx},${cz}`);
  const nb = { n: get(cx, cz - 1), s: get(cx, cz + 1), e: get(cx + 1, cz), w: get(cx - 1, cz) };
  const lod0 = time(() => meshChunk(c, nb));
  const lod0Tris = tris(lod0.out.opaque) + tris(lod0.out.walls);
  const [rx, rz] = regionOf(cx, cz);
  const regionChunks = [];
  for (let z = rz * REGION; z < rz * REGION + REGION; z++) for (let x = rx * REGION; x < rx * REGION + REGION; x++) if (get(x, z)) regionChunks.push(get(x, z));
  const lod1 = time(() => meshRegion(regionChunks, [], 1));
  const lod2 = time(() => meshRegion(regionChunks, [], 2));
  const ok = lod0.median <= TARGET_MS;
  console.log(`city:perf (${city})`);
  console.log(`  LOD0 chunk ${cx},${cz}: ${fmt(lod0)}, ${lod0Tris} triangles (opaque ${tris(lod0.out.opaque)}, walls ${tris(lod0.out.walls)}) — target ≤ ${TARGET_MS} ms: ${ok ? "ok" : "OVER"}`);
  console.log(`  LOD1 region ${rx},${rz} (${regionChunks.length} chunks): ${fmt(lod1)}, ${tris(lod1.out.opaque)} triangles`);
  console.log(`  LOD2 region ${rx},${rz}: ${fmt(lod2)}, ${tris(lod2.out.opaque)} triangles`);
  return { lod0Ms: lod0.median, lod0Tris, lod1Ms: lod1.median, lod2Ms: lod2.median };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf("--city");
  await perf(i > 0 ? { city: process.argv[i + 1] } : {});
}
