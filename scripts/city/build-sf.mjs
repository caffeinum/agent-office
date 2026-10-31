// Build public/city/sf/{manifest.json,chunks/*,landmask.bin,landmarks.bin,report.json,LICENSE.txt} and
// data/city/sf/build/topdown.png from the raw cache (never the network). Spec: docs/city/spec.md §2 as amended by
// docs/city/spec-v2.md §1-3. Optional: CITY_TERRAIN_EXAGGERATION (sf/config.mjs).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import {
  BLOCK_M, CHUNK, CITY_VERSION, LANDMASK_CELL, SURFACE, blockToLonLat, chunkKey, encodeChunk, encodeLandmask,
  lonLatToBlock, osmColourToHex, osmMaterial, paletteFor, validateManifest,
} from "../../public/shared/city.js";
import { readSources } from "./lib/http.mjs";
import { assembleRings, pointInPolygon, polygonArea, ringCentroid, ringsToPolygons, scanPolygon, stampLine } from "./lib/geo.mjs";
import { buildLandmask, buildWaterMask, percentile, skirtHeights } from "./lib/mask.mjs";
import {
  DECK_CLASSES, SHORT_BRIDGE_M, dropBuildingReason, highwayClass, isBridge, keepHighway, landcoverSkipReason, landcoverSurface,
  layerOf, osmHeightM, osmMinHeightM, parseHeightM, roadSpec,
} from "./lib/osm.mjs";
import { createRaster, rasterIndex, rasterToChunks, resetChunkToSea } from "./lib/raster.mjs";
import { createElevation } from "./lib/terrain.mjs";
import { baseTop, boundsOf, centroidOf, gridIndex, mergeBuildings } from "./lib/buildings.mjs";
import { applyParts } from "./lib/parts.mjs";
import { createBuildCtx } from "./lib/ctx.mjs";
import { applyStructures, structureKind } from "./lib/structures.mjs";
import { applyLandmarks } from "./lib/landmarks.mjs";
import { calibrateSkyline } from "./lib/skyline.mjs";
import { buildLandmarkMesh } from "./lib/meshlayer.mjs";
import { renderTopdown } from "./lib/topdown.mjs";
import { areaSources, coarseTerrainTiles, terrainTiles } from "./fetch-sf.mjs";
import {
  AREAS, ATTRIBUTION, BUDGET, BUILD_DIR, CACHE_BUILDINGS, CITY, COARSE_TERRAIN_ZOOM, DROP_BUILDINGS, GRID, HILL_GROUND, HILL_SLOPE,
  HILL_SLOPE_RADIUS, LANDMARK_BRIDGE_RE, MASK, NAME, OUT_DIR, PROJ, RAW_DIR, SPAWN, TERRAIN_EXAGGERATION, TERRAIN_ZOOM, spawnAz,
} from "./sf/config.mjs";

const OVERRIDES_PATH = new URL("./sf/overrides.json", import.meta.url);
const SKYLINE_PATH = new URL("./sf/skyline.src.json", import.meta.url);
const MAX_UNCLOSABLE = 0.01;
const MAX_UNPARSEABLE = 0.02;
const SHALLOW_RADIUS = 2;
const RAIL_WIDTH = 2;
const PIER_LINE_WIDTH = 2;
const PILLAR_EVERY = 12;
const DECK_GROUND_RADIUS = 3;
const MAX_DECK_WATER = 0.5;
const SAMPLES = 8;
/** unresolvedTower: a DataSF max this far above what the raster reaches is a contradiction (spec-v2 §3.6). */
const TOWER_SLACK_M = 20;
const TOP50_RADIUS = 6;
const MIN_COVERAGE = 0.9;

const toBlock = (lon, lat) => {
  const p = lonLatToBlock(lon, lat, PROJ);
  return [p.x, p.z];
};
const ringFromGeoJSON = (ring) => ring.map(([lon, lat]) => toBlock(lon, lat));
const ringFromOsm = (geom) => geom.map((p) => toBlock(p.lon, p.lat));
const isWater = (s) => s === SURFACE.WATER || s === SURFACE.SHALLOW;
const inc = (obj, k) => { obj[k] = (obj[k] ?? 0) + 1; };
const inAnyArea = (lon, lat) => AREAS.some((a) => lon >= a.west && lon <= a.east && lat >= a.south && lat <= a.north);

function readJson(rel) {
  const p = join(RAW_DIR, rel);
  if (!existsSync(p)) throw new Error(`raw file missing: ${p} (run npm run city:fetch)`);
  return JSON.parse(readFileSync(p, "utf8"));
}

/** Elements of one OSM fetch kind over every area, deduped by type+id. */
function readOsm(kind) {
  const seen = new Map();
  for (const a of AREAS) {
    for (const e of readJson(areaSources(a)[kind].file).elements) seen.set(`${e.type}/${e.id}`, e);
  }
  return [...seen.values()];
}

function polylineLengthBlocks(points) {
  let s = 0;
  for (let i = 1; i < points.length; i++) s += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return s;
}

/** Points every `step` blocks along the polyline, starting at its first point. */
function pointsAlong(points, step) {
  const out = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1], [bx, bz] = points[i];
    const len = Math.hypot(bx - ax, bz - az);
    let t = step - carry;
    while (t <= len) {
      out.push([ax + ((bx - ax) * t) / len, az + ((bz - az) * t) / len]);
      t += step;
    }
    carry = len - (t - step);
  }
  return out;
}

/** OSM `out geom` element → {polygons} (closed way or multipolygon relation), {line} (open way), or {unclosable}. */
function osmShape(e) {
  if (e.type === "way") {
    if (!Array.isArray(e.geometry) || e.geometry.length < 2) return { unclosable: true };
    const ring = ringFromOsm(e.geometry);
    const closed = e.nodes ? e.nodes[0] === e.nodes[e.nodes.length - 1] : ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1];
    return closed && ring.length >= 4 ? { polygons: [[ring]] } : { line: ring };
  }
  if (e.type === "relation") {
    if (e.tags?.type !== "multipolygon" && e.tags?.type !== "building") return { notMultipolygon: true };
    const members = (e.members ?? []).filter((m) => m.type === "way" && (m.role === "outer" || m.role === "inner" || m.role === ""))
      .map((m) => ({ id: m.ref, role: m.role, geometry: m.geometry ? ringFromOsm(m.geometry) : null }));
    if (members.length === 0) return { notMultipolygon: true };
    if (members.some((m) => !m.geometry)) return { unclosable: true };
    const { outers, inners, unclosable } = assembleRings(members);
    if (outers.length === 0) return { unclosable: true };
    return { polygons: ringsToPolygons(outers, inners), partialUnclosable: unclosable.length > 0 ? unclosable : null };
  }
  return { notMultipolygon: true };
}

/** Chunks (cx, cz) of the reserved grid with at least one of their 8×8 samples inside an area. → Set "cx,cz" */
function areaChunks() {
  const out = new Set();
  const step = CHUNK / SAMPLES;
  for (let cz = 0; cz < GRID[1]; cz++) {
    for (let cx = 0; cx < GRID[0]; cx++) {
      let hit = false;
      for (let j = 0; j < SAMPLES && !hit; j++) {
        for (let i = 0; i < SAMPLES && !hit; i++) {
          const { lon, lat } = blockToLonLat(cx * CHUNK + (i + 0.5) * step, cz * CHUNK + (j + 0.5) * step, PROJ);
          hit = inAnyArea(lon, lat);
        }
      }
      if (hit) out.add(`${cx},${cz}`);
    }
  }
  if (out.size === 0) throw new Error("no chunk of the reserved grid samples inside an area");
  return out;
}

function chunkRange(keys) {
  const cs = [...keys].map((k) => k.split(",").map(Number));
  return {
    min: [Math.min(...cs.map((c) => c[0])), Math.min(...cs.map((c) => c[1]))],
    max: [Math.max(...cs.map((c) => c[0])), Math.max(...cs.map((c) => c[1]))],
  };
}

function landPolygons() {
  const land = readJson("datasf/land.geojson");
  return land.features.flatMap((f) => {
    const g = f.geometry;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : null;
    if (!polys) throw new Error(`${MASK.id}: unexpected geometry ${g.type}`);
    return polys.map((p) => p.map(ringFromGeoJSON));
  });
}

/** Ground in blocks from metres with the terrain knob. */
const groundFromM = (m) => Math.max(1, Math.round((m * TERRAIN_EXAGGERATION) / BLOCK_M));

/**
 * Mask, then ground for every land column (z15). In-area chunks must be covered by fetched tiles (throws); the
 * rest of the raster gets ground wherever tiles reach, so buildings straddling an area edge get a true base (the
 * out-of-area chunks are reset to sea before encode). Natural ground is HILL at HILL_GROUND or where the local
 * slope reaches HILL_SLOPE (hill shading data), else GRASS.
 */
function stampTerrainAndMask(raster, land, inArea, report) {
  const water = buildWaterMask(raster, land);
  const elevation = createElevation(RAW_DIR, terrainTiles(), TERRAIN_ZOOM);
  const { x0, z0, w, h, ground, surface } = raster;
  let landCols = 0;
  for (let lz = 0; lz < h; lz++) {
    const cz = Math.floor((z0 + lz) / CHUNK);
    for (let lx = 0; lx < w; lx++) {
      const i = lz * w + lx;
      if (water[i]) continue;
      const { lon, lat } = blockToLonLat(x0 + lx + 0.5, z0 + lz + 0.5, PROJ);
      if (!inArea.has(`${Math.floor((x0 + lx) / CHUNK)},${cz}`) && !elevation.covers(lon, lat)) continue;
      const e = elevation.sample(lon, lat);
      if (!Number.isFinite(e)) throw new Error(`terrain: non-finite elevation at ${lon},${lat}`);
      ground[i] = groundFromM(e);
      landCols++;
    }
  }
  const r = HILL_SLOPE_RADIUS;
  let hill = 0, steep = 0;
  for (let lz = 0; lz < h; lz++) {
    for (let lx = 0; lx < w; lx++) {
      const i = lz * w + lx;
      const g = ground[i];
      if (g === 0) continue;
      let slope = 0;
      for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
        const x = lx + dx, z = lz + dz;
        if (x < 0 || z < 0 || x >= w || z >= h) continue;
        const n = ground[z * w + x];
        if (n > 0) slope = Math.max(slope, Math.abs(n - g) / r);
      }
      const isHill = g >= HILL_GROUND || slope >= HILL_SLOPE;
      surface[i] = isHill ? SURFACE.HILL : SURFACE.GRASS;
      if (isHill) {
        hill++;
        if (g < HILL_GROUND) steep++;
      }
    }
  }
  report.mask = { dataset: MASK.dataset, polygons: land.length, landColumns: landCols, waterColumns: w * h - landCols };
  report.terrain = { exaggeration: TERRAIN_EXAGGERATION, hillColumns: hill, hillBySlope: steep, hillGround: HILL_GROUND, hillSlope: HILL_SLOPE };
  return water;
}

function stampLandcover(raster, report) {
  const elements = [...readOsm("land"), ...readOsm("extra").filter((e) => !(e.tags ?? {})["building:part"])];
  const seen = new Set();
  const features = [];
  const rails = [];
  const unmapped = {};
  const skipped = {};
  let relations = 0, unclosableRelations = 0;
  const unclosable = [];
  for (const e of elements) {
    const id = `${e.type}/${e.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const t = e.tags ?? {};
    if (e.type === "way" && (t.railway === "rail" || t.railway === "light_rail")) {
      const layer = layerOf(t);
      if (t.tunnel === "yes" || layer === null || layer < 0) inc(report.rail, "skippedTunnel");
      else rails.push({ id: e.id, line: ringFromOsm(e.geometry), tags: t });
      continue;
    }
    const s = landcoverSurface(t);
    if (s === null) {
      const why = landcoverSkipReason(t);
      if (why) {
        inc(skipped, why);
        continue;
      }
      const k = ["leisure", "landuse", "natural", "man_made", "amenity", "highway"].filter((k) => t[k]).map((k) => `${k}=${t[k]}`).join(",") || "(none)";
      inc(unmapped, k);
      continue;
    }
    if (e.type === "relation") relations++;
    const shape = osmShape(e);
    if (shape.unclosable || shape.partialUnclosable) {
      unclosableRelations += e.type === "relation" ? 1 : 0;
      unclosable.push({ id: `${e.type[0]}${e.id}`, members: shape.partialUnclosable ?? "all" });
    }
    if (shape.polygons) features.push({ s, polygons: shape.polygons, area: shape.polygons.reduce((a, p) => a + polygonArea(p), 0) });
    else if (shape.line && s === SURFACE.PIER) features.push({ s, line: shape.line, width: parseHeightM(t.width) ? Math.max(1, Math.round(parseHeightM(t.width) / BLOCK_M)) : PIER_LINE_WIDTH, area: 0 });
    else if (shape.line) inc(unmapped, `open way ${Object.entries(t).filter(([k]) => ["leisure", "landuse", "natural", "amenity"].includes(k)).map(([k, v]) => `${k}=${v}`).join(",")}`);
  }
  features.sort((a, b) => b.area - a.area);
  const { ground, surface } = raster;
  const counts = {};
  for (const f of features) {
    const visit = (x, z) => {
      const i = rasterIndex(raster, x, z);
      if (i < 0) return;
      if (f.s === SURFACE.WATER) {
        ground[i] = 0;
        surface[i] = SURFACE.WATER;
      } else if (f.s === SURFACE.PIER) {
        ground[i] = 1;
        surface[i] = SURFACE.PIER;
      } else if (ground[i] > 0) surface[i] = f.s;
      else return;
      inc(counts, f.s);
    };
    if (f.line) stampLine(f.line, f.width, visit);
    else for (const p of f.polygons) scanPolygon(p, visit);
  }
  report.landcover = { features: features.length, columnsBySurface: counts, skipped, unmappedTags: unmapped };
  report.unclosable = { relations, unclosableRelations, list: unclosable };
  if (relations > 0 && unclosableRelations / relations > MAX_UNCLOSABLE) {
    throw new Error(`landcover: ${unclosableRelations}/${relations} relations unclosable (> ${MAX_UNCLOSABLE * 100}%)`);
  }
  return rails;
}

/** Deck candidates (spec-v2 §3.8): elevated DECK_CLASSES ways, and any `bridge` way under 300 m (rail too). */
function deckKind(tags, lengthM, cls) {
  const bridge = isBridge(tags);
  if (bridge && lengthM < SHORT_BRIDGE_M) return "short";
  if ((bridge || layerOf(tags) >= 1) && cls !== null && DECK_CLASSES.has(cls)) return "elevated";
  return null;
}

function stampRoads(raster, report) {
  const { ground, surface } = raster;
  const roads = [];
  const decks = [];
  const unmapped = {};
  const droppedLandmarkDecks = [];
  let dropped = 0;
  for (const e of readOsm("roads")) {
    const t = e.tags ?? {};
    if (!keepHighway(t)) {
      dropped++;
      continue;
    }
    const spec = roadSpec(t);
    if (!spec) {
      inc(unmapped, t.highway);
      continue;
    }
    const line = ringFromOsm(e.geometry);
    const lengthM = polylineLengthBlocks(line) * BLOCK_M;
    const kind = deckKind(t, lengthM, highwayClass(t.highway));
    if (kind && LANDMARK_BRIDGE_RE.test(`${t.name ?? ""} ${t["bridge:name"] ?? ""}`)) {
      droppedLandmarkDecks.push(e.id);
      continue;
    }
    if (kind) decks.push({ id: e.id, line, width: spec.roadway, layer: layerOf(t), kind, tags: t });
    else roads.push({ line, spec });
  }
  const onLand = (s) => (x, z) => {
    const i = rasterIndex(raster, x, z);
    if (i >= 0 && ground[i] > 0) surface[i] = s;
  };
  for (const r of roads) if (r.spec.sidewalk > 0) stampLine(r.line, r.spec.roadway + 2 * r.spec.sidewalk, onLand(SURFACE.SIDEWALK));
  roads.sort((a, b) => a.spec.roadway - b.spec.roadway);
  for (const r of roads) stampLine(r.line, r.spec.roadway, onLand(r.spec.surface));
  report.roads = { kept: roads.length, dropped, unmappedClasses: unmapped, droppedLandmarkDecks };
  return decks;
}

function stampRails(raster, rails, decks, report) {
  let deckRails = 0;
  for (const r of rails) {
    const kind = deckKind(r.tags, polylineLengthBlocks(r.line) * BLOCK_M, null);
    if (kind) {
      decks.push({ id: r.id, line: r.line, width: RAIL_WIDTH, layer: layerOf(r.tags), kind, tags: r.tags });
      deckRails++;
      continue;
    }
    stampLine(r.line, RAIL_WIDTH, (x, z) => {
      const i = rasterIndex(raster, x, z);
      if (i >= 0 && raster.ground[i] > 0) raster.surface[i] = SURFACE.RAIL;
    });
  }
  report.rail.lines = rails.length - deckRails;
  report.rail.bridgeDecks = deckRails;
}

/**
 * Decks: slab tops and pillar flags; written into raster.deck after buildings (finishDecks). Short bridges (any
 * class, under 300 m) span water, with pillars on both banks; other elevated ways skip water columns and are
 * dropped when over half their centreline is water. report.decks = {wayId: deckY} for every drawn way (W5 reads it).
 */
function planDecks(raster, water, decks, overrides, report) {
  const top = new Int16Array(raster.w * raster.h);
  const pillar = new Uint8Array(raster.w * raster.h);
  let skippedLenBlocks = 0, skippedWays = 0, stacked = 0, overWater = 0, spanWater = 0;
  const overridden = [];
  const deckY = {};
  for (const d of decks) {
    const centre = [];
    stampLine(d.line, 1, (x, z) => centre.push(rasterIndex(raster, x, z)));
    if (centre.length === 0) centre.push(rasterIndex(raster, Math.floor(d.line[0][0]), Math.floor(d.line[0][1]))); // sub-block stub
    const inside = centre.filter((i) => i >= 0);
    if (inside.length === 0) continue;
    const short = d.kind === "short";
    const wet = inside.filter((i) => water[i]).length;
    if (!short && wet / inside.length > MAX_DECK_WATER) {
      skippedWays++;
      skippedLenBlocks += polylineLengthBlocks(d.line);
      continue;
    }
    const o = overrides[`o:w${d.id}`];
    let y;
    if (o?.deckY !== undefined) {
      y = o.deckY;
      overridden.push(d.id);
    } else {
      let gmax = 0;
      stampLine(d.line, 2 * DECK_GROUND_RADIUS, (x, z) => {
        const i = rasterIndex(raster, x, z);
        if (i >= 0 && raster.ground[i] > gmax) gmax = raster.ground[i];
      });
      y = gmax + 1 + 2 * Math.max(1, d.layer ?? 1);
    }
    deckY[d.id] = y;
    stampLine(d.line, d.width, (x, z) => {
      const i = rasterIndex(raster, x, z);
      if (i < 0) return;
      if (water[i]) {
        if (!short) {
          overWater++;
          return;
        }
        spanWater++;
      }
      if (top[i] !== 0 && top[i] !== y) stacked++;
      if (y > top[i]) top[i] = y;
    });
    for (const [px, pz] of pointsAlong(d.line, PILLAR_EVERY)) {
      const i = rasterIndex(raster, Math.floor(px), Math.floor(pz));
      if (i >= 0 && !water[i]) pillar[i] = 1;
    }
    if (short && wet > 0) {
      const dry = inside.filter((i) => !water[i]);
      if (dry.length) {
        pillar[dry[0]] = 1;
        pillar[dry[dry.length - 1]] = 1;
      }
    }
  }
  report.decks = deckY;
  report.deckStats = {
    ways: decks.length, drawn: Object.keys(deckY).length, short: decks.filter((d) => d.kind === "short").length,
    skippedOverWater: skippedWays, skippedLengthM: Math.round(skippedLenBlocks * BLOCK_M), stackedColumns: stacked,
    overWaterColumnsDropped: overWater, shortBridgeWaterColumns: spanWater, deckYOverrides: overridden.length,
  };
  return { top, pillar };
}

function finishDecks(raster, { top, pillar }, report) {
  let blocked = 0, columns = 0, pillars = 0;
  for (let i = 0; i < top.length; i++) {
    if (top[i] === 0) continue;
    if (top[i] <= raster.ground[i]) {
      blocked++;
      continue;
    }
    raster.deck[i] = pillar[i] ? -top[i] : top[i];
    columns++;
    if (pillar[i]) pillars++;
  }
  Object.assign(report.deckStats, { columns, pillars, blockedByGround: blocked });
}

/** Records in the frozen ctx shapes (lib/ctx.mjs): DataSF footprints and OSM buildings + parts, deduped across areas. */
function loadBuildings(raster, report) {
  const rx0 = raster.x0, rz0 = raster.z0, rx1 = raster.x0 + raster.w, rz1 = raster.z0 + raster.h;
  const overlaps = (polys) => polys.some((p) => p[0].some(([x, z]) => x >= rx0 - 1 && x <= rx1 + 1 && z >= rz0 - 1 && z <= rz1 + 1));
  const datasf = [];
  const dsSeen = new Set();
  for (const a of AREAS) {
    for (const f of readJson(areaSources(a).footprints.file).features) {
      const p = f.properties;
      if (dsSeen.has(p.area_id)) continue;
      dsSeen.add(p.area_id);
      const num = (v, what) => {
        const n = Number(v);
        if (v === null || v === undefined || !Number.isFinite(n)) throw new Error(`DataSF footprint ${p.area_id}: ${what} ${v} is not a number`);
        return n;
      };
      const heightM = Math.max(0, num(p.hgt_median_m, "hgt_median_m"));
      if (f.geometry?.type !== "MultiPolygon") throw new Error(`DataSF footprint ${p.area_id}: geometry ${f.geometry?.type}`);
      const polygons = f.geometry.coordinates.map((poly) => poly.map(ringFromGeoJSON));
      if (!overlaps(polygons)) continue;
      datasf.push({
        key: `d:${p.area_id}`, areaId: String(p.area_id), polygons, heightM, maxM: Math.max(heightM, num(p.hgt_maxcm, "hgt_maxcm") / 100),
        gndMinM: num(p.gnd_min_m, "gnd_min_m"), peakM: p.peak_1st_m == null ? null : num(p.peak_1st_m, "peak_1st_m"),
      });
    }
  }
  const osm = [];
  let tagged = 0, unparseable = 0, relations = 0, unclosableRelations = 0;
  const unparseableList = [];
  const skipped = {};
  const droppedUnderground = [];
  const drop = new Set(DROP_BUILDINGS);
  const elements = [...readOsm("buildings"), ...readOsm("extra").filter((e) => (e.tags ?? {})["building:part"] !== undefined)];
  const seen = new Set();
  for (const e of elements) {
    const id = `${e.type}/${e.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const t = e.tags ?? {};
    const key = `o:${e.type[0]}${e.id}`;
    const isPart = t["building:part"] !== undefined && t["building:part"] !== "no";
    if (!isPart && (t.building === "no" || t.building === undefined)) {
      inc(skipped, t.building === "no" ? "building=no" : "building:part=no");
      continue;
    }
    if (drop.has(key)) {
      inc(skipped, "landmark-only (config DROP_BUILDINGS)");
      continue;
    }
    if (e.type === "relation") relations++;
    const shape = osmShape(e);
    if (shape.notMultipolygon) {
      inc(skipped, `relation type=${t.type}`);
      continue;
    }
    if (shape.unclosable) {
      if (e.type === "relation") unclosableRelations++;
      inc(skipped, "unclosable");
      continue;
    }
    if (shape.partialUnclosable && e.type === "relation") unclosableRelations++;
    if (shape.line) {
      inc(skipped, "open way");
      continue;
    }
    if (!overlaps(shape.polygons)) continue;
    const why = dropBuildingReason(t);
    if (why) {
      droppedUnderground.push({ key, reason: why, isPart, location: t.location ?? null, polygons: shape.polygons });
      continue;
    }
    if (t.height !== undefined || t["building:levels"] !== undefined) {
      tagged++;
      if (osmHeightM(t) === null && (t.height !== undefined || Number(t["building:levels"]) !== 0)) {
        unparseable++;
        unparseableList.push({ key, height: t.height, levels: t["building:levels"] });
      }
    }
    osm.push({
      key, osmType: e.type, osmId: e.id, tags: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, String(v)])), polygons: shape.polygons,
      isPart, heightM: osmHeightM(t), minHeightM: osmMinHeightM(t), structure: null,
    });
  }
  report.osmBuildings = { kept: osm.length, parts: osm.filter((o) => o.isPart).length, tagged, unparseable, unparseableList, relations, unclosableRelations, skipped };
  if (tagged > 0 && unparseable / tagged > MAX_UNPARSEABLE) throw new Error(`buildings: ${unparseable}/${tagged} height tags unparseable (> ${MAX_UNPARSEABLE * 100}%)`);
  if (relations > 0 && unclosableRelations / relations > MAX_UNCLOSABLE) throw new Error(`buildings: ${unclosableRelations}/${relations} relations unclosable (> ${MAX_UNCLOSABLE * 100}%)`);
  // structure kinds (W3 hook) need the DataSF record under each OSM footprint
  const dsIndex = gridIndex(datasf);
  for (const o of osm) {
    const [cx, cz] = centroidOf(o);
    const ds = [...dsIndex(boundsOf(o))].map((i) => datasf[i]).find((d) => d.polygons.some((p) => pointInPolygon(cx, cz, p))) ?? null;
    o.structure = structureKind(o.tags, ds);
  }
  // spec-v2 §3.2 gate: a dropped building must be covered by DataSF or be tagged location=underground
  const unexplained = [];
  for (const d of droppedUnderground) {
    const [cx, cz] = ringCentroid(d.polygons[0][0]);
    const covered = [...dsIndex(boundsOf(d))].some((i) => datasf[i].polygons.some((p) => pointInPolygon(cx, cz, p)));
    d.datasfCovered = covered;
    if (!covered && d.location !== "underground" && !d.isPart) unexplained.push(d.key);
    delete d.polygons;
  }
  report.droppedUnderground = droppedUnderground;
  if (unexplained.length) throw new Error(`buildings: ${unexplained.length} dropped building(s) have no DataSF coverage and no location=underground: ${unexplained.slice(0, 20).join(", ")}`);
  return { datasf, osm };
}

/** Owner-resolve the merged buildings (taller wins), then write entries and columns through the raster API. */
function stampBuildings(raster, merged, datasf, report) {
  const { ground, surface } = raster;
  const placed = [];
  for (const b of merged) {
    const cols = [];
    for (const p of b.polygons) scanPolygon(p, (x, z) => {
      const i = rasterIndex(raster, x, z);
      if (i >= 0) cols.push(i);
    });
    if (cols.length === 0) {
      const big = b.polygons.reduce((m, p) => (polygonArea(p) > polygonArea(m) ? p : m), b.polygons[0]);
      const [cx, cz] = ringCentroid(big[0]);
      const i = rasterIndex(raster, Math.floor(cx), Math.floor(cz));
      if (i >= 0) cols.push(i);
    }
    if (cols.length === 0) continue;
    const heightBlocks = Math.max(1, Math.round(b.heightM / BLOCK_M));
    const { base, top } = baseTop(cols.map((i) => Math.max(1, ground[i])), b.heightM);
    placed.push({ ...b, cols, base, top, roofRef: top - heightBlocks });
  }
  const order = placed.map((_, k) => k).sort((a, c) => placed[c].top - placed[a].top || placed[a].id - placed[c].id);
  const claim = new Int32Array(ground.length).fill(-1);
  const lostColumns = new Map();
  for (const k of order) {
    let lost = 0;
    for (const i of placed[k].cols) {
      if (claim[i] === -1) claim[i] = k;
      else if (claim[i] !== k) lost++;
    }
    if (lost) lostColumns.set(placed[k].key, lost);
  }
  const owned = new Int32Array(placed.length);
  for (let i = 0; i < claim.length; i++) if (claim[i] >= 0) owned[claim[i]]++;
  const refByEntry = new Map();
  for (let k = 0; k < placed.length; k++) {
    if (owned[k] === 0) continue;
    const b = placed[k];
    const opts = {};
    const colour = osmColourToHex(b.tags?.["building:colour"]);
    if (colour) opts.colour = colour;
    const material = osmMaterial(b.tags?.["building:material"]);
    if (material) opts.material = material;
    if (b.structure) opts.structure = b.structure;
    b.palette = b.palette ?? paletteFor(b.top - b.base, b.id, opts);
    raster.addEntry({ id: b.id, base: b.base, top: b.top, palette: b.palette });
    refByEntry.set(raster.entryIndex(b.id), { roofRef: b.roofRef, base: b.base });
  }
  for (let i = 0; i < claim.length; i++) {
    const k = claim[i];
    if (k < 0) continue;
    const b = placed[k];
    if (isWater(surface[i])) surface[i] = SURFACE.PIER;
    raster.setColumn(raster.x0 + (i % raster.w), raster.z0 + Math.floor(i / raster.w), { bldg: b.id, base: b.base, top: b.top });
  }
  // coverage over in-area DataSF footprints (by centroid), counting only columns that carry that footprint's own id
  // a parcel deleted by a §3.4 rank-3 OSM outline counts as covered when that outline was placed (it owns columns)
  const placedByKey = new Map(placed.map((b, k) => [b.key, k]));
  const replacedBy = new Map();
  for (const d of report.deletedParcels) for (const key of d.parcels) replacedBy.set(key, d.key);
  let totalArea = 0, coveredArea = 0, replacedArea = 0, footprints = 0, lostToNeighbours = 0;
  for (const d of datasf) {
    const [cx, cz] = ringCentroid(d.polygons[0][0]);
    const { lon, lat } = blockToLonLat(cx, cz, PROJ);
    if (!inAnyArea(lon, lat)) continue;
    footprints++;
    const area = d.polygons.reduce((s, p) => s + polygonArea(p), 0);
    totalArea += area;
    const k = placedByKey.get(d.key);
    if (k !== undefined) coveredArea += Math.min(area, owned[k]);
    else if (replacedBy.has(d.key)) {
      const r = placedByKey.get(replacedBy.get(d.key));
      if (r !== undefined && owned[r] > 0) { coveredArea += area; replacedArea += area; }
    }
    lostToNeighbours += lostColumns.get(d.key) ?? 0;
  }
  const peakDisagree = placed
    .filter((b) => b.peakM !== undefined && Number.isFinite(b.peakM) && Math.abs(b.peakM - b.top * BLOCK_M) > 9)
    .map((b) => ({ key: b.key, id: b.id, peakM: b.peakM, topM: b.top * BLOCK_M }));
  report.buildings = {
    placed: placed.length,
    fullyOccluded: placed.filter((_, k) => owned[k] === 0).length,
    columns: owned.reduce((s, n) => s + n, 0),
    maxTop: Math.max(...placed.map((b) => b.top)),
    overlapColumnsLost: [...lostColumns.values()].reduce((s, n) => s + n, 0),
    coverage: { footprints, areaBlocks2: Math.round(totalArea), coveredBlocks2: Math.round(coveredArea), replacedByOsmBlocks2: Math.round(replacedArea), ratio: totalArea ? coveredArea / totalArea : 0, overlapColumnsLostByDatasf: lostToNeighbours },
    peak1stDisagreements: { count: peakDisagree.length, list: peakDisagree },
  };
  if (report.buildings.coverage.ratio < MIN_COVERAGE) throw new Error(`buildings: footprint coverage ${(report.buildings.coverage.ratio * 100).toFixed(1)}% < ${MIN_COVERAGE * 100}%`);
  return { placed, refOf: (k) => {
    const r = refByEntry.get(k);
    if (!r) throw new Error(`stampBuildings: entry index ${k} is not a merged building`);
    return r;
  } };
}

function stampShallow(raster) {
  const { w, h, ground, surface } = raster;
  let n = 0;
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const i = z * w + x;
      if (surface[i] !== SURFACE.WATER) continue;
      let near = false;
      for (let dz = -SHALLOW_RADIUS; dz <= SHALLOW_RADIUS && !near; dz++) {
        const zz = z + dz;
        if (zz < 0 || zz >= h) continue;
        for (let dx = -SHALLOW_RADIUS; dx <= SHALLOW_RADIUS; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w && ground[zz * w + xx] > 0) {
            near = true;
            break;
          }
        }
      }
      if (near) {
        surface[i] = SURFACE.SHALLOW;
        n++;
      }
    }
  }
  return n;
}

/**
 * spec-v2 §3.6: towers whose DataSF max height the raster does not reach (by TOWER_SLACK_M) after parts and
 * landmarks, plus OSM outlines tagged < 10 levels over a DataSF max above 100 m. The top-50 gate needs W3's
 * skyline.src.json; without it the gate is reported as not run.
 */
function unresolvedTowers(raster, placed, report) {
  const out = [];
  for (const b of placed) {
    if (b.maxM === null || b.medianM === null) continue;
    const gap = b.maxM - b.medianM > 40;
    const levels = Number(b.tags?.["building:levels"]);
    const lowLevels = b.tags && b.tags.height === undefined && Number.isFinite(levels) && levels < 10 && b.maxM > 100;
    if (!gap && !lowLevels) continue;
    let reachM = 0;
    for (const i of b.cols) if (raster.owner[i] >= 0 && raster.top[i] > 0) reachM = Math.max(reachM, (raster.top[i] - raster.ground[i]) * BLOCK_M);
    if (reachM >= b.maxM - TOWER_SLACK_M) continue;
    const ring = b.polygons[0][0];
    const [cx, cz] = ringCentroid(ring);
    const { lon, lat } = blockToLonLat(cx, cz, PROJ);
    out.push({ key: b.key, id: b.id, x: Math.round(cx), z: Math.round(cz), lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)), medianM: b.medianM, maxM: b.maxM, reachM, why: gap ? "datasf max-median > 40 m" : "levels < 10 with datasf max > 100 m" });
  }
  report.unresolvedTowerAll = out;
  if (!existsSync(SKYLINE_PATH)) {
    report.unresolvedTower = null;
    report.warnings.push("unresolvedTower top-50 gate not run: scripts/city/sf/skyline.src.json (W3) is missing");
    console.warn("  ! unresolvedTower top-50 gate not run: skyline.src.json (W3) is missing");
    return;
  }
  const sky = JSON.parse(readFileSync(SKYLINE_PATH, "utf8"));
  const rows = Array.isArray(sky) ? sky : sky.rows;
  if (!Array.isArray(rows)) throw new Error("skyline.src.json: expected an array of rows or {rows}");
  const pts = rows.filter((r) => r.rank === undefined || r.rank <= 50).map((r) => {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) throw new Error(`skyline.src.json: row ${JSON.stringify(r).slice(0, 80)} has no lat/lon`);
    return lonLatToBlock(r.lon, r.lat, PROJ);
  });
  const byKey = new Map(placed.map((b) => [b.key, b]));
  report.unresolvedTower = out.filter((t) => pts.some((p) => Math.hypot(p.x - t.x, p.z - t.z) <= TOP50_RADIUS
    || byKey.get(t.key).polygons.some((poly) => pointInPolygon(p.x, p.z, poly))));
  if (report.unresolvedTower.length) throw new Error(`unresolvedTower: ${report.unresolvedTower.length} top-50 tower(s) unresolved: ${JSON.stringify(report.unresolvedTower)}`);
}

function licenseText(sources) {
  const terrain = sources.find((s) => s.id === "terrain");
  if (!terrain?.attribution) throw new Error("raw/sources.json has no terrain attribution text (run npm run city:fetch)");
  return [
    "San Francisco voxel city data (public/city/sf/)",
    "",
    "The data files under public/city/** (manifest.json, chunks/*.bin, landmask.bin, landmarks.bin, walk.bin,",
    "places.json, companies.json, report.json) are a Derived Database of OpenStreetMap and are released under the",
    "Open Database License (ODbL) 1.0: https://opendatacommons.org/licenses/odbl/1-0/",
    "",
    "The rest of this repository, including the build scripts, stays under the MIT license.",
    "Means to reproduce the derived database: scripts/city/ (npm run city:fetch && npm run city:build) together",
    "with data/city/sf/raw/sources.json, which records the URL, license, fetch time and sha256 of every input.",
    "",
    "Attribution:",
    ATTRIBUTION,
    "",
    "Sources:",
    ...sources.filter((s) => !s.id.startsWith("terrarium-")).map((s) => `- ${s.id}: ${s.url} (${s.license})`),
    "",
    `Terrain tile sources (joerd attribution, verbatim from ${terrain.attributionUrl}):`,
    "",
    terrain.attribution.trimEnd(),
    "",
  ].join("\n");
}

function manifestSources(sources) {
  return sources
    .filter((s) => !s.id.startsWith("terrarium-"))
    .map((s) => (s.id === "terrain"
      ? { id: s.id, url: s.url, license: s.license, fetchedAt: s.fetchedAt, tiles: s.tiles.length, attributionUrl: s.attributionUrl }
      : { id: s.id, url: s.url, license: s.license, fetchedAt: s.fetchedAt, sha256: s.sha256 }));
}

/** Coarse + fine elevation for landmask cells: z15 where loaded, else z12. → (x, z) → ground blocks */
function coarseHeightAt() {
  const fine = createElevation(RAW_DIR, terrainTiles(), TERRAIN_ZOOM);
  const coarse = createElevation(RAW_DIR, coarseTerrainTiles(), COARSE_TERRAIN_ZOOM);
  return (x, z) => {
    const { lon, lat } = blockToLonLat(x, z, PROJ);
    const e = fine.covers(lon, lat) ? fine.sample(lon, lat) : coarse.sample(lon, lat);
    if (!Number.isFinite(e)) throw new Error(`landmask: non-finite elevation at ${lon},${lat}`);
    return groundFromM(e);
  };
}

const gz = (bytes) => gzipSync(bytes, { level: 9 });
const filesIn = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? filesIn(join(dir, d.name)) : [join(dir, d.name)]));

/** Run the full build from raw/ (never hits the network). → {manifest, report} */
export async function buildSf() {
  const t0 = Date.now();
  const sources = readSources(RAW_DIR);
  if (sources.length === 0) throw new Error(`${RAW_DIR}/sources.json is missing or empty (run npm run city:fetch)`);
  const overrides = JSON.parse(readFileSync(OVERRIDES_PATH, "utf8"));
  const report = { rail: {}, warnings: [] };
  const lap = (what) => console.log(`  ${what} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  const inArea = areaChunks();
  const range = chunkRange(inArea);
  const raster = createRaster(range.min, range.max);
  report.raster = { min: range.min, max: range.max, areaChunks: inArea.size };
  lap(`raster ${range.min}..${range.max}, ${inArea.size} area chunks`);
  const land = landPolygons();
  const water = stampTerrainAndMask(raster, land, inArea, report);
  lap("terrain + mask");
  const rails = stampLandcover(raster, report);
  lap("landcover");
  const terrainGround = raster.ground.slice();
  const decks = stampRoads(raster, report);
  stampRails(raster, rails, decks, report);
  const deckPlan = planDecks(raster, water, decks, overrides, report);
  lap("roads, rail, decks");
  const { datasf, osm } = loadBuildings(raster, report);
  const outlines = osm.filter((o) => !o.isPart).map((o) => ({ key: o.key, polygons: o.polygons, heightM: o.heightM, explicitHeightM: o.tags.height !== undefined ? parseHeightM(o.tags.height) : null, tags: o.tags, structure: o.structure }));
  const { buildings: merged, report: mergeReport } = mergeBuildings({ datasf, osm: outlines, overrides });
  report.merge = { ...mergeReport, deletedParcels: undefined, heightCopyBlocked: mergeReport.heightCopyBlocked.length };
  report.deletedParcels = mergeReport.deletedParcels;
  const { placed, refOf } = stampBuildings(raster, merged, datasf, report);
  const parts = applyParts(raster, osm.filter((o) => o.isPart), refOf);
  report.parts = { ...parts, droppedFloatingParts: undefined };
  report.droppedFloatingParts = parts.droppedFloatingParts;
  lap(`buildings (${placed.length}), parts (${parts.columns} columns)`);

  const groundAt = (x, z) => {
    const i = rasterIndex(raster, x, z);
    if (i < 0) throw new Error(`ctx.groundAt: block ${x},${z} is outside the raster`);
    return terrainGround[i];
  };
  mkdirSync(dirname(CACHE_BUILDINGS), { recursive: true });
  const ctx = createBuildCtx({ proj: PROJ, groundAt, osm, datasf, report });
  writeFileSync(CACHE_BUILDINGS, JSON.stringify({ builtFrom: sources.filter((s) => !s.id.startsWith("terrarium-")).map((s) => ({ id: s.id, sha256: s.sha256 })), osm, datasf }));
  applyStructures(raster, ctx);
  finishDecks(raster, deckPlan, report);
  report.shallowColumns = stampShallow(raster);
  applyLandmarks(raster, ctx);
  calibrateSkyline(raster, ctx);
  lap("hooks");
  unresolvedTowers(raster, placed, report);

  for (let cz = range.min[1]; cz <= range.max[1]; cz++) {
    for (let cx = range.min[0]; cx <= range.max[0]; cx++) if (!inArea.has(`${cx},${cz}`)) resetChunkToSea(raster, cx, cz);
  }
  const parents = mergeParents(raster.parents, report.parents ?? {});
  const { chunks, water: waterChunks } = rasterToChunks(raster, parents);
  const waterList = waterChunks.filter(([cx, cz]) => inArea.has(`${cx},${cz}`));
  lap(`chunks (${chunks.length} listed, ${waterList.length} water)`);

  const mask = buildLandmask({ grid: GRID, chunk: CHUNK, cell: LANDMASK_CELL, landPolygons: land, heightAt: coarseHeightAt() });
  const landmaskGz = gz(encodeLandmask(mask, GRID));
  if (landmaskGz.length > BUDGET.landmaskBytes) throw new Error(`landmask.bin ${landmaskGz.length} bytes gz > ${BUDGET.landmaskBytes}`);
  lap(`landmask ${mask.cellsX}×${mask.cellsZ} (${landmaskGz.length} B gz)`);
  const landmarksRaw = buildLandmarkMesh(ctx);
  if (!(landmarksRaw instanceof Uint8Array)) throw new Error("buildLandmarkMesh must return a Uint8Array (raw SFL1)");
  const landmarksGz = gz(landmarksRaw);

  rmSync(join(OUT_DIR, "chunks"), { recursive: true, force: true });
  mkdirSync(join(OUT_DIR, "chunks"), { recursive: true });
  const list = [];
  let chunkBytes = 0, maxChunk = { key: null, bytes: 0 };
  const decoded = new Map();
  let yMax = 0;
  for (const c of chunks) {
    const bytes = gz(encodeChunk(c, parents));
    if (bytes.length > BUDGET.chunkBytes) throw new Error(`chunk ${chunkKey(c.cx, c.cz)}: ${bytes.length} bytes gz > ${BUDGET.chunkBytes}`);
    writeFileSync(join(OUT_DIR, "chunks", `${chunkKey(c.cx, c.cz)}.bin`), bytes);
    list.push([c.cx, c.cz, bytes.length]);
    chunkBytes += bytes.length;
    if (bytes.length > maxChunk.bytes) maxChunk = { key: chunkKey(c.cx, c.cz), bytes: bytes.length };
    decoded.set(chunkKey(c.cx, c.cz), c);
    for (const b of c.buildings) if (b.top > yMax) yMax = b.top;
    for (const p of c.props) if (p.y1 > yMax) yMax = p.y1;
    for (let i = 0; i < c.deck.length; i++) if (Math.abs(c.deck[i]) > yMax) yMax = Math.abs(c.deck[i]);
    for (let i = 0; i < c.ground.length; i++) if (c.ground[i] > yMax) yMax = c.ground[i];
  }
  const shipped = chunkRange(new Set([...list, ...waterList].map(([cx, cz]) => `${cx},${cz}`)));
  const listedSet = new Set(list.map(([cx, cz]) => `${cx},${cz}`));
  const waterSet = new Set(waterList.map(([cx, cz]) => `${cx},${cz}`));
  const skirts = skirtHeights(chunks, listedSet, waterSet, mask);
  report.skirts = { columns: skirts.length, p50: percentile(skirts, 0.5), p90: percentile(skirts, 0.9), max: skirts.reduce((m, v) => Math.max(m, v), 0) };

  const spawn = lonLatToBlock(SPAWN.lon, SPAWN.lat, PROJ);
  const manifest = validateManifest({
    version: CITY_VERSION,
    city: CITY,
    name: NAME,
    blockM: BLOCK_M,
    chunk: CHUNK,
    proj: { ...PROJ },
    terrainExaggeration: TERRAIN_EXAGGERATION,
    chunks: { grid: [...GRID], min: shipped.min, max: shipped.max, list },
    water: waterList,
    areas: AREAS.map(({ id, west, south, east, north }) => ({ id, west, south, east, north })),
    landmask: "landmask.bin",
    landmarks: "landmarks.bin",
    walk: "walk.bin",
    places: "places.json",
    parents,
    yRange: [0, yMax],
    spawn: { x: Math.round(spawn.x), z: Math.round(spawn.z), dist: SPAWN.dist, az: Number(spawnAz().toFixed(6)) },
    attribution: [ATTRIBUTION],
    sources: manifestSources(sources),
    builtAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  });
  const manifestJson = `${JSON.stringify(manifest)}\n`;
  if (manifestJson.length > BUDGET.manifestBytes) throw new Error(`manifest.json ${manifestJson.length} bytes > ${BUDGET.manifestBytes}`);
  writeFileSync(join(OUT_DIR, "manifest.json"), manifestJson);
  writeFileSync(join(OUT_DIR, "landmask.bin"), landmaskGz);
  writeFileSync(join(OUT_DIR, "landmarks.bin"), landmarksGz);
  writeFileSync(join(OUT_DIR, "LICENSE.txt"), licenseText(sources));
  report.seconds = (Date.now() - t0) / 1000;
  report.heapMB = Math.round(process.memoryUsage().rss / 1e6);
  const reportJson = `${JSON.stringify(report)}\n`;
  writeFileSync(join(OUT_DIR, "report.json"), reportJson);
  const files = filesIn(OUT_DIR);
  const pending = ["walk.bin", "places.json", "companies.json"].filter((f) => !existsSync(join(OUT_DIR, f)));
  const totalBytes = files.reduce((s, f) => s + statSync(f).size, 0);
  const output = { chunks: list.length, water: waterList.length, chunkBytes, totalBytes, maxChunk, files: files.length, pendingFiles: pending, landmaskBytes: landmaskGz.length, landmarksBytes: landmarksGz.length, manifestBytes: manifestJson.length };
  console.log(`  output: ${JSON.stringify(output)}`);
  if (totalBytes > BUDGET.totalBytes) throw new Error(`public/city/sf: ${totalBytes} bytes > ${BUDGET.totalBytes}`);
  if (files.length + pending.length > BUDGET.files) throw new Error(`public/city/sf: ${files.length} files (+${pending.length} pending) > ${BUDGET.files}`);
  writeFileSync(join(OUT_DIR, "report.json"), `${JSON.stringify({ ...report, output })}\n`);
  mkdirSync(BUILD_DIR, { recursive: true });
  writeFileSync(join(BUILD_DIR, "topdown.png"), renderTopdown(manifest, decoded, mask));
  lap(`wrote ${list.length} chunks (${(chunkBytes / 1e6).toFixed(2)} MB), ${waterList.length} water, max ${maxChunk.key} ${maxChunk.bytes} B`);
  if (report.skirts.p90 >= 2) throw new Error(`unbuilt-land skirts: p90 ${report.skirts.p90} blocks ≥ 2 (report.json skirts)`);
  return { manifest, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildSf();

function mergeParents(...maps) {
  const out = {};
  for (const m of maps) for (const [id, name] of Object.entries(m)) {
    if (out[id] !== undefined && out[id] !== name) throw new Error(`parents: id ${id} is both "${out[id]}" and "${name}"`);
    out[id] = name;
  }
  return out;
}
