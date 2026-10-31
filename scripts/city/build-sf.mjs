// Build public/city/sf/{manifest.json,chunks/*,LICENSE.txt} and data/city/sf/build/{report.json,topdown.png}
// from the raw cache (never the network). Spec: docs/city/spec.md section 2.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import {
  CITY_VERSION, BLOCK_M, CHUNK, SURFACE, blockToLonLat, chunkKey, encodeChunk, lonLatToBlock, paletteFor, validateManifest,
} from "../../public/shared/city.js";
import { readSources } from "./lib/http.mjs";
import { assembleRings, polygonArea, ringsToPolygons, scanPolygon, stampLine } from "./lib/geo.mjs";
import { buildWaterMask } from "./lib/mask.mjs";
import { DECK_CLASSES, highwayClass, keepHighway, landcoverSurface, layerOf, levelsHeightM, parseHeightM, roadSpec } from "./lib/osm.mjs";
import { createRaster, rasterIndex, rasterToChunks } from "./lib/raster.mjs";
import { createElevation } from "./lib/terrain.mjs";
import { baseTop, mergeBuildings } from "./lib/buildings.mjs";
import { renderTopdown } from "./lib/topdown.mjs";
import { terrainTiles } from "./fetch-sf.mjs";
import {
  ATTRIBUTION, BBOX, BUDGET, BUILD_DIR, CHUNK_MAX, CHUNK_MIN, CITY, MASK, NAME, OUT_DIR, PROJ, RAW_DIR, SPAWN,
} from "./sf/config.mjs";

const OVERRIDES_PATH = new URL("./sf/overrides.json", import.meta.url);
const MAX_UNCLOSABLE = 0.01;
const MAX_UNPARSEABLE = 0.02;
const SHALLOW_RADIUS = 2;
const RAIL_WIDTH = 2;
const PIER_LINE_WIDTH = 2;
const PILLAR_EVERY = 12;
const DECK_GROUND_RADIUS = 3;
const MAX_DECK_WATER = 0.5;

const toBlock = (lon, lat) => {
  const p = lonLatToBlock(lon, lat, PROJ);
  return [p.x, p.z];
};
const ringFromGeoJSON = (ring) => ring.map(([lon, lat]) => toBlock(lon, lat));
const ringFromOsm = (geom) => geom.map((p) => toBlock(p.lon, p.lat));
const isWater = (s) => s === SURFACE.WATER || s === SURFACE.SHALLOW;
const inc = (obj, k) => { obj[k] = (obj[k] ?? 0) + 1; };

function readJson(rel) {
  const p = join(RAW_DIR, rel);
  if (!existsSync(p)) throw new Error(`raw file missing: ${p} (run npm run city:fetch)`);
  return JSON.parse(readFileSync(p, "utf8"));
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
    if (e.tags?.type !== "multipolygon") return { notMultipolygon: true };
    const members = (e.members ?? []).filter((m) => m.type === "way").map((m) => ({ id: m.ref, role: m.role, geometry: m.geometry ? ringFromOsm(m.geometry) : null }));
    if (members.some((m) => !m.geometry)) return { unclosable: true };
    const { outers, inners, unclosable } = assembleRings(members);
    if (outers.length === 0) return { unclosable: true };
    return { polygons: ringsToPolygons(outers, inners), partialUnclosable: unclosable.length > 0 ? unclosable : null };
  }
  return { notMultipolygon: true };
}

function stampTerrainAndMask(raster, report) {
  const land = readJson("datasf/land.geojson");
  const landPolygons = land.features.flatMap((f) => {
    const g = f.geometry;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : null;
    if (!polys) throw new Error(`${MASK.id}: unexpected geometry ${g.type}`);
    return polys.map((p) => p.map(ringFromGeoJSON));
  });
  const water = buildWaterMask(raster, landPolygons);
  const elevation = createElevation(RAW_DIR, terrainTiles());
  const { x0, z0, w, h, ground, surface } = raster;
  let landCols = 0;
  for (let lz = 0; lz < h; lz++) {
    for (let lx = 0; lx < w; lx++) {
      const i = lz * w + lx;
      if (water[i]) {
        ground[i] = 0;
        surface[i] = SURFACE.WATER;
        continue;
      }
      const { lon, lat } = blockToLonLat(x0 + lx + 0.5, z0 + lz + 0.5, PROJ);
      const e = elevation.sample(lon, lat);
      if (!Number.isFinite(e)) throw new Error(`terrain: non-finite elevation at ${lon},${lat}`);
      ground[i] = Math.max(1, Math.round(e / BLOCK_M));
      surface[i] = ground[i] >= 20 ? SURFACE.HILL : SURFACE.GRASS;
      landCols++;
    }
  }
  report.mask = { dataset: MASK.dataset, polygons: landPolygons.length, landColumns: landCols, waterColumns: w * h - landCols };
  return water;
}

function stampLandcover(raster, report) {
  const doc = readJson("osm/osm-land.json");
  const features = [];
  const rails = [];
  const unmapped = {};
  let relations = 0, unclosableRelations = 0;
  const unclosable = [];
  for (const e of doc.elements) {
    const t = e.tags ?? {};
    if (e.type === "way" && (t.railway === "rail" || t.railway === "light_rail")) {
      const layer = layerOf(t);
      if (t.tunnel === "yes" || layer === null || layer < 0) inc(report.rail, "skippedTunnel");
      else rails.push(ringFromOsm(e.geometry));
      continue;
    }
    const s = landcoverSurface(t);
    if (s === null) {
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
  report.landcover = { features: features.length, columnsBySurface: counts, unmappedTags: unmapped };
  report.unclosable = { relations, unclosableRelations, list: unclosable };
  if (relations > 0 && unclosableRelations / relations > MAX_UNCLOSABLE) {
    throw new Error(`landcover: ${unclosableRelations}/${relations} relations unclosable (> ${MAX_UNCLOSABLE * 100}%)`);
  }
  return rails;
}

function stampRoads(raster, report) {
  const doc = readJson("osm/osm-roads.json");
  const { ground, surface } = raster;
  const roads = [];
  const decks = [];
  const unmapped = {};
  let dropped = 0;
  for (const e of doc.elements) {
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
    const layer = layerOf(t);
    const elevated = (t.bridge && t.bridge !== "no") || layer >= 1;
    if (elevated && DECK_CLASSES.has(highwayClass(t.highway))) decks.push({ id: e.id, line, spec, layer, tags: t });
    else roads.push({ line, spec });
  }
  const onLand = (s) => (x, z) => {
    const i = rasterIndex(raster, x, z);
    if (i >= 0 && ground[i] > 0) surface[i] = s;
  };
  for (const r of roads) if (r.spec.sidewalk > 0) stampLine(r.line, r.spec.roadway + 2 * r.spec.sidewalk, onLand(SURFACE.SIDEWALK));
  roads.sort((a, b) => a.spec.roadway - b.spec.roadway);
  for (const r of roads) stampLine(r.line, r.spec.roadway, onLand(r.spec.surface));
  report.roads = { kept: roads.length, dropped, unmappedClasses: unmapped };
  return decks;
}

function stampRails(raster, rails, report) {
  for (const line of rails) {
    stampLine(line, RAIL_WIDTH, (x, z) => {
      const i = rasterIndex(raster, x, z);
      if (i >= 0 && raster.ground[i] > 0) raster.surface[i] = SURFACE.RAIL;
    });
  }
  report.rail.lines = rails.length;
}

/**
 * Decks: slab tops and pillar flags; written into raster.deck after buildings (see finishDecks). Ways over
 * >50% mask water are skipped (spec); kept ways that run onto the bay (the Bay Bridge approach) are not
 * drawn over mask water either, so no deck hangs over open water in v1. Both are counted in the report.
 */
function planDecks(raster, water, decks, overrides, report) {
  const top = new Int16Array(raster.w * raster.h);
  const pillar = new Uint8Array(raster.w * raster.h);
  let skippedLenBlocks = 0, skippedWays = 0, stacked = 0, drawn = 0, overWater = 0;
  const overridden = [];
  for (const d of decks) {
    const centre = [];
    stampLine(d.line, 1, (x, z) => centre.push(rasterIndex(raster, x, z)));
    const inside = centre.filter((i) => i >= 0);
    if (inside.length === 0) continue;
    const wet = inside.filter((i) => water[i]).length;
    if (wet / inside.length > MAX_DECK_WATER) {
      skippedWays++;
      skippedLenBlocks += polylineLengthBlocks(d.line);
      continue;
    }
    const o = overrides[`o:w${d.id}`];
    let deckY;
    if (o?.deckY !== undefined) {
      deckY = o.deckY;
      overridden.push(d.id);
    } else {
      let gmax = 0;
      stampLine(d.line, 2 * DECK_GROUND_RADIUS, (x, z) => {
        const i = rasterIndex(raster, x, z);
        if (i >= 0 && raster.ground[i] > gmax) gmax = raster.ground[i];
      });
      deckY = gmax + 1 + 2 * Math.max(1, d.layer ?? 1);
    }
    drawn++;
    stampLine(d.line, d.spec.roadway, (x, z) => {
      const i = rasterIndex(raster, x, z);
      if (i < 0) return;
      if (water[i]) {
        overWater++;
        return;
      }
      if (top[i] !== 0 && top[i] !== deckY) stacked++;
      if (deckY > top[i]) top[i] = deckY;
    });
    for (const [px, pz] of pointsAlong(d.line, PILLAR_EVERY)) {
      const i = rasterIndex(raster, Math.floor(px), Math.floor(pz));
      if (i >= 0 && !water[i]) pillar[i] = 1;
    }
  }
  report.decks = { ways: decks.length, drawn, skippedOverWater: skippedWays, skippedLengthM: Math.round(skippedLenBlocks * BLOCK_M), stackedColumns: stacked, overWaterColumnsDropped: overWater, deckYOverrides: overridden.length };
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
  Object.assign(report.decks, { columns, pillars, blockedByGround: blocked });
}

function loadBuildings(raster, report) {
  const rx0 = raster.x0, rz0 = raster.z0, rx1 = raster.x0 + raster.w, rz1 = raster.z0 + raster.h;
  const overlaps = (polys) => polys.some((p) => p[0].some(([x, z]) => x >= rx0 - 1 && x <= rx1 + 1 && z >= rz0 - 1 && z <= rz1 + 1));
  const ds = readJson("datasf/footprints.geojson");
  const datasf = [];
  for (const f of ds.features) {
    const p = f.properties;
    const heightM = Number(p.hgt_median_m);
    if (!Number.isFinite(heightM)) throw new Error(`DataSF footprint ${p.area_id}: hgt_median_m ${p.hgt_median_m} is not a number`);
    if (f.geometry?.type !== "MultiPolygon") throw new Error(`DataSF footprint ${p.area_id}: geometry ${f.geometry?.type}`);
    const polygons = f.geometry.coordinates.map((poly) => poly.map(ringFromGeoJSON));
    if (!overlaps(polygons)) continue;
    datasf.push({ key: `d:${p.area_id}`, polygons, heightM: Math.max(0, heightM), peakM: p.peak_1st_m == null ? undefined : Number(p.peak_1st_m) });
  }
  const doc = readJson("osm/osm-buildings.json");
  const osm = [];
  let tagged = 0, unparseable = 0, relations = 0, unclosableRelations = 0;
  const unparseableList = [];
  const skipped = {};
  for (const e of doc.elements) {
    const t = e.tags ?? {};
    if (t.building === "no") {
      inc(skipped, "building=no");
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
    let heightM = null;
    if (t.height !== undefined || t["building:levels"] !== undefined) {
      tagged++;
      const h = t.height !== undefined ? parseHeightM(t.height) : null;
      const lv = levelsHeightM(t["building:levels"]);
      if ((t.height !== undefined && h === null) || (t.height === undefined && lv === null)) {
        unparseable++;
        unparseableList.push({ key: `o:${e.type[0]}${e.id}`, height: t.height, levels: t["building:levels"] });
      }
      heightM = h ?? lv;
    }
    osm.push({ key: `o:${e.type[0]}${e.id}`, polygons: shape.polygons, heightM });
  }
  report.osmBuildings = { kept: osm.length, tagged, unparseable, unparseableList, relations, unclosableRelations, skipped };
  if (tagged > 0 && unparseable / tagged > MAX_UNPARSEABLE) throw new Error(`buildings: ${unparseable}/${tagged} height tags unparseable (> ${MAX_UNPARSEABLE * 100}%)`);
  if (relations > 0 && unclosableRelations / relations > MAX_UNCLOSABLE) throw new Error(`buildings: ${unclosableRelations}/${relations} relations unclosable (> ${MAX_UNCLOSABLE * 100}%)`);
  return { datasf, osm };
}

function stampBuildings(raster, merged, datasf, report) {
  const { ground, surface, owner } = raster;
  const placed = [];
  for (const b of merged) {
    const cols = [];
    for (const p of b.polygons) scanPolygon(p, (x, z) => {
      const i = rasterIndex(raster, x, z);
      if (i >= 0) cols.push(i);
    });
    if (cols.length === 0) {
      const big = b.polygons.reduce((m, p) => (polygonArea(p) > polygonArea(m) ? p : m), b.polygons[0]);
      const ring = big[0];
      const cx = ring.reduce((s, q) => s + q[0], 0) / ring.length, cz = ring.reduce((s, q) => s + q[1], 0) / ring.length;
      const i = rasterIndex(raster, Math.floor(cx), Math.floor(cz));
      if (i >= 0) cols.push(i);
    }
    if (cols.length === 0) continue;
    const { base, top } = baseTop(cols.map((i) => Math.max(1, ground[i])), b.heightM);
    placed.push({ ...b, cols, base, top, roof: 0 });
  }
  const order = placed.map((_, k) => k).sort((a, c) => placed[c].top - placed[a].top || placed[a].id - placed[c].id);
  const lostColumns = new Map();
  for (const k of order) {
    const b = placed[k];
    let lost = 0;
    for (const i of b.cols) {
      if (owner[i] === -1) owner[i] = k;
      else if (owner[i] !== k) lost++;
    }
    if (lost) lostColumns.set(b.key, lost);
  }
  const owned = new Int32Array(placed.length);
  for (let i = 0; i < owner.length; i++) {
    const k = owner[i];
    if (k < 0) continue;
    owned[k]++;
    ground[i] = placed[k].base;
    if (isWater(surface[i])) surface[i] = SURFACE.PIER;
  }
  for (const b of placed) b.palette = b.palette ?? paletteFor(b.top - b.base, b.id);
  // coverage over in-bbox DataSF footprints (by centroid), counting only columns that carry that footprint's own id
  const placedByKey = new Map(placed.map((b, k) => [b.key, k]));
  const { x: bx0, z: bz0 } = lonLatToBlock(BBOX.west, BBOX.north, PROJ);
  const { x: bx1, z: bz1 } = lonLatToBlock(BBOX.east, BBOX.south, PROJ);
  let totalArea = 0, coveredArea = 0, footprints = 0, lostToNeighbours = 0;
  for (const d of datasf) {
    const ring = d.polygons[0][0];
    const cx = ring.reduce((s, q) => s + q[0], 0) / ring.length, cz = ring.reduce((s, q) => s + q[1], 0) / ring.length;
    if (cx < bx0 || cx >= bx1 || cz < bz0 || cz >= bz1) continue;
    footprints++;
    const area = d.polygons.reduce((s, p) => s + polygonArea(p), 0);
    totalArea += area;
    const k = placedByKey.get(d.key);
    if (k !== undefined) coveredArea += Math.min(area, owned[k]);
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
    coverage: { footprints, areaBlocks2: Math.round(totalArea), coveredBlocks2: Math.round(coveredArea), ratio: totalArea ? coveredArea / totalArea : 0, overlapColumnsLostByDatasf: lostToNeighbours },
    peak1stDisagreements: { count: peakDisagree.length, list: peakDisagree },
  };
  if (report.buildings.coverage.ratio < 0.9) throw new Error(`buildings: footprint coverage ${(report.buildings.coverage.ratio * 100).toFixed(1)}% < 90%`);
  return placed;
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

function licenseText(sources) {
  const terrain = sources.find((s) => s.id === "terrain");
  if (!terrain?.attribution) throw new Error("raw/sources.json has no terrain attribution text (run npm run city:fetch)");
  return [
    "San Francisco voxel city data (public/city/sf/)",
    "",
    "The data files under public/city/** (manifest.json, chunks/*.bin, companies.json) are a Derived Database",
    "of OpenStreetMap and are released under the Open Database License (ODbL) 1.0:",
    "https://opendatacommons.org/licenses/odbl/1-0/",
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

/** Run the full build from raw/ (never hits the network). → {manifest, report} */
export async function buildSf() {
  const t0 = Date.now();
  const sources = readSources(RAW_DIR);
  if (sources.length === 0) throw new Error(`${RAW_DIR}/sources.json is missing or empty (run npm run city:fetch)`);
  const overrides = JSON.parse(readFileSync(OVERRIDES_PATH, "utf8"));
  const report = { rail: {}, warnings: [] };
  const raster = createRaster(CHUNK_MIN, CHUNK_MAX);
  const lap = (what) => console.log(`  ${what} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  const water = stampTerrainAndMask(raster, report);
  lap("terrain + mask");
  const rails = stampLandcover(raster, report);
  lap("landcover");
  const decks = stampRoads(raster, report);
  stampRails(raster, rails, report);
  const deckPlan = planDecks(raster, water, decks, overrides, report);
  lap("roads, rail, decks");
  const { datasf, osm } = loadBuildings(raster, report);
  const { buildings: merged, report: mergeReport } = mergeBuildings({ datasf, osm, overrides });
  report.merge = mergeReport;
  const placed = stampBuildings(raster, merged, datasf, report);
  lap("buildings");
  finishDecks(raster, deckPlan, report);
  report.shallowColumns = stampShallow(raster);

  const { chunks, allWater } = rasterToChunks(raster, placed);
  lap("chunks");
  rmSync(join(OUT_DIR, "chunks"), { recursive: true, force: true });
  mkdirSync(join(OUT_DIR, "chunks"), { recursive: true });
  const list = [];
  let chunkBytes = 0, maxChunk = { key: null, bytes: 0 };
  const decoded = new Map();
  let yMax = 0;
  for (const c of chunks) {
    const gz = gzipSync(encodeChunk(c), { level: 9 });
    if (gz.length > BUDGET.chunkBytes) throw new Error(`chunk ${chunkKey(c.cx, c.cz)}: ${gz.length} bytes gz > ${BUDGET.chunkBytes}`);
    writeFileSync(join(OUT_DIR, "chunks", `${chunkKey(c.cx, c.cz)}.bin`), gz);
    list.push([c.cx, c.cz, gz.length]);
    chunkBytes += gz.length;
    if (gz.length > maxChunk.bytes) maxChunk = { key: chunkKey(c.cx, c.cz), bytes: gz.length };
    decoded.set(chunkKey(c.cx, c.cz), c);
    for (const b of c.buildings) if (b.top > yMax) yMax = b.top;
    for (let i = 0; i < c.deck.length; i++) if (Math.abs(c.deck[i]) > yMax) yMax = Math.abs(c.deck[i]);
    for (let i = 0; i < c.ground.length; i++) if (c.ground[i] > yMax) yMax = c.ground[i];
  }
  const manifest = validateManifest({
    version: CITY_VERSION,
    city: CITY,
    name: NAME,
    blockM: BLOCK_M,
    chunk: CHUNK,
    proj: { ...PROJ },
    chunks: { min: [...CHUNK_MIN], max: [...CHUNK_MAX], list },
    yRange: [0, yMax],
    spawn: { ...SPAWN },
    attribution: [ATTRIBUTION],
    sources: manifestSources(sources),
    builtAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  });
  const manifestJson = `${JSON.stringify(manifest)}\n`;
  if (manifestJson.length > BUDGET.manifestBytes) throw new Error(`manifest.json ${manifestJson.length} bytes > ${BUDGET.manifestBytes}`);
  writeFileSync(join(OUT_DIR, "manifest.json"), manifestJson);
  writeFileSync(join(OUT_DIR, "LICENSE.txt"), licenseText(sources));
  const companiesPath = join(OUT_DIR, "companies.json");
  const companiesBytes = existsSync(companiesPath) ? statSync(companiesPath).size : 0;
  const totalBytes = chunkBytes + manifestJson.length + statSync(join(OUT_DIR, "LICENSE.txt")).size + companiesBytes;
  const files = list.length + 2 + (companiesBytes ? 1 : 0);
  report.output = { chunks: list.length, allWaterChunks: allWater, chunkBytes, totalBytes, maxChunk, files, manifestBytes: manifestJson.length, companiesBytes };
  if (totalBytes > BUDGET.totalBytes) throw new Error(`public/city/sf: ${totalBytes} bytes > ${BUDGET.totalBytes}`);
  if (files > BUDGET.files) throw new Error(`public/city/sf: ${files} files > ${BUDGET.files}`);
  report.seconds = (Date.now() - t0) / 1000;
  report.heapMB = Math.round(process.memoryUsage().rss / 1e6);
  mkdirSync(BUILD_DIR, { recursive: true });
  writeFileSync(join(BUILD_DIR, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(BUILD_DIR, "topdown.png"), renderTopdown(manifest, decoded));
  lap(`wrote ${list.length} chunks (${(chunkBytes / 1e6).toFixed(2)} MB, ${allWater} all-water skipped), max ${maxChunk.key} ${maxChunk.bytes} B`);
  return { manifest, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildSf();
