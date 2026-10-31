// W3 (spec-v2 §5): landmark recipes from scripts/city/sf/landmarks.json. W1 stub with the final signature; W3 owns
// this file from the W1 merge. The hook starts as a no-op.

/**
 * build-sf calls this last, before encode. Every column a landmark writes clears other buildings there, so the
 * landmark wins. Writes through the raster API only. → the same raster
 */
export function applyLandmarks(raster, ctx) {
  return raster;
}
