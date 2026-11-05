// Box and wedge corners for voxel.js, kept pure (no three.js) so node checks can test them.
//
// A wedge is a box whose top slopes down towards one side ("+x", "-x", "+z", "-z"): the top corners on that side sit
// at y0 + lowFrac·h instead of y0 + h. Its faces stay quads (a zero-height one is skipped), each with one flat normal.

/** Low-side test per slope, on a unit-cube corner [x, y, z] ∈ {0, 1}³. */
const LOW_SIDE = { "+x": (c) => c[0] === 1, "-x": (c) => c[0] === 0, "+z": (c) => c[2] === 1, "-z": (c) => c[2] === 0 };

/** The unit corner → world point of a box {at: [cx, y0, cz], size: [w, h, d], slope?, lowFrac?}. */
export function cornerPoint(b, corner) {
  const [cx, y0, cz] = b.at, [w, h, d] = b.size;
  let top = corner[1] * h;
  if (b.slope) {
    const low = LOW_SIDE[b.slope];
    if (!low) throw new Error(`unknown slope ${JSON.stringify(b.slope)}`);
    if (corner[1] === 1 && low(corner)) top = h * (b.lowFrac ?? 0);
  }
  return [cx - w / 2 + corner[0] * w, y0 + top, cz - d / 2 + corner[2] * d];
}

/** Newell normal of a quad given in fan order a, b, d, c (as voxel.js emits: triangles abc and cbd). Zero for a sliver. */
export function quadNormal(a, b, c, d) {
  const poly = [a, b, d, c];
  const n = [0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const p = poly[i], q = poly[(i + 1) % 4];
    n[0] += (p[1] - q[1]) * (p[2] + q[2]);
    n[1] += (p[2] - q[2]) * (p[0] + q[0]);
    n[2] += (p[0] - q[0]) * (p[1] + q[1]);
  }
  const len = Math.hypot(n[0], n[1], n[2]);
  return len < 1e-9 ? [0, 0, 0] : [n[0] / len, n[1] / len, n[2] / len];
}

/**
 * A validated mesh (kinds.js: local units, 16 per cell, origin at the footprint's min corner) → non-indexed triangles in
 * the item frame (cells, origin at the footprint centre, y up): {positions, normals}, three floats per vertex, one flat
 * normal per triangle. Slivers (zero area after rounding) are dropped.
 */
export function meshTriangles(mesh, fw, fd, units = 16) {
  const at = (i) => { const v = mesh.vertices[i]; return [v[0] / units - fw / 2, v[1] / units, v[2] / units - fd / 2]; };
  const positions = [], normals = [];
  for (const [a, b, c] of mesh.faces) {
    const p = at(a), q = at(b), r = at(c);
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-9) continue;
    for (const pt of [p, q, r]) { positions.push(...pt); normals.push(n[0] / len, n[1] / len, n[2] / len); }
  }
  return { positions, normals };
}
