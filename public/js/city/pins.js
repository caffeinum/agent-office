// STUB (W1) — owner W6. Agent pins: one InstancedMesh, 0.6 block tall, 0.25 block wide; demo data only in v1.
// Final exported signatures; bodies are TODO. Spec: docs/city/spec.md.

export const PIN_SIZE = Object.freeze({ h: 0.6, w: 0.25 });
export const PINS_PER_COLUMN = 4;
export const PINS_PER_COMPANY = 12;
export const PINS_MAX_DIST = 200;

/** Pure. 2×2 per column from the anchor, away from the door, ≤ 12. → {pins: [{x, y, z}], overflow: number} */
export function layoutPins(anchor, count) {
  throw new Error("not implemented: layoutPins");
}

/** → {setPresence([{companyId, agents: [{id, name, hue, status}]}])} */
export function createPins(city, sites) {
  throw new Error("not implemented: createPins");
}
