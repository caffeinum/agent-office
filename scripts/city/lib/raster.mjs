// The working raster over the whole chunk range, and its split into shared/city.js chunks.
import { CHUNK, COLUMNS, SURFACE, validateChunk } from "../../../public/shared/city.js";

/** → {x0, z0, w, h, ground: Int16Array, surface: Uint8Array, owner: Int32Array (building index or -1), deck: Int16Array} */
export function createRaster(minChunk, maxChunk) {
  const [cx0, cz0] = minChunk;
  const [cx1, cz1] = maxChunk;
  if (cx1 < cx0 || cz1 < cz0) throw new Error(`createRaster: max ${maxChunk} is before min ${minChunk}`);
  const w = (cx1 - cx0 + 1) * CHUNK;
  const h = (cz1 - cz0 + 1) * CHUNK;
  return {
    x0: cx0 * CHUNK,
    z0: cz0 * CHUNK,
    w,
    h,
    ground: new Int16Array(w * h),
    surface: new Uint8Array(w * h).fill(SURFACE.WATER),
    owner: new Int32Array(w * h).fill(-1),
    deck: new Int16Array(w * h),
  };
}

/** Raster index of global block (x, z), or -1 when outside. */
export function rasterIndex(raster, x, z) {
  const lx = x - raster.x0, lz = z - raster.z0;
  return lx >= 0 && lz >= 0 && lx < raster.w && lz < raster.h ? lz * raster.w + lx : -1;
}

const isOpenWater = (raster, i) => raster.surface[i] === SURFACE.WATER && raster.deck[i] === 0 && raster.owner[i] === -1;

/**
 * Split into shared/city.js Chunk objects (validated). buildings[owner] = {id, base, top, palette, roof}.
 * Chunks that are entirely open WATER (no shallow, deck or building) are dropped and counted.
 * → {chunks: Chunk[] (row-major by cz, cx), allWater: number}
 */
export function rasterToChunks(raster, buildings) {
  const nx = raster.w / CHUNK, nz = raster.h / CHUNK;
  const cx0 = raster.x0 / CHUNK, cz0 = raster.z0 / CHUNK;
  const chunks = [];
  let allWater = 0;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const chunk = {
        cx: cx0 + i,
        cz: cz0 + j,
        ground: new Int16Array(COLUMNS),
        surface: new Uint8Array(COLUMNS),
        bldg: new Uint16Array(COLUMNS),
        deck: new Int16Array(COLUMNS),
        buildings: [],
      };
      const owners = new Set();
      let water = true;
      for (let lz = 0; lz < CHUNK; lz++) {
        const row = (j * CHUNK + lz) * raster.w + i * CHUNK;
        for (let lx = 0; lx < CHUNK; lx++) {
          const ri = row + lx, ci = lz * CHUNK + lx;
          chunk.ground[ci] = raster.ground[ri];
          chunk.surface[ci] = raster.surface[ri];
          chunk.deck[ci] = raster.deck[ri];
          if (raster.owner[ri] >= 0) owners.add(raster.owner[ri]);
          if (water && !isOpenWater(raster, ri)) water = false;
        }
      }
      if (water) {
        allWater++;
        continue;
      }
      const table = [...owners].map((o) => {
        const b = buildings[o];
        if (!b) throw new Error(`rasterToChunks: owner ${o} has no building`);
        return { o, entry: { id: b.id, base: b.base, top: b.top, palette: b.palette, roof: b.roof } };
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
      chunks.push(validateChunk(chunk));
    }
  }
  return { chunks, allWater };
}
