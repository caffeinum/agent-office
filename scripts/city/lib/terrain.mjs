// AWS Terrarium elevation tiles; used for land height only, never for land vs water. z15 for the built chunks,
// z12 for the coarse relief of unbuilt land over the whole reserved grid (spec-v2 §2).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";

export const TERRARIUM_ZOOM = 15;
const TILE = 256;

const zoomOk = (z) => {
  if (!Number.isInteger(z) || z < 0 || z > 15) throw new Error(`terrarium: zoom must be an integer 0..15, got ${z}`);
  return z;
};

/** → https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png */
export function terrariumUrl(x, y, z = TERRARIUM_ZOOM) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error(`terrariumUrl: integer tile x, y required, got ${x}, ${y}`);
  return `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoomOk(z)}/${x}/${y}.png`;
}

/** Cache path of a tile, relative to the raw dir. */
export const terrariumFile = (x, y, z = TERRARIUM_ZOOM) => `terrarium/${zoomOk(z)}/${x}/${y}.png`;

/** R*256 + G + B/256 - 32768. → metres */
export function decodeTerrarium(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

/** Fractional global pixel coordinates (pixel centres at .5) of lon/lat at `zoom`. */
function lonLatToPixel(lon, lat, zoom) {
  const world = 2 ** zoom * TILE;
  const s = Math.sin((lat * Math.PI) / 180);
  return {
    px: ((lon + 180) / 360) * world,
    py: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world,
  };
}

/** bbox = {south, west, north, east}. → Array<{x, y, z}> (tiles at `zoom`, row-major) */
export function tilesForBbox(bbox, zoom = TERRARIUM_ZOOM) {
  zoomOk(zoom);
  const a = lonLatToPixel(bbox.west, bbox.north, zoom);
  const b = lonLatToPixel(bbox.east, bbox.south, zoom);
  // one pixel of margin so bilinear sampling at the bbox edge has its neighbours
  const x0 = Math.floor((a.px - 1) / TILE), x1 = Math.floor((b.px + 1) / TILE);
  const y0 = Math.floor((a.py - 1) / TILE), y1 = Math.floor((b.py + 1) / TILE);
  const tiles = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push({ x, y, z: zoom });
  return tiles;
}

/** Tiles of several boxes at one zoom, deduplicated, sorted row-major. */
export function tilesForBboxes(boxes, zoom = TERRARIUM_ZOOM) {
  const seen = new Map();
  for (const b of boxes) for (const t of tilesForBbox(b, zoom)) seen.set(`${t.y}/${t.x}`, t);
  return [...seen.values()].sort((p, q) => p.y - q.y || p.x - q.x);
}

/**
 * Load cached tiles of one zoom. → {zoom, sample(lon, lat) → metres (bilinear between pixel centres; throws
 * where a needed tile is not loaded), covers(lon, lat) → whether every pixel sample() needs is loaded}
 */
export function createElevation(rawDir, tiles, zoom = TERRARIUM_ZOOM) {
  zoomOk(zoom);
  const loaded = new Map();
  for (const t of tiles) {
    if (t.z !== undefined && t.z !== zoom) throw new Error(`createElevation: tile ${t.z}/${t.x}/${t.y} is not zoom ${zoom}`);
    const p = join(rawDir, terrariumFile(t.x, t.y, zoom));
    if (!existsSync(p)) throw new Error(`terrain tile missing: ${p} (run npm run city:fetch)`);
    const png = PNG.sync.read(readFileSync(p));
    if (png.width !== TILE || png.height !== TILE) throw new Error(`${p}: ${png.width}×${png.height}, expected ${TILE}×${TILE}`);
    const elev = new Float32Array(TILE * TILE);
    for (let i = 0; i < TILE * TILE; i++) elev[i] = decodeTerrarium(png.data[4 * i], png.data[4 * i + 1], png.data[4 * i + 2]);
    loaded.set(`${t.x}/${t.y}`, elev);
  }
  const tileOf = (gx, gy) => loaded.get(`${Math.floor(gx / TILE)}/${Math.floor(gy / TILE)}`);
  const pixel = (gx, gy) => {
    const t = tileOf(gx, gy);
    if (!t) throw new Error(`terrain: no tile ${zoom}/${Math.floor(gx / TILE)}/${Math.floor(gy / TILE)} loaded for pixel ${gx},${gy}`);
    return t[(gy - Math.floor(gy / TILE) * TILE) * TILE + (gx - Math.floor(gx / TILE) * TILE)];
  };
  const corners = (lon, lat) => {
    const { px, py } = lonLatToPixel(lon, lat, zoom);
    const fx = px - 0.5, fy = py - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    return { x0, y0, tx: fx - x0, ty: fy - y0 };
  };
  return {
    zoom,
    sample(lon, lat) {
      const { x0, y0, tx, ty } = corners(lon, lat);
      const top = pixel(x0, y0) * (1 - tx) + pixel(x0 + 1, y0) * tx;
      const bot = pixel(x0, y0 + 1) * (1 - tx) + pixel(x0 + 1, y0 + 1) * tx;
      return top * (1 - ty) + bot * ty;
    },
    covers(lon, lat) {
      const { x0, y0 } = corners(lon, lat);
      return !!(tileOf(x0, y0) && tileOf(x0 + 1, y0) && tileOf(x0, y0 + 1) && tileOf(x0 + 1, y0 + 1));
    },
  };
}
