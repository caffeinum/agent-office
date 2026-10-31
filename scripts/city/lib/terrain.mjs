// AWS Terrarium z15 elevation; used for land height only, never for land vs water.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";

export const TERRARIUM_ZOOM = 15;
const TILE = 256;
const WORLD = 2 ** TERRARIUM_ZOOM;

/** → https://s3.amazonaws.com/elevation-tiles-prod/terrarium/15/{x}/{y}.png */
export function terrariumUrl(x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error(`terrariumUrl: integer tile x, y required, got ${x}, ${y}`);
  return `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${TERRARIUM_ZOOM}/${x}/${y}.png`;
}

/** Cache path of a tile, relative to the raw dir. */
export const terrariumFile = (x, y) => `terrarium/${TERRARIUM_ZOOM}/${x}/${y}.png`;

/** R*256 + G + B/256 - 32768. → metres */
export function decodeTerrarium(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

/** Fractional global pixel coordinates (pixel centres at .5) of lon/lat at zoom 15. */
function lonLatToPixel(lon, lat) {
  const s = Math.sin((lat * Math.PI) / 180);
  return {
    px: ((lon + 180) / 360) * WORLD * TILE,
    py: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WORLD * TILE,
  };
}

/** bbox = {south, west, north, east}. → Array<{x, y}> (z15 tiles, row-major) */
export function tilesForBbox(bbox) {
  const a = lonLatToPixel(bbox.west, bbox.north);
  const b = lonLatToPixel(bbox.east, bbox.south);
  // one pixel of margin so bilinear sampling at the bbox edge has its neighbours
  const x0 = Math.floor((a.px - 1) / TILE), x1 = Math.floor((b.px + 1) / TILE);
  const y0 = Math.floor((a.py - 1) / TILE), y1 = Math.floor((b.py + 1) / TILE);
  const tiles = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push({ x, y });
  return tiles;
}

/** Load cached tiles. → {sample(lon, lat) → metres} (bilinear between pixel centres) */
export function createElevation(rawDir, tiles) {
  const loaded = new Map();
  for (const { x, y } of tiles) {
    const p = join(rawDir, terrariumFile(x, y));
    if (!existsSync(p)) throw new Error(`terrain tile missing: ${p} (run npm run city:fetch)`);
    const png = PNG.sync.read(readFileSync(p));
    if (png.width !== TILE || png.height !== TILE) throw new Error(`${p}: ${png.width}×${png.height}, expected ${TILE}×${TILE}`);
    const elev = new Float32Array(TILE * TILE);
    for (let i = 0; i < TILE * TILE; i++) elev[i] = decodeTerrarium(png.data[4 * i], png.data[4 * i + 1], png.data[4 * i + 2]);
    loaded.set(`${x}/${y}`, elev);
  }
  const pixel = (gx, gy) => {
    const tx = Math.floor(gx / TILE), ty = Math.floor(gy / TILE);
    const t = loaded.get(`${tx}/${ty}`);
    if (!t) throw new Error(`terrain: no tile ${TERRARIUM_ZOOM}/${tx}/${ty} loaded for pixel ${gx},${gy}`);
    return t[(gy - ty * TILE) * TILE + (gx - tx * TILE)];
  };
  return {
    sample(lon, lat) {
      const { px, py } = lonLatToPixel(lon, lat);
      const fx = px - 0.5, fy = py - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const top = pixel(x0, y0) * (1 - tx) + pixel(x0 + 1, y0) * tx;
      const bot = pixel(x0, y0 + 1) * (1 - tx) + pixel(x0 + 1, y0 + 1) * tx;
      return top * (1 - ty) + bot * ty;
    },
  };
}
