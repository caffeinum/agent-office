// Pure voxel picking: a 2D DDA over columns along the ray's ground track, then an exact test against
// each column's solid y-intervals. Large meshes are never raycast. A chunk the store does not hold is
// open water (y = 0), matching the manifest rule that unlisted chunks are water.
import { CHUNK, SURFACE } from "../../shared/city.js";

const BELOW = -Infinity;

/**
 * Solid intervals of column k, as [lo, hi, kind] triples, where kind is "ground" | "building" | "water" | "deck".
 * Terrain is solid all the way down.
 */
function columnIntervals(chunk, k, out) {
  out.length = 0;
  const g = chunk.ground[k];
  const b = chunk.bldg[k];
  let top = g;
  if (g === 0) out.push(BELOW, 0, "water");
  else out.push(BELOW, g, "ground");
  if (b) {
    const B = chunk.buildings[b - 1];
    if (!B) throw new Error(`pick: chunk ${chunk.cx},${chunk.cz} column ${k} points past its building table`);
    out.push(B.base, B.top, "building");
    top = B.top;
  }
  const deck = chunk.deck[k];
  const d = Math.abs(deck);
  if (deck !== 0 && d > top) {
    const slabLo = Math.max(d - 1, top);
    out.push(deck < 0 ? top : slabLo, d, "deck");
  }
  return out;
}

const WATER_ONLY = [BELOW, 0, "water"];

/**
 * store.get(cx, cz) → Chunk | undefined | null; origin, dir = {x, y, z} in blocks (dir need not be unit).
 * → {x, z (the hit column), y (hit height), cx, cz, kind, buildingId?, surface?, point: {x, y, z}, dist} | null
 */
export function pickRay(store, origin, dir, maxDist) {
  if (!store || typeof store.get !== "function") throw new Error("pickRay: store.get(cx, cz) required");
  for (const v of [origin, dir]) {
    if (!v || ![v.x, v.y, v.z].every(Number.isFinite)) throw new Error(`pickRay: bad vector ${JSON.stringify(v)}`);
  }
  if (!(maxDist > 0)) throw new Error(`pickRay: maxDist must be > 0, got ${maxDist}`);
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (len === 0) throw new Error("pickRay: zero direction");
  const dx = dir.x / len, dy = dir.y / len, dz = dir.z / len;

  let X = Math.floor(origin.x), Z = Math.floor(origin.z);
  const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tMaxX = dx !== 0 ? ((dx > 0 ? X + 1 : X) - origin.x) / dx : Infinity;
  let tMaxZ = dz !== 0 ? ((dz > 0 ? Z + 1 : Z) - origin.z) / dz : Infinity;
  let tIn = 0;
  let chunk, ccx = NaN, ccz = NaN;
  const iv = [];

  while (tIn <= maxDist) {
    const tOut = Math.min(tMaxX, tMaxZ, maxDist);
    const cx = Math.floor(X / CHUNK), cz = Math.floor(Z / CHUNK);
    if (cx !== ccx || cz !== ccz) { chunk = store.get(cx, cz); ccx = cx; ccz = cz; }
    const k = (Z - cz * CHUNK) * CHUNK + (X - cx * CHUNK);
    const list = chunk ? columnIntervals(chunk, k, iv) : WATER_ONLY;
    let best = Infinity, bestKind = null;
    for (let n = 0; n < list.length; n += 3) {
      const lo = list[n], hi = list[n + 1];
      let a = tIn, b = tOut;
      if (dy === 0) {
        if (origin.y < lo || origin.y > hi) continue;
      } else {
        const t0 = (lo - origin.y) / dy, t1 = (hi - origin.y) / dy;
        a = Math.max(a, Math.min(t0, t1));
        b = Math.min(b, Math.max(t0, t1));
        if (a > b) continue;
      }
      if (a < best) { best = a; bestKind = list[n + 2]; }
    }
    if (bestKind) {
      const point = { x: origin.x + dx * best, y: origin.y + dy * best, z: origin.z + dz * best };
      const hit = { x: X, y: point.y, z: Z, cx, cz, kind: bestKind, point, dist: best };
      if (chunk) {
        hit.surface = chunk.surface[k];
        if (bestKind === "building") hit.buildingId = chunk.buildings[chunk.bldg[k] - 1].id;
      } else hit.surface = SURFACE.WATER;
      return hit;
    }
    if (tOut >= maxDist) return null;
    if (tMaxX < tMaxZ) { tIn = tMaxX; tMaxX += tDeltaX; X += stepX; }
    else { tIn = tMaxZ; tMaxZ += tDeltaZ; Z += stepZ; }
  }
  return null;
}
