// STUB (W1) — owner W5. The city scene API consumed by W6 (spec §3 Scene API).
// Final exported signatures; bodies are TODO. Spec: docs/city/spec.md.

/** → Promise<{manifest, store, setTheme, focus(x, z, dist?), onFrame, pick(clientX, clientY), worldToScreen(x, y, z), groundAt(x, z), buildingAt(x, z), cameraDistance(), add, remove, THREE, stats()}> */
export async function createCityScene(container, { manifestUrl }) {
  throw new Error("not implemented: createCityScene");
}
