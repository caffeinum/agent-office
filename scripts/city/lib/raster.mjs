// STUB (W1) — owner W2. The working raster over the chunk range and its split into chunks.
// Final exported signatures; bodies are TODO. Spec: docs/city/spec.md.

/** → {x0, z0, w, h, ground: Int16Array, surface: Uint8Array, owner: Int32Array (building index or -1), deck: Int16Array} */
export function createRaster(minChunk, maxChunk) {
  throw new Error("not implemented: createRaster");
}

/** Split into shared/city.js Chunk objects; all-water chunks are dropped and counted. → {chunks: Chunk[], allWater: number} */
export function rasterToChunks(raster, buildings) {
  throw new Error("not implemented: rasterToChunks");
}
