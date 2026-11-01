// `npm run city:walk`: writes public/city/sf/{walk.bin,places.json} (spec-v2 §7.6) from the cached OSM roads, the
// built chunks (ground), report.json decks, companies.json and scripts/city/sf/places.src.json. Never hits the network.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  CHUNK, MAX_WALK_BYTES, chunkKey, decodeChunk, decodeWalk, encodeWalk, validateCompanies, validateManifest, validatePlaces,
} from "../../public/shared/city.js";
import { buildWalk } from "./lib/walk.mjs";
import { BUILD_DIR, OUT_DIR, RAW_DIR } from "./sf/config.mjs";

/** 160 KB (spec-v2 said 150): OSM `lanes` widths since the street-detail pass vary halfWidth along a street. */
export const MAX_WALK_GZ_BYTES = 160 * 1024;
const PLACES_SRC = "scripts/city/sf/places.src.json";

const readJson = (p) => {
  if (!existsSync(p)) throw new Error(`walk-sf: ${p} is missing`);
  return JSON.parse(readFileSync(p, "utf8"));
};

/** Every cached osm/osm-roads*.json (one per fetch area), merged; buildWalk dedupes by way id. */
export function loadRoads(rawDir = RAW_DIR) {
  const dir = join(rawDir, "osm");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^osm-roads.*\.json$/.test(f)).sort() : [];
  if (files.length === 0) throw new Error(`walk-sf: no ${dir}/osm-roads*.json (run npm run city:fetch)`);
  return files.flatMap((f) => readJson(join(dir, f)).elements);
}

/** report.json `decks` ({wayId: deckY}, spec-v2 §3.8): public/city/sf first, then the build dir. */
export function loadDecks(outDir = OUT_DIR, buildDir = BUILD_DIR) {
  const tried = [];
  for (const p of [join(outDir, "report.json"), join(buildDir, "report.json")]) {
    if (!existsSync(p)) continue;
    const d = readJson(p).decks;
    const isMap = d && typeof d === "object" && !Array.isArray(d) && Object.entries(d).every(([k, v]) => /^\d+$/.test(k) && Number.isInteger(v));
    if (isMap) return d;
    tried.push(`${p} (decks is not {wayId: deckY})`);
  }
  throw new Error(`walk-sf: no report.json with v2 decks {wayId: deckY}; tried ${tried.join(", ") || "none found"}`);
}

/** Column ground from the shipped chunks (decoded on demand). Unlisted chunks throw. */
export function chunkGround(dir, manifest) {
  const listed = new Set(manifest.chunks.list.map(([cx, cz]) => chunkKey(cx, cz)));
  const cache = new Map();
  return (x, z) => {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const k = chunkKey(cx, cz);
    if (!cache.has(k)) {
      if (!listed.has(k)) throw new Error(`groundAt(${x}, ${z}): chunk ${k} is not listed`);
      cache.set(k, decodeChunk(new Uint8Array(gunzipSync(readFileSync(join(dir, "chunks", `${k}.bin`)))), manifest.parents));
    }
    return cache.get(k).ground[(z - cz * CHUNK) * CHUNK + (x - cx * CHUNK)];
  };
}

export async function walkSf({ outDir = OUT_DIR } = {}) {
  const t0 = Date.now();
  const manifest = validateManifest(readJson(join(outDir, "manifest.json")));
  const companies = validateCompanies(readJson(join(outDir, "companies.json")), manifest);
  const { walk, places, stats } = buildWalk({
    roads: loadRoads(),
    decks: loadDecks(outDir),
    groundAt: chunkGround(outDir, manifest),
    manifest,
    sites: companies.sites,
    placesSrc: readJson(PLACES_SRC),
  });
  const bytes = encodeWalk(walk, manifest);
  const gz = gzipSync(bytes, { level: 9 }).length;
  if (bytes.length > MAX_WALK_BYTES) throw new Error(`walk.bin ${bytes.length} B > ${MAX_WALK_BYTES}`);
  if (gz > MAX_WALK_GZ_BYTES) throw new Error(`walk.bin ${gz} B gzipped > ${MAX_WALK_GZ_BYTES}`);
  validatePlaces(places, manifest, decodeWalk(bytes, manifest));
  if (stats.largestShare < 0.95) throw new Error(`walk: the largest component holds ${(stats.largestShare * 100).toFixed(1)}% of nodes (< 95%)`);
  writeFileSync(join(outDir, manifest.walk), bytes);
  writeFileSync(join(outDir, manifest.places), `${JSON.stringify(places)}\n`);
  console.log(`walk-sf: ${stats.nodes} nodes, ${stats.edges} edges, ${walk.names.length} names, ${places.places.length} places (${stats.intersections} intersections); walk.bin ${bytes.length} B (${gz} B gz); largest component ${(stats.largestShare * 100).toFixed(1)}% of ${stats.components} components; ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return { walk, places, stats };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await walkSf();
