// STUB (W1) — owner W2. Hand-written geometry. Ring = Array<[x, z]> in blocks; Polygon = Ring[] (first outer, rest holes).
// Final exported signatures; bodies are TODO. Spec: docs/city/spec.md.

/** Even-odd test against outer + holes. → boolean */
export function pointInPolygon(x, z, polygon) {
  throw new Error("not implemented: pointInPolygon");
}

/** Scanline: call visit(x, z) for every integer column whose centre (x+0.5, z+0.5) is inside. */
export function scanPolygon(polygon, visit) {
  throw new Error("not implemented: scanPolygon");
}

/** Call visit(x, z) for every column within width/2 of the polyline `points`. */
export function stampLine(points, width, visit) {
  throw new Error("not implemented: stampLine");
}

/** members = [{id, role: "outer"|"inner", geometry: Ring}] from `out geom` relations; stitch by endpoints. → {outers: Ring[], inners: Ring[], unclosable: Array<{role, ids}>} */
export function assembleRings(members) {
  throw new Error("not implemented: assembleRings");
}

/** Signed shoelace area in blocks². → number */
export function ringArea(ring) {
  throw new Error("not implemented: ringArea");
}

/** Area centroid. → [x, z] */
export function ringCentroid(ring) {
  throw new Error("not implemented: ringCentroid");
}
