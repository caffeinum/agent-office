// STUB (W1) — owner W4. Greedy heightfield mesher. Imports only ../../shared/city.js (module workers have no importmap; no three).
// Final exported signatures; bodies are TODO. Spec: docs/city/spec.md.
//
// MeshBuffers = {positions: Float32Array (chunk/region-local), colors: Uint8Array (normalised RGB), uvs?: Float32Array, indices: Uint32Array, origin: [x, y, z]}

/** LOD0. neighbours = {n, s, e, w}: Chunk | null (null = absent = water). → {opaque: MeshBuffers, walls: MeshBuffers} */
export function meshChunk(chunk, neighbours) {
  throw new Error("not implemented: meshChunk");
}

/** LOD1 (2×2) / LOD2 (4×4) downsample of ≤16 chunks, skipping [[cx, cz], ...]; vertex colour only. → {opaque: MeshBuffers} */
export function meshRegion(chunks, skip, lod) {
  throw new Error("not implemented: meshRegion");
}

/** req = {id, kind: "chunk", lod: 0, chunk, n, s, e, w} | {id, kind: "region", lod: 1|2, chunks, skip}. → {reply: {id, opaque, walls?}, transfer: ArrayBuffer[]} */
export function handleMeshRequest(req) {
  throw new Error("not implemented: handleMeshRequest");
}
