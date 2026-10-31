// STUB (W1) — owner W3. DataSF EAS (3mea-di5p) geocoding. W3 pins the column names here before writing the query.
// Final exported signatures; bodies are TODO. Spec: docs/city/spec.md.

/** Uppercase, strip suite/unit/floor/#, numeric ordinals, abbreviated street types, ranges → first number. → {number, street, type, range: string|null} */
export function normalizeAddress(address) {
  throw new Error("not implemented: normalizeAddress");
}

/** → data.sf.gov SODA URL for the normalised address */
export function easQueryUrl(norm) {
  throw new Error("not implemented: easQueryUrl");
}

/** All within 10 m → lowest id; else easId must pick one; else throw. → hit */
export function pickEasHit(hits, { easId } = {}) {
  throw new Error("not implemented: pickEasHit");
}

/** Query (cached in raw/eas/<id>.json), pick, check ≤ 60 m from entry.hint (error names hint.from). → Promise<{id, parcel, lat, lon}> */
export async function resolveEas(entry, { rawDir }) {
  throw new Error("not implemented: resolveEas");
}
