// Land/water mask at block-centre resolution. Primary: a DataSF land polygon set (config MASK). Fallback:
// OSM natural=coastline ways assembled and closed along the bbox edge (sea on the right of the way).
import { CHUNK, landmaskHeight } from "../../../public/shared/city.js";
import { pointInPolygon, scanPolygon } from "./geo.mjs";

/** landPolygons in global block coords. → Uint8Array over the raster, 1 = water */
export function buildWaterMask(raster, landPolygons) {
  if (!Array.isArray(landPolygons) || landPolygons.length === 0) throw new Error("buildWaterMask: no land polygons");
  const { x0, z0, w, h } = raster;
  const water = new Uint8Array(w * h).fill(1);
  for (const poly of landPolygons) {
    scanPolygon(poly, (x, z) => {
      const lx = x - x0, lz = z - z0;
      if (lx >= 0 && lz >= 0 && lx < w && lz < h) water[lz * w + lx] = 0;
    });
  }
  return water;
}

/**
 * landmask.bin cells (spec-v2 §2) over the whole reserved grid: 0 = sea, else coarse ground (blocks) + 1, clamped
 * to 255. A cell is land when its centre lies in the land polygons (global block coords); heightAt(x, z) gives the
 * ground in blocks at a block-space point (the cell centre). extraLand(x, z) (optional) marks more land cells by
 * their centre (land outside the polygon set, e.g. the Marin Headlands from the terrain model). → {cellsX, cellsZ, cells}
 */
export function buildLandmask({ grid, chunk, cell, landPolygons, heightAt, extraLand = null }) {
  if (!Array.isArray(landPolygons) || landPolygons.length === 0) throw new Error("buildLandmask: no land polygons");
  const cellsX = (grid[0] * chunk) / cell, cellsZ = (grid[1] * chunk) / cell;
  if (!Number.isInteger(cellsX) || !Number.isInteger(cellsZ)) throw new Error(`buildLandmask: grid ${grid} × ${chunk} is not a multiple of cell ${cell}`);
  const land = new Uint8Array(cellsX * cellsZ);
  for (const poly of landPolygons) {
    const scaled = poly.map((ring) => ring.map(([x, z]) => [x / cell, z / cell]));
    scanPolygon(scaled, (cx, cz) => {
      if (cx >= 0 && cz >= 0 && cx < cellsX && cz < cellsZ) land[cz * cellsX + cx] = 1;
    });
  }
  if (extraLand) {
    for (let cz = 0; cz < cellsZ; cz++) {
      for (let cx = 0; cx < cellsX; cx++) if (!land[cz * cellsX + cx] && extraLand((cx + 0.5) * cell, (cz + 0.5) * cell)) land[cz * cellsX + cx] = 1;
    }
  }
  const cells = new Uint8Array(cellsX * cellsZ);
  for (let cz = 0; cz < cellsZ; cz++) {
    for (let cx = 0; cx < cellsX; cx++) {
      const i = cz * cellsX + cx;
      if (!land[i]) continue;
      const h = heightAt((cx + 0.5) * cell, (cz + 0.5) * cell);
      if (!Number.isInteger(h) || h < 1) throw new Error(`buildLandmask: height at cell ${cx},${cz} must be an integer ≥ 1, got ${h}`);
      cells[i] = Math.min(255, h + 1);
    }
  }
  return { cellsX, cellsZ, cells };
}

/**
 * Skirts (spec-v2 §2): |ground − coarse height| for every edge column of a listed chunk whose neighbour chunk is
 * unbuilt (neither listed nor water) and whose neighbouring landmask cell is land. listed/water = Sets of "cx,cz".
 * → number[] (blocks)
 */
export function skirtHeights(chunks, listed, water, mask) {
  const out = [];
  const isUnbuilt = (cx, cz) => !listed.has(`${cx},${cz}`) && !water.has(`${cx},${cz}`);
  for (const c of chunks) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (!isUnbuilt(c.cx + dx, c.cz + dz)) continue;
      for (let k = 0; k < CHUNK; k++) {
        const lx = dx === 1 ? CHUNK - 1 : dx === -1 ? 0 : k;
        const lz = dz === 1 ? CHUNK - 1 : dz === -1 ? 0 : k;
        const g = c.ground[lz * CHUNK + lx];
        if (g === 0) continue;
        const h = landmaskHeight(mask, c.cx * CHUNK + lx + dx, c.cz * CHUNK + lz + dz);
        if (h === null) continue;
        out.push(Math.abs(g - h));
      }
    }
  }
  return out;
}

/** Nearest-rank percentile (p in 0..1) of a number list; 0 for an empty list. */
export function percentile(xs, p) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

const ptKey = ([x, z]) => `${x},${z}`;

/** Liang–Barsky: the part of segment a→b inside the box, as [t0, t1], or null. */
function clipSegment([ax, az], [bx, bz], box) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  const edges = [[-dx, ax - box.minX], [dx, box.maxX - ax], [-dz, az - box.minZ], [dz, box.maxZ - az]];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
  }
  return t0 <= t1 ? [t0, t1] : null;
}

/** Split a polyline into the pieces inside the box. */
function clipPolyline(points, box) {
  const pieces = [];
  let cur = null;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    const c = clipSegment(a, b, box);
    if (!c) {
      cur = null;
      continue;
    }
    const at = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const p0 = at(c[0]), p1 = at(c[1]);
    if (!cur || c[0] > 0) {
      cur = [p0];
      pieces.push(cur);
    }
    cur.push(p1);
    if (c[1] < 1) cur = null;
  }
  return pieces.filter((p) => p.length >= 2);
}

/**
 * Perimeter parameter of a boundary point, increasing in the direction that keeps land on the left of a
 * coastline (counter-clockwise on a north-up map, i.e. with +z pointing south: along the south edge eastward,
 * up the east edge, west along the north edge, down the west edge).
 */
function perimeterT([x, z], box) {
  const W = box.maxX - box.minX, H = box.maxZ - box.minZ;
  const eps = 1e-9;
  if (Math.abs(z - box.maxZ) < eps) return x - box.minX;
  if (Math.abs(x - box.maxX) < eps) return W + (box.maxZ - z);
  if (Math.abs(z - box.minZ) < eps) return W + H + (box.maxX - x);
  if (Math.abs(x - box.minX) < eps) return 2 * W + H + (z - box.minZ);
  throw new Error(`closeCoastline: point ${x},${z} is not on the bbox edge`);
}
function cornersBetween(t0, t1, box) {
  const W = box.maxX - box.minX, H = box.maxZ - box.minZ, P = 2 * (W + H);
  const corners = [[W, [box.maxX, box.maxZ]], [W + H, [box.maxX, box.minZ]], [2 * W + H, [box.minX, box.minZ]], [P, [box.minX, box.maxZ]]];
  const out = [];
  const end = t1 >= t0 ? t1 : t1 + P;
  for (let lap = 0; lap < 2; lap++) {
    for (const [ct, p] of corners) {
      const t = ct + lap * P;
      if (t > t0 && t < end) out.push(p);
    }
  }
  return out;
}

/**
 * ways = [{id, geometry: Ring}] of natural=coastline in block coords; bbox = {minX, minZ, maxX, maxZ}.
 * Chains are stitched end to end, clipped to the bbox, and closed along the bbox edge so the sea stays on
 * the right of the way direction (OSM convention). → Polygon[] (land)
 */
export function closeCoastline(ways, bbox) {
  const byStart = new Map();
  for (const w of ways) byStart.set(ptKey(w.geometry[0]), w);
  const used = new Set();
  const chains = [];
  const islands = [];
  for (const w of ways) {
    if (used.has(w)) continue;
    let head = w;
    const seen = new Set([w]);
    for (;;) {
      const prev = ways.find((o) => !seen.has(o) && !used.has(o) && ptKey(o.geometry[o.geometry.length - 1]) === ptKey(head.geometry[0]));
      if (!prev) break;
      seen.add(prev);
      head = prev;
    }
    const chain = head.geometry.slice();
    used.add(head);
    for (;;) {
      const next = byStart.get(ptKey(chain[chain.length - 1]));
      if (!next || used.has(next)) break;
      used.add(next);
      for (let i = 1; i < next.geometry.length; i++) chain.push(next.geometry[i]);
    }
    if (ptKey(chain[0]) === ptKey(chain[chain.length - 1])) islands.push(chain);
    else chains.push(chain);
  }
  const pieces = chains.flatMap((c) => clipPolyline(c, bbox));
  for (const p of pieces) {
    perimeterT(p[0], bbox);
    perimeterT(p[p.length - 1], bbox);
  }
  const polys = [];
  const left = new Set(pieces);
  while (left.size) {
    const first = left.values().next().value;
    left.delete(first);
    const ring = first.slice();
    for (let guard = 0; guard <= pieces.length; guard++) {
      const tEnd = perimeterT(ring[ring.length - 1], bbox);
      const P = 2 * (bbox.maxX - bbox.minX + bbox.maxZ - bbox.minZ);
      const dist = (t) => (t - tEnd + P) % P;
      const tStart = perimeterT(first[0], bbox);
      let best = null, bestD = dist(tStart) || P;
      for (const p of left) {
        const d = dist(perimeterT(p[0], bbox));
        if (d < bestD) {
          best = p;
          bestD = d;
        }
      }
      const target = best ?? first;
      ring.push(...cornersBetween(tEnd, perimeterT(target[0], bbox), bbox));
      if (!best) break;
      left.delete(best);
      ring.push(...best);
    }
    ring.push(ring[0]);
    polys.push([ring]);
  }
  for (const island of islands) {
    const inside = island.some(([x, z]) => x > bbox.minX && x < bbox.maxX && z > bbox.minZ && z < bbox.maxZ);
    if (inside) polys.push([island]);
  }
  if (pieces.length === 0 && islands.length === 0) throw new Error("closeCoastline: no coastline inside the bbox");
  return polys;
}

/** True iff (x, z) is land under any of the polygons. */
export const isLand = (x, z, polys) => polys.some((p) => pointInPolygon(x, z, p));
