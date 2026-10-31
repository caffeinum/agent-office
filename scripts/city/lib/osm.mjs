// STUB (W1) — owner W2. Overpass queries and OSM tag → city class rules.
// Final exported signatures; bodies are TODO. Spec: docs/city/spec.md.

/** → {roads, land, buildings} query strings, each prefixed [out:json][timeout:300][maxsize:1073741824]; */
export function overpassQueries(bbox) {
  throw new Error("not implemented: overpassQueries");
}

/** Highway filter (spec §2). → boolean */
export function keepHighway(tags) {
  throw new Error("not implemented: keepHighway");
}

/** → {roadway, sidewalk, surface} in blocks, or null for skipped classes */
export function roadSpec(tags) {
  throw new Error("not implemented: roadSpec");
}

/** Landcover table (spec §2). → SURFACE value or null (unmapped, counted in the report) */
export function landcoverSurface(tags) {
  throw new Error("not implemented: landcoverSurface");
}

/** Parse m or ft. → metres, or null if unparseable */
export function parseHeightM(value) {
  throw new Error("not implemented: parseHeightM");
}
