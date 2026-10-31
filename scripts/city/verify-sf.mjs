// Known-point gates on the built city (spec section 5, W2 acceptance). Fails the run on any miss.
// Decodes every manifest chunk, checks the pinned points in sf/config.mjs, and the water/land gate over
// in-bbox DataSF footprint centroids (read from the raw cache).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  BLOCK_M, CHUNK, SURFACE, assertGzip, chunkKey, chunkOf, decodeChunk, lonLatToBlock, validateManifest,
} from "../../public/shared/city.js";
import { BBOX, RAW_DIR, VERIFY } from "./sf/config.mjs";

const MAX_FOOTPRINTS_ON_WATER = 0.005;
const isWater = (s) => s === SURFACE.WATER || s === SURFACE.SHALLOW;

export function loadCity(dir) {
  const manifest = validateManifest(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
  const chunks = new Map();
  for (const [cx, cz, bytes] of manifest.chunks.list) {
    const p = join(dir, "chunks", `${chunkKey(cx, cz)}.bin`);
    if (!existsSync(p)) throw new Error(`manifest lists ${p} but it is missing`);
    const gz = readFileSync(p);
    if (gz.length !== bytes) throw new Error(`${p}: ${gz.length} bytes, manifest says ${bytes}`);
    assertGzip(gz, p);
    const c = decodeChunk(new Uint8Array(gunzipSync(gz)), manifest.parents);
    if (c.cx !== cx || c.cz !== cz) throw new Error(`${p}: header says chunk ${c.cx},${c.cz}`);
    chunks.set(chunkKey(cx, cz), c);
  }
  /** Column at global block (x, z); a chunk inside min/max but not listed is open water. */
  const column = (x, z) => {
    const [cx, cz] = chunkOf(x, z);
    const { min, max } = manifest.chunks;
    if (cx < min[0] || cx > max[0] || cz < min[1] || cz > max[1]) throw new Error(`block ${x},${z} is outside the built chunk range`);
    const c = chunks.get(chunkKey(cx, cz));
    if (!c) return { ground: 0, surface: SURFACE.WATER, building: null, deck: 0 };
    const i = (z - cz * CHUNK) * CHUNK + (x - cx * CHUNK);
    return { ground: c.ground[i], surface: c.surface[i], building: c.bldg[i] ? c.buildings[c.bldg[i] - 1] : null, deck: c.deck[i] };
  };
  const at = (lat, lon) => {
    const p = lonLatToBlock(lon, lat, manifest.proj);
    return { x: Math.floor(p.x), z: Math.floor(p.z), ...column(Math.floor(p.x), Math.floor(p.z)) };
  };
  return { manifest, chunks, column, at };
}

/** Building at a point, or the tallest building column within `r` blocks of it. */
function buildingNear(city, { lat, lon }, r = 4) {
  const c = city.at(lat, lon);
  let best = c.building;
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    const b = city.column(c.x + dx, c.z + dz).building;
    if (b && (!best || b.top - b.base > best.top - best.base)) best = b;
  }
  if (!best) throw new Error(`no building within ${r} blocks of ${lat},${lon}`);
  return best;
}

/** Every column of building `id` inside the chunks that hold it. */
function columnsOf(city, id) {
  const out = [];
  for (const c of city.chunks.values()) {
    const slot = c.buildings.findIndex((b) => b.id === id) + 1;
    if (!slot) continue;
    for (let i = 0; i < c.bldg.length; i++) if (c.bldg[i] === slot) out.push({ ground: c.ground[i], surface: c.surface[i] });
  }
  return out;
}

function knownPoints(city) {
  const P = VERIFY;
  const gates = [];
  const gate = (name, fn) => gates.push([name, fn]);
  const near = (v, want, tol, what) => {
    if (Math.abs(v - want) > tol) throw new Error(`${what} = ${v}, want ${want}±${tol}`);
    return `${what} = ${v}`;
  };
  gate("Ferry Building ground 1, columns building or PIER", () => {
    const c = city.at(P.ferryBuilding.lat, P.ferryBuilding.lon);
    if (c.ground !== 1) throw new Error(`ground ${c.ground}`);
    if (!c.building && c.surface !== SURFACE.PIER) throw new Error(`surface ${c.surface}, not a building or PIER`);
    const b = buildingNear(city, P.ferryBuilding, 0);
    const cols = columnsOf(city, b.id);
    const wet = cols.filter((x) => isWater(x.surface) || x.ground !== 1).length;
    if (wet) throw new Error(`${wet} of ${cols.length} Ferry Building columns are water or off ground 1`);
    return `building ${b.id}, ${cols.length} columns on ground 1`;
  });
  // The spec's 34±3 is the Nob Hill summit (≈103 m, one block west). Grace Cathedral itself stands lower:
  // DataSF footprint area_id 550 records gnd_min_m 90.04 m (30 blocks) and the Terrarium DEM gives 92.5 m.
  // The gate checks the independently surveyed DataSF ground, ±3 blocks.
  gate("Grace Cathedral ground 30±3 (DataSF gnd_min_m 90.04 m; spec said 34, the summit)", () => near(city.at(P.graceCathedral.lat, P.graceCathedral.lon).ground, 30, 3, "ground"));
  gate("Coit Tower base 28±3", () => near(buildingNear(city, P.coitTower, 0).base, 28, 3, "base"));
  gate("Salesforce Tower top-base 109±3", () => {
    const b = buildingNear(city, P.salesforceTower);
    return near(b.top - b.base, 109, 3, `building ${b.id} top-base`);
  });
  gate("Transamerica top-base 87±3", () => {
    const b = buildingNear(city, P.transamerica);
    return near(b.top - b.base, 87, 3, `building ${b.id} top-base`);
  });
  gate("1455 3rd St ground 1-2", () => {
    const g = city.at(P.openai1455.lat, P.openai1455.lon).ground;
    if (g < 1 || g > 2) throw new Error(`ground ${g}`);
    return `ground ${g}`;
  });
  gate("Pier 39 is PIER or a building", () => {
    const c = city.at(P.pier39.lat, P.pier39.lon);
    if (!c.building && c.surface !== SURFACE.PIER) throw new Error(`surface ${c.surface}`);
    return c.building ? `building ${c.building.id}` : "PIER";
  });
  const water = (name, p) => gate(`${name} is WATER`, () => {
    const c = city.at(p.lat, p.lon);
    if (c.ground !== 0 || !isWater(c.surface) || c.building) throw new Error(`ground ${c.ground} surface ${c.surface}`);
    return `surface ${c.surface}`;
  });
  water("Mission Creek channel", P.missionCreek);
  water("McCovey Cove", P.mccoveyCove);
  water("the Bay east of the Embarcadero", P.bayEast);
  gate("Embarcadero in front of the Ferry Building is ROAD, ground ≥1", () => {
    const c = city.at(P.embarcadero.lat, P.embarcadero.lon);
    if (c.surface !== SURFACE.ROAD || c.ground < 1 || c.building) throw new Error(`surface ${c.surface} ground ${c.ground}`);
    return `ground ${c.ground}`;
  });
  return gates;
}

function footprintGate(city) {
  const p = join(RAW_DIR, "datasf/footprints.geojson");
  if (!existsSync(p)) throw new Error(`${p} missing: the water/land gate needs the raw DataSF footprints (npm run city:fetch)`);
  const fc = JSON.parse(readFileSync(p, "utf8"));
  let n = 0, wet = 0;
  for (const f of fc.features) {
    const ring = f.geometry.coordinates[0][0];
    const lon = ring.reduce((s, q) => s + q[0], 0) / ring.length, lat = ring.reduce((s, q) => s + q[1], 0) / ring.length;
    if (lon < BBOX.west || lon >= BBOX.east || lat <= BBOX.south || lat > BBOX.north) continue;
    n++;
    if (isWater(city.at(lat, lon).surface)) wet++;
  }
  if (n === 0) throw new Error("water/land gate: no DataSF footprints inside the bbox");
  const ratio = wet / n;
  if (ratio > MAX_FOOTPRINTS_ON_WATER) throw new Error(`${wet}/${n} footprint centroids on WATER (${(ratio * 100).toFixed(2)}% > 0.5%)`);
  return `${wet}/${n} footprint centroids on water (${(ratio * 100).toFixed(3)}%)`;
}

/** Decode the built city in `dir` and assert every known point + the water/land gate. → {passed, skipped} */
export async function verifySf(dir = "public/city/sf") {
  const city = loadCity(dir);
  const passed = [], failed = [], skipped = [];
  const run = (name, fn) => {
    try {
      const detail = fn();
      passed.push(name);
      console.log(`✓ ${name}: ${detail}`);
    } catch (e) {
      failed.push(name);
      console.error(`✗ ${name}: ${e.message}`);
    }
  };
  run(`all ${city.manifest.chunks.list.length} manifest chunks exist and decode`, () => `${city.chunks.size} chunks`);
  for (const [name, fn] of knownPoints(city)) run(name, fn);
  run("water/land gate (≤0.5% footprint centroids on water)", () => footprintGate(city));
  if (failed.length) throw new Error(`verify-sf: ${failed.length} gate(s) failed: ${failed.join("; ")}`);
  console.log(`verify-sf: ${passed.length} passed, ${skipped.length} skipped (1 block = ${BLOCK_M} m)`);
  return { passed, skipped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await verifySf();
