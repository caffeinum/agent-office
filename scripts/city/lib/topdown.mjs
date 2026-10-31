// Headless 1 px-per-column preview over the manifest's min/max range: surface colours (every SURFACE id, v2 ones
// included), buildings shaded by their per-column top, decks in orange, props as bright dots; unlisted chunks come
// from landmask.bin (unbuilt land in the paper tone, shaded by coarse height) or are sea.
import { PNG } from "pngjs";
import { CHUNK, SURFACE, SURFACE_COLORS, UNBUILT_COLORS, chunkKey, landmaskHeight } from "../../../public/shared/city.js";

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const DECK = rgb("#e07b39");
const PROP = rgb("#fff4d6");
const TALL_M = 330;

/** Topdown colour of every SURFACE id (the chunk palette; asserted complete by format.check). */
export const TOPDOWN_SURFACE = Object.freeze(Object.fromEntries(Object.values(SURFACE).map((s) => [s, rgb(SURFACE_COLORS[s])])));

/** manifest + decoded chunks (Map "cx_cz" → chunk) + decoded landmask → PNG bytes. */
export function renderTopdown(manifest, chunks, landmask) {
  if (!landmask) throw new Error("renderTopdown: landmask is required (decodeLandmask of landmask.bin)");
  const [minX, minZ] = manifest.chunks.min;
  const [maxX, maxZ] = manifest.chunks.max;
  const width = (maxX - minX + 1) * CHUNK;
  const height = (maxZ - minZ + 1) * CHUNK;
  const png = new PNG({ width, height });
  const sea = TOPDOWN_SURFACE[SURFACE.WATER];
  const paper = rgb(UNBUILT_COLORS.top);
  for (let cz = minZ; cz <= maxZ; cz++) {
    for (let cx = minX; cx <= maxX; cx++) {
      const c = chunks.get(chunkKey(cx, cz));
      const props = new Set((c?.props ?? []).map((p) => p.lz * CHUNK + p.lx));
      for (let lz = 0; lz < CHUNK; lz++) {
        for (let lx = 0; lx < CHUNK; lx++) {
          const i = lz * CHUNK + lx;
          let px;
          if (!c) {
            const h = landmaskHeight(landmask, cx * CHUNK + lx, cz * CHUNK + lz);
            px = h === null ? sea : paper.map((v) => Math.round(v * (0.85 + 0.15 * Math.min(1, h / 30))));
          } else if (props.has(i)) px = PROP;
          else if (c.deck[i] !== 0) px = DECK;
          else if (c.bldg[i] !== 0) {
            const t = Math.min(1, ((c.top[i] - c.ground[i]) * 3) / TALL_M);
            const v = Math.round(70 + 185 * t);
            px = [v, v, v];
          } else {
            const shade = c.ground[i] === 0 ? 1 : 0.75 + 0.25 * Math.min(1, c.ground[i] / 30);
            px = TOPDOWN_SURFACE[c.surface[i]].map((v) => Math.round(v * shade));
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
