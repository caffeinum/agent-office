// The voxel city contract: projection, chunk binary format, surface classes, palette, and the
// manifest/companies validators. Shared by the build scripts (node), the viewer and the mesher worker
// (served as /shared/city.js). Plain ESM, no DOM, no node APIs, no dependencies: the mesher worker
// imports this by relative path because module workers get no importmap.
//
// World: 1 block = 3 m on every axis. +x east, +z south, y up, y = 0 is sea level (water top).
// A chunk is 64×64 columns; column index = lz * 64 + lx. Spec: docs/city/spec.md (sections 1–2).

export const CITY_VERSION = 1;
export const BLOCK_M = 3;
export const CHUNK = 64;
export const REGION = 4;
/** 1 office cell = 1/4 block = 0.75 m (spec section 1). */
export const OFFICE_CELL_BLOCKS = 0.25;

/** Global, fixed local-equirectangular projection; the NW corner of SF is the origin. */
export const SF_PROJ = Object.freeze({
  lon0: -122.52,
  lat0: 37.835,
  latRef: 37.77,
  mPerDegLat: 110574,
  mPerDegLon: 87995.8,
});

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
});

export const SURFACE_COLORS = Object.freeze({
  [SURFACE.WATER]: "#3d7fb3",
  [SURFACE.SHALLOW]: "#5aa0cf",
  [SURFACE.SAND]: "#e9d8a6",
  [SURFACE.GRASS]: "#7cbf5a",
  [SURFACE.PARK]: "#6aad4d",
  [SURFACE.FOREST]: "#4f8a3c",
  [SURFACE.ROAD]: "#4a4d52",
  [SURFACE.SIDEWALK]: "#c9c4ba",
  [SURFACE.RAIL]: "#6b6158",
  [SURFACE.PLAZA]: "#d8cdbd",
  [SURFACE.PIER]: "#8b6b4a",
  [SURFACE.HILL]: "#c8b273",
  [SURFACE.PARKING]: "#8d8f93",
});

const SURFACE_IDS = new Set(Object.values(SURFACE));
const isWaterSurface = (s) => s === SURFACE.WATER || s === SURFACE.SHALLOW;

/** Building wall colours; a chunk's building-table `palette` byte indexes this array. Roofs are 12% darker. */
export const BUILDING_PALETTE = Object.freeze([
  // pastel (0–5)
  "#f4c6c6", "#c9e2f0", "#f6e3a6", "#cfe8c9", "#e4d3f2", "#fbf6ec",
  // midrise brick / stucco (6–10)
  "#a65a44", "#8c4a3a", "#e9dfcf", "#d8cdbd", "#b9b3a8",
  // stone / concrete (11–14)
  "#cfcac0", "#b5afa5", "#9f9a92", "#e2ddd3",
  // glass (15–16)
  "#7fa6c4", "#5e86a8",
  // landmarks (17–18)
  "#e8e6df", "#f2efe8",
]);

const range = (a, b) => Object.freeze(Array.from({ length: b - a + 1 }, (_, i) => a + i));

/** Height groups by building height in blocks (top − base). Landmarks are assigned by override only. */
export const PALETTE_GROUPS = Object.freeze({
  pastel: Object.freeze({ minH: 0, maxH: 4, indices: range(0, 5) }),
  midrise: Object.freeze({ minH: 5, maxH: 12, indices: range(6, 10) }),
  stone: Object.freeze({ minH: 13, maxH: 30, indices: range(11, 14) }),
  glass: Object.freeze({ minH: 31, maxH: Infinity, indices: range(15, 16) }),
  landmark: Object.freeze({ salesforce: 17, transamerica: 18 }),
});

export const ROOF_DARKEN = 0.12;

const DIRT = "#8a6b4e";
/** Colour of a column's exposed terrain side (cliffs, terraces, the land under a building). */
export const TERRAIN_SIDE_COLORS = Object.freeze({
  [SURFACE.WATER]: "#2f6a99",
  [SURFACE.SHALLOW]: "#2f6a99",
  [SURFACE.SAND]: "#d4c08c",
  [SURFACE.GRASS]: DIRT,
  [SURFACE.PARK]: DIRT,
  [SURFACE.FOREST]: DIRT,
  [SURFACE.ROAD]: "#7d7870",
  [SURFACE.SIDEWALK]: "#a9a398",
  [SURFACE.RAIL]: "#5a5149",
  [SURFACE.PLAZA]: "#b3a998",
  [SURFACE.PIER]: "#6e5338",
  [SURFACE.HILL]: DIRT,
  [SURFACE.PARKING]: "#7d7870",
});

/** Elevated road decks: asphalt slab top, concrete edges and pillars, a shaded underside. */
export const DECK_COLORS = Object.freeze({
  top: "#4a4d52",
  edge: "#b5afa5",
  pillar: "#9f9a92",
  under: "#6e6a64",
});

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

/** Palette index for a non-landmark building of `heightBlocks` (top − base) with building id `id`. */
export function paletteFor(heightBlocks, id) {
  if (!Number.isInteger(heightBlocks) || heightBlocks < 1) throw new Error(`paletteFor: height must be an integer ≥ 1, got ${heightBlocks}`);
  const group = [PALETTE_GROUPS.pastel, PALETTE_GROUPS.midrise, PALETTE_GROUPS.stone, PALETTE_GROUPS.glass]
    .find((g) => heightBlocks >= g.minH && heightBlocks <= g.maxH);
  return group.indices[hashId(id) % group.indices.length];
}

// ---------- projection ----------

const finite = (v, what) => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${what} must be a finite number, got ${v}`);
  return v;
};

/** lon/lat (degrees) → fractional block coordinates. */
export function lonLatToBlock(lon, lat, proj = SF_PROJ) {
  finite(lon, "lon");
  finite(lat, "lat");
  return {
    x: ((lon - proj.lon0) * proj.mPerDegLon) / BLOCK_M,
    z: ((proj.lat0 - lat) * proj.mPerDegLat) / BLOCK_M,
  };
}

/** Fractional block coordinates → lon/lat (degrees). Exact inverse of lonLatToBlock. */
export function blockToLonLat(x, z, proj = SF_PROJ) {
  finite(x, "x");
  finite(z, "z");
  return {
    lon: proj.lon0 + (x * BLOCK_M) / proj.mPerDegLon,
    lat: proj.lat0 - (z * BLOCK_M) / proj.mPerDegLat,
  };
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

// ---------- chunk binary format ----------

export const CHUNK_MAGIC = "SFC1";
export const COLUMNS = CHUNK * CHUNK;
export const HEADER_BYTES = 16;
export const BUILDING_ENTRY_BYTES = 12;
const LAYERS = [
  ["ground", Int16Array],
  ["surface", Uint8Array],
  ["bldg", Uint16Array],
  ["deck", Int16Array],
];
const BODY_BYTES = LAYERS.reduce((n, [, T]) => n + T.BYTES_PER_ELEMENT * COLUMNS, 0);
const I16_MIN = -32768;
const I16_MAX = 32767;

const inRange = (v, lo, hi, what) => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${what} must be an integer in ${lo}..${hi}, got ${v}`);
  return v;
};

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

/** Structural and semantic checks every encoded/decoded chunk satisfies. Throws on the first problem. */
export function validateChunk(chunk) {
  if (!chunk || typeof chunk !== "object") throw new Error("chunk: not an object");
  const at = `chunk ${chunk.cx},${chunk.cz}`;
  inRange(chunk.cx, I16_MIN, I16_MAX, `${at}: cx`);
  inRange(chunk.cz, I16_MIN, I16_MAX, `${at}: cz`);
  for (const [name, T] of LAYERS) {
    if (!(chunk[name] instanceof T)) throw new Error(`${at}: ${name} must be a ${T.name}`);
    if (chunk[name].length !== COLUMNS) throw new Error(`${at}: ${name} has ${chunk[name].length} columns, expected ${COLUMNS}`);
  }
  if (!Array.isArray(chunk.buildings)) throw new Error(`${at}: buildings must be an array`);
  inRange(chunk.buildings.length, 0, 0xffff, `${at}: nBuildings`);
  const ids = new Set();
  chunk.buildings.forEach((b, i) => {
    const bt = `${at}: building[${i}]`;
    inRange(b.id, 0, 0xffffffff, `${bt}.id`);
    if (ids.has(b.id)) throw new Error(`${bt}: duplicate id ${b.id}`);
    ids.add(b.id);
    inRange(b.base, I16_MIN, I16_MAX, `${bt}.base`);
    inRange(b.top, I16_MIN, I16_MAX, `${bt}.top`);
    if (b.top <= b.base) throw new Error(`${bt}: top ${b.top} must be above base ${b.base}`);
    if (b.base < 1) throw new Error(`${bt}: base ${b.base} is below land (y=1)`);
    inRange(b.palette, 0, BUILDING_PALETTE.length - 1, `${bt}.palette`);
    if (b.roof !== 0) throw new Error(`${bt}: roof must be 0 (flat) in v1, got ${b.roof}`);
  });
  const { ground, surface, bldg, deck, buildings } = chunk;
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
      if (g !== buildings[b - 1].base) throw new Error(`${col()}: building column ground ${g} must equal its base ${buildings[b - 1].base}`);
    }
    const d = deck[i];
    if (d !== 0 && Math.abs(d) <= g) throw new Error(`${col()}: deck top ${Math.abs(d)} not above ground ${g}`);
  }
  return chunk;
}

/** Chunk → raw (un-gzipped) little-endian SFC1 bytes. Validates first. */
export function encodeChunk(chunk) {
  validateChunk(chunk);
  const n = chunk.buildings.length;
  const out = new Uint8Array(HEADER_BYTES + BODY_BYTES + n * BUILDING_ENTRY_BYTES);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = CHUNK_MAGIC.charCodeAt(i);
  dv.setUint16(4, CITY_VERSION, true);
  dv.setInt16(6, chunk.cx, true);
  dv.setInt16(8, chunk.cz, true);
  dv.setUint16(10, CHUNK, true);
  dv.setUint16(12, n, true);
  dv.setUint16(14, 0, true);
  let o = HEADER_BYTES;
  for (const [name, T] of LAYERS) {
    const src = chunk[name];
    if (T.BYTES_PER_ELEMENT === 1) out.set(src, o);
    else for (let i = 0; i < COLUMNS; i++) T === Int16Array ? dv.setInt16(o + 2 * i, src[i], true) : dv.setUint16(o + 2 * i, src[i], true);
    o += T.BYTES_PER_ELEMENT * COLUMNS;
  }
  for (const b of chunk.buildings) {
    dv.setUint32(o, b.id, true);
    dv.setInt16(o + 4, b.base, true);
    dv.setInt16(o + 6, b.top, true);
    dv.setUint8(o + 8, b.palette);
    dv.setUint8(o + 9, b.roof);
    dv.setUint16(o + 10, 0, true);
    o += BUILDING_ENTRY_BYTES;
  }
  return out;
}

/** Raw (already inflated) SFC1 bytes → chunk. Throws on HTML, gzip, bad magic/version/size, or bad data. */
export function decodeChunk(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error("decodeChunk: expected a Uint8Array");
  if (bytes[0] === 0x3c) throw new Error("not a city chunk (got HTML?)");
  if (isGzip(bytes)) throw new Error("decodeChunk: bytes are still gzipped; inflate first");
  if (bytes.length < HEADER_BYTES + BODY_BYTES) throw new Error(`decodeChunk: ${bytes.length} bytes is shorter than a chunk`);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== CHUNK_MAGIC) throw new Error(`not a city chunk: magic ${JSON.stringify(magic)}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint16(4, true);
  if (version !== CITY_VERSION) throw new Error(`city chunk version ${version}, this viewer reads ${CITY_VERSION}`);
  const cx = dv.getInt16(6, true);
  const cz = dv.getInt16(8, true);
  const size = dv.getUint16(10, true);
  if (size !== CHUNK) throw new Error(`chunk ${cx},${cz}: size ${size}, expected ${CHUNK}`);
  const n = dv.getUint16(12, true);
  if (dv.getUint16(14, true) !== 0) throw new Error(`chunk ${cx},${cz}: reserved header field is not 0`);
  const expected = HEADER_BYTES + BODY_BYTES + n * BUILDING_ENTRY_BYTES;
  if (bytes.length !== expected) throw new Error(`chunk ${cx},${cz}: ${bytes.length} bytes, expected ${expected}`);
  const chunk = { cx, cz };
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
    if (dv.getUint16(o + 10, true) !== 0) throw new Error(`chunk ${cx},${cz}: building[${i}] reserved field is not 0`);
    chunk.buildings.push({
      id: dv.getUint32(o, true),
      base: dv.getInt16(o + 4, true),
      top: dv.getInt16(o + 6, true),
      palette: dv.getUint8(o + 8),
      roof: dv.getUint8(o + 9),
    });
  }
  return validateChunk(chunk);
}

// ---------- manifest & companies validators ----------

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const CITY_ID_RE = /^[a-z0-9-]+$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;

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

/** Throws on any deviation from the manifest shape (spec section 2); returns the manifest. */
export function validateManifest(m) {
  keysExactly(m, ["version", "city", "name", "blockM", "chunk", "proj", "chunks", "yRange", "spawn", "attribution", "sources", "builtAt"], [], "manifest");
  if (m.version !== CITY_VERSION) throw new Error(`manifest: version ${m.version}, this viewer reads ${CITY_VERSION}`);
  if (typeof m.city !== "string" || !CITY_ID_RE.test(m.city)) throw new Error(`manifest: bad city id ${JSON.stringify(m.city)}`);
  str(m.name, "manifest.name");
  if (m.blockM !== BLOCK_M) throw new Error(`manifest: blockM ${m.blockM}, expected ${BLOCK_M}`);
  if (m.chunk !== CHUNK) throw new Error(`manifest: chunk ${m.chunk}, expected ${CHUNK}`);
  keysExactly(m.proj, Object.keys(SF_PROJ), [], "manifest.proj");
  for (const k of Object.keys(SF_PROJ)) finite(m.proj[k], `manifest.proj.${k}`);
  keysExactly(m.chunks, ["min", "max", "list"], [], "manifest.chunks");
  const [minX, minZ] = intPair(m.chunks.min, "manifest.chunks.min");
  const [maxX, maxZ] = intPair(m.chunks.max, "manifest.chunks.max");
  if (minX > maxX || minZ > maxZ) throw new Error("manifest.chunks: min is past max");
  if (!Array.isArray(m.chunks.list)) throw new Error("manifest.chunks.list must be an array");
  const seen = new Set();
  m.chunks.list.forEach((e, i) => {
    const what = `manifest.chunks.list[${i}]`;
    if (!Array.isArray(e) || e.length !== 3) throw new Error(`${what} must be [cx, cz, bytesGz]`);
    const [cx, cz, bytes] = e.map((v, j) => int(v, `${what}[${j}]`));
    if (cx < minX || cx > maxX || cz < minZ || cz > maxZ) throw new Error(`${what}: chunk ${cx},${cz} outside min/max`);
    if (bytes < 1 || bytes > MAX_CHUNK_GZ_BYTES) throw new Error(`${what}: ${bytes} bytes outside 1..${MAX_CHUNK_GZ_BYTES}`);
    const key = chunkKey(cx, cz);
    if (seen.has(key)) throw new Error(`${what}: duplicate chunk ${key}`);
    seen.add(key);
  });
  const [yMin, yMax] = intPair(m.yRange, "manifest.yRange");
  if (yMin > yMax) throw new Error("manifest.yRange: min above max");
  keysExactly(m.spawn, ["x", "z", "dist"], [], "manifest.spawn");
  finite(m.spawn.x, "manifest.spawn.x");
  finite(m.spawn.z, "manifest.spawn.z");
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
 * Placement against chunk data (buildingId present, anchor column) is W3's companies.check.
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
