// Known-point gates on the built city (spec §5 W2 acceptance, spec-v2 §2 and §8 W2). Fails the run on any miss.
// Decodes every manifest chunk, checks the pinned points in sf/config.mjs, the water/land gate over in-area
// DataSF footprint centroids (read from the raw cache), and the unbuilt-land skirts against landmask.bin.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  BLOCK_M, CHUNK, SURFACE, assertGzip, chunkKey, chunkOf, decodeChunk, decodeLandmarks, decodeLandmask, lonLatToBlock, validateManifest,
} from "../../public/shared/city.js";
import { percentile, skirtHeights } from "./lib/mask.mjs";
import { areaSources } from "./fetch-sf.mjs";
import { AREAS, RAW_DIR, VERIFY } from "./sf/config.mjs";

const MAX_FOOTPRINTS_ON_WATER = 0.005;
const MAX_SKIRT_P90 = 2;
const isWater = (s) => s === SURFACE.WATER || s === SURFACE.SHALLOW;
const inAnyArea = (lon, lat) => AREAS.some((a) => lon >= a.west && lon <= a.east && lat >= a.south && lat <= a.north);

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
  const water = new Set(manifest.water.map(([cx, cz]) => chunkKey(cx, cz)));
  const readGz = (name) => {
    const p = join(dir, manifest[name]);
    if (!existsSync(p)) throw new Error(`manifest.${name}: ${p} is missing`);
    const bytes = readFileSync(p);
    assertGzip(bytes, p);
    return new Uint8Array(gunzipSync(bytes));
  };
  const landmask = decodeLandmask(readGz("landmask"), manifest.chunks.grid);
  const landmarks = decodeLandmarks(readGz("landmarks"), manifest.chunks.grid);
  /** Column at global block (x, z): listed chunk data, or open water for a water chunk. Unbuilt land throws. */
  const column = (x, z) => {
    const [cx, cz] = chunkOf(x, z);
    const key = chunkKey(cx, cz);
    const c = chunks.get(key);
    if (!c) {
      if (water.has(key)) return { ground: 0, surface: SURFACE.WATER, building: null, deck: 0, top: 0 };
      throw new Error(`block ${x},${z}: chunk ${key} is not built (neither listed nor water)`);
    }
    const i = (z - cz * CHUNK) * CHUNK + (x - cx * CHUNK);
    return { ground: c.ground[i], surface: c.surface[i], building: c.bldg[i] ? c.buildings[c.bldg[i] - 1] : null, deck: c.deck[i], top: c.top[i] };
  };
  const at = (lat, lon) => {
    const p = lonLatToBlock(lon, lat, manifest.proj);
    return { x: Math.floor(p.x), z: Math.floor(p.z), ...column(Math.floor(p.x), Math.floor(p.z)) };
  };
  return { manifest, chunks, water, landmask, landmarks, column, at };
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

/** Every column within r blocks of a point. */
function disc(city, { lat, lon }, r) {
  const c = city.at(lat, lon);
  const out = [];
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (Math.hypot(dx, dz) <= r) out.push(city.column(c.x + dx, c.z + dz));
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
  // The gate checks the independently surveyed DataSF ground, ±3 blocks, scaled by the terrain knob.
  const tx = city.manifest.terrainExaggeration;
  gate(`Grace Cathedral ground ${Math.round(30 * tx)}±3 (DataSF gnd_min_m 90.04 m × ${tx})`, () => near(city.at(P.graceCathedral.lat, P.graceCathedral.lon).ground, Math.round(30 * tx), 3, "ground"));
  gate(`Coit Tower base ${Math.round(28 * tx)}±3`, () => near(buildingNear(city, P.coitTower, 0).base, Math.round(28 * tx), 3, "base"));
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
  water("Palace of Fine Arts lagoon", P.palaceLagoon);
  gate("Embarcadero in front of the Ferry Building is ROAD, ground ≥1", () => {
    const c = city.at(P.embarcadero.lat, P.embarcadero.lon);
    if (c.surface !== SURFACE.ROAD || c.ground < 1 || c.building) throw new Error(`surface ${c.surface} ground ${c.ground}`);
    return `ground ${c.ground}`;
  });
  gate("Fort Point is a land/water edge (both within 16 blocks)", () => {
    const cols = disc(city, P.fortPoint, 16);
    const wet = cols.filter((c) => c.ground === 0).length, dry = cols.length - wet;
    if (!wet || !dry) throw new Error(`${dry} land and ${wet} water columns`);
    return `${dry} land, ${wet} water columns`;
  });
  gate("Crissy Field beach is SAND", () => {
    const c = city.at(P.crissyBeach.lat, P.crissyBeach.lon);
    if (c.surface !== SURFACE.SAND || c.ground < 1) throw new Error(`surface ${c.surface} ground ${c.ground}`);
    return `ground ${c.ground}`;
  });
  gate(`Presidio Main Post is land, ground ${Math.round(3 * tx)}-${Math.round(8 * tx)}`, () => {
    const c = city.at(P.presidioMainPost.lat, P.presidioMainPost.lon);
    if (c.ground < Math.round(3 * tx) || c.ground > Math.round(8 * tx) || isWater(c.surface)) throw new Error(`ground ${c.ground} surface ${c.surface}`);
    return `ground ${c.ground}`;
  });
  gate("Civic Center station slab is gone: ROAD/PLAZA/SIDEWALK, no building", () => {
    const c = city.at(P.civicCenterStation.lat, P.civicCenterStation.lon);
    if (c.building || ![SURFACE.ROAD, SURFACE.PLAZA, SURFACE.SIDEWALK].includes(c.surface)) throw new Error(`surface ${c.surface} building ${c.building?.id ?? "-"}`);
    return `surface ${c.surface}`;
  });
  gate("4th St bridge over Mission Creek is a deck", () => {
    const c = city.at(P.fourthStBridge.lat, P.fourthStBridge.lon);
    if (c.deck === 0) throw new Error(`no deck (ground ${c.ground} surface ${c.surface})`);
    return `deck ${c.deck}, ground ${c.ground}`;
  });
  gate("Yerba Buena Gardens MLK fountain has ground > 0", () => {
    const c = city.at(P.ybgFountain.lat, P.ybgFountain.lon);
    if (c.ground < 1) throw new Error(`ground ${c.ground} surface ${c.surface}`);
    return `ground ${c.ground} surface ${c.surface}`;
  });
  gate("Union Square is not PARKING", () => {
    const c = city.at(P.unionSquare.lat, P.unionSquare.lon);
    if (c.surface === SURFACE.PARKING) throw new Error("surface PARKING");
    return `surface ${c.surface}`;
  });
  return gates;
}

/** GGB south tower in landmarks.bin (W3 mesh). → detail, or null when the mesh layer is still the empty W1 stub. */
function ggbTower(city) {
  if (city.landmarks.length === 0) return null;
  const p = lonLatToBlock(VERIFY.ggbSouthTower.lon, VERIFY.ggbSouthTower.lat, city.manifest.proj);
  const hit = city.landmarks.find((b) => p.x >= b.x - 8 && p.x <= b.x + b.sx + 8 && p.z >= b.z - 8 && p.z <= b.z + b.sz + 8 && b.y1 >= 60);
  if (!hit) throw new Error(`no landmark box ≥ 60 blocks tall within 8 blocks of ${Math.round(p.x)},${Math.round(p.z)}`);
  return `box at ${hit.x},${hit.z} to y${hit.y1}`;
}

function footprintGate(city) {
  let n = 0, wet = 0;
  const seen = new Set();
  for (const a of AREAS) {
    const p = join(RAW_DIR, areaSources(a).footprints.file);
    if (!existsSync(p)) throw new Error(`${p} missing: the water/land gate needs the raw DataSF footprints (npm run city:fetch)`);
    for (const f of JSON.parse(readFileSync(p, "utf8")).features) {
      if (seen.has(f.properties.area_id)) continue;
      seen.add(f.properties.area_id);
      const ring = f.geometry.coordinates[0][0];
      const lon = ring.reduce((s, q) => s + q[0], 0) / ring.length, lat = ring.reduce((s, q) => s + q[1], 0) / ring.length;
      if (!inAnyArea(lon, lat)) continue;
      n++;
      if (isWater(city.at(lat, lon).surface)) wet++;
    }
  }
  if (n === 0) throw new Error("water/land gate: no DataSF footprints inside the areas");
  const ratio = wet / n;
  if (ratio > MAX_FOOTPRINTS_ON_WATER) throw new Error(`${wet}/${n} footprint centroids on WATER (${(ratio * 100).toFixed(2)}% > 0.5%)`);
  return `${wet}/${n} footprint centroids on water (${(ratio * 100).toFixed(3)}%)`;
}

function skirtGate(city) {
  const key = ([cx, cz]) => `${cx},${cz}`;
  const listed = new Set(city.manifest.chunks.list.map(key));
  const s = skirtHeights([...city.chunks.values()], listed, new Set(city.manifest.water.map(key)), city.landmask);
  if (s.length === 0) throw new Error("no listed chunk borders unbuilt land; the skirt gate measured nothing");
  const p90 = percentile(s, 0.9);
  if (p90 >= MAX_SKIRT_P90) throw new Error(`p90 ${p90} blocks over ${s.length} edge columns`);
  return `p90 ${p90} blocks over ${s.length} edge columns (max ${s.reduce((m, v) => Math.max(m, v), 0)})`;
}

/** Decode the built city in `dir` and assert every known point + the water/land gate. → {passed, skipped} */
export async function verifySf(dir = "public/city/sf") {
  const city = loadCity(dir);
  const passed = [], failed = [], skipped = [];
  const run = (name, fn) => {
    try {
      const detail = fn();
      if (detail === null) {
        skipped.push(name);
        console.log(`- ${name}: skipped, landmarks.bin is still empty (W3 mesh layer not merged) [post-int]`);
        return;
      }
      passed.push(name);
      console.log(`✓ ${name}: ${detail}`);
    } catch (e) {
      failed.push(name);
      console.error(`✗ ${name}: ${e.message}`);
    }
  };
  run(`all ${city.manifest.chunks.list.length} manifest chunks exist and decode`, () => `${city.chunks.size} chunks, ${city.water.size} water`);
  for (const [name, fn] of knownPoints(city)) run(name, fn);
  run("Golden Gate Bridge south tower is in landmarks.bin", () => ggbTower(city));
  run("water/land gate (≤0.5% footprint centroids on water)", () => footprintGate(city));
  run("unbuilt-land skirts under 2 blocks at p90", () => skirtGate(city));
  if (failed.length) throw new Error(`verify-sf: ${failed.length} gate(s) failed: ${failed.join("; ")}`);
  console.log(`verify-sf: ${passed.length} passed, ${skipped.length} skipped (1 block = ${BLOCK_M} m)`);
  return { passed, skipped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await verifySf();
