// STUB (W1) — owner W4. Pure voxel DDA picking over the decoded store; meshes are never raycast.
// Final exported signatures; bodies are TODO. Spec: docs/city/spec.md.

/** store.get(cx, cz) → Chunk | undefined; origin/dir = {x, y, z} in blocks. → {x, y, z, cx, cz, kind: "building"|"ground"|"water"|"deck", buildingId?, surface?} | null */
export function pickRay(store, origin, dir, maxDist) {
  throw new Error("not implemented: pickRay");
}
