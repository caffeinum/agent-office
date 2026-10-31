// Pure voxel picking: a 2D DDA over columns along the ray's ground track, then an exact test against
// each column's solid y-intervals (format v2: the per-column top, plus the column's props). Large meshes are
// never raycast. A chunk the store does not hold is open water (y = 0), or unbuilt land when the caller
// passes `unbuiltAt` (landmask coarse height). A building resolves to `pickId(entry)` (parent || id), so a
// multi-part landmark picks as one building; a prop on a building column picks as that building.
import { CHUNK, SURFACE, pickId } from "../../shared/city.js";

const BELOW = -Infinity;

/** Per chunk: column index → its props. */
const propIndex = new WeakMap();
function propsAt(chunk, k) {
  if (!chunk.props || chunk.props.length === 0) return null;
  let idx = propIndex.get(chunk);
  if (!idx) {
    idx = new Map();
    for (const p of chunk.props) {
      const key = p.lz * CHUNK + p.lx;
      if (!idx.has(key)) idx.set(key, []);
      idx.get(key).push(p);
    }
    propIndex.set(chunk, idx);
  }
  return idx.get(k) ?? null;
}

/**
 * Solid intervals of column k, as [lo, hi, kind] triples, where kind is "ground" | "building" | "water" | "deck" | "prop".
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
    top = chunk.top[k];
    out.push(B.base, top, "building");
  }
  const deck = chunk.deck[k];
  const d = Math.abs(deck);
  if (deck !== 0 && d > top) {
    const slabLo = Math.max(d - 1, top);
    out.push(deck < 0 ? top : slabLo, d, "deck");
  }
  const props = propsAt(chunk, k);
  if (props) for (const p of props) out.push(p.y0, p.y1, "prop");
  return out;
}

const WATER_ONLY = [BELOW, 0, "water"];

/**
 * store.get(cx, cz) → Chunk | undefined | null; origin, dir = {x, y, z} in blocks (dir need not be unit).
 * opts.unbuiltAt(x, z) → coarse height | null, for columns of chunks the store does not hold.
 * → {x, z (the hit column), y (hit height), cx, cz, kind, buildingId?, entryId?, surface?, point: {x, y, z}, dist} | null
 * kind: "building" (buildingId = parent || id, entryId = the entry), "ground", "water", "deck", "prop" (a prop on a
 * column without a building), "unbuilt" (landmask land outside the listed chunks).
 */
export function pickRay(store, origin, dir, maxDist, opts = {}) {
  if (!store || typeof store.get !== "function") throw new Error("pickRay: store.get(cx, cz) required");
  for (const v of [origin, dir]) {
    if (!v || ![v.x, v.y, v.z].every(Number.isFinite)) throw new Error(`pickRay: bad vector ${JSON.stringify(v)}`);
  }
  if (!(maxDist > 0)) throw new Error(`pickRay: maxDist must be > 0, got ${maxDist}`);
  const { unbuiltAt = null } = opts;
  if (unbuiltAt !== null && typeof unbuiltAt !== "function") throw new Error("pickRay: opts.unbuiltAt must be a function (x, z) → height | null");
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
  const unbuilt = [BELOW, 0, "unbuilt"];

  while (tIn <= maxDist) {
    const tOut = Math.min(tMaxX, tMaxZ, maxDist);
    const cx = Math.floor(X / CHUNK), cz = Math.floor(Z / CHUNK);
    if (cx !== ccx || cz !== ccz) { chunk = store.get(cx, cz); ccx = cx; ccz = cz; }
    const k = (Z - cz * CHUNK) * CHUNK + (X - cx * CHUNK);
    let list = WATER_ONLY;
    if (chunk) list = columnIntervals(chunk, k, iv);
    else if (unbuiltAt) {
      const h = unbuiltAt(X, Z);
      if (h !== null) { unbuilt[1] = h; list = unbuilt; }
    }
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
        const b = chunk.bldg[k];
        if (b && (bestKind === "building" || bestKind === "prop")) {
          const B = chunk.buildings[b - 1];
          hit.kind = "building";
          hit.buildingId = pickId(B);
          hit.entryId = B.id;
        }
      } else if (bestKind === "water") hit.surface = SURFACE.WATER;
      return hit;
    }
    if (tOut >= maxDist) return null;
    if (tMaxX < tMaxZ) { tIn = tMaxX; tMaxX += tDeltaX; X += stepX; }
    else { tIn = tMaxZ; tMaxZ += tDeltaZ; Z += stepZ; }
  }
  return null;
}
