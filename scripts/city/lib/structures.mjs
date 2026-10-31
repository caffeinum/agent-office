// W3 (spec-v2 §5): structure classes. W1 stub with the final signatures; W3 owns this file from the W1 merge.
// The hooks start as no-ops: applyStructures returns the raster unchanged.

/**
 * OSM tags (+ the DataSF record under the footprint, or null) → one of STRUCTURE_KINDS, or null for an ordinary
 * building. W2 calls it per OSM record while loading (ctx.osm[].structure).
 * @param {Record<string, string>} tags
 * @param {import("./ctx.mjs").DatasfBuilding | null} ds
 * @returns {string | null}
 */
export function structureKind(tags, ds) {
  return null;
}

/**
 * build-sf calls this after stampBuildings and before finishDecks. Writes through the raster API only
 * (setColumn, setSurface, clearBuilding, addEntry, addProp). → the same raster
 */
export function applyStructures(raster, ctx) {
  return raster;
}
