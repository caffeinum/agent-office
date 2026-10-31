// Synthetic v2 test city: `npm run city:fixture` writes public/city/fixture/**. Built through the W1 raster API
// (lib/raster.mjs), so it also exercises setColumn / setSurface / addEntry / addProp / rasterToChunks.
// Deterministic: running it twice gives byte-identical files (format.check compares against disk).
//
// v1 features (unchanged places): a hill rising to 30, a water strip with a pier and a building on it, a 4-wide
// road with sidewalks, 10 flat towers up to 100, a deck with pillars, a sloped lot (base/top rule), 3 companies
// (two share a tower). v2 features: a taper tower using the per-column top layer with a 1×1 spire prop, a sawtooth
// slab, a two-part landmark sharing a parent (one part with accentFrom), a 3-block-high bowl with a field and
// emissive light props, a POOL on the hill, a short bridge deck over an inlet with walk nodes at deck y,
// DIRT/COURT/TRACK surfaces; listed, water (59,27), unbuilt (cx 55) and sea chunks with a landmask.bin;
// a 40-node walk.bin with 3 company sites; places.json; a 50-box landmarks.bin.
import { gzipSync } from "node:zlib";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BLOCK_M, CAP, CHUNK, CITY_VERSION, FACADE, LANDMASK_CELL, PALETTE_INDEX, SF_PROJ, SURFACE, WALK_NO_NAME, blockToLonLat,
  chunkKey, chunkOf, encodeChunk, encodeLandmarks, encodeLandmask, encodeWalk, intersectionName, lonLatToBlock, packEdgeWidth,
  paletteFor, validateCompanies, validateManifest, validatePlaces,
} from "../../public/shared/city.js";
import { createRaster, rasterToChunks } from "./lib/raster.mjs";
import { renderTopdown } from "./lib/topdown.mjs";

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../public/city/fixture");
const CX0 = 56;
const CZ0 = 24;
const N = 4;
const W = N * CHUNK;
const X0 = CX0 * CHUNK;
const Z0 = CZ0 * CHUNK;
/** Reserved grid: room for an unbuilt column of chunks (cx 55) and sea (cx 60, cz 28). */
export const FIXTURE_GRID = Object.freeze([61, 29]);
const UNBUILT_CX = 55;
const UNBUILT_HEIGHT = 2;
const BUILT_AT = "2026-10-31T00:00:00Z";
const VERIFIED_AT = "2026-10-31";
export const FIXTURE_PARENTS = Object.freeze({ 1001: "Fixture Ferry", 1002: "Fixture Park" });
const FERRY = 1001;
const PARK = 1002;
const BRIDGE = Object.freeze({ lx0: 195, lx1: 197, lz0: 58, lz1: 72, y: 4 });

const rect = (x0, z0, x1, z1, fn) => {
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) fn(x, z);
};
const isWaterAt = (lx, lz) => lx >= 208 || (lz >= 190 && lx >= 188) || (lx >= 188 && lz >= 62 && lz <= 68);

function stampTerrain(r) {
  const i = (x, z) => z * W + x;
  rect(0, 0, W - 1, W - 1, (x, z) => {
    const k = i(x, z);
    r.ground[k] = 1;
    r.surface[k] = SURFACE.GRASS;
    const d = Math.hypot(x - 64, z - 64);
    if (d < 60) {
      r.ground[k] = Math.max(1, Math.round(30 * (1 - (d / 60) ** 2)));
      r.surface[k] = r.ground[k] >= 20 ? SURFACE.HILL : SURFACE.GRASS;
    }
    if (x >= 20 && x <= 60 && z >= 134 && z <= 175) r.ground[k] = 2 + Math.floor((x - 20) / 3);
    if (isWaterAt(x, z)) {
      r.ground[k] = 0;
      r.surface[k] = SURFACE.WATER;
    }
  });
  rect(0, 0, W - 1, W - 1, (x, z) => {
    if (r.surface[i(x, z)] !== SURFACE.WATER) return;
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, nz = z + dz;
      if (nx >= 0 && nz >= 0 && nx < W && nz < W && !isWaterAt(nx, nz)) r.surface[i(x, z)] = SURFACE.SHALLOW;
    }
  });
  const surf = (x0, z0, x1, z1, s) => rect(x0, z0, x1, z1, (x, z) => r.setSurface(X0 + x, Z0 + z, s));
  surf(140, 20, 180, 60, SURFACE.PARK);
  surf(145, 25, 150, 30, SURFACE.COURT);
  surf(140, 17, 180, 18, SURFACE.TRACK);
  surf(106, 133, 186, 138, SURFACE.PLAZA);
  surf(30, 92, 34, 96, SURFACE.POOL);
  rect(208, 96, 235, 124, (x, z) => {
    r.ground[i(x, z)] = 1;
    r.surface[i(x, z)] = SURFACE.PIER;
  });
}

function stampRoads(r) {
  const road = (x0, z0, x1, z1, s) => rect(x0, z0, x1, z1, (x, z) => {
    if (r.ground[z * W + x] > 0) r.surface[z * W + x] = s;
  });
  road(0, 127, 207, 132, SURFACE.SIDEWALK);
  road(99, 0, 104, W - 1, SURFACE.SIDEWALK);
  road(0, 128, 207, 131, SURFACE.ROAD);
  road(100, 0, 103, W - 1, SURFACE.ROAD);
}

function stampDecks(r) {
  const deckY = 1 + 1 + 2;
  rect(8, 236, 92, 238, (x, z) => {
    r.deck[z * W + x] = z === 237 && (x - 8) % 12 === 0 ? -deckY : deckY;
  });
  rect(BRIDGE.lx0, BRIDGE.lz0, BRIDGE.lx1, BRIDGE.lz1, (x, z) => {
    const pillar = (z === BRIDGE.lz0 || z === BRIDGE.lz1) && x === BRIDGE.lx0 + 1;
    r.deck[z * W + x] = pillar ? -BRIDGE.y : BRIDGE.y;
  });
}

const box = (x0, z0, w, d, h) => {
  const cols = [];
  rect(x0, z0, x0 + w - 1, z0 + d - 1, (x, z) => cols.push([x, z, h]));
  return cols;
};

function defineBuildings() {
  const list = [];
  const heights = [100, 90, 80, 70, 60, 50, 40, 32, 24, 16];
  heights.forEach((h, k) => {
    list.push({ key: `fixture:tower-${String(k).padStart(2, "0")}`, cols: box(112 + (k % 5) * 14, 140 + Math.floor(k / 5) * 16, 6, 6, h) });
  });
  [2, 3, 4, 8, 12].forEach((h, k) => list.push({ key: `fixture:house-${k}`, cols: box(112 + k * 8, 176, 3, 3, h) }));
  list.push({ key: "fixture:pier-shed", cols: box(220, 104, 10, 10, 4) });
  list.push({ key: "fixture:sloped-lot", cols: box(30, 138, 10, 10, 4) });

  const taper = [];
  const tiers = [40, 50, 58, 64, 70, 76, 80];
  rect(140, 66, 153, 79, (x, z) => taper.push([x, z, tiers[Math.min(x - 140, 153 - x, z - 66, 79 - z)]]));
  list.push({ key: "fixture:v2-taper", cols: taper, spire: { at: [146, 72], h: 8 } });

  const saw = [];
  rect(112, 100, 135, 107, (x, z) => {
    const face = z === 100 || z === 107;
    if (!face || Math.floor((x - 112) / 2) % 2 === 0) saw.push([x, z, 20]);
  });
  list.push({ key: "fixture:v2-sawtooth", cols: saw });

  list.push({ key: "fixture:v2-ferry-shed", cols: box(160, 82, 26, 8, 5), parent: FERRY, facade: FACADE.ARCADE, palette: PALETTE_INDEX.ferry });
  const clock = [];
  rect(170, 74, 175, 79, (x, z) => clock.push([x, z, Math.min(x - 170, 175 - x, z - 74, 79 - z) >= 1 ? 30 : 24]));
  list.push({
    key: "fixture:v2-ferry-tower", cols: clock, parent: FERRY, cap: CAP.DOME, facade: FACADE.BLANK, palette: PALETTE_INDEX.ferry,
    accent: PALETTE_INDEX["salesforce-crown"], accentFrom: 20,
  });

  const stands = [];
  rect(10, 194, 50, 234, (x, z) => {
    const d = Math.hypot(x - 30, z - 214);
    if (d >= 12 && d < 18) stands.push([x, z, Math.min(3, 1 + Math.floor(0.6 * (d - 12)))]);
  });
  list.push({
    key: "fixture:v2-park-stands", cols: stands, parent: PARK, cap: CAP.SEATS, facade: FACADE.ARCADE,
    palette: PALETTE_INDEX["brick-dark"], accent: PALETTE_INDEX.seats,
  });
  list.push({ key: "fixture:v2-park-scoreboard", cols: box(26, 193, 8, 2, 6).filter(([x, z]) => Math.hypot(x - 30, z - 214) >= 18), parent: PARK, facade: FACADE.BLANK, palette: PALETTE_INDEX.concrete });

  list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return list.map((b, n) => ({ ...b, id: n + 1 }));
}

function stampBuildings(r, buildings) {
  for (const b of buildings) {
    let min = Infinity, max = -Infinity;
    for (const [x, z] of b.cols) {
      const g = r.ground[z * W + x];
      if (g < 1) throw new Error(`fixture: ${b.key} stands on water at ${x},${z}`);
      min = Math.min(min, g);
      max = Math.max(max, g);
    }
    b.base = min;
    b.top = max + Math.max(...b.cols.map((c) => c[2]));
    const palette = b.palette ?? paletteFor(b.top - b.base, b.id);
    r.addEntry({
      id: b.id, parent: b.parent ?? 0, base: b.base, top: b.top, palette, accent: b.accent ?? palette,
      cap: b.cap ?? CAP.FLAT, facade: b.facade ?? FACADE.WINDOWS, ...(b.accentFrom ? { accentFrom: b.base + b.accentFrom } : {}),
    });
    for (const [x, z, h] of b.cols) r.setColumn(X0 + x, Z0 + z, { bldg: b.id, base: b.base, top: max + h });
    if (b.spire) {
      const [sx, sz] = b.spire.at;
      const y0 = r.top[sz * W + sx];
      r.addProp(X0 + sx, Z0 + sz, { y0, y1: y0 + b.spire.h, color: PALETTE_INDEX.metal, flags: 0 });
    }
  }
}

function stampBowl(r, buildings) {
  rect(18, 202, 42, 226, (x, z) => {
    const d = Math.hypot(x - 30, z - 214);
    if (d >= 12) return;
    r.setSurface(X0 + x, Z0 + z, d < 4 || d >= 11 ? SURFACE.DIRT : SURFACE.GRASS);
  });
  const stands = buildings.find((b) => b.key === "fixture:v2-park-stands");
  for (const [dx, dz] of [[11, 11], [-11, 11], [11, -11], [-11, -11], [15, 0], [-15, 0]]) {
    const x = 30 + dx, z = 214 + dz;
    const y0 = r.top[z * W + x];
    if (r.owner[z * W + x] !== r.entryIndex(stands.id)) throw new Error(`fixture: light tower ${x},${z} is not on the stands`);
    r.addProp(X0 + x, Z0 + z, { y0, y1: stands.base + 9, color: PALETTE_INDEX.light, flags: 1 });
  }
}

const ANCHOR_PREFERENCE = [SURFACE.SIDEWALK, SURFACE.PLAZA, SURFACE.ROAD];
const ownerId = (r, k) => (r.owner[k] >= 0 ? r.entries[r.owner[k]].id : -1);

function placeSite(r, buildings, spec) {
  const b = buildings.find((x) => x.key === spec.building);
  if (!b) throw new Error(`fixture: no building ${spec.building}`);
  const [bx, bz] = b.cols[0];
  const lx = bx + spec.at[0];
  const lz = bz + spec.at[1];
  if (ownerId(r, lz * W + lx) !== b.id) throw new Error(`fixture: ${spec.id} point is outside ${spec.building}`);
  const ll = blockToLonLat(X0 + lx + 0.5, Z0 + lz + 0.5);
  const lat = Number(ll.lat.toFixed(7));
  const lon = Number(ll.lon.toFixed(7));
  const p = lonLatToBlock(lon, lat);
  const block = { x: Math.floor(p.x), z: Math.floor(p.z) };
  if (block.x !== X0 + lx || block.z !== Z0 + lz) throw new Error(`fixture: ${spec.id} lat/lon rounding moved the column`);
  let anchor = null;
  for (const want of ANCHOR_PREFERENCE) {
    let best = Infinity;
    rect(Math.max(0, lx - 12), Math.max(0, lz - 12), Math.min(W - 1, lx + 12), Math.min(W - 1, lz + 12), (x, z) => {
      const k = z * W + x;
      const d = Math.hypot(x - lx, z - lz);
      if (d <= 12 && d < best && r.owner[k] < 0 && r.surface[k] === want) {
        best = d;
        anchor = { x: X0 + x, y: r.ground[k], z: Z0 + z };
      }
    });
    if (anchor) break;
  }
  if (!anchor) throw new Error(`fixture: ${spec.id} has no sidewalk/plaza/road within 12 blocks`);
  return {
    id: spec.id, companyId: spec.companyId, name: spec.name, primary: true, address: spec.address, status: "hq",
    category: spec.category, color: spec.color,
    sources: [{ url: `https://example.com/${spec.companyId}/office`, kind: "occupancy", date: VERIFIED_AT }],
    verifiedAt: VERIFIED_AT, note: "synthetic fixture company", lat, lon,
    eas: { id: spec.easId, parcel: `FIXTURE-${spec.easId}` }, hintFrom: "fixture", buildingId: b.id, block,
    chunk: chunkOf(block.x, block.z), anchor, roofY: b.top, heightM: (b.top - b.base) * BLOCK_M,
    placement: "contains", placementDistM: 0,
  };
}

const SITES = [
  { id: "fixture-labs", companyId: "fixture-labs", name: "Fixture Labs", address: "1 Fixture Tower", category: "ai-lab", color: "#d97757", building: "fixture:tower-00", at: [1, 0], easId: 900001 },
  { id: "example-robotics", companyId: "example-robotics", name: "Example Robotics", address: "1 Fixture Tower", category: "robotics", color: "#4f7cff", building: "fixture:tower-00", at: [4, 0], easId: 900002 },
  { id: "sample-bakery", companyId: "sample-bakery", name: "Sample Bakery Co", address: "7 Slope Lane", category: "food", color: "#c08a3e", building: "fixture:sloped-lot", at: [4, 0], easId: 900003 },
];

/** 40 nodes: Fixture Ave (E-W), Test St (N-S), the bridge footway with deck nodes at deck y, Park Path, 3 site doors. */
function buildWalkGraph(r, sites) {
  const nodes = [];
  const index = new Map();
  const node = (lx, lz, y) => {
    const key = `${lx},${lz}`;
    if (index.has(key)) return index.get(key);
    const yy = y ?? r.ground[lz * W + lx];
    if (yy < 1) throw new Error(`fixture walk: node ${lx},${lz} is on water and not a deck`);
    nodes.push([lx, lz, yy]);
    index.set(key, nodes.length - 1);
    return nodes.length - 1;
  };
  const names = ["Fixture Ave", "Test St", "Fixture Bridge", "Park Path"];
  const edges = [];
  const link = (a, b, name, halfWidth10, deck = false) => {
    const [pa, pb] = [nodes[a], nodes[b]];
    const len10 = Math.max(1, Math.round(10 * Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2])));
    const w = packEdgeWidth(halfWidth10, deck);
    edges.push([a, b, len10, name, w], [b, a, len10, name, w]);
  };
  const chain = (ids, name, hw, deckAt = () => false) => ids.slice(1).forEach((b, k) => link(ids[k], b, name, hw, deckAt(ids[k], b)));

  const ave = [0, 20, 40, 60, 80, 101, 120, 140, 160, 180, 196, 206].map((x) => node(x, 129));
  chain(ave, 0, 20);
  const st = [0, 20, 40, 60, 80, 100, 115, 129, 150, 170, 190, 210, 230, 250].map((z) => node(101, z));
  chain(st, 1, 20);
  const isDeck = (lz) => lz >= BRIDGE.lz0 && lz <= BRIDGE.lz1;
  const bridge = [129, 110, 90, 73, 72, 65, 58, 50, 40].map((z) => node(196, z, isDeck(z) ? BRIDGE.y : undefined));
  chain(bridge, 2, 10, (a, b) => isDeck(nodes[a][1]) && isDeck(nodes[b][1]));
  const path = [node(101, 190), node(80, 190), node(55, 190), node(30, 190)];
  chain(path, 3, 10);
  const ferryDoor = node(172, 92);
  link(ferryDoor, index.get("196,90"), WALK_NO_NAME, 10);
  const doors = sites.map((s) => {
    const lx = s.anchor.x - X0, lz = s.anchor.z - Z0;
    const d = node(lx, lz);
    const near = ave.reduce((best, n) => (Math.hypot(nodes[n][0] - lx, nodes[n][1] - lz) < Math.hypot(nodes[best][0] - lx, nodes[best][1] - lz) ? n : best), ave[0]);
    if (near !== d) link(d, near, WALK_NO_NAME, 10);
    return d;
  });
  const flat = new Int32Array(nodes.length * 3);
  nodes.forEach(([x, z, y], k) => flat.set([(X0 + x) * 10 + 5, (Z0 + z) * 10 + 5, y * 10], k * 3));
  return {
    graph: { builtAt: Date.parse(BUILT_AT), nodes: flat, edges: new Int32Array(edges.flat()), names },
    at: { intersection: index.get("101,129"), ferryDoor, bowlGate: index.get("30,190"), doors },
  };
}

function placeAt(id, kind, name, aliases, lx, lz, nodeIdx, extra = {}) {
  const ll = blockToLonLat(X0 + lx + 0.5, Z0 + lz + 0.5);
  const lat = Number(ll.lat.toFixed(7)), lon = Number(ll.lon.toFixed(7));
  const p = lonLatToBlock(lon, lat);
  return { id, kind, name, aliases, lat, lon, x: Number(p.x.toFixed(3)), z: Number(p.z.toFixed(3)), node: nodeIdx, ...extra };
}

function buildPlaces(sites, at) {
  const places = sites.map((s, k) => {
    const p = lonLatToBlock(s.lon, s.lat);
    return {
      id: `site:${s.id}`, kind: "company", name: s.name, aliases: [s.address], lat: s.lat, lon: s.lon,
      x: Number(p.x.toFixed(3)), z: Number(p.z.toFixed(3)), node: at.doors[k], siteId: s.id, door: [s.anchor.x, s.anchor.z],
    };
  });
  places.push(placeAt("lm:fixture-ferry", "landmark", "Fixture Ferry", ["the ferry"], 172, 86, at.ferryDoor));
  places.push(placeAt("x:fixture-ave&test-st", "intersection", intersectionName("Fixture Ave", "Test St"), [intersectionName("Test St", "Fixture Ave")], 101, 129, at.intersection));
  places.push(placeAt("area:fixture-park", "area", "Fixture Park", ["the park"], 30, 214, at.bowlGate));
  return { builtAt: BUILT_AT, places };
}

/** 50 boxes: a small suspension truss over the inlet bridge (legs, cross-beams, two catenary cables). */
function buildLandmarkBoxes() {
  const boxes = [];
  const color = PALETTE_INDEX["golden-gate"];
  for (const lz of [60, 70]) {
    for (const lx of [194, 198]) boxes.push({ x: X0 + lx, z: Z0 + lz, y0: 1, y1: 14, sx: 1, sz: 1, color, flags: 0 });
    for (const y of [13, 8]) boxes.push({ x: X0 + 194, z: Z0 + lz, y0: y, y1: y + 1, sx: 5, sz: 1, color, flags: 0 });
  }
  for (const lx of [194, 198]) {
    for (let lz = 55; lz <= 75; lz++) {
      const t = (lz - 65) / 5;
      const y = Math.min(13, 5 + Math.round(8 * t * t));
      boxes.push({ x: X0 + lx, z: Z0 + lz, y0: y, y1: y + 1, sx: 1, sz: 1, color, flags: 0 });
    }
  }
  return boxes;
}

function buildLandmask(r) {
  const [gx, gz] = FIXTURE_GRID;
  const cellsX = (gx * CHUNK) / LANDMASK_CELL, cellsZ = (gz * CHUNK) / LANDMASK_CELL;
  const cells = new Uint8Array(cellsX * cellsZ);
  const per = CHUNK / LANDMASK_CELL;
  for (let cz = CZ0; cz < CZ0 + N; cz++) {
    for (let k = 0; k < per; k++) for (let j = 0; j < per; j++) cells[(cz * per + k) * cellsX + UNBUILT_CX * per + j] = UNBUILT_HEIGHT + 1;
  }
  for (let mz = 0; mz < W / LANDMASK_CELL; mz++) {
    for (let mx = 0; mx < W / LANDMASK_CELL; mx++) {
      let sum = 0, land = 0;
      rect(mx * LANDMASK_CELL, mz * LANDMASK_CELL, mx * LANDMASK_CELL + LANDMASK_CELL - 1, mz * LANDMASK_CELL + LANDMASK_CELL - 1, (x, z) => {
        const g = r.ground[z * W + x];
        if (g > 0) { sum += g; land++; }
      });
      if (land * 2 >= LANDMASK_CELL * LANDMASK_CELL) cells[(Z0 / LANDMASK_CELL + mz) * cellsX + X0 / LANDMASK_CELL + mx] = Math.min(255, Math.round(sum / land) + 1);
    }
  }
  return { cellsX, cellsZ, cells };
}

function areaBox(id, x0, z0, x1, z1) {
  const ll = [[x0, z0], [x1, z0], [x0, z1], [x1, z1]].map(([x, z]) => blockToLonLat(x, z));
  const r7 = (v, up) => (up ? Math.ceil(v * 1e5) : Math.floor(v * 1e5)) / 1e5;
  return {
    id,
    west: r7(Math.min(...ll.map((p) => p.lon)), false), east: r7(Math.max(...ll.map((p) => p.lon)), true),
    south: r7(Math.min(...ll.map((p) => p.lat)), false), north: r7(Math.max(...ll.map((p) => p.lat)), true),
  };
}

/** → Map of path (relative to public/city/fixture) → bytes. */
export function generateFixture() {
  const r = createRaster([CX0, CZ0], [CX0 + N - 1, CZ0 + N - 1]);
  stampTerrain(r);
  stampRoads(r);
  stampDecks(r);
  const buildings = defineBuildings();
  stampBuildings(r, buildings);
  stampBowl(r, buildings);
  const { chunks, water } = rasterToChunks(r, FIXTURE_PARENTS);
  const files = new Map();
  const list = [];
  let yMin = Infinity, yMax = -Infinity;
  for (const c of chunks) {
    const gz = gzipSync(encodeChunk(c, FIXTURE_PARENTS), { level: 9 });
    files.set(`chunks/${chunkKey(c.cx, c.cz)}.bin`, gz);
    list.push([c.cx, c.cz, gz.length]);
    for (let i = 0; i < c.ground.length; i++) {
      yMin = Math.min(yMin, c.ground[i]);
      yMax = Math.max(yMax, c.ground[i], Math.abs(c.deck[i]), c.top[i]);
    }
    for (const p of c.props) yMax = Math.max(yMax, p.y1);
  }
  const manifest = validateManifest({
    version: CITY_VERSION, city: "fixture", name: "Fixture City", blockM: BLOCK_M, chunk: CHUNK, proj: { ...SF_PROJ },
    terrainExaggeration: 1,
    chunks: { grid: [...FIXTURE_GRID], min: [CX0, CZ0], max: [CX0 + N - 1, CZ0 + N - 1], list },
    water,
    areas: [areaBox("fixture", X0, Z0, X0 + W, Z0 + W)],
    landmask: "landmask.bin", landmarks: "landmarks.bin", walk: "walk.bin", places: "places.json",
    parents: { ...FIXTURE_PARENTS },
    yRange: [yMin, yMax], spawn: { x: X0 + W / 2, z: Z0 + W / 2, dist: 400, az: Math.PI * 0.18 },
    attribution: ["Synthetic test city generated by scripts/city/fixture.mjs; no map data."],
    sources: [{ id: "fixture", url: "https://github.com/caffeinum/agent-office/blob/main/scripts/city/fixture.mjs", license: "MIT" }],
    builtAt: BUILT_AT,
  });
  const sites = SITES.map((s) => placeSite(r, buildings, s));
  const companies = validateCompanies({ version: CITY_VERSION, city: "fixture", builtAt: BUILT_AT, sites }, manifest);
  const { graph, at } = buildWalkGraph(r, sites);
  const walkBytes = encodeWalk(graph, manifest);
  const places = validatePlaces(buildPlaces(sites, at), manifest, graph);
  const landmask = buildLandmask(r);
  files.set("manifest.json", Buffer.from(JSON.stringify(manifest, null, 1) + "\n"));
  files.set("companies.json", Buffer.from(JSON.stringify(companies, null, 1) + "\n"));
  files.set("walk.bin", Buffer.from(walkBytes));
  files.set("places.json", Buffer.from(JSON.stringify(places, null, 1) + "\n"));
  files.set("landmask.bin", gzipSync(encodeLandmask(landmask, FIXTURE_GRID), { level: 9 }));
  files.set("landmarks.bin", gzipSync(encodeLandmarks(buildLandmarkBoxes(), FIXTURE_GRID), { level: 9 }));
  files.set("topdown.png", renderTopdown(manifest, new Map(chunks.map((c) => [chunkKey(c.cx, c.cz), c])), landmask));
  return files;
}

export function writeFixture(dir = FIXTURE_DIR) {
  const files = generateFixture();
  rmSync(join(dir, "chunks"), { recursive: true, force: true });
  for (const [rel, bytes] of files) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), bytes);
  }
  const total = [...files.values()].reduce((n, b) => n + b.length, 0);
  console.log(`fixture: ${files.size} files, ${total} bytes → ${dir}`);
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) writeFixture();
