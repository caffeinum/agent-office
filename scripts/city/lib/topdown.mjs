// Headless 1 px-per-column preview: surface colours, buildings shaded by height, decks in orange,
// chunks missing from the manifest list drawn as open water.
import { PNG } from "pngjs";
import { CHUNK, SURFACE, SURFACE_COLORS, chunkKey } from "../../../public/shared/city.js";

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const DECK = rgb("#e07b39");
const TALL_M = 330;

/** manifest + decoded chunks (Map "cx_cz" → chunk) → PNG bytes. */
export function renderTopdown(manifest, chunks) {
  const [minX, minZ] = manifest.chunks.min;
  const [maxX, maxZ] = manifest.chunks.max;
  const width = (maxX - minX + 1) * CHUNK;
  const height = (maxZ - minZ + 1) * CHUNK;
  const png = new PNG({ width, height });
  const water = rgb(SURFACE_COLORS[SURFACE.WATER]);
  for (let cz = minZ; cz <= maxZ; cz++) {
    for (let cx = minX; cx <= maxX; cx++) {
      const c = chunks.get(chunkKey(cx, cz));
      for (let lz = 0; lz < CHUNK; lz++) {
        for (let lx = 0; lx < CHUNK; lx++) {
          const i = lz * CHUNK + lx;
          let px;
          if (!c) px = water;
          else if (c.deck[i] !== 0) px = DECK;
          else if (c.bldg[i] !== 0) {
            const b = c.buildings[c.bldg[i] - 1];
            const t = Math.min(1, ((b.top - b.base) * 3) / TALL_M);
            const v = Math.round(70 + 185 * t);
            px = [v, v, v];
          } else {
            const shade = c.ground[i] === 0 ? 1 : 0.75 + 0.25 * Math.min(1, c.ground[i] / 30);
            px = rgb(SURFACE_COLORS[c.surface[i]]).map((v) => Math.round(v * shade));
          }
          const o = (((cz - minZ) * CHUNK + lz) * width + (cx - minX) * CHUNK + lx) * 4;
          png.data[o] = px[0];
          png.data[o + 1] = px[1];
          png.data[o + 2] = px[2];
          png.data[o + 3] = 255;
        }
      }
    }
  }
  return PNG.sync.write(png, { colorType: 2 });
}
