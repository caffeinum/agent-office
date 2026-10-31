// W5 (spec-v2 §7.6): the walk graph and places. W1 stub with the final signature; W5 owns this file from the W1
// merge.

/**
 * Build the pedestrian graph and the place list.
 * @param {{
 *   roads: object[],                         // cached OSM highway ways (osm-roads.json elements, merged areas)
 *   decks: Record<string, number>,           // report.json decks: {wayId: deckY}
 *   groundAt: (x: number, z: number) => number,
 *   manifest: import("../../../public/shared/city.js").Manifest,
 *   sites: import("../../../public/shared/city.js").CompanySite[],
 *   placesSrc: object[],                     // scripts/city/sf/places.src.json
 * }} input
 * @returns {{ walk: import("../../../public/shared/city.js").WalkGraph, places: import("../../../public/shared/city.js").PlacesDoc }}
 *   walk.builtAt = Date.parse(manifest.builtAt); write with encodeWalk(walk, manifest) and validatePlaces.
 */
export function buildWalk(input) {
  throw new Error("buildWalk: not implemented yet (W5, spec-v2 §7.6)");
}
