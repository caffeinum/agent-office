// The working raster over a chunk range, the v2 raster API the hooks write through (spec-v2 §3.10), and its
// split into shared/city.js v2 chunks.
import { ACCENT_NONE, CHUNK, COLUMNS, SURFACE, validateChunk } from "../../../public/shared/city.js";

const ENTRY_DEFAULTS = Object.freeze({ parent: 0, accentFrom: ACCENT_NONE, cap: 0, facade: 0 });
const ENTRY_KEYS = new Set(["id", "parent", "base", "top", "accentFrom", "palette", "cap", "facade", "accent"]);

/**
 * → raster {x0, z0, w, h, ground: Int16Array, surface: Uint8Array, owner: Int32Array (entry index or -1),
 *   deck: Int16Array, top: Int16Array (per-column building top, 0 = none), entries: Entry[], props: GlobalProp[],
 *   parents: {id: name}, setColumn, setSurface, setDeck, clearBuilding, addEntry, addProp, entryIndex, newId, addParent}
 * Starts all open water.
 */
export function createRaster(minChunk, maxChunk) {
  const [cx0, cz0] = minChunk;
  const [cx1, cz1] = maxChunk;
  if (cx1 < cx0 || cz1 < cz0) throw new Error(`createRaster: max ${maxChunk} is before min ${minChunk}`);
  const w = (cx1 - cx0 + 1) * CHUNK;
  const h = (cz1 - cz0 + 1) * CHUNK;
  const raster = {
    x0: cx0 * CHUNK,
    z0: cz0 * CHUNK,
    w,
    h,
    ground: new Int16Array(w * h),
    surface: new Uint8Array(w * h).fill(SURFACE.WATER),
    owner: new Int32Array(w * h).fill(-1),
    deck: new Int16Array(w * h),
    top: new Int16Array(w * h),
    entries: [],
    props: [],
    parents: {},
  };
  const byId = new Map();
  let maxId = 0;
  const at = (x, z, what) => {
    const i = rasterIndex(raster, x, z);
    if (i < 0) throw new Error(`${what}: block ${x},${z} is outside the raster`);
    return i;
  };

  /**
   * Register a building entry {id, base, top, palette, accent?, parent?, accentFrom?, cap?, facade?}; accent
   * defaults to palette, parent to 0, accentFrom to ACCENT_NONE, cap/facade to 0. → id
   */
  raster.addEntry = (entry) => {
    for (const k of Object.keys(entry)) if (!ENTRY_KEYS.has(k)) throw new Error(`addEntry: unknown field "${k}"`);
    if (!Number.isInteger(entry.id) || entry.id < 1) throw new Error(`addEntry: id must be a positive integer, got ${entry.id}`);
    if (byId.has(entry.id)) throw new Error(`addEntry: duplicate id ${entry.id}`);
    for (const k of ["base", "top", "palette"]) if (!Number.isInteger(entry[k])) throw new Error(`addEntry ${entry.id}: ${k} must be an integer, got ${entry[k]}`);
    const e = { ...ENTRY_DEFAULTS, accent: entry.palette, ...entry };
    byId.set(e.id, raster.entries.length);
    raster.entries.push(e);
    if (e.id > maxId) maxId = e.id;
    if (e.parent > maxId) maxId = e.parent;
    return e.id;
  };
  /** A fresh id above every entry and parent id so far (for hook-made entries and virtual parents). */
  raster.newId = () => ++maxId;
  /**
   * Name a virtual parent id shared by several entries (a multi-part landmark); build-sf writes these to
   * manifest.parents, which decodeChunk needs to accept a parent outside a chunk's own table.
   */
  raster.addParent = (id, name) => {
    if (!Number.isInteger(id) || id < 1) throw new Error(`addParent: id must be a positive integer, got ${id}`);
    if (typeof name !== "string" || !name.trim()) throw new Error(`addParent ${id}: name must be a non-empty string`);
    if (byId.has(id)) throw new Error(`addParent: ${id} is already an entry id`);
    if (raster.parents[id] !== undefined && raster.parents[id] !== name) throw new Error(`addParent: ${id} is already "${raster.parents[id]}"`);
    raster.parents[id] = name;
    if (id > maxId) maxId = id;
    return id;
  };
  /** Index of entry `id` in raster.entries (the owner value). */
  raster.entryIndex = (id) => {
    const k = byId.get(id);
    if (k === undefined) throw new Error(`raster: no entry with id ${id} (addEntry first)`);
    return k;
  };
  /** Make (x, z) a column of building `bldg` (an entry id): ground = base, column top = top. */
  raster.setColumn = (x, z, { bldg, base, top }) => {
    const i = at(x, z, "setColumn");
    const k = raster.entryIndex(bldg);
    if (!Number.isInteger(base) || base < 1) throw new Error(`setColumn ${x},${z}: base must be an integer ≥ 1, got ${base}`);
    if (!Number.isInteger(top) || top <= base) throw new Error(`setColumn ${x},${z}: top ${top} must be an integer above base ${base}`);
    raster.owner[i] = k;
    raster.ground[i] = base;
    raster.top[i] = top;
  };
  raster.setSurface = (x, z, id) => {
    raster.surface[at(x, z, "setSurface")] = id;
  };
  /** Remove any building from (x, z); ground and surface stay. */
  raster.clearBuilding = (x, z) => {
    const i = at(x, z, "clearBuilding");
    raster.owner[i] = -1;
    raster.top[i] = 0;
  };
  /** A deck at (x, z) with its top at `top` (above ground); pillar: true draws a pillar under it. */
  raster.setDeck = (x, z, top, { pillar = false } = {}) => {
    const i = at(x, z, "setDeck");
    if (!Number.isInteger(top) || top <= raster.ground[i]) throw new Error(`setDeck ${x},${z}: top ${top} must be an integer above ground ${raster.ground[i]}`);
    raster.deck[i] = pillar ? -top : top;
  };
  /** A chunk prop at global block (x, z): {y0, y1, color, flags}. */
  raster.addProp = (x, z, { y0, y1, color, flags }) => {
    at(x, z, "addProp");
    raster.props.push({ x, z, y0, y1, color, flags });
  };
  return raster;
}

/** Raster index of global block (x, z), or -1 when outside. */
export function rasterIndex(raster, x, z) {
  const lx = x - raster.x0, lz = z - raster.z0;
  return lx >= 0 && lz >= 0 && lx < raster.w && lz < raster.h ? lz * raster.w + lx : -1;
}

/** Turn chunk (cx, cz) of the raster back into open water and drop its props (chunks outside every area). */
export function resetChunkToSea(raster, cx, cz) {
  const lx0 = cx * CHUNK - raster.x0, lz0 = cz * CHUNK - raster.z0;
  if (lx0 < 0 || lz0 < 0 || lx0 >= raster.w || lz0 >= raster.h) throw new Error(`resetChunkToSea: chunk ${cx},${cz} is outside the raster`);
  for (let lz = lz0; lz < lz0 + CHUNK; lz++) {
    const row = lz * raster.w;
    for (let lx = lx0; lx < lx0 + CHUNK; lx++) {
      const i = row + lx;
      raster.ground[i] = 0;
      raster.surface[i] = SURFACE.WATER;
      raster.owner[i] = -1;
      raster.deck[i] = 0;
      raster.top[i] = 0;
    }
  }
  raster.props = raster.props.filter((p) => Math.floor(p.x / CHUNK) !== cx || Math.floor(p.z / CHUNK) !== cz);
}

const isOpenWater = (raster, i) => raster.surface[i] === SURFACE.WATER && raster.deck[i] === 0 && raster.owner[i] === -1;

/**
 * Split into shared/city.js v2 Chunk objects, validated with `parents` (manifest.parents). Each chunk's entry
 * `top` is the max column top of that entry inside the chunk. Chunks that are entirely open WATER (no shallow,
 * deck, building or prop) are dropped and returned as `water` [cx, cz] pairs.
 * → {chunks: Chunk[] (row-major by cz, cx), water: [cx, cz][]}
 */
export function rasterToChunks(raster, parents = {}) {
  const nx = raster.w / CHUNK, nz = raster.h / CHUNK;
  const cx0 = raster.x0 / CHUNK, cz0 = raster.z0 / CHUNK;
  const propsByChunk = new Map();
  for (const p of raster.props) {
    const key = `${Math.floor(p.x / CHUNK)},${Math.floor(p.z / CHUNK)}`;
    if (!propsByChunk.has(key)) propsByChunk.set(key, []);
    propsByChunk.get(key).push(p);
  }
  const chunks = [];
  const water = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const cx = cx0 + i, cz = cz0 + j;
      const chunk = {
        cx, cz, frame: 0,
        ground: new Int16Array(COLUMNS),
        surface: new Uint8Array(COLUMNS),
        bldg: new Uint16Array(COLUMNS),
        deck: new Int16Array(COLUMNS),
        top: new Int16Array(COLUMNS),
        buildings: [],
        props: [],
      };
      const tops = new Map();
      let open = true;
      for (let lz = 0; lz < CHUNK; lz++) {
        const row = (j * CHUNK + lz) * raster.w + i * CHUNK;
        for (let lx = 0; lx < CHUNK; lx++) {
          const ri = row + lx, ci = lz * CHUNK + lx;
          chunk.ground[ci] = raster.ground[ri];
          chunk.surface[ci] = raster.surface[ri];
          chunk.deck[ci] = raster.deck[ri];
          const o = raster.owner[ri];
          if (o >= 0) {
            if (raster.top[ri] === 0) throw new Error(`rasterToChunks: column ${raster.x0 + i * CHUNK + lx},${raster.z0 + j * CHUNK + lz} has owner ${o} but no top; write it with setColumn`);
            chunk.top[ci] = raster.top[ri];
            tops.set(o, Math.max(tops.get(o) ?? -Infinity, raster.top[ri]));
          }
          if (open && !isOpenWater(raster, ri)) open = false;
        }
      }
      const props = propsByChunk.get(`${cx},${cz}`) ?? [];
      if (open && props.length === 0) {
        water.push([cx, cz]);
        continue;
      }
      const table = [...tops.keys()].map((o) => {
        const e = raster.entries[o];
        if (!e) throw new Error(`rasterToChunks: owner ${o} has no entry`);
        return { o, entry: { id: e.id, parent: e.parent, base: e.base, top: tops.get(o), accentFrom: e.accentFrom, palette: e.palette, cap: e.cap, facade: e.facade, accent: e.accent } };
      }).sort((a, b) => a.entry.id - b.entry.id);
      const slot = new Map(table.map((t, k) => [t.o, k + 1]));
      chunk.buildings = table.map((t) => t.entry);
      for (let lz = 0; lz < CHUNK; lz++) {
        const row = (j * CHUNK + lz) * raster.w + i * CHUNK;
        for (let lx = 0; lx < CHUNK; lx++) {
          const o = raster.owner[row + lx];
          if (o >= 0) chunk.bldg[lz * CHUNK + lx] = slot.get(o);
        }
      }
      chunk.props = props.map((p) => ({ lx: p.x - cx * CHUNK, lz: p.z - cz * CHUNK, y0: p.y0, y1: p.y1, color: p.color, flags: p.flags }));
      chunks.push(validateChunk(chunk, parents));
    }
  }
  return { chunks, water };
}
