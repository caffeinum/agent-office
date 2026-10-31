// The global landmark layer (landmarks.bin, SFL1): bridge towers, decks, cables and open crowns as instanced
// boxes. One InstancedMesh for lit-by-sun boxes and one for emissive boxes (flags & 1), so the whole layer costs
// at most two draw calls (plus shadow). Pure instance building is separate from THREE so node checks can run it;
// THREE is passed in (this file imports only shared/city.js).
import { BUILDING_PALETTE } from "../../shared/city.js";

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function linear(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`meshlayer: bad colour ${hex}`);
  return [1, 3, 5].map((k) => srgbToLinear(parseInt(hex.slice(k, k + 2), 16) / 255));
}

/**
 * Pure. Boxes (decoded landmarks.bin) → instance data for a unit cube spanning [0, 1]³:
 * {count, matrices: Float32Array[16·count] (column-major scale + translate), colors: Float32Array[3·count] linear}
 * per group, for `solid` (flags 0) and `emissive` (flags 1).
 */
export function landmarkInstances(boxes) {
  if (!Array.isArray(boxes)) throw new Error("landmarkInstances: boxes must be an array (decodeLandmarks output)");
  const groups = { solid: [], emissive: [] };
  for (const [i, b] of boxes.entries()) {
    if (!b || ![b.x, b.z, b.y0, b.y1, b.sx, b.sz, b.color, b.flags].every(Number.isInteger)) throw new Error(`landmarkInstances: box ${i} is not a decoded landmark box`);
    const hex = BUILDING_PALETTE[b.color];
    if (!hex) throw new Error(`landmarkInstances: box ${i} colour ${b.color} is not a palette index`);
    if (b.y1 <= b.y0) throw new Error(`landmarkInstances: box ${i} has y1 ${b.y1} ≤ y0 ${b.y0}`);
    (b.flags & 1 ? groups.emissive : groups.solid).push(b);
  }
  const pack = (list) => {
    const matrices = new Float32Array(list.length * 16);
    const colors = new Float32Array(list.length * 3);
    list.forEach((b, n) => {
      const m = n * 16;
      matrices[m] = b.sx;
      matrices[m + 5] = b.y1 - b.y0;
      matrices[m + 10] = b.sz;
      matrices[m + 12] = b.x;
      matrices[m + 13] = b.y0;
      matrices[m + 14] = b.z;
      matrices[m + 15] = 1;
      colors.set(linear(BUILDING_PALETTE[b.color]), n * 3);
    });
    return { count: list.length, matrices, colors };
  };
  return { solid: pack(groups.solid), emissive: pack(groups.emissive) };
}

/** Pure. Triangles the layer draws: 12 per box (a closed cube; the instanced geometry is shared). */
export const landmarkTriangles = (boxes) => boxes.length * 12;

/**
 * → {group: THREE.Group, meshes, setNight(k), dispose()}. Boxes = decodeLandmarks(...). The group holds 0–2
 * InstancedMeshes; add it to the scene.
 */
export function createLandmarkLayer(THREE, boxes) {
  const inst = landmarkInstances(boxes);
  const geo = new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5);
  const group = new THREE.Group();
  group.name = "city-landmarks";
  const mats = [];
  const glowing = [];
  const meshes = [];
  const make = (data, emissive) => {
    if (!data.count) return;
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.05, flatShading: true });
    if (emissive) { mat.emissive = new THREE.Color("#fff4d6"); mat.emissiveIntensity = 0; glowing.push(mat); }
    const mesh = new THREE.InstancedMesh(geo, mat, data.count);
    mesh.instanceMatrix.array.set(data.matrices);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(data.colors, 3);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    group.add(mesh);
    mats.push(mat);
    meshes.push(mesh);
  };
  make(inst.solid, false);
  make(inst.emissive, true);
  return {
    group,
    meshes,
    count: boxes.length,
    /** k = 0 (day) .. 1 (night): emissive boxes light up. */
    setNight(k) { for (const m of glowing) m.emissiveIntensity = 2 * k; },
    dispose() { geo.dispose(); for (const m of mats) m.dispose(); group.removeFromParent(); },
  };
}
