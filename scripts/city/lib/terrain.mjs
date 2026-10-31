// STUB (W1) — owner W2. AWS Terrarium z15 elevation; land height only, never land vs water.
// Final exported signatures; bodies are TODO. Spec: docs/city/spec.md.

export const TERRARIUM_ZOOM = 15;

/** → https://s3.amazonaws.com/elevation-tiles-prod/terrarium/15/{x}/{y}.png */
export function terrariumUrl(x, y) {
  throw new Error("not implemented: terrariumUrl");
}

/** R*256 + G + B/256 - 32768. → metres */
export function decodeTerrarium(r, g, b) {
  throw new Error("not implemented: decodeTerrarium");
}

/** bbox = {south, west, north, east}. → Array<{x, y}> */
export function tilesForBbox(bbox) {
  throw new Error("not implemented: tilesForBbox");
}

/** Load cached tiles. → {sample(lon, lat) → metres} (bilinear) */
export function createElevation(rawDir, tiles) {
  throw new Error("not implemented: createElevation");
}
