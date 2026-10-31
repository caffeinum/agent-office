// Fetch raw sources into data/city/sf/raw/ (spec §2, spec-v2 §2-3). `npm run city:fetch [-- --force]`.
// Idempotent: cached files are reused. --force re-downloads, except Overpass inside its 24 h cooldown.
// Every area gets its own raw files (east keeps the v1 ids and paths, so its cache carries over); the build
// dedupes records by OSM id and DataSF area_id. Overpass queries run one at a time; terrain tiles four at a time.
import { pathToFileURL } from "node:url";
import { fetchBytes, fetchCached, readSources, recordSource } from "./lib/http.mjs";
import { overpassQueries } from "./lib/osm.mjs";
import { terrariumFile, terrariumUrl, tilesForBboxes } from "./lib/terrain.mjs";
import {
  AREAS, COARSE_TERRAIN_BOX, COARSE_TERRAIN_ZOOM, ENDPOINTS, LICENSES, MASK, OVERPASS_COOLDOWN_H, RAW_DIR, TERRAIN_ZOOM, areaSourceId,
} from "./sf/config.mjs";

const overpassUrl = (q) => `${ENDPOINTS.overpass}?data=${encodeURIComponent(q)}`;

/** v1 file names of the east area's sources (kept so the cache carries over). */
const EAST_FILES = Object.freeze({ footprints: "datasf/footprints.geojson", roads: "osm/osm-roads.json", land: "osm/osm-land.json", buildings: "osm/osm-buildings.json" });
export const OSM_KINDS = Object.freeze(["roads", "land", "buildings", "extra", "points", "trees"]);

/** → {footprints, roads, land, buildings, extra, points, trees}: each {id, url, license, file, cooldownH?} for one area. */
export function areaSources(area) {
  const q = overpassQueries(area.fetch);
  const file = (kind, id, dir, ext) => (area.id === "east" && EAST_FILES[kind]) || `${dir}/${id}.${ext}`;
  const fpId = areaSourceId("datasf-footprints", area);
  const out = {
    footprints: { id: fpId, url: ENDPOINTS.datasfFootprints(area.fetch), license: LICENSES.datasf, file: file("footprints", fpId, "datasf", "geojson") },
  };
  for (const kind of OSM_KINDS) {
    const id = areaSourceId(`osm-${kind}`, area);
    out[kind] = { id, url: overpassUrl(q[kind]), license: LICENSES.osm, file: file(kind, id, "osm", "json"), cooldownH: OVERPASS_COOLDOWN_H };
  }
  return out;
}

/**
 * Every non-tile source: the citywide land mask, then each area's DataSF footprints and Overpass queries. The
 * tree queries (the heaviest node queries, used by nothing the chunk build needs) come last for every area.
 */
export function sourceList() {
  const per = AREAS.map((a) => areaSources(a));
  return [
    { id: MASK.id, url: MASK.url, license: MASK.license, file: "datasf/land.geojson" },
    ...per.flatMap(({ trees, ...rest }) => Object.values(rest)),
    ...per.map((s) => s.trees),
  ];
}

/** z15 tiles over every area's fetch box (the built chunks). */
export const terrainTiles = () => tilesForBboxes(AREAS.map((a) => a.fetch), TERRAIN_ZOOM);
/** z12 tiles over the whole city box (coarse relief for landmask.bin). */
export const coarseTerrainTiles = () => tilesForBboxes([COARSE_TERRAIN_BOX], COARSE_TERRAIN_ZOOM);

async function fetchJoerdAttribution() {
  const { bytes } = await fetchBytes(ENDPOINTS.joerdAttributionApi);
  const doc = JSON.parse(bytes.toString("utf8"));
  if (doc.encoding !== "base64" || typeof doc.content !== "string") throw new Error(`${ENDPOINTS.joerdAttributionApi}: expected base64 content, got ${JSON.stringify(doc).slice(0, 200)}`);
  const text = Buffer.from(doc.content, "base64").toString("utf8");
  if (!text.includes("USGS")) throw new Error("joerd attribution.md does not mention USGS; refusing to store it");
  return text;
}

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

async function fetchTiles(tiles, force) {
  let fetched = 0;
  await pool(tiles, 4, async ({ x, y, z }) => {
    const r = await fetchCached(
      { id: `terrarium-${z}-${x}-${y}`, url: terrariumUrl(x, y, z), license: LICENSES.terrain, file: terrariumFile(x, y, z) },
      { rawDir: RAW_DIR, force },
    );
    if (r.fetched) fetched++;
  });
  return fetched;
}

/** Fetch every source once (cached; --force re-downloads, Overpass 24 h cooldown) and write raw/sources.json. → sources[] */
export async function fetchSf({ force = false } = {}) {
  for (const s of sourceList()) {
    console.log(`${s.id}: ${s.url.slice(0, 110)}…`);
    const t = Date.now();
    const { entry, fetched } = await fetchCached(s, { rawDir: RAW_DIR, force });
    console.log(`  ${fetched ? "fetched" : "cached"} ${entry.bytes} bytes${fetched ? ` in ${((Date.now() - t) / 1000).toFixed(1)}s` : ""}`);
  }
  const fine = terrainTiles();
  const coarse = coarseTerrainTiles();
  console.log(`terrain: ${fine.length} z${TERRAIN_ZOOM} tiles (${await fetchTiles(fine, force)} fetched)`);
  console.log(`terrain: ${coarse.length} z${COARSE_TERRAIN_ZOOM} tiles (${await fetchTiles(coarse, force)} fetched)`);
  const tileNames = [...fine, ...coarse].map(({ x, y, z }) => `${z}/${x}/${y}`);
  const prev = readSources(RAW_DIR).find((e) => e.id === "terrain");
  const sameTiles = prev && JSON.stringify(prev.tiles) === JSON.stringify(tileNames);
  if (!sameTiles || force) {
    recordSource(RAW_DIR, {
      id: "terrain",
      url: ENDPOINTS.terrarium,
      license: LICENSES.terrain,
      fetchedAt: new Date().toISOString(),
      tiles: tileNames,
      attributionUrl: ENDPOINTS.joerdAttribution,
      attribution: prev && !force ? prev.attribution : await fetchJoerdAttribution(),
    });
    console.log("terrain: tile list and joerd attribution recorded in sources.json");
  }
  return readSources(RAW_DIR);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await fetchSf({ force: process.argv.includes("--force") });
