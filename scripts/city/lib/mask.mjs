// STUB (W1) — owner W2. Land/water mask at block-centre resolution (DataSF polygon primary, OSM coastline fallback).
// Final exported signatures; bodies are TODO. Spec: docs/city/spec.md.

/** → Uint8Array over the raster, 1 = water */
export function buildWaterMask(raster, landPolygons) {
  throw new Error("not implemented: buildWaterMask");
}

/** Assemble natural=coastline ways; close open ends along the bbox edge with the sea on the right. → Polygon[] (land) */
export function closeCoastline(ways, bbox) {
  throw new Error("not implemented: closeCoastline");
}
