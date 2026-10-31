// Fetch raw sources into data/city/sf/raw/ (spec section 2). `npm run city:fetch [-- --force]`.
// Idempotent: cached files are reused. --force re-downloads, except Overpass inside its 24 h cooldown.
// Overpass queries run one at a time; terrain tiles four at a time.
import { pathToFileURL } from "node:url";
import { fetchBytes, fetchCached, readSources, recordSource } from "./lib/http.mjs";
import { overpassQueries } from "./lib/osm.mjs";
import { terrariumFile, terrariumUrl, tilesForBbox } from "./lib/terrain.mjs";
import { ENDPOINTS, FETCH_BBOX, LICENSES, MASK, OVERPASS_COOLDOWN_H, RAW_DIR } from "./sf/config.mjs";

const overpassUrl = (q) => `${ENDPOINTS.overpass}?data=${encodeURIComponent(q)}`;

export function sourceList() {
  const q = overpassQueries(FETCH_BBOX);
  const osm = (id, query) => ({ id, url: overpassUrl(query), license: LICENSES.osm, file: `osm/${id}.json`, cooldownH: OVERPASS_COOLDOWN_H });
  return [
    { id: "datasf-footprints", url: ENDPOINTS.datasfFootprints, license: LICENSES.datasf, file: "datasf/footprints.geojson" },
    { id: MASK.id, url: MASK.url, license: MASK.license, file: "datasf/land.geojson" },
    osm("osm-roads", q.roads),
    osm("osm-land", q.land),
    osm("osm-buildings", q.buildings),
  ];
}

export const terrainTiles = () => tilesForBbox(FETCH_BBOX);

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

/** Fetch every source once (cached; --force re-downloads, Overpass 24 h cooldown) and write raw/sources.json. → sources[] */
export async function fetchSf({ force = false } = {}) {
  for (const s of sourceList()) {
    console.log(`${s.id}: ${s.url.slice(0, 110)}…`);
    const t = Date.now();
    const { entry, fetched } = await fetchCached(s, { rawDir: RAW_DIR, force });
    console.log(`  ${fetched ? "fetched" : "cached"} ${entry.bytes} bytes${fetched ? ` in ${((Date.now() - t) / 1000).toFixed(1)}s` : ""}`);
  }
  const tiles = terrainTiles();
  let fetchedTiles = 0;
  await pool(tiles, 4, async ({ x, y }) => {
    const { fetched } = await fetchCached(
      { id: `terrarium-15-${x}-${y}`, url: terrariumUrl(x, y), license: LICENSES.terrain, file: terrariumFile(x, y) },
      { rawDir: RAW_DIR, force },
    );
    if (fetched) fetchedTiles++;
  });
  console.log(`terrain: ${tiles.length} z15 tiles (${fetchedTiles} fetched)`);
  const prev = readSources(RAW_DIR).find((e) => e.id === "terrain");
  if (!prev || force) {
    recordSource(RAW_DIR, {
      id: "terrain",
      url: ENDPOINTS.terrarium,
      license: LICENSES.terrain,
      fetchedAt: new Date().toISOString(),
      tiles: tiles.map(({ x, y }) => `15/${x}/${y}`),
      attributionUrl: ENDPOINTS.joerdAttribution,
      attribution: await fetchJoerdAttribution(),
    });
    console.log("terrain: joerd attribution stored verbatim in sources.json");
  }
  return readSources(RAW_DIR);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await fetchSf({ force: process.argv.includes("--force") });
