// STUB (W1) — owner W2. DataSF + OSM building merge and the base/top rule.
// Final exported signatures; bodies are TODO. Spec: docs/city/spec.md.

/** Spec §2 building rules 1-4; ids assigned sequentially after sorting by source key. → {buildings, report} */
export function mergeBuildings({ datasf, osm, overrides }) {
  throw new Error("not implemented: mergeBuildings");
}

/** base = min ground, top = max ground + max(1, round(h/3)). → {base, top} */
export function baseTop(groundsUnderFootprint, heightM) {
  throw new Error("not implemented: baseTop");
}
