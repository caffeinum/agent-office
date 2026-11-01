// W3 (spec-v2 §4/§5): the global landmarks.bin mesh layer: the Bay Bridge west span, the Golden Gate Bridge south
// half to midspan, and Salesforce Tower's open crown lattice. Everything is axis-aligned SFL1 boxes in block
// space, built from voxel cells and merged into x-runs. Bridge geometry comes from landmarks.json `bridge`
// (sourced OSM pier/tower positions, sourced heights); never from chunks.
import { BLOCK_M, PALETTE_INDEX, SF_GRID, encodeLandmarks, lonLatToBlock } from "../../../public/shared/city.js";
import { compileLandmark, loadLandmarks, loadSkyline, siteBase, siteHeightM } from "./landmarks.mjs";

/** cells: Map "x,z" → Set of y → boxes merged along y (runs) then along x (equal y-runs on one row). */
export class VoxelSet {
  constructor() {
    this.cells = new Map();
  }
  add(x, z, y0, y1, color, flags = 0) {
    if (!(y1 > y0)) throw new Error(`VoxelSet.add: y1 ${y1} must be above y0 ${y0}`);
    const k = `${x},${z},${color},${flags}`;
    let s = this.cells.get(k);
    if (!s) this.cells.set(k, (s = new Set()));
    for (let y = y0; y < y1; y++) s.add(y);
  }
  boxes() {
    const rows = new Map();
    for (const [k, ys] of this.cells) {
      const [x, z, color, flags] = k.split(",").map(Number);
      const sorted = [...ys].sort((a, b) => a - b);
      for (let i = 0; i < sorted.length;) {
        let j = i;
        while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
        const rk = `${z},${sorted[i]},${sorted[j] + 1},${color},${flags}`;
        if (!rows.has(rk)) rows.set(rk, []);
        rows.get(rk).push(x);
        i = j + 1;
      }
    }
    const out = [];
    for (const [rk, xs] of rows) {
      const [z, y0, y1, color, flags] = rk.split(",").map(Number);
      xs.sort((a, b) => a - b);
      for (let i = 0; i < xs.length;) {
        let j = i;
        while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1 && xs[j + 1] - xs[i] < 255) j++;
        out.push({ x: xs[i], z, y0, y1, sx: xs[j] - xs[i] + 1, sz: 1, color, flags });
        i = j + 1;
      }
    }
    return out.sort((a, b) => a.z - b.z || a.x - b.x || a.y0 - b.y0);
  }
}

/** Cells whose centre lies within `half` of segment a→b (block space). */
function stripCells(a, b, half, visit) {
  const minX = Math.floor(Math.min(a[0], b[0]) - half - 1), maxX = Math.ceil(Math.max(a[0], b[0]) + half + 1);
  const minZ = Math.floor(Math.min(a[1], b[1]) - half - 1), maxZ = Math.ceil(Math.max(a[1], b[1]) + half + 1);
  const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz;
  for (let z = minZ; z <= maxZ; z++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, pz = z + 0.5;
      const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / L2));
      if (Math.hypot(px - a[0] - t * dx, pz - a[1] - t * dz) < half) visit(x, z, t);
    }
  }
}

const APPROACH_PILLAR_EVERY = 8;

/**
 * A suspension bridge from landmarks.json `bridge` (spec-v2 §5 rows 20, 21): 2-block-thick deck(s) along the pier
 * chain, twin tower legs with cross-beams at every `tower` point, two parabolic cables per span from anchor/tower
 * tops, and suspenders every `suspenderEvery` blocks. `end` points are cut ends (midspan): the cable reaches its
 * sag there. An `approach` point lands the deck on the shore: from the neighbouring anchor (a concrete anchorage
 * block up to the deck) the deck descends to groundAt + 1 there, never below the ground, on pillars.
 */
export function bridgeVoxels(bridge, towerTop, proj, vox, groundAt = null) {
  const color = PALETTE_INDEX[bridge.palette];
  if (color === undefined) throw new Error(`bridge: unknown palette ${bridge.palette}`);
  const pts = bridge.points.map((p) => {
    const b = lonLatToBlock(p.lon, p.lat, proj);
    return { ...p, at: [b.x, b.z] };
  });
  if (pts.length < 2) throw new Error("bridge: needs at least 2 points");
  const decks = bridge.decks.map((d) => Math.round(d.clearanceM / BLOCK_M) + (d.above ?? 0));
  const deckTop = Math.max(...decks) + 1;
  const half = bridge.deckWidth / 2;
  const cableTop = (p) => (p.kind === "tower" ? towerTop - 1 : p.kind === "anchor" ? deckTop + 1 : deckTop + bridge.cableSag);
  for (let s = 0; s + 1 < pts.length; s++) {
    const a = pts[s], b = pts[s + 1];
    if (a.kind === "approach" || b.kind === "approach") {
      approachVoxels(a.kind === "approach" ? b : a, a.kind === "approach" ? a : b, Math.max(...decks), half, color, vox, groundAt);
      continue;
    }
    for (const y of decks) stripCells(a.at, b.at, half, (x, z) => vox.add(x, z, y - 1, y + 1, color));
    const dx = b.at[0] - a.at[0], dz = b.at[1] - a.at[1], L = Math.hypot(dx, dz);
    const ux = dx / L, uz = dz / L, vx = -uz, vz = ux;
    // parabola: between two towers its low point (deck + sag) is midway; otherwise it is at the non-tower end
    const ya = cableTop(a), yb = cableTop(b);
    const cableY = (t) => {
      if (a.kind === "tower" && b.kind === "tower") {
        const low = deckTop + bridge.cableSag;
        return low + (ya - low) * ((t - 0.5) / 0.5) ** 2;
      }
      if (a.kind === "tower") return yb + (ya - yb) * (1 - t) ** 2;
      if (b.kind === "tower") return ya + (yb - ya) * t ** 2;
      return ya + (yb - ya) * t;
    };
    for (const side of [-1, 1]) {
      const ox = vx * side * (half - 0.5), oz = vz * side * (half - 0.5);
      let prev = null;
      for (let i = 0; i <= Math.ceil(L * 2); i++) {
        const t = i / Math.ceil(L * 2);
        const x = Math.floor(a.at[0] + dx * t + ox), z = Math.floor(a.at[1] + dz * t + oz), y = Math.round(cableY(t));
        const lo = prev && prev.x === x && prev.z === z ? Math.min(prev.y, y) : y;
        vox.add(x, z, lo, Math.max(lo, y) + 1, color);
        prev = { x, z, y };
        const along = t * L;
        if (Math.floor(along) % bridge.suspenderEvery === 0 && along % 1 < 0.5 && y > deckTop) vox.add(x, z, deckTop, y, color);
      }
    }
  }
  for (const p of pts) {
    if (p.kind === "anchor" && p.anchorTop) {
      const top = Math.round(p.anchorTop.heightM / BLOCK_M);
      stripCells([p.at[0] - 0.01, p.at[1]], [p.at[0] + 0.01, p.at[1]], bridge.anchorSize / 2, (x, z) => vox.add(x, z, 0, top, color));
    }
    if (p.kind !== "tower") continue;
    const nb = pts[pts.indexOf(p) + 1] ?? pts[pts.indexOf(p) - 1];
    const L = Math.hypot(nb.at[0] - p.at[0], nb.at[1] - p.at[1]);
    const ux = (nb.at[0] - p.at[0]) / L, uz = (nb.at[1] - p.at[1]) / L, vx = -uz, vz = ux;
    const { w, d } = bridge.towerLegs;
    const legCells = new Set();
    for (const side of [-1, 1]) {
      const cx = p.at[0] + vx * side * (half - w / 2), cz = p.at[1] + vz * side * (half - w / 2);
      for (let z = Math.floor(cz - 4); z <= Math.ceil(cz + 4); z++) {
        for (let x = Math.floor(cx - 4); x <= Math.ceil(cx + 4); x++) {
          const ex = x + 0.5 - cx, ez = z + 0.5 - cz;
          if (Math.abs(ex * ux + ez * uz) < d / 2 && Math.abs(ex * vx + ez * vz) < w / 2) {
            vox.add(x, z, 0, towerTop, color);
            legCells.add(`${x},${z}`);
          }
        }
      }
    }
    for (const f of bridge.crossBeams) {
      const y = Math.round(towerTop * f);
      stripCells([p.at[0] - vx * half, p.at[1] - vz * half], [p.at[0] + vx * half, p.at[1] + vz * half], 1, (x, z) => {
        if (!legCells.has(`${x},${z}`)) vox.add(x, z, y - 1, y + 1, color);
      });
    }
  }
}

/** Deck from `from` (at deck height y) down to the shore at `to`, on pillars; a concrete anchorage at an anchor. */
function approachVoxels(from, to, y, half, color, vox, groundAt) {
  if (!groundAt) throw new Error("bridge: an approach point needs ctx.groundAt");
  const g = (x, z) => groundAt(x, z);
  const land = g(Math.floor(to.at[0]), Math.floor(to.at[1])) + 1;
  if (land > y) throw new Error(`bridge approach ${to.ref}: ground ${land - 1} is above the deck ${y}`);
  const L = Math.hypot(to.at[0] - from.at[0], to.at[1] - from.at[1]);
  stripCells(from.at, to.at, half, (x, z, t) => {
    const ground = g(x, z);
    const top = Math.max(ground + 1, Math.round(y + (land - y) * t));
    vox.add(x, z, top - 1, top + 1, color);
    const along = Math.round(t * L);
    if (along % APPROACH_PILLAR_EVERY === 0 && top - 1 > ground) vox.add(x, z, ground, top - 1, PALETTE_INDEX.concrete);
  });
  if (from.kind === "anchor") {
    const size = 4;
    stripCells([from.at[0] - 0.01, from.at[1]], [from.at[0] + 0.01, from.at[1]], size, (x, z) => {
      const ground = g(x, z);
      if (y - 1 > ground) vox.add(x, z, ground, y - 1, PALETTE_INDEX.concrete);
    });
  }
}

/** Salesforce crown lattice (spec-v2 §5 row 1): fins every `every` ring cells from y0 to y1 plus a top band. */
function latticeVoxels(op, S, base, vox) {
  const [cx, cz] = [S.frame.cx, S.frame.cz];
  const ring = [...op.cells].sort((a, b) => Math.atan2(a[1] + 0.5 - cz, a[0] + 0.5 - cx) - Math.atan2(b[1] + 0.5 - cz, b[0] + 0.5 - cx));
  const flags = op.emissive ? 1 : 0;
  ring.forEach(([x, z], i) => {
    if (i % op.every === 0) vox.add(x, z, base + op.y0, base + op.y1, op.palette, flags);
    else vox.add(x, z, base + op.y1 - 1, base + op.y1, op.palette, flags);
  });
}

/** → the boxes (validated against `grid`). */
export function landmarkMeshBoxes(ctx, landmarks = loadLandmarks(), skyline = loadSkyline(), grid = SF_GRID) {
  const vox = new VoxelSet();
  for (const lm of landmarks) {
    if (lm.bridge !== undefined) {
      bridgeVoxels(lm.bridge, Math.round(siteHeightM(lm, skyline) / BLOCK_M), ctx.proj, vox, ctx.groundAt);
      continue;
    }
    if (!lm.recipe.some((o) => o.op === "mesh")) continue;
    const compiled = compileLandmark(lm, ctx, skyline);
    for (const S of compiled.sites) {
      if (S.mesh.length === 0) continue;
      const base = siteBase(S, ctx);
      for (const op of S.mesh) {
        if (op.kind !== "crown_lattice") throw new Error(`mesh kind ${op.kind} has no generator`);
        latticeVoxels(op, S, base, vox);
      }
    }
  }
  const boxes = vox.boxes();
  encodeLandmarks(boxes, grid);
  return boxes;
}

/**
 * → raw SFL1 bytes (encodeLandmarks); build-sf gzips them into public/city/sf/landmarks.bin.
 */
export function buildLandmarkMesh(ctx, landmarks = loadLandmarks(), skyline = loadSkyline()) {
  return encodeLandmarks(landmarkMeshBoxes(ctx, landmarks, skyline, SF_GRID), SF_GRID);
}
