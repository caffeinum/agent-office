// The voxel city contract (v2): projection, chunk / landmarks / landmask / walk binary formats, surface classes,
// palette, and the manifest / companies / places validators. Shared by the build scripts (node), the viewer, the
// mesher worker (served as /shared/city.js) and the City DO (via src/city/*). Plain ESM, no DOM, no node APIs,
// no dependencies: the mesher worker imports this by relative path because module workers get no importmap.
//
// World: 1 block = 3 m on every axis. +x, +z are the rotated grid axes (option a: the SoMa street grid), y up,
// y = 0 is sea level (water top). A chunk is 64×64 columns; column index = lz * 64 + lx.
// Spec: docs/city/spec-v2.md (§1 projection, §4 format) on top of docs/city/spec.md.

export const CITY_VERSION = 2;
export const BLOCK_M = 3;
export const CHUNK = 64;
export const REGION = 4;
/** 1 office cell = 1/4 block = 0.75 m (spec section 1). */
export const OFFICE_CELL_BLOCKS = 0.25;

// ---------- projection ----------

/** Grid option a (spec-v2 §1.3, operator decision 2026-10-31): rigid rotation onto the SoMa street grid. */
export const ROT_DEG = 44.7;
/** Rotation pivot: the city centre. */
export const SF_PIVOT = Object.freeze({ lon: -122.4385, lat: 37.7715 });
/** The full-city box the reserved grid must hold, plus SF_MARGIN blocks on each side. */
export const SF_BOX = Object.freeze({ west: -122.52, south: 37.708, east: -122.3569, north: 37.845 });
export const SF_MARGIN = 64;

/** v1 local equirectangular base (unchanged): NW corner of SF is the unrotated origin. */
const SF_BASE = Object.freeze({ lon0: -122.52, lat0: 37.835, latRef: 37.77, mPerDegLat: 110574, mPerDegLon: 87995.8 });

/**
 * The SF projection, frozen per CITY_VERSION. Every number comes from fitProjection(SF_BASE, ROT_DEG, SF_PIVOT,
 * SF_BOX, SF_MARGIN); format.check asserts that. Durable data stores lat/lon or ids, never block coordinates.
 */
export const SF_PROJ = Object.freeze({
  ...SF_BASE,
  rotDeg: ROT_DEG,
  pivotX: 2390.553,
  pivotZ: 2340.483,
  x0: 3456,
  z0: 3712,
});
/** Reserved grid, in chunks per axis: chunk cx, cz ∈ [0, SF_GRID). */
export const SF_GRID = Object.freeze([112, 112]);

export const PROJ_KEYS = Object.freeze(["lon0", "lat0", "latRef", "mPerDegLat", "mPerDegLon", "rotDeg", "pivotX", "pivotZ", "x0", "z0"]);

const finite = (v, what) => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${what} must be a finite number, got ${v}`);
  return v;
};

const trig = (proj) => {
  const r = (finite(proj.rotDeg, "proj.rotDeg") * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r)];
};

/** v1 equirect (unrotated) block coordinates. */
function equirect(lon, lat, p) {
  return { xe: ((lon - p.lon0) * p.mPerDegLon) / BLOCK_M, ze: ((p.lat0 - lat) * p.mPerDegLat) / BLOCK_M };
}

/** lon/lat (degrees) → fractional block coordinates: v1 equirect, then rigid rotation about the pivot, then shift. */
export function lonLatToBlock(lon, lat, proj = SF_PROJ) {
  finite(lon, "lon");
  finite(lat, "lat");
  const [c, s] = trig(proj);
  const { xe, ze } = equirect(lon, lat, proj);
  const dx = xe - finite(proj.pivotX, "proj.pivotX"), dz = ze - finite(proj.pivotZ, "proj.pivotZ");
  return { x: c * dx - s * dz + finite(proj.x0, "proj.x0"), z: s * dx + c * dz + finite(proj.z0, "proj.z0") };
}

/** Fractional block coordinates → lon/lat (degrees). Exact inverse of lonLatToBlock. */
export function blockToLonLat(x, z, proj = SF_PROJ) {
  finite(x, "x");
  finite(z, "z");
  const [c, s] = trig(proj);
  const dx = x - finite(proj.x0, "proj.x0"), dz = z - finite(proj.z0, "proj.z0");
  const xe = c * dx + s * dz + finite(proj.pivotX, "proj.pivotX");
  const ze = -s * dx + c * dz + finite(proj.pivotZ, "proj.pivotZ");
  return { lon: proj.lon0 + (xe * BLOCK_M) / proj.mPerDegLon, lat: proj.lat0 - (ze * BLOCK_M) / proj.mPerDegLat };
}

/**
 * The projection for `rotDeg` about `pivot`: x0/z0 put the rotated `box` plus `margin` blocks in positive
 * coordinates, rounded up to a multiple of CHUNK; grid is the chunk count per axis that holds the shifted box plus
 * `margin` on the far side. (spec-v2 §1.1; the spec's "ceil((extent + 128) / 64)" undercounts by the x0 round-up.)
 * → {proj, grid: [gx, gz]}
 */
export function fitProjection(base, rotDeg, pivot, box, margin) {
  const { xe: pivotX, ze: pivotZ } = equirect(pivot.lon, pivot.lat, base);
  const unshifted = { ...base, rotDeg, pivotX: Math.round(pivotX * 1000) / 1000, pivotZ: Math.round(pivotZ * 1000) / 1000, x0: 0, z0: 0 };
  const corners = [[box.west, box.south], [box.west, box.north], [box.east, box.south], [box.east, box.north]]
    .map(([lon, lat]) => lonLatToBlock(lon, lat, unshifted));
  const minX = Math.min(...corners.map((p) => p.x)), maxX = Math.max(...corners.map((p) => p.x));
  const minZ = Math.min(...corners.map((p) => p.z)), maxZ = Math.max(...corners.map((p) => p.z));
  const x0 = Math.ceil((margin - minX) / CHUNK) * CHUNK;
  const z0 = Math.ceil((margin - minZ) / CHUNK) * CHUNK;
  const grid = [Math.ceil((x0 + maxX + margin) / CHUNK), Math.ceil((z0 + maxZ + margin) / CHUNK)];
  return { proj: { ...unshifted, x0, z0 }, grid };
}

/** Block (fractional ok) → the chunk that holds it, [cx, cz]. */
export function chunkOf(x, z) {
  return [Math.floor(finite(x, "x") / CHUNK), Math.floor(finite(z, "z") / CHUNK)];
}

/** "cx_cz": the chunk file stem (`chunks/{cx}_{cz}.bin`) and store key. */
export function chunkKey(cx, cz) {
  if (!Number.isInteger(cx) || !Number.isInteger(cz)) throw new Error(`chunkKey: integer cx, cz required, got ${cx}, ${cz}`);
  return `${cx}_${cz}`;
}

/** Chunk → its 4×4-chunk region, [rx, rz]; the region covers cx rx*4 .. rx*4+3. */
export function regionOf(cx, cz) {
  if (!Number.isInteger(cx) || !Number.isInteger(cz)) throw new Error(`regionOf: integer cx, cz required, got ${cx}, ${cz}`);
  return [Math.floor(cx / REGION), Math.floor(cz / REGION)];
}

// ---------- surfaces ----------

export const SURFACE = Object.freeze({
  WATER: 1,
  SHALLOW: 2,
  SAND: 3,
  GRASS: 4,
  PARK: 5,
  FOREST: 6,
  ROAD: 7,
  SIDEWALK: 8,
  RAIL: 9,
  PLAZA: 10,
  PIER: 11,
  HILL: 12,
  PARKING: 13,
  DIRT: 14,
  COURT: 15,
  TRACK: 16,
  /** fountains, ponds, layer ≥ 1 water on land: keeps its ground, is not a water surface. */
  POOL: 17,
  /** arterial asphalt (trunk / primary / secondary): darker than ROAD. */
  ROAD_MAJOR: 18,
});

/** true for the carriageway surfaces (the viewer sinks them a curb below the sidewalk). */
export const isRoadSurface = (s) => s === SURFACE.ROAD || s === SURFACE.ROAD_MAJOR;

export const SURFACE_COLORS = Object.freeze({
  [SURFACE.WATER]: "#3d7fb3",
  [SURFACE.SHALLOW]: "#5aa0cf",
  [SURFACE.SAND]: "#e9d8a6",
  [SURFACE.GRASS]: "#5b8a3c",
  [SURFACE.PARK]: "#56843d",
  [SURFACE.FOREST]: "#4a7236",
  [SURFACE.ROAD]: "#4a4d52",
  [SURFACE.SIDEWALK]: "#c9c4ba",
  [SURFACE.RAIL]: "#6b6158",
  [SURFACE.PLAZA]: "#d8cdbd",
  [SURFACE.PIER]: "#9a968f",
  [SURFACE.HILL]: "#c8b273",
  [SURFACE.PARKING]: "#8d8f93",
  [SURFACE.DIRT]: "#a8754d",
  [SURFACE.COURT]: "#7d8c7a",
  [SURFACE.TRACK]: "#b5523b",
  [SURFACE.POOL]: "#6fa8c0",
  [SURFACE.ROAD_MAJOR]: "#3c3f44",
});

const SURFACE_IDS = new Set(Object.values(SURFACE));
const isWaterSurface = (s) => s === SURFACE.WATER || s === SURFACE.SHALLOW;

const DIRT_SIDE = "#8a6b4e";
/** Colour of a column's exposed terrain side (cliffs, terraces, the land under a building). */
export const TERRAIN_SIDE_COLORS = Object.freeze({
  [SURFACE.WATER]: "#2f6a99",
  [SURFACE.SHALLOW]: "#2f6a99",
  [SURFACE.SAND]: "#d4c08c",
  [SURFACE.GRASS]: "#55783a",
  [SURFACE.PARK]: "#4f7136",
  [SURFACE.FOREST]: "#3f5f2e",
  [SURFACE.ROAD]: "#7d7870",
  [SURFACE.SIDEWALK]: "#a9a398",
  [SURFACE.RAIL]: "#5a5149",
  [SURFACE.PLAZA]: "#b3a998",
  [SURFACE.PIER]: "#7b7871",
  [SURFACE.HILL]: DIRT_SIDE,
  [SURFACE.PARKING]: "#7d7870",
  [SURFACE.DIRT]: "#86593a",
  [SURFACE.COURT]: "#9f9a92",
  [SURFACE.TRACK]: "#9f9a92",
  [SURFACE.POOL]: "#b3a998",
  [SURFACE.ROAD_MAJOR]: "#7d7870",
});

/** Land outside the listed chunks, drawn from landmask.bin (spec-v2 §2): muted paper tone, and its skirt sides. */
export const UNBUILT_COLORS = Object.freeze({ top: "#e4dccb", side: "#dcd3c1" });
/** Unbuilt land that is wild hillside rather than city (the Marin Headlands): olive scrub and dry grass. */
export const SCRUB_COLORS = Object.freeze({ green: "#7c8b52", tan: "#a39265", side: "#6c6747" });
/** The Marin Headlands across the Golden Gate: north of `south`, west of `east` (lon/lat). */
export const MARIN_BOX = Object.freeze({ south: 37.8185, east: -122.44 });
/** true when block (x, z) lies in the Marin Headlands box. */
export function inMarin(x, z, proj = SF_PROJ) {
  const { lon, lat } = blockToLonLat(x, z, proj);
  return lat > MARIN_BOX.south && lon < MARIN_BOX.east;
}

/** Elevated road decks: asphalt slab top, concrete edges and pillars, a shaded underside. */
export const DECK_COLORS = Object.freeze({
  top: "#4a4d52",
  edge: "#b5afa5",
  pillar: "#9f9a92",
  under: "#6e6a64",
});

// ---------- palette ----------

/** [name, colour]; a building entry's `palette`/`accent` byte, a prop's and a landmark box's `color` index this. */
const PALETTE = [
  // pastel Victorian (0–5)
  ["pastel-pink", "#f4c6c6"], ["pastel-blue", "#c9e2f0"], ["pastel-yellow", "#f6e3a6"],
  ["pastel-green", "#cfe8c9"], ["pastel-lilac", "#e4d3f2"], ["pastel-cream", "#fbf6ec"],
  // midrise brick / stucco (6–10)
  ["brick", "#a65a44"], ["brick-dark", "#8c4a3a"], ["stucco", "#e9dfcf"], ["stucco-tan", "#d8cdbd"], ["concrete-warm", "#b9b3a8"],
  // stone / concrete (11–14)
  ["stone-light", "#cfcac0"], ["concrete", "#b5afa5"], ["concrete-dark", "#9f9a92"], ["stone-white", "#e2ddd3"],
  // tall: stone / precast (15–18), blue-grey glass (19–20)
  ["precast-1", "#e6e1d6"], ["precast-2", "#d9d4c9"], ["precast-3", "#cfc8bb"], ["precast-4", "#bfb8ab"],
  ["glass", "#8ea3b3"], ["glass-dark", "#6f8799"],
  // landmarks and structures (21–38)
  ["salesforce", "#e6e7e3"], ["salesforce-crown", "#fffdf6"], ["transamerica", "#f2efe8"], ["fremont-181", "#c8d0d6"],
  ["california-555", "#5a3f38"], ["california-345", "#c9b9ad"], ["millennium", "#8fa4b4"], ["rincon", "#9fb3c2"],
  ["market-575", "#6b5e55"], ["embarcadero", "#ece8de"], ["ferry", "#f4efe2"], ["coit", "#e0e0e0"], ["seats", "#2e5e4e"],
  ["chase", "#dcdcd8"], ["bay-bridge", "#a7adb3"], ["golden-gate", "#a8301f"], ["palace", "#d8c3a5"], ["transit-white", "#f2f2ef"],
  // props (39–41); pier sheds use concrete-warm
  ["light", "#fff4d6"], ["metal", "#8a8f96"], ["flag", "#b8312f"],
  // trees and ballpark props (42–46)
  ["leaf", "#3f6a30"], ["trunk", "#5e4632"], ["steel-dark", "#3b3f45"], ["coke", "#c4232c"], ["glove", "#8b5a2b"],
];
export const BUILDING_PALETTE = Object.freeze(PALETTE.map(([, hex]) => hex));
/** name → palette index. */
export const PALETTE_INDEX = Object.freeze(Object.fromEntries(PALETTE.map(([name], i) => [name, i])));

const range = (a, b) => Object.freeze(Array.from({ length: b - a + 1 }, (_, i) => a + i));

const named = (...names) => Object.freeze(names.map((n) => {
  const i = PALETTE.findIndex(([name]) => name === n);
  if (i < 0) throw new Error(`palette group: unknown colour ${n}`);
  return i;
}));

/**
 * Height groups by building height in blocks (top − base). SF reads white, cream and pastel: low buildings are
 * pastel or white stucco, midrise is stucco / stone (brick only from tags or the old-warehouse share). Above 30:
 * stone/precast with ~25% blue-grey glass.
 */
export const PALETTE_GROUPS = Object.freeze({
  pastel: Object.freeze({ minH: 0, maxH: 4, indices: named("pastel-pink", "pastel-blue", "pastel-yellow", "pastel-green", "pastel-lilac", "pastel-cream", "stucco", "stone-white") }),
  midrise: Object.freeze({ minH: 5, maxH: 12, indices: named("stucco", "stucco-tan", "concrete-warm", "stone-white", "pastel-cream", "stone-light") }),
  warehouse: Object.freeze({ minH: 3, maxH: 12, indices: named("brick", "brick-dark", "stucco-tan", "concrete-warm", "concrete", "stucco") }),
  stone: Object.freeze({ minH: 13, maxH: 30, indices: range(11, 14) }),
  tall: Object.freeze({ minH: 31, maxH: Infinity, indices: range(15, 18) }),
  glass: Object.freeze({ minH: 31, maxH: Infinity, indices: range(19, 20) }),
});
/** Palette indices a building colour/material may map to (props-only colours excluded). */
const PROP_COLOURS = new Set(["light", "metal", "flag", "leaf", "trunk", "steel-dark", "coke", "glove"]);
const BUILDING_COLOUR_INDICES = Object.freeze(PALETTE.flatMap(([name], i) => (PROP_COLOURS.has(name) ? [] : [i])));

export const ROOF_DARKEN = 0.12;

/** Entry `cap` (top face of the column only). */
export const CAP = Object.freeze({ FLAT: 0, CROWN: 1, SPIRE: 2, DOME: 3, GREEN: 4, SEATS: 5 });
/** Entry `facade`. */
export const FACADE = Object.freeze({ WINDOWS: 0, BLANK: 1, RIBBED: 2, PARKING: 3, ARCADE: 4, CURTAIN: 5, BRACED: 6 });
/** `accentFrom` value meaning "no accent band". */
export const ACCENT_NONE = 0x7fff;

/** structureKind() results (W3, spec-v2 §5). Structures ≤ 4 blocks never get the pastel group. */
export const STRUCTURE_KINDS = Object.freeze([
  "ballpark", "arena", "conference", "pier_shed", "terminal_tower", "church", "parking_garage", "canopy", "transit_roofpark",
]);

/** building:material → representative colour; paletteFor maps it to the nearest palette entry. */
export const MATERIAL_COLORS = Object.freeze({
  brick: "#a65a44",
  concrete: "#b5afa5",
  glass: "#8ea3b3",
  stone: "#cfc8bb",
  sandstone: "#d8c3a5",
  granite: "#9f9a92",
  limestone: "#e6e1d6",
  marble: "#f2efe8",
  metal: "#a7adb3",
  steel: "#a7adb3",
  plaster: "#e9dfcf",
  stucco: "#e9dfcf",
  wood: "#b9b3a8",
});

const NAMED_COLOURS = Object.freeze({
  white: "#f4f2ea", black: "#4e3530", grey: "#9f9a92", gray: "#9f9a92", lightgrey: "#cfcac0", lightgray: "#cfcac0",
  darkgrey: "#6b5e55", darkgray: "#6b5e55", silver: "#c8d0d6", beige: "#e9dfcf", tan: "#d8cdbd", cream: "#fbf6ec",
  ivory: "#f2efe8", brown: "#8c4a3a", red: "#a65a44", maroon: "#8c4a3a", pink: "#f4c6c6", yellow: "#f6e3a6",
  green: "#cfe8c9", blue: "#8ea3b3", lightblue: "#c9e2f0", navy: "#6f8799",
});

/** OSM building:colour → "#rrggbb", or null when the value is not a colour we can read (the caller drops the option). */
export function osmColourToHex(tag) {
  if (typeof tag !== "string") return null;
  const v = tag.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return NAMED_COLOURS[v.replace(/[\s_-]/g, "")] ?? null;
}

/** OSM building:material → a MATERIAL_COLORS key, or null when unknown. */
export function osmMaterial(tag) {
  if (typeof tag !== "string") return null;
  const v = tag.trim().toLowerCase();
  return v in MATERIAL_COLORS ? v : null;
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Nearest palette entry (RGB distance) among building colours. */
export function nearestPaletteIndex(hex) {
  if (typeof hex !== "string" || !/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`nearestPaletteIndex: expected #rrggbb, got ${hex}`);
  const [r, g, b] = rgb(hex);
  let best = -1, bestD = Infinity;
  for (const i of BUILDING_COLOUR_INDICES) {
    const [pr, pg, pb] = rgb(BUILDING_PALETTE[i]);
    const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** FNV-1a over the decimal id: the deterministic "hash(id)" that picks a variant inside a palette group. */
export function hashId(id) {
  if (!Number.isInteger(id) || id < 0) throw new Error(`hashId: id must be a non-negative integer, got ${id}`);
  let h = 0x811c9dc5;
  for (const ch of String(id)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const PALETTE_OPTIONS = new Set(["colour", "material", "structure", "warehouse"]);

/**
 * Palette index for a non-landmark building of `heightBlocks` (top − base) with id `id` (spec-v2 §3.9).
 * opts.colour ("#rrggbb", from osmColourToHex) wins, then opts.material (an osmMaterial key), then the height
 * group. opts.structure (a STRUCTURE_KINDS value) keeps a ≤ 4-block structure out of the pastel group.
 * opts.warehouse (true for an old industrial / warehouse building ≤ 12 blocks) uses the warehouse group, the only
 * untagged source of brick (one in three).
 */
export function paletteFor(heightBlocks, id, opts = {}) {
  if (!Number.isInteger(heightBlocks) || heightBlocks < 1) throw new Error(`paletteFor: height must be an integer ≥ 1, got ${heightBlocks}`);
  if (!opts || typeof opts !== "object") throw new Error("paletteFor: opts must be an object");
  for (const k of Object.keys(opts)) if (!PALETTE_OPTIONS.has(k)) throw new Error(`paletteFor: unknown option "${k}"`);
  if (opts.structure !== undefined && !STRUCTURE_KINDS.includes(opts.structure)) throw new Error(`paletteFor: unknown structure "${opts.structure}"`);
  const h = hashId(id);
  if (opts.colour !== undefined) return nearestPaletteIndex(opts.colour);
  if (opts.material !== undefined) {
    if (!(opts.material in MATERIAL_COLORS)) throw new Error(`paletteFor: unknown material "${opts.material}" (use osmMaterial)`);
    return nearestPaletteIndex(MATERIAL_COLORS[opts.material]);
  }
  if (opts.warehouse !== undefined && typeof opts.warehouse !== "boolean") throw new Error("paletteFor: warehouse must be a boolean");
  let group;
  if (opts.warehouse && heightBlocks <= PALETTE_GROUPS.warehouse.maxH) group = PALETTE_GROUPS.warehouse;
  else if (heightBlocks > PALETTE_GROUPS.stone.maxH) group = h % 4 === 0 ? PALETTE_GROUPS.glass : PALETTE_GROUPS.tall;
  else if (heightBlocks > PALETTE_GROUPS.midrise.maxH) group = PALETTE_GROUPS.stone;
  else if (heightBlocks > PALETTE_GROUPS.pastel.maxH || opts.structure !== undefined) group = PALETTE_GROUPS.midrise;
  else group = PALETTE_GROUPS.pastel;
  return group.indices[(h >>> 2) % group.indices.length];
}

// ---------- chunk binary format (SFC1 v2) ----------

export const CHUNK_MAGIC = "SFC1";
export const COLUMNS = CHUNK * CHUNK;
export const HEADER_BYTES = 16;
export const BUILDING_ENTRY_BYTES = 20;
export const PROP_BYTES = 8;
export const MAX_CAP = 5;
export const MAX_FACADE = 6;
const LAYERS = [
  ["ground", Int16Array],
  ["surface", Uint8Array],
  ["bldg", Uint16Array],
  ["deck", Int16Array],
  ["top", Int16Array],
];
export const CHUNK_BODY_BYTES = LAYERS.reduce((n, [, T]) => n + T.BYTES_PER_ELEMENT * COLUMNS, 0);
const I16_MIN = -32768;
const I16_MAX = 32767;

const inRange = (v, lo, hi, what) => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${what} must be an integer in ${lo}..${hi}, got ${v}`);
  return v;
};
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** true iff the bytes start with the gzip magic 1f 8b. */
export function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Throws unless `bytes` is a gzip stream; an HTML body (SPA fallback) gets its own message. */
export function assertGzip(bytes, what = "chunk") {
  if (isGzip(bytes)) return;
  if (bytes[0] === 0x3c) throw new Error(`not a city chunk (got HTML?): ${what}`);
  throw new Error(`not a city chunk (no gzip magic): ${what}`);
}

const ENTRY_KEYS = ["id", "parent", "base", "top", "accentFrom", "palette", "cap", "facade", "accent"];
const PROP_KEYS = ["lx", "lz", "y0", "y1", "color", "flags"];
const CHUNK_KEYS = ["cx", "cz", "frame", ...LAYERS.map(([n]) => n), "buildings", "props"];

function exactKeys(obj, keys, what) {
  if (!isObj(obj)) throw new Error(`${what}: must be an object`);
  for (const k of keys) if (!(k in obj)) throw new Error(`${what}: missing "${k}"`);
  for (const k of Object.keys(obj)) if (!keys.includes(k)) throw new Error(`${what}: unknown field "${k}"`);
}

/** manifest.parents ({"id": name}) → Set of numeric ids. */
function parentIds(parents) {
  if (!isObj(parents)) throw new Error("parents must be the manifest.parents object ({id: name})");
  return new Set(Object.keys(parents).map(Number));
}

/**
 * Structural and semantic checks every encoded/decoded chunk satisfies (spec-v2 §4). Throws on the first problem.
 * `parents` is manifest.parents: a building's parent must be 0, an id in this chunk's table, or a key of it.
 */
export function validateChunk(chunk, parents = {}) {
  if (!chunk || typeof chunk !== "object") throw new Error("chunk: not an object");
  const at = `chunk ${chunk.cx},${chunk.cz}`;
  exactKeys(chunk, CHUNK_KEYS, at);
  inRange(chunk.cx, I16_MIN, I16_MAX, `${at}: cx`);
  inRange(chunk.cz, I16_MIN, I16_MAX, `${at}: cz`);
  if (chunk.frame !== 0) throw new Error(`${at}: frame ${chunk.frame}, must be 0 (single frame, grid option a)`);
  for (const [name, T] of LAYERS) {
    if (!(chunk[name] instanceof T)) throw new Error(`${at}: ${name} must be a ${T.name}`);
    if (chunk[name].length !== COLUMNS) throw new Error(`${at}: ${name} has ${chunk[name].length} columns, expected ${COLUMNS}`);
  }
  if (!Array.isArray(chunk.buildings)) throw new Error(`${at}: buildings must be an array`);
  inRange(chunk.buildings.length, 0, 0xffff, `${at}: nBuildings`);
  const external = parentIds(parents);
  const ids = new Set(chunk.buildings.map((b) => b?.id));
  const seen = new Set();
  chunk.buildings.forEach((b, i) => {
    const bt = `${at}: building[${i}]`;
    exactKeys(b, ENTRY_KEYS, bt);
    inRange(b.id, 1, 0xffffffff, `${bt}.id`);
    if (seen.has(b.id)) throw new Error(`${bt}: duplicate id ${b.id}`);
    seen.add(b.id);
    inRange(b.parent, 0, 0xffffffff, `${bt}.parent`);
    if (b.parent !== 0) {
      if (b.parent === b.id) throw new Error(`${bt}: parent is its own id ${b.id}`);
      if (!ids.has(b.parent) && !external.has(b.parent)) throw new Error(`${bt}: parent ${b.parent} is neither in this chunk's table nor in manifest.parents`);
      const p = chunk.buildings.find((x) => x.id === b.parent);
      if (p && p.parent !== 0) throw new Error(`${bt}: parent ${b.parent} has its own parent ${p.parent} (no chains)`);
    }
    inRange(b.base, I16_MIN, I16_MAX, `${bt}.base`);
    inRange(b.top, I16_MIN, I16_MAX, `${bt}.top`);
    if (b.top <= b.base) throw new Error(`${bt}: top ${b.top} must be above base ${b.base}`);
    if (b.base < 1) throw new Error(`${bt}: base ${b.base} is below land (y=1)`);
    inRange(b.accentFrom, I16_MIN, I16_MAX, `${bt}.accentFrom`);
    if (b.accentFrom !== ACCENT_NONE && b.accentFrom <= b.base) throw new Error(`${bt}: accentFrom ${b.accentFrom} must be above base ${b.base} (or ${ACCENT_NONE} = none)`);
    inRange(b.palette, 0, BUILDING_PALETTE.length - 1, `${bt}.palette`);
    inRange(b.accent, 0, BUILDING_PALETTE.length - 1, `${bt}.accent`);
    inRange(b.cap, 0, MAX_CAP, `${bt}.cap`);
    inRange(b.facade, 0, MAX_FACADE, `${bt}.facade`);
  });
  const { ground, surface, bldg, deck, top, buildings } = chunk;
  const maxTop = new Int32Array(buildings.length).fill(I16_MIN - 1);
  for (let i = 0; i < COLUMNS; i++) {
    const col = () => `${at} column ${i % CHUNK},${Math.floor(i / CHUNK)}`;
    const s = surface[i];
    if (!SURFACE_IDS.has(s)) throw new Error(`${col()}: unknown surface ${s}`);
    const g = ground[i];
    if (g < 0) throw new Error(`${col()}: ground ${g} below sea level`);
    if (isWaterSurface(s) !== (g === 0)) throw new Error(`${col()}: surface ${s} with ground ${g} (water iff ground 0)`);
    const b = bldg[i];
    if (b !== 0) {
      if (b > buildings.length) throw new Error(`${col()}: bldg ${b} past the ${buildings.length}-entry table`);
      const e = buildings[b - 1];
      if (g !== e.base) throw new Error(`${col()}: building column ground ${g} must equal its base ${e.base}`);
      if (top[i] <= e.base) throw new Error(`${col()}: column top ${top[i]} must be above base ${e.base} on a building column`);
      if (top[i] > e.top) throw new Error(`${col()}: column top ${top[i]} above its entry top ${e.top}`);
      if (top[i] > maxTop[b - 1]) maxTop[b - 1] = top[i];
    } else if (top[i] !== 0) {
      throw new Error(`${col()}: column top ${top[i]} on a column with no building (must be 0)`);
    }
    const d = deck[i];
    if (d !== 0 && Math.abs(d) <= g) throw new Error(`${col()}: deck top ${Math.abs(d)} not above ground ${g}`);
  }
  buildings.forEach((e, k) => {
    if (maxTop[k] < I16_MIN) throw new Error(`${at}: building[${k}] (id ${e.id}) has no columns in this chunk`);
    if (maxTop[k] !== e.top) throw new Error(`${at}: building[${k}] (id ${e.id}) top ${e.top} != max column top ${maxTop[k]}`);
  });
  if (!Array.isArray(chunk.props)) throw new Error(`${at}: props must be an array`);
  inRange(chunk.props.length, 0, 0xffff, `${at}: nProps`);
  chunk.props.forEach((p, i) => {
    const pt = `${at}: prop[${i}]`;
    exactKeys(p, PROP_KEYS, pt);
    inRange(p.lx, 0, CHUNK - 1, `${pt}.lx`);
    inRange(p.lz, 0, CHUNK - 1, `${pt}.lz`);
    inRange(p.y0, I16_MIN, I16_MAX, `${pt}.y0`);
    inRange(p.y1, I16_MIN, I16_MAX, `${pt}.y1`);
    if (p.y1 <= p.y0) throw new Error(`${pt}: y1 ${p.y1} must be above y0 ${p.y0}`);
    inRange(p.color, 0, BUILDING_PALETTE.length - 1, `${pt}.color`);
    inRange(p.flags, 0, 1, `${pt}.flags`);
  });
  return chunk;
}

/** Byte length of an SFC1 v2 chunk with n buildings and p props. */
export const chunkByteLength = (n, p) => HEADER_BYTES + CHUNK_BODY_BYTES + n * BUILDING_ENTRY_BYTES + 2 + p * PROP_BYTES;

/** Chunk → raw (un-gzipped) little-endian SFC1 v2 bytes. Validates first (with manifest.parents). */
export function encodeChunk(chunk, parents = {}) {
  validateChunk(chunk, parents);
  const n = chunk.buildings.length;
  const out = new Uint8Array(chunkByteLength(n, chunk.props.length));
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = CHUNK_MAGIC.charCodeAt(i);
  dv.setUint16(4, CITY_VERSION, true);
  dv.setInt16(6, chunk.cx, true);
  dv.setInt16(8, chunk.cz, true);
  dv.setUint16(10, CHUNK, true);
  dv.setUint16(12, n, true);
  dv.setUint8(14, chunk.frame);
  dv.setUint8(15, 0);
  let o = HEADER_BYTES;
  for (const [name, T] of LAYERS) {
    const src = chunk[name];
    if (T.BYTES_PER_ELEMENT === 1) out.set(src, o);
    else for (let i = 0; i < COLUMNS; i++) T === Int16Array ? dv.setInt16(o + 2 * i, src[i], true) : dv.setUint16(o + 2 * i, src[i], true);
    o += T.BYTES_PER_ELEMENT * COLUMNS;
  }
  for (const b of chunk.buildings) {
    dv.setUint32(o, b.id, true);
    dv.setUint32(o + 4, b.parent, true);
    dv.setInt16(o + 8, b.base, true);
    dv.setInt16(o + 10, b.top, true);
    dv.setInt16(o + 12, b.accentFrom, true);
    dv.setUint8(o + 14, b.palette);
    dv.setUint8(o + 15, b.cap);
    dv.setUint8(o + 16, b.facade);
    dv.setUint8(o + 17, b.accent);
    dv.setUint16(o + 18, 0, true);
    o += BUILDING_ENTRY_BYTES;
  }
  dv.setUint16(o, chunk.props.length, true);
  o += 2;
  for (const p of chunk.props) {
    dv.setUint8(o, p.lx);
    dv.setUint8(o + 1, p.lz);
    dv.setInt16(o + 2, p.y0, true);
    dv.setInt16(o + 4, p.y1, true);
    dv.setUint8(o + 6, p.color);
    dv.setUint8(o + 7, p.flags);
    o += PROP_BYTES;
  }
  return out;
}

function magicOf(bytes) {
  return String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
}

/**
 * Raw (already inflated) SFC1 bytes → chunk. `parents` is manifest.parents. Throws on HTML, gzip, bad
 * magic/version/size, or bad data; a v1 chunk throws "city chunk version 1, this viewer reads 2".
 */
export function decodeChunk(bytes, parents = {}) {
  if (!(bytes instanceof Uint8Array)) throw new Error("decodeChunk: expected a Uint8Array");
  if (bytes[0] === 0x3c) throw new Error("not a city chunk (got HTML?)");
  if (isGzip(bytes)) throw new Error("decodeChunk: bytes are still gzipped; inflate first");
  if (bytes.length < 6) throw new Error(`decodeChunk: ${bytes.length} bytes is shorter than a chunk`);
  const magic = magicOf(bytes);
  if (magic !== CHUNK_MAGIC) throw new Error(`not a city chunk: magic ${JSON.stringify(magic)}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint16(4, true);
  if (version !== CITY_VERSION) throw new Error(`city chunk version ${version}, this viewer reads ${CITY_VERSION}`);
  if (bytes.length < chunkByteLength(0, 0)) throw new Error(`decodeChunk: ${bytes.length} bytes is shorter than a chunk`);
  const cx = dv.getInt16(6, true);
  const cz = dv.getInt16(8, true);
  const size = dv.getUint16(10, true);
  if (size !== CHUNK) throw new Error(`chunk ${cx},${cz}: size ${size}, expected ${CHUNK}`);
  const n = dv.getUint16(12, true);
  const frame = dv.getUint8(14);
  if (frame !== 0) throw new Error(`chunk ${cx},${cz}: frame ${frame}, must be 0`);
  if (dv.getUint8(15) !== 0) throw new Error(`chunk ${cx},${cz}: reserved header byte is not 0`);
  const propsAt = HEADER_BYTES + CHUNK_BODY_BYTES + n * BUILDING_ENTRY_BYTES;
  if (bytes.length < propsAt + 2) throw new Error(`chunk ${cx},${cz}: ${bytes.length} bytes, expected at least ${propsAt + 2}`);
  const p = dv.getUint16(propsAt, true);
  const expected = chunkByteLength(n, p);
  if (bytes.length !== expected) throw new Error(`chunk ${cx},${cz}: ${bytes.length} bytes, expected ${expected}`);
  const chunk = { cx, cz, frame };
  let o = HEADER_BYTES;
  for (const [name, T] of LAYERS) {
    const arr = new T(COLUMNS);
    if (T === Uint8Array) arr.set(bytes.subarray(o, o + COLUMNS));
    else for (let i = 0; i < COLUMNS; i++) arr[i] = T === Int16Array ? dv.getInt16(o + 2 * i, true) : dv.getUint16(o + 2 * i, true);
    chunk[name] = arr;
    o += T.BYTES_PER_ELEMENT * COLUMNS;
  }
  chunk.buildings = [];
  for (let i = 0; i < n; i++, o += BUILDING_ENTRY_BYTES) {
    if (dv.getUint16(o + 18, true) !== 0) throw new Error(`chunk ${cx},${cz}: building[${i}] reserved field is not 0`);
    chunk.buildings.push({
      id: dv.getUint32(o, true),
      parent: dv.getUint32(o + 4, true),
      base: dv.getInt16(o + 8, true),
      top: dv.getInt16(o + 10, true),
      accentFrom: dv.getInt16(o + 12, true),
      palette: dv.getUint8(o + 14),
      cap: dv.getUint8(o + 15),
      facade: dv.getUint8(o + 16),
      accent: dv.getUint8(o + 17),
    });
  }
  o += 2;
  chunk.props = [];
  for (let i = 0; i < p; i++, o += PROP_BYTES) {
    chunk.props.push({
      lx: dv.getUint8(o),
      lz: dv.getUint8(o + 1),
      y0: dv.getInt16(o + 2, true),
      y1: dv.getInt16(o + 4, true),
      color: dv.getUint8(o + 6),
      flags: dv.getUint8(o + 7),
    });
  }
  return validateChunk(chunk, parents);
}

/** The id pick and labels resolve a building entry to: one landmark picks as one building. */
export const pickId = (entry) => entry.parent || entry.id;

// ---------- landmarks.bin (SFL1) ----------

export const LANDMARKS_MAGIC = "SFL1";
export const LANDMARKS_VERSION = 1;
export const LANDMARKS_HEADER_BYTES = 12;
export const LANDMARK_BOX_BYTES = 12;
export const MAX_LANDMARKS_BYTES = 200 * 1024;
const BOX_KEYS = ["x", "z", "y0", "y1", "sx", "sz", "color", "flags"];

/** Boxes (global block coords) → checks; with `grid` ([gx, gz] chunks) every box must lie inside it. */
export function validateLandmarks(boxes, grid) {
  if (!Array.isArray(boxes)) throw new Error("landmarks: boxes must be an array");
  const bytes = LANDMARKS_HEADER_BYTES + boxes.length * LANDMARK_BOX_BYTES;
  if (bytes > MAX_LANDMARKS_BYTES) throw new Error(`landmarks: ${bytes} bytes > ${MAX_LANDMARKS_BYTES}`);
  boxes.forEach((b, i) => {
    const what = `landmarks box[${i}]`;
    exactKeys(b, BOX_KEYS, what);
    inRange(b.x, I16_MIN, I16_MAX, `${what}.x`);
    inRange(b.z, I16_MIN, I16_MAX, `${what}.z`);
    inRange(b.y0, I16_MIN, I16_MAX, `${what}.y0`);
    inRange(b.y1, I16_MIN, I16_MAX, `${what}.y1`);
    if (b.y1 <= b.y0) throw new Error(`${what}: y1 ${b.y1} must be above y0 ${b.y0}`);
    inRange(b.sx, 1, 255, `${what}.sx`);
    inRange(b.sz, 1, 255, `${what}.sz`);
    inRange(b.color, 0, BUILDING_PALETTE.length - 1, `${what}.color`);
    inRange(b.flags, 0, 1, `${what}.flags`);
    if (grid) {
      const [gx, gz] = grid;
      if (b.x < 0 || b.z < 0 || b.x + b.sx > gx * CHUNK || b.z + b.sz > gz * CHUNK) {
        throw new Error(`${what}: ${b.x},${b.z} +${b.sx}×${b.sz} outside the ${gx}×${gz}-chunk grid`);
      }
    }
  });
  return boxes;
}

/** Boxes → raw SFL1 bytes (written gzipped as landmarks.bin). */
export function encodeLandmarks(boxes, grid) {
  validateLandmarks(boxes, grid);
  const out = new Uint8Array(LANDMARKS_HEADER_BYTES + boxes.length * LANDMARK_BOX_BYTES);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = LANDMARKS_MAGIC.charCodeAt(i);
  dv.setUint16(4, LANDMARKS_VERSION, true);
  dv.setUint16(6, 0, true);
  dv.setUint32(8, boxes.length, true);
  let o = LANDMARKS_HEADER_BYTES;
  for (const b of boxes) {
    dv.setInt16(o, b.x, true);
    dv.setInt16(o + 2, b.z, true);
    dv.setInt16(o + 4, b.y0, true);
    dv.setInt16(o + 6, b.y1, true);
    dv.setUint8(o + 8, b.sx);
    dv.setUint8(o + 9, b.sz);
    dv.setUint8(o + 10, b.color);
    dv.setUint8(o + 11, b.flags);
    o += LANDMARK_BOX_BYTES;
  }
  return out;
}

/** Raw SFL1 bytes → boxes. */
export function decodeLandmarks(bytes, grid) {
  if (!(bytes instanceof Uint8Array)) throw new Error("decodeLandmarks: expected a Uint8Array");
  if (isGzip(bytes)) throw new Error("decodeLandmarks: bytes are still gzipped; inflate first");
  if (bytes.length < LANDMARKS_HEADER_BYTES) throw new Error(`decodeLandmarks: ${bytes.length} bytes is shorter than the header`);
  const magic = magicOf(bytes);
  if (magic !== LANDMARKS_MAGIC) throw new Error(`not a landmarks file: magic ${JSON.stringify(magic)}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint16(4, true);
  if (version !== LANDMARKS_VERSION) throw new Error(`landmarks version ${version}, this viewer reads ${LANDMARKS_VERSION}`);
  if (dv.getUint16(6, true) !== 0) throw new Error("landmarks: reserved header field is not 0");
  const n = dv.getUint32(8, true);
  const expected = LANDMARKS_HEADER_BYTES + n * LANDMARK_BOX_BYTES;
  if (bytes.length !== expected) throw new Error(`landmarks: ${bytes.length} bytes, expected ${expected}`);
  const boxes = [];
  for (let i = 0, o = LANDMARKS_HEADER_BYTES; i < n; i++, o += LANDMARK_BOX_BYTES) {
    boxes.push({
      x: dv.getInt16(o, true), z: dv.getInt16(o + 2, true), y0: dv.getInt16(o + 4, true), y1: dv.getInt16(o + 6, true),
      sx: dv.getUint8(o + 8), sz: dv.getUint8(o + 9), color: dv.getUint8(o + 10), flags: dv.getUint8(o + 11),
    });
  }
  return validateLandmarks(boxes, grid);
}

// ---------- landmask.bin (SFM1) ----------

export const LANDMASK_MAGIC = "SFM1";
export const LANDMASK_VERSION = 1;
export const LANDMASK_HEADER_BYTES = 10;
/** One landmask cell is LANDMASK_CELL × LANDMASK_CELL blocks; the mask covers the whole reserved grid from 0,0. */
export const LANDMASK_CELL = 4;

/** {cellsX, cellsZ, cells: Uint8Array} checks; with `grid` the size must be grid × CHUNK / LANDMASK_CELL. */
export function validateLandmask(mask, grid) {
  exactKeys(mask, ["cellsX", "cellsZ", "cells"], "landmask");
  inRange(mask.cellsX, 1, 0xffff, "landmask.cellsX");
  inRange(mask.cellsZ, 1, 0xffff, "landmask.cellsZ");
  if (!(mask.cells instanceof Uint8Array)) throw new Error("landmask.cells must be a Uint8Array");
  if (mask.cells.length !== mask.cellsX * mask.cellsZ) throw new Error(`landmask: ${mask.cells.length} cells, expected ${mask.cellsX * mask.cellsZ}`);
  if (grid) {
    const want = [grid[0] * (CHUNK / LANDMASK_CELL), grid[1] * (CHUNK / LANDMASK_CELL)];
    if (mask.cellsX !== want[0] || mask.cellsZ !== want[1]) throw new Error(`landmask: ${mask.cellsX}×${mask.cellsZ} cells, the grid needs ${want[0]}×${want[1]}`);
  }
  return mask;
}

/** → raw SFM1 bytes (written gzipped as landmask.bin). */
export function encodeLandmask(mask, grid) {
  validateLandmask(mask, grid);
  const out = new Uint8Array(LANDMASK_HEADER_BYTES + mask.cells.length);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = LANDMASK_MAGIC.charCodeAt(i);
  dv.setUint16(4, LANDMASK_VERSION, true);
  dv.setUint16(6, mask.cellsX, true);
  dv.setUint16(8, mask.cellsZ, true);
  out.set(mask.cells, LANDMASK_HEADER_BYTES);
  return out;
}

export function decodeLandmask(bytes, grid) {
  if (!(bytes instanceof Uint8Array)) throw new Error("decodeLandmask: expected a Uint8Array");
  if (isGzip(bytes)) throw new Error("decodeLandmask: bytes are still gzipped; inflate first");
  if (bytes.length < LANDMASK_HEADER_BYTES) throw new Error(`decodeLandmask: ${bytes.length} bytes is shorter than the header`);
  const magic = magicOf(bytes);
  if (magic !== LANDMASK_MAGIC) throw new Error(`not a landmask file: magic ${JSON.stringify(magic)}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint16(4, true);
  if (version !== LANDMASK_VERSION) throw new Error(`landmask version ${version}, this viewer reads ${LANDMASK_VERSION}`);
  const cellsX = dv.getUint16(6, true), cellsZ = dv.getUint16(8, true);
  if (bytes.length !== LANDMASK_HEADER_BYTES + cellsX * cellsZ) throw new Error(`landmask: ${bytes.length} bytes, expected ${LANDMASK_HEADER_BYTES + cellsX * cellsZ}`);
  return validateLandmask({ cellsX, cellsZ, cells: bytes.slice(LANDMASK_HEADER_BYTES) }, grid);
}

/** Coarse ground height (blocks) of the mask cell holding block (x, z); null for sea or outside the mask. */
export function landmaskHeight(mask, x, z) {
  const cx = Math.floor(finite(x, "x") / LANDMASK_CELL), cz = Math.floor(finite(z, "z") / LANDMASK_CELL);
  if (cx < 0 || cz < 0 || cx >= mask.cellsX || cz >= mask.cellsZ) return null;
  const v = mask.cells[cz * mask.cellsX + cx];
  return v === 0 ? null : v - 1;
}

// ---------- street.bin (SFS1) ----------
// The street-level detail layer, loaded once and drawn only on LOD0 chunks: road centrelines (lane markings and
// the ambient-traffic graph), crosswalks, tram / cable-car track, and street furniture points. Coordinates are
// quarter blocks (x4, z4 = round(block × STREET_Q)) inside the reserved grid; y comes from the chunk ground.
// Layout (little-endian): header 16 B {magic, version u16, reserved u16, nLines u32, nPoints u32}; lines, each
// {kind u8, flags u8, width4 u8, lanes u8, n u16, reserved u16} then n × {x4 i16, z4 i16}; points, 6 B each
// {kind u8, rot u8 (heading in 1/256 turns, three.js yaw: 0 faces +z, turning toward +x), x4 i16, z4 i16}.

export const STREET_MAGIC = "SFS1";
export const STREET_VERSION = 1;
export const STREET_HEADER_BYTES = 16;
export const STREET_LINE_BYTES = 8;
export const STREET_VERT_BYTES = 4;
export const STREET_POINT_BYTES = 6;
/** Sub-block resolution of street.bin coordinates and widths. */
export const STREET_Q = 4;
export const MAX_STREET_BYTES = 4 * 1024 * 1024;
export const MAX_STREET_GZ_BYTES = 1536 * 1024;

/**
 * Line kinds. ROAD: a ground carriageway centreline (width4 = roadway, lanes = OSM lanes or 0), in OSM way
 * direction (a one-way runs forward). CROSSWALK: the crossing's centreline across the road (width4 = band width).
 * TRACK: rails embedded in the street or its median (width4 = gauge).
 */
export const STREET_LINE = Object.freeze({ ROAD: 1, CROSSWALK: 2, TRACK: 3 });
export const ROAD_FLAG = Object.freeze({ ONEWAY: 1, MAJOR: 2, CENTRE: 4, DOUBLE_YELLOW: 8 });
export const CROSSWALK_STYLE = Object.freeze({ ZEBRA: 0, LADDER: 1, LINES: 2 });
export const TRACK_FLAG = Object.freeze({ CABLE: 1, MEDIAN: 2 });
const LINE_FLAG_MAX = Object.freeze({ [STREET_LINE.ROAD]: 15, [STREET_LINE.CROSSWALK]: 2, [STREET_LINE.TRACK]: 3 });

/** Point kinds (street furniture and parked cars); rot is the way the object faces (a car: its heading). */
export const STREET_POINT = Object.freeze({ LAMP: 1, HYDRANT: 2, BENCH: 3, SHELTER: 4, STOP: 5, CAR: 6, SIGNAL: 7, BIN: 8 });
const POINT_KINDS = new Set(Object.values(STREET_POINT));

/** Heading (radians, three.js yaw) → rot byte, and back. */
export const rotByte = (rad) => ((Math.round((finite(rad, "rot") / (2 * Math.PI)) * 256) % 256) + 256) % 256;
export const rotRad = (byte) => (byte / 256) * 2 * Math.PI;
/** Block coordinate → quarter-block integer. */
export const streetQ = (v) => Math.round(finite(v, "street coordinate") * STREET_Q);

/** {lines: [{kind, flags, width4, lanes, pts: Int16Array x4,z4 pairs}], points: [{kind, rot, x4, z4}]} checks. */
export function validateStreet(doc, grid) {
  exactKeys(doc, ["lines", "points"], "street");
  if (!Array.isArray(doc.lines) || !Array.isArray(doc.points)) throw new Error("street: lines and points must be arrays");
  const lim = grid ? [grid[0] * CHUNK * STREET_Q, grid[1] * CHUNK * STREET_Q] : [I16_MAX + 1, I16_MAX + 1];
  const inGrid = (x, z, what) => {
    if (x < 0 || z < 0 || x >= lim[0] || z >= lim[1]) throw new Error(`${what}: ${x / STREET_Q},${z / STREET_Q} outside the reserved grid`);
  };
  doc.lines.forEach((l, i) => {
    const what = `street line[${i}]`;
    exactKeys(l, ["kind", "flags", "width4", "lanes", "pts"], what);
    if (!(l.kind in LINE_FLAG_MAX)) throw new Error(`${what}: unknown kind ${l.kind}`);
    inRange(l.flags, 0, LINE_FLAG_MAX[l.kind], `${what}.flags`);
    inRange(l.width4, 1, 255, `${what}.width4`);
    inRange(l.lanes, 0, 15, `${what}.lanes`);
    if (!(l.pts instanceof Int16Array) || l.pts.length < 4 || l.pts.length % 2) throw new Error(`${what}: pts must be an Int16Array of ≥ 2 x4,z4 pairs`);
    if (l.pts.length / 2 > 0xffff) throw new Error(`${what}: ${l.pts.length / 2} vertices > 65535`);
    for (let k = 0; k < l.pts.length; k += 2) inGrid(l.pts[k], l.pts[k + 1], `${what} vertex ${k / 2}`);
  });
  doc.points.forEach((p, i) => {
    const what = `street point[${i}]`;
    exactKeys(p, ["kind", "rot", "x4", "z4"], what);
    if (!POINT_KINDS.has(p.kind)) throw new Error(`${what}: unknown kind ${p.kind}`);
    inRange(p.rot, 0, 255, `${what}.rot`);
    inRange(p.x4, 0, I16_MAX, `${what}.x4`);
    inRange(p.z4, 0, I16_MAX, `${what}.z4`);
    inGrid(p.x4, p.z4, what);
  });
  return doc;
}

/** → raw SFS1 bytes (written gzipped as street.bin). */
export function encodeStreet(doc, grid) {
  validateStreet(doc, grid);
  const verts = doc.lines.reduce((n, l) => n + l.pts.length / 2, 0);
  const len = STREET_HEADER_BYTES + doc.lines.length * STREET_LINE_BYTES + verts * STREET_VERT_BYTES + doc.points.length * STREET_POINT_BYTES;
  if (len > MAX_STREET_BYTES) throw new Error(`street.bin: ${len} bytes > ${MAX_STREET_BYTES}`);
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = STREET_MAGIC.charCodeAt(i);
  dv.setUint16(4, STREET_VERSION, true);
  dv.setUint16(6, 0, true);
  dv.setUint32(8, doc.lines.length, true);
  dv.setUint32(12, doc.points.length, true);
  let o = STREET_HEADER_BYTES;
  for (const l of doc.lines) {
    dv.setUint8(o, l.kind); dv.setUint8(o + 1, l.flags); dv.setUint8(o + 2, l.width4); dv.setUint8(o + 3, l.lanes);
    dv.setUint16(o + 4, l.pts.length / 2, true); dv.setUint16(o + 6, 0, true);
    o += STREET_LINE_BYTES;
    for (const v of l.pts) { dv.setInt16(o, v, true); o += 2; }
  }
  for (const p of doc.points) {
    dv.setUint8(o, p.kind); dv.setUint8(o + 1, p.rot); dv.setInt16(o + 2, p.x4, true); dv.setInt16(o + 4, p.z4, true);
    o += STREET_POINT_BYTES;
  }
  return out;
}

/** Raw SFS1 bytes → {lines, points}, validated (inside `grid` when given). */
export function decodeStreet(bytes, grid) {
  if (!(bytes instanceof Uint8Array)) throw new Error("decodeStreet: expected a Uint8Array");
  if (isGzip(bytes)) throw new Error("decodeStreet: bytes are still gzipped; inflate first");
  if (bytes.length < STREET_HEADER_BYTES) throw new Error(`decodeStreet: ${bytes.length} bytes is shorter than the header`);
  const magic = magicOf(bytes);
  if (magic !== STREET_MAGIC) throw new Error(`not a street file: magic ${JSON.stringify(magic)}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint16(4, true);
  if (version !== STREET_VERSION) throw new Error(`street version ${version}, this viewer reads ${STREET_VERSION}`);
  if (dv.getUint16(6, true) !== 0) throw new Error("street: reserved header field is not 0");
  const nLines = dv.getUint32(8, true), nPoints = dv.getUint32(12, true);
  const need = (o, n, what) => { if (o + n > bytes.length) throw new Error(`street: truncated in ${what} (${bytes.length} bytes)`); };
  let o = STREET_HEADER_BYTES;
  const lines = [];
  for (let i = 0; i < nLines; i++) {
    need(o, STREET_LINE_BYTES, `line ${i}`);
    const n = dv.getUint16(o + 4, true);
    if (dv.getUint16(o + 6, true) !== 0) throw new Error(`street line[${i}]: reserved field is not 0`);
    const l = { kind: dv.getUint8(o), flags: dv.getUint8(o + 1), width4: dv.getUint8(o + 2), lanes: dv.getUint8(o + 3), pts: new Int16Array(n * 2) };
    o += STREET_LINE_BYTES;
    need(o, n * STREET_VERT_BYTES, `line ${i} vertices`);
    for (let k = 0; k < n * 2; k++, o += 2) l.pts[k] = dv.getInt16(o, true);
    lines.push(l);
  }
  if (bytes.length !== o + nPoints * STREET_POINT_BYTES) throw new Error(`street: ${bytes.length} bytes, expected ${o + nPoints * STREET_POINT_BYTES}`);
  const points = [];
  for (let i = 0; i < nPoints; i++, o += STREET_POINT_BYTES) {
    points.push({ kind: dv.getUint8(o), rot: dv.getUint8(o + 1), x4: dv.getInt16(o + 2, true), z4: dv.getInt16(o + 4, true) });
  }
  return validateStreet({ lines, points }, grid);
}


// ---------- walk.bin (SFW1) ----------

export const WALK_MAGIC = "SFW1";
export const WALK_VERSION = 1;
export const WALK_HEADER_BYTES = 32;
export const WALK_NODE_INTS = 3;
export const WALK_EDGE_INTS = 5;
export const MAX_WALK_BYTES = 600 * 1024;
export const WALK_Y_MAX = 300;
/** nameIdx of an unnamed edge. */
export const WALK_NO_NAME = -1;
const DECK_BIT = 0x80000000;

/** Edge e's half width in decimetre-blocks. */
export const edgeHalfWidth10 = (edges, e) => edges[e * WALK_EDGE_INTS + 4] & 0x7fffffff;
/** true iff edge e is a bridge deck (its nodes carry the deck top as y). */
export const edgeIsDeck = (edges, e) => (edges[e * WALK_EDGE_INTS + 4] & DECK_BIT) !== 0;
/** The packed halfWidth10 | deck<<31 field, as an Int32 value. */
export const packEdgeWidth = (halfWidth10, deck) => (inRange(halfWidth10, 1, 0x7fffffff, "halfWidth10") | (deck ? DECK_BIT : 0)) | 0;

/**
 * Graph checks (spec-v2 §4): index ranges, every edge in both directions with the same len/name/width/deck,
 * y ∈ [0, WALK_Y_MAX]; with `manifest`, builtAt equals manifest.builtAt and nodes lie inside the reserved grid.
 */
/** Every edge a→b has exactly one reverse b→a with the same len/name/width/deck (sorted numeric keys, no string Map). */
function checkReverseEdges(edges, nNodes, nEdges) {
  if (nNodes * nNodes * nEdges >= Number.MAX_SAFE_INTEGER) throw new Error(`walk: ${nNodes} nodes × ${nEdges} edges too large to key`);
  const keys = new Float64Array(nEdges);
  for (let e = 0; e < nEdges; e++) keys[e] = (edges[e * WALK_EDGE_INTS] * nNodes + edges[e * WALK_EDGE_INTS + 1]) * nEdges + e;
  keys.sort();
  const pairOf = (k) => Math.floor(k / nEdges);
  for (let i = 1; i < nEdges; i++) {
    if (pairOf(keys[i]) === pairOf(keys[i - 1])) {
      const e = keys[i] % nEdges;
      throw new Error(`walk edge ${e}: duplicate edge ${edges[e * WALK_EDGE_INTS]},${edges[e * WALK_EDGE_INTS + 1]}`);
    }
  }
  for (let i = 0; i < nEdges; i++) {
    const e = keys[i] % nEdges, o = e * WALK_EDGE_INTS;
    const a = edges[o], b = edges[o + 1];
    const want = b * nNodes + a;
    let lo = 0, hi = nEdges - 1, r = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, p = pairOf(keys[mid]);
      if (p === want) { r = keys[mid] % nEdges; break; }
      if (p < want) lo = mid + 1; else hi = mid - 1;
    }
    if (r < 0) throw new Error(`walk: edge ${a},${b} has no reverse edge ${b},${a}`);
    const ro = r * WALK_EDGE_INTS;
    if (edges[ro + 2] !== edges[o + 2] || edges[ro + 3] !== edges[o + 3] || edges[ro + 4] !== edges[o + 4]) throw new Error(`walk: edge ${a},${b} and its reverse disagree on len/name/width/deck`);
  }
}

export function validateWalk(g, manifest) {
  exactKeys(g, ["builtAt", "nodes", "edges", "names"], "walk");
  if (!Number.isSafeInteger(g.builtAt) || g.builtAt <= 0) throw new Error(`walk.builtAt must be epoch ms, got ${g.builtAt}`);
  if (!(g.nodes instanceof Int32Array) || g.nodes.length % WALK_NODE_INTS) throw new Error("walk.nodes must be an Int32Array of x10, z10, y10 triples");
  if (!(g.edges instanceof Int32Array) || g.edges.length % WALK_EDGE_INTS) throw new Error("walk.edges must be an Int32Array of 5-int edges");
  if (!Array.isArray(g.names)) throw new Error("walk.names must be an array");
  const names = new Set();
  g.names.forEach((s, i) => {
    if (typeof s !== "string" || s.length === 0) throw new Error(`walk.names[${i}] must be a non-empty string`);
    if (names.has(s)) throw new Error(`walk.names[${i}]: duplicate name ${JSON.stringify(s)}`);
    names.add(s);
  });
  const nNodes = g.nodes.length / WALK_NODE_INTS, nEdges = g.edges.length / WALK_EDGE_INTS;
  const limit = manifest ? [manifest.chunks.grid[0] * CHUNK * 10, manifest.chunks.grid[1] * CHUNK * 10] : null;
  for (let n = 0; n < nNodes; n++) {
    const x = g.nodes[n * 3], z = g.nodes[n * 3 + 1], y = g.nodes[n * 3 + 2];
    if (y < 0 || y > WALK_Y_MAX * 10) throw new Error(`walk node ${n}: y10 ${y} outside 0..${WALK_Y_MAX * 10}`);
    if (limit && (x < 0 || z < 0 || x >= limit[0] || z >= limit[1])) throw new Error(`walk node ${n}: ${x / 10},${z / 10} outside the reserved grid`);
  }
  for (let e = 0; e < nEdges; e++) {
    const o = e * WALK_EDGE_INTS;
    const a = g.edges[o], b = g.edges[o + 1], len = g.edges[o + 2], name = g.edges[o + 3];
    if (a < 0 || a >= nNodes || b < 0 || b >= nNodes) throw new Error(`walk edge ${e}: node ${a}→${b} outside 0..${nNodes - 1}`);
    if (a === b) throw new Error(`walk edge ${e}: self loop at node ${a}`);
    if (len < 1) throw new Error(`walk edge ${e}: len10 ${len} must be ≥ 1`);
    if (name !== WALK_NO_NAME && (name < 0 || name >= g.names.length)) throw new Error(`walk edge ${e}: nameIdx ${name} outside 0..${g.names.length - 1}`);
    if (edgeHalfWidth10(g.edges, e) < 1) throw new Error(`walk edge ${e}: halfWidth10 must be ≥ 1`);
  }
  checkReverseEdges(g.edges, nNodes, nEdges);
  if (manifest && g.builtAt !== Date.parse(manifest.builtAt)) throw new Error(`walk.builtAt ${new Date(g.builtAt).toISOString()} != manifest.builtAt ${manifest.builtAt}`);
  return g;
}

const utf8 = new TextEncoder();

/** Graph → raw SFW1 bytes (walk.bin is served uncompressed so the City DO can view it without a parse). */
export function encodeWalk(g, manifest) {
  validateWalk(g, manifest);
  const blobs = g.names.map((s) => utf8.encode(s));
  const blobLen = blobs.reduce((n, b) => n + b.length, 0);
  const nameTable = 4 * (g.names.length + 1);
  const len = WALK_HEADER_BYTES + g.nodes.byteLength + g.edges.byteLength + nameTable + blobLen;
  if (len > MAX_WALK_BYTES) throw new Error(`walk.bin: ${len} bytes > ${MAX_WALK_BYTES}`);
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = WALK_MAGIC.charCodeAt(i);
  dv.setUint16(4, WALK_VERSION, true);
  dv.setUint16(6, 0, true);
  dv.setUint32(8, g.nodes.length / WALK_NODE_INTS, true);
  dv.setUint32(12, g.edges.length / WALK_EDGE_INTS, true);
  dv.setUint32(16, g.names.length, true);
  dv.setUint32(20, 0, true);
  dv.setBigUint64(24, BigInt(g.builtAt), true);
  let o = WALK_HEADER_BYTES;
  for (const v of g.nodes) { dv.setInt32(o, v, true); o += 4; }
  for (const v of g.edges) { dv.setInt32(o, v, true); o += 4; }
  let off = 0;
  for (const b of blobs) { dv.setUint32(o, off, true); o += 4; off += b.length; }
  dv.setUint32(o, off, true);
  o += 4;
  for (const b of blobs) { out.set(b, o); o += b.length; }
  return out;
}

const int32View = (bytes, offset, count) => {
  const at = bytes.byteOffset + offset;
  if (at % 4 === 0) return new Int32Array(bytes.buffer, at, count);
  const copy = new Int32Array(count);
  const dv = new DataView(bytes.buffer, at, count * 4);
  for (let i = 0; i < count; i++) copy[i] = dv.getInt32(i * 4, true);
  return copy;
};

/** Raw SFW1 bytes → graph (typed-array views, no parse); validated, and against `manifest` when given. */
export function decodeWalk(bytes, manifest) {
  if (!(bytes instanceof Uint8Array)) throw new Error("decodeWalk: expected a Uint8Array");
  if (bytes.length < WALK_HEADER_BYTES) throw new Error(`decodeWalk: ${bytes.length} bytes is shorter than the header`);
  const magic = magicOf(bytes);
  if (magic !== WALK_MAGIC) throw new Error(`not a walk graph: magic ${JSON.stringify(magic)}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint16(4, true);
  if (version !== WALK_VERSION) throw new Error(`walk graph version ${version}, this reader reads ${WALK_VERSION}`);
  if (dv.getUint16(6, true) !== 0 || dv.getUint32(20, true) !== 0) throw new Error("walk: reserved header fields are not 0");
  const nNodes = dv.getUint32(8, true), nEdges = dv.getUint32(12, true), nNames = dv.getUint32(16, true);
  const builtAt = Number(dv.getBigUint64(24, true));
  const nodesAt = WALK_HEADER_BYTES, edgesAt = nodesAt + nNodes * 12, namesAt = edgesAt + nEdges * 20;
  const blobAt = namesAt + 4 * (nNames + 1);
  if (bytes.length < blobAt) throw new Error(`walk: ${bytes.length} bytes, header needs at least ${blobAt}`);
  const offsets = [];
  for (let i = 0; i <= nNames; i++) offsets.push(dv.getUint32(namesAt + 4 * i, true));
  if (offsets[0] !== 0) throw new Error("walk: first name offset is not 0");
  for (let i = 1; i <= nNames; i++) if (offsets[i] < offsets[i - 1]) throw new Error(`walk: name offset ${i} goes backwards`);
  if (bytes.length !== blobAt + offsets[nNames]) throw new Error(`walk: ${bytes.length} bytes, expected ${blobAt + offsets[nNames]}`);
  const dec = new TextDecoder("utf-8", { fatal: true });
  const names = [];
  for (let i = 0; i < nNames; i++) names.push(dec.decode(bytes.subarray(blobAt + offsets[i], blobAt + offsets[i + 1])));
  return validateWalk({ builtAt, nodes: int32View(bytes, nodesAt, nNodes * 3), edges: int32View(bytes, edgesAt, nEdges * 5), names }, manifest);
}

// ---------- places.json ----------

export const PLACE_KINDS = Object.freeze(["company", "landmark", "intersection", "area"]);
const PLACE_ID_RE = /^[a-z0-9][a-z0-9:&-]*$/;

/** Intersection display name "A & B" (as written). */
export const intersectionName = (a, b) => `${a} & ${b}`;

/**
 * places.json checks (spec-v2 §4): {builtAt, places: [{id, kind, name, aliases[], lat, lon, x, z, node, siteId?, door?}]}.
 * x, z are lat/lon projected with manifest.proj (±0.5 block); node indexes `walk`; company places carry siteId;
 * an intersection "A & B" lists "B & A" among its aliases.
 */
export function validatePlaces(doc, manifest, walk) {
  keysExactly(doc, ["builtAt", "places"], [], "places");
  if (doc.builtAt !== manifest.builtAt) throw new Error(`places.builtAt ${doc.builtAt} != manifest.builtAt ${manifest.builtAt}`);
  if (!Array.isArray(doc.places)) throw new Error("places.places must be an array");
  const nNodes = walk.nodes.length / WALK_NODE_INTS;
  const ids = new Set();
  doc.places.forEach((p, i) => {
    const what = `places[${i}]${isObj(p) && typeof p.id === "string" ? ` (${p.id})` : ""}`;
    keysExactly(p, ["id", "kind", "name", "aliases", "lat", "lon", "x", "z", "node"], ["siteId", "door"], what);
    if (typeof p.id !== "string" || !PLACE_ID_RE.test(p.id)) throw new Error(`${what}.id: bad id ${JSON.stringify(p.id)}`);
    if (ids.has(p.id)) throw new Error(`${what}: duplicate place id`);
    ids.add(p.id);
    if (!PLACE_KINDS.includes(p.kind)) throw new Error(`${what}.kind must be one of ${PLACE_KINDS.join("|")}, got ${p.kind}`);
    str(p.name, `${what}.name`);
    if (!Array.isArray(p.aliases)) throw new Error(`${what}.aliases must be an array`);
    p.aliases.forEach((a, k) => str(a, `${what}.aliases[${k}]`));
    const q = lonLatToBlock(finite(p.lon, `${what}.lon`), finite(p.lat, `${what}.lat`), manifest.proj);
    if (Math.abs(q.x - finite(p.x, `${what}.x`)) > 0.5 || Math.abs(q.z - finite(p.z, `${what}.z`)) > 0.5) {
      throw new Error(`${what}: x,z ${p.x},${p.z} is not lat/lon projected (${q.x.toFixed(2)},${q.z.toFixed(2)})`);
    }
    inRange(p.node, 0, nNodes - 1, `${what}.node`);
    if (p.kind === "company") {
      if (typeof p.siteId !== "string" || !SITE_ID_RE.test(p.siteId)) throw new Error(`${what}: a company place needs a siteId`);
    } else if ("siteId" in p) throw new Error(`${what}: siteId on a ${p.kind} place`);
    if ("door" in p) {
      if (p.kind !== "company") throw new Error(`${what}: door on a ${p.kind} place`);
      intPair(p.door, `${what}.door`);
    }
    if (p.kind === "intersection") {
      const parts = p.name.split(" & ");
      if (parts.length !== 2) throw new Error(`${what}: intersection name must be "A & B", got ${JSON.stringify(p.name)}`);
      const swapped = intersectionName(parts[1], parts[0]);
      if (!p.aliases.includes(swapped)) throw new Error(`${what}: aliases must include ${JSON.stringify(swapped)}`);
    }
  });
  return doc;
}

// ---------- manifest & companies validators ----------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const CITY_ID_RE = /^[a-z0-9-]+$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;
const FILE_RE = /^[a-z0-9][a-z0-9._-]*\.(bin|json)$/;
const PARENT_KEY_RE = /^[1-9]\d*$/;

function keysExactly(obj, required, optional, what) {
  if (!isObj(obj)) throw new Error(`${what}: must be an object`);
  for (const k of required) if (!(k in obj)) throw new Error(`${what}: missing "${k}"`);
  for (const k of Object.keys(obj)) if (!required.includes(k) && !optional.includes(k)) throw new Error(`${what}: unknown field "${k}"`);
}
const str = (v, what) => {
  if (typeof v !== "string" || v.length === 0) throw new Error(`${what} must be a non-empty string`);
  return v;
};
const int = (v, what) => {
  if (!Number.isInteger(v)) throw new Error(`${what} must be an integer, got ${v}`);
  return v;
};
const intPair = (v, what) => {
  if (!Array.isArray(v) || v.length !== 2) throw new Error(`${what} must be [a, b]`);
  return [int(v[0], `${what}[0]`), int(v[1], `${what}[1]`)];
};

export const MAX_CHUNK_GZ_BYTES = 64 * 1024;
/** Output budget for public/city/{id}/ (spec-v2 §2). */
export const CITY_BUDGET = Object.freeze({ files: 1300, totalBytes: 8 * 1024 * 1024, chunkGzBytes: MAX_CHUNK_GZ_BYTES });
export const TERRAIN_EXAGGERATION = Object.freeze({ default: 1, min: 1, max: 3 });

const MANIFEST_KEYS = [
  "version", "city", "name", "blockM", "chunk", "proj", "terrainExaggeration", "chunks", "water", "areas",
  "landmask", "landmarks", "street", "walk", "places", "parents", "yRange", "spawn", "attribution", "sources", "builtAt",
];

/** Projection object checks: exactly PROJ_KEYS, all finite, x0/z0 chunk-aligned integers. */
export function validateProj(p, what = "proj") {
  keysExactly(p, PROJ_KEYS, [], what);
  for (const k of PROJ_KEYS) finite(p[k], `${what}.${k}`);
  if (p.rotDeg <= -180 || p.rotDeg > 180) throw new Error(`${what}.rotDeg ${p.rotDeg} outside (-180, 180]`);
  for (const k of ["x0", "z0"]) if (!Number.isInteger(p[k]) || p[k] % CHUNK !== 0) throw new Error(`${what}.${k} must be a multiple of ${CHUNK}, got ${p[k]}`);
  return p;
}

/** Throws on any deviation from the v2 manifest shape (spec-v2 §4) and on extra keys; returns the manifest. */
export function validateManifest(m) {
  if (!isObj(m)) throw new Error("manifest: must be an object");
  if (m.version !== CITY_VERSION) throw new Error(`manifest: version ${m.version}, this viewer reads ${CITY_VERSION}`);
  keysExactly(m, MANIFEST_KEYS, [], "manifest");
  if (typeof m.city !== "string" || !CITY_ID_RE.test(m.city)) throw new Error(`manifest: bad city id ${JSON.stringify(m.city)}`);
  str(m.name, "manifest.name");
  if (m.blockM !== BLOCK_M) throw new Error(`manifest: blockM ${m.blockM}, expected ${BLOCK_M}`);
  if (m.chunk !== CHUNK) throw new Error(`manifest: chunk ${m.chunk}, expected ${CHUNK}`);
  validateProj(m.proj, "manifest.proj");
  const tx = finite(m.terrainExaggeration, "manifest.terrainExaggeration");
  if (tx < TERRAIN_EXAGGERATION.min || tx > TERRAIN_EXAGGERATION.max) throw new Error(`manifest.terrainExaggeration ${tx} outside ${TERRAIN_EXAGGERATION.min}..${TERRAIN_EXAGGERATION.max}`);

  keysExactly(m.chunks, ["grid", "min", "max", "list"], [], "manifest.chunks");
  const [gx, gz] = intPair(m.chunks.grid, "manifest.chunks.grid");
  if (gx < 1 || gz < 1) throw new Error("manifest.chunks.grid must be ≥ 1 chunk per axis");
  const [minX, minZ] = intPair(m.chunks.min, "manifest.chunks.min");
  const [maxX, maxZ] = intPair(m.chunks.max, "manifest.chunks.max");
  if (minX > maxX || minZ > maxZ) throw new Error("manifest.chunks: min is past max");
  if (minX < 0 || minZ < 0 || maxX >= gx || maxZ >= gz) throw new Error(`manifest.chunks: min/max outside the ${gx}×${gz} grid`);
  if (!Array.isArray(m.chunks.list)) throw new Error("manifest.chunks.list must be an array");
  if (m.chunks.list.length > CITY_BUDGET.files) throw new Error(`manifest.chunks.list: ${m.chunks.list.length} chunks > ${CITY_BUDGET.files} files`);
  const seen = new Set();
  const inMinMax = (cx, cz) => cx >= minX && cx <= maxX && cz >= minZ && cz <= maxZ;
  m.chunks.list.forEach((e, i) => {
    const what = `manifest.chunks.list[${i}]`;
    if (!Array.isArray(e) || e.length !== 3) throw new Error(`${what} must be [cx, cz, bytesGz]`);
    const [cx, cz, bytes] = e.map((v, j) => int(v, `${what}[${j}]`));
    if (!inMinMax(cx, cz)) throw new Error(`${what}: chunk ${cx},${cz} outside min/max`);
    if (bytes < 1 || bytes > MAX_CHUNK_GZ_BYTES) throw new Error(`${what}: ${bytes} bytes outside 1..${MAX_CHUNK_GZ_BYTES}`);
    const key = chunkKey(cx, cz);
    if (seen.has(key)) throw new Error(`${what}: duplicate chunk ${key}`);
    seen.add(key);
  });
  if (!Array.isArray(m.water)) throw new Error("manifest.water must be an array of [cx, cz]");
  m.water.forEach((e, i) => {
    const what = `manifest.water[${i}]`;
    const [cx, cz] = intPair(e, what);
    if (!inMinMax(cx, cz)) throw new Error(`${what}: chunk ${cx},${cz} outside min/max`);
    const key = chunkKey(cx, cz);
    if (seen.has(key)) throw new Error(`${what}: chunk ${key} is listed or already water`);
    seen.add(key);
  });

  if (!Array.isArray(m.areas) || m.areas.length === 0) throw new Error("manifest.areas must be a non-empty array");
  const areaIds = new Set();
  m.areas.forEach((a, i) => {
    const what = `manifest.areas[${i}]`;
    keysExactly(a, ["id", "west", "south", "east", "north"], [], what);
    if (typeof a.id !== "string" || !CITY_ID_RE.test(a.id)) throw new Error(`${what}.id: bad id ${JSON.stringify(a.id)}`);
    if (areaIds.has(a.id)) throw new Error(`${what}: duplicate area id ${a.id}`);
    areaIds.add(a.id);
    for (const k of ["west", "south", "east", "north"]) finite(a[k], `${what}.${k}`);
    if (a.west >= a.east || a.south >= a.north) throw new Error(`${what}: west/south must be below east/north`);
    if (a.west < -180 || a.east > 180 || a.south < -90 || a.north > 90) throw new Error(`${what}: outside lon/lat range`);
  });
  for (const k of ["landmask", "landmarks", "street", "walk", "places"]) {
    if (typeof m[k] !== "string" || !FILE_RE.test(m[k])) throw new Error(`manifest.${k} must be a file name next to the manifest, got ${JSON.stringify(m[k])}`);
  }
  if (!isObj(m.parents)) throw new Error("manifest.parents must be an object {id: name}");
  for (const [k, v] of Object.entries(m.parents)) {
    if (!PARENT_KEY_RE.test(k) || Number(k) > 0xffffffff) throw new Error(`manifest.parents: bad id ${JSON.stringify(k)}`);
    str(v, `manifest.parents[${k}]`);
  }

  const [yMin, yMax] = intPair(m.yRange, "manifest.yRange");
  if (yMin > yMax) throw new Error("manifest.yRange: min above max");
  keysExactly(m.spawn, ["x", "z", "dist", "az"], [], "manifest.spawn");
  finite(m.spawn.x, "manifest.spawn.x");
  finite(m.spawn.z, "manifest.spawn.z");
  finite(m.spawn.az, "manifest.spawn.az");
  if (finite(m.spawn.dist, "manifest.spawn.dist") <= 0) throw new Error("manifest.spawn.dist must be > 0");
  if (!Array.isArray(m.attribution) || m.attribution.length === 0) throw new Error("manifest.attribution must be a non-empty array");
  m.attribution.forEach((a, i) => str(a, `manifest.attribution[${i}]`));
  if (!Array.isArray(m.sources)) throw new Error("manifest.sources must be an array");
  m.sources.forEach((s, i) => {
    if (!isObj(s)) throw new Error(`manifest.sources[${i}] must be an object`);
    for (const k of ["id", "url", "license"]) str(s[k], `manifest.sources[${i}].${k}`);
  });
  if (typeof m.builtAt !== "string" || !ISO_TIME_RE.test(m.builtAt)) throw new Error(`manifest.builtAt must be an ISO UTC timestamp, got ${m.builtAt}`);
  return m;
}

export const COMPANY_STATUSES = Object.freeze(["hq", "office", "former", "landmark"]);
export const SOURCE_KINDS = Object.freeze(["occupancy", "registry", "news", "company", "operator"]);
export const PLACEMENTS = Object.freeze(["contains", "nearest", "override"]);
const SITE_REQUIRED = [
  "id", "companyId", "name", "primary", "address", "status", "category", "color", "sources", "verifiedAt",
  "lat", "lon", "eas", "hintFrom", "buildingId", "block", "chunk", "anchor", "roofY", "heightM", "placement", "placementDistM",
];
const SITE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function validateSource(s, what) {
  if (isObj(s) && s.kind === "operator") {
    keysExactly(s, ["kind", "statement", "date"], [], what);
    str(s.statement, `${what}.statement`);
    if (typeof s.date !== "string" || !ISO_DATE_RE.test(s.date)) throw new Error(`${what}.date must be YYYY-MM-DD`);
    return;
  }
  keysExactly(s, ["url", "kind"], ["date", "accessed"], what);
  str(s.url, `${what}.url`);
  if (!SOURCE_KINDS.includes(s.kind)) throw new Error(`${what}.kind must be one of ${SOURCE_KINDS.join("|")}, got ${s.kind}`);
  if ("date" in s && (typeof s.date !== "string" || !ISO_DATE_RE.test(s.date))) throw new Error(`${what}.date must be YYYY-MM-DD`);
  if ("accessed" in s && (typeof s.accessed !== "string" || !ISO_DATE_RE.test(s.accessed))) throw new Error(`${what}.accessed must be YYYY-MM-DD`);
}

function validateSite(s, what, proj, manifest) {
  keysExactly(s, SITE_REQUIRED, ["note"], what);
  if (typeof s.id !== "string" || !SITE_ID_RE.test(s.id)) throw new Error(`${what}.id: bad id ${JSON.stringify(s.id)}`);
  if (typeof s.companyId !== "string" || !SITE_ID_RE.test(s.companyId)) throw new Error(`${what}.companyId: bad id ${JSON.stringify(s.companyId)}`);
  str(s.name, `${what}.name`);
  if (typeof s.primary !== "boolean") throw new Error(`${what}.primary must be boolean`);
  str(s.address, `${what}.address`);
  if (!COMPANY_STATUSES.includes(s.status)) throw new Error(`${what}.status must be one of ${COMPANY_STATUSES.join("|")}, got ${s.status}`);
  str(s.category, `${what}.category`);
  if (typeof s.color !== "string" || !HEX_RE.test(s.color)) throw new Error(`${what}.color must be #rrggbb`);
  if (!Array.isArray(s.sources) || s.sources.length === 0) throw new Error(`${what}.sources must be a non-empty array`);
  s.sources.forEach((src, i) => validateSource(src, `${what}.sources[${i}]`));
  if (typeof s.verifiedAt !== "string" || !ISO_DATE_RE.test(s.verifiedAt)) throw new Error(`${what}.verifiedAt must be YYYY-MM-DD`);
  if ((s.status === "hq" || s.status === "office") && !s.sources.some((x) => x.kind === "occupancy" || x.kind === "operator")) {
    throw new Error(`${what}: status ${s.status} needs an occupancy or operator source`);
  }
  if (s.status === "former" && !s.sources.some((x) => (x.kind === "news" || x.kind === "company") && x.date)) {
    throw new Error(`${what}: status former needs a dated news or company source`);
  }
  if ("note" in s) str(s.note, `${what}.note`);
  finite(s.lat, `${what}.lat`);
  finite(s.lon, `${what}.lon`);
  keysExactly(s.eas, ["id", "parcel"], [], `${what}.eas`);
  if (!Number.isInteger(s.eas.id) || s.eas.id < 1) throw new Error(`${what}.eas.id must be a positive integer`);
  str(s.eas.parcel, `${what}.eas.parcel`);
  str(s.hintFrom, `${what}.hintFrom`);
  inRange(s.buildingId, 0, 0xffffffff, `${what}.buildingId`);
  keysExactly(s.block, ["x", "z"], [], `${what}.block`);
  int(s.block.x, `${what}.block.x`);
  int(s.block.z, `${what}.block.z`);
  const p = lonLatToBlock(s.lon, s.lat, proj);
  if (Math.floor(p.x) !== s.block.x || Math.floor(p.z) !== s.block.z) {
    throw new Error(`${what}.block ${s.block.x},${s.block.z} is not the column of lat/lon (${Math.floor(p.x)},${Math.floor(p.z)})`);
  }
  const [cx, cz] = intPair(s.chunk, `${what}.chunk`);
  const [ecx, ecz] = chunkOf(s.block.x, s.block.z);
  if (cx !== ecx || cz !== ecz) throw new Error(`${what}.chunk ${cx},${cz} does not hold block (expected ${ecx},${ecz})`);
  if (manifest) {
    const { min, max } = manifest.chunks;
    if (cx < min[0] || cx > max[0] || cz < min[1] || cz > max[1]) throw new Error(`${what}: chunk ${cx},${cz} outside the manifest`);
  }
  keysExactly(s.anchor, ["x", "y", "z"], [], `${what}.anchor`);
  for (const k of ["x", "y", "z"]) int(s.anchor[k], `${what}.anchor.${k}`);
  if (s.anchor.y < 1) throw new Error(`${what}.anchor.y ${s.anchor.y} is not on land`);
  int(s.roofY, `${what}.roofY`);
  if (finite(s.heightM, `${what}.heightM`) <= 0) throw new Error(`${what}.heightM must be > 0`);
  if (!PLACEMENTS.includes(s.placement)) throw new Error(`${what}.placement must be one of ${PLACEMENTS.join("|")}`);
  if (finite(s.placementDistM, `${what}.placementDistM`) < 0) throw new Error(`${what}.placementDistM must be ≥ 0`);
  if (s.placement === "contains" && s.placementDistM !== 0) throw new Error(`${what}: placement contains with distance ${s.placementDistM}`);
}

/**
 * Throws on any deviation from companies.json (spec section 4); returns the document.
 * With `manifest`, also checks city, projection and that every site's chunk is inside the manifest.
 * Placement against chunk data (buildingId present, anchor column) is companies.check.
 */
export function validateCompanies(doc, manifest) {
  keysExactly(doc, ["version", "city", "builtAt", "sites"], [], "companies");
  if (doc.version !== CITY_VERSION) throw new Error(`companies: version ${doc.version}, expected ${CITY_VERSION}`);
  if (typeof doc.city !== "string" || !CITY_ID_RE.test(doc.city)) throw new Error(`companies: bad city id ${JSON.stringify(doc.city)}`);
  if (typeof doc.builtAt !== "string" || !ISO_TIME_RE.test(doc.builtAt)) throw new Error("companies.builtAt must be an ISO UTC timestamp");
  if (!Array.isArray(doc.sites)) throw new Error("companies.sites must be an array");
  if (manifest) {
    validateManifest(manifest);
    if (manifest.city !== doc.city) throw new Error(`companies: city ${doc.city} does not match manifest ${manifest.city}`);
  }
  const proj = manifest ? manifest.proj : SF_PROJ;
  const ids = new Set();
  const primaries = new Map();
  doc.sites.forEach((s, i) => {
    const what = `companies.sites[${i}]${isObj(s) && typeof s.id === "string" ? ` (${s.id})` : ""}`;
    validateSite(s, what, proj, manifest);
    if (ids.has(s.id)) throw new Error(`${what}: duplicate site id`);
    ids.add(s.id);
    primaries.set(s.companyId, (primaries.get(s.companyId) ?? 0) + (s.primary ? 1 : 0));
  });
  for (const [companyId, n] of primaries) {
    if (n !== 1) throw new Error(`companies: ${companyId} has ${n} primary sites, expected exactly 1`);
  }
  return doc;
}
