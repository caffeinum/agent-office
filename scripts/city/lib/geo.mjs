// Hand-written geometry in block coordinates (no GDAL). Ring = Array<[x, z]>, closed or not (a repeated
// last point is harmless); Polygon = Ring[] with the outer ring first and holes after it.

/** Even-odd test against outer + holes. → boolean */
export function pointInPolygon(x, z, polygon) {
  let inside = false;
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i];
      const [xj, zj] = ring[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Bounding box of a polygon's rings. → {minX, minZ, maxX, maxZ} */
export function polygonBounds(polygon) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const ring of polygon) {
    for (const [x, z] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  return { minX, minZ, maxX, maxZ };
}

/** Scanline: call visit(x, z) for every integer column whose centre (x+0.5, z+0.5) is inside (even-odd). */
export function scanPolygon(polygon, visit) {
  const { minZ, maxZ } = polygonBounds(polygon);
  if (!Number.isFinite(minZ)) return;
  const xs = [];
  for (let z = Math.floor(minZ - 0.5); z <= Math.ceil(maxZ); z++) {
    const zc = z + 0.5;
    xs.length = 0;
    for (const ring of polygon) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, zi] = ring[i];
        const [xj, zj] = ring[j];
        if (zi > zc !== zj > zc) xs.push(xi + ((zc - zi) * (xj - xi)) / (zj - zi));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.ceil(xs[k] - 0.5);
      const x1 = Math.ceil(xs[k + 1] - 0.5) - 1;
      for (let x = x0; x <= x1; x++) visit(x, z);
    }
  }
}

/** Call visit(x, z) once for every column whose centre is within width/2 of the polyline `points`. */
export function stampLine(points, width, visit) {
  if (!(width > 0)) throw new Error(`stampLine: width must be > 0, got ${width}`);
  const r = width / 2;
  const r2 = r * r;
  const seen = new Set();
  const segs = points.length === 1 ? [[points[0], points[0]]] : points.slice(1).map((p, i) => [points[i], p]);
  for (const [[ax, az], [bx, bz]] of segs) {
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    for (let z = Math.floor(Math.min(az, bz) - r - 0.5); z <= Math.ceil(Math.max(az, bz) + r); z++) {
      for (let x = Math.floor(Math.min(ax, bx) - r - 0.5); x <= Math.ceil(Math.max(ax, bx) + r); x++) {
        const cx = x + 0.5, cz = z + 0.5;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((cx - ax) * dx + (cz - az) * dz) / len2));
        const ex = ax + t * dx - cx, ez = az + t * dz - cz;
        if (ex * ex + ez * ez > r2) continue;
        const key = x * 1048576 + z;
        if (seen.has(key)) continue;
        seen.add(key);
        visit(x, z);
      }
    }
  }
}

const ptKey = ([x, z]) => `${x},${z}`;
const isClosed = (ring) => ring.length >= 4 && ptKey(ring[0]) === ptKey(ring[ring.length - 1]);

/** Stitch open ways (each {id, geometry}) into closed rings by matching endpoints. → {rings, unclosable: ids[][]} */
function stitch(parts) {
  const rings = [];
  const unclosable = [];
  const open = [];
  for (const p of parts) {
    if (p.geometry.length < 2) {
      unclosable.push([p.id]);
      continue;
    }
    if (isClosed(p.geometry)) rings.push(p.geometry.slice());
    else open.push(p);
  }
  const byEnd = new Map();
  const add = (key, p) => {
    if (!byEnd.has(key)) byEnd.set(key, new Set());
    byEnd.get(key).add(p);
  };
  for (const p of open) {
    add(ptKey(p.geometry[0]), p);
    add(ptKey(p.geometry[p.geometry.length - 1]), p);
  }
  const used = new Set();
  const take = (p) => {
    used.add(p);
    byEnd.get(ptKey(p.geometry[0])).delete(p);
    byEnd.get(ptKey(p.geometry[p.geometry.length - 1])).delete(p);
  };
  for (const start of open) {
    if (used.has(start)) continue;
    take(start);
    const ring = start.geometry.slice();
    const ids = [start.id];
    for (;;) {
      const endKey = ptKey(ring[ring.length - 1]);
      if (endKey === ptKey(ring[0]) && ring.length >= 4) break;
      const next = [...(byEnd.get(endKey) ?? [])][0];
      if (!next) break;
      take(next);
      ids.push(next.id);
      const g = ptKey(next.geometry[0]) === endKey ? next.geometry : next.geometry.slice().reverse();
      for (let i = 1; i < g.length; i++) ring.push(g[i]);
    }
    if (isClosed(ring)) rings.push(ring);
    else unclosable.push(ids);
  }
  return { rings, unclosable };
}

/** members = [{id, role: "outer"|"inner", geometry: Ring}] from `out geom` relations; stitch by endpoints. → {outers, inners, unclosable: Array<{role, ids}>} */
export function assembleRings(members) {
  const byRole = { outer: [], inner: [] };
  for (const m of members) {
    const role = m.role === "inner" ? "inner" : "outer";
    if (!Array.isArray(m.geometry)) throw new Error(`assembleRings: member ${m.id} has no geometry`);
    byRole[role].push(m);
  }
  const outer = stitch(byRole.outer);
  const inner = stitch(byRole.inner);
  return {
    outers: outer.rings,
    inners: inner.rings,
    unclosable: [...outer.unclosable.map((ids) => ({ role: "outer", ids })), ...inner.unclosable.map((ids) => ({ role: "inner", ids }))],
  };
}

/** Group assembled rings into polygons: each inner goes to the smallest outer that contains its first vertex. → Polygon[] */
export function ringsToPolygons(outers, inners) {
  const polys = outers.map((o) => ({ rings: [o], area: Math.abs(ringArea(o)) })).sort((a, b) => a.area - b.area);
  for (const inner of inners) {
    const [x, z] = inner[0];
    const host = polys.find((p) => pointInPolygon(x, z, [p.rings[0]]));
    if (host) host.rings.push(inner);
  }
  return polys.map((p) => p.rings);
}

/** Signed shoelace area in blocks² (positive = counter-clockwise in x-right, z-down axes). → number */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}

/** Area of a polygon (outer minus holes), blocks². */
export const polygonArea = (polygon) => polygon.reduce((s, r, i) => s + (i === 0 ? 1 : -1) * Math.abs(ringArea(r)), 0);

/** Area centroid; degenerate (zero-area) rings fall back to the vertex mean. → [x, z] */
export function ringCentroid(ring) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f;
    cx += (ring[j][0] + ring[i][0]) * f;
    cz += (ring[j][1] + ring[i][1]) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const n = ring.length;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cz / (3 * a)];
}
