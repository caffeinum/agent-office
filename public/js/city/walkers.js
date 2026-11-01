// Walkers in the city (spec-v2 §7.5): true-scale 0.6-block bodies in one InstancedMesh with leg/arm swing in the
// vertex shader (phase = distance walked / stride, so feet never slide), a seated pose on an instanced scooter in
// ride mode, constant-pixel hue beacons beyond BEACON_DIST, and DOM name/speech chips (≤ 24; selected, then
// talking, then nearest). Names and chat only ever go through textContent.

import { cullLabels } from "./labels.js";
import { pickRay } from "./pick.js";
import { PIN_BOXES, hueColor, pinGeometry, tintPatch } from "./pins.js";

export const BEACON_DIST = 120;
export const MAX_CHIPS = 24;
export const MAX_WALKERS = 512;
export const PICK_PX = 12;
export const BEACON_PX = 9;
export const BEACON_LIFT = 1.2;
export const CHIP_LIFT = 0.9;
export const OCCLUSION_MS = 250;
/** Leg swing amplitude (rad) and pivots (blocks above the feet), from PIN_BOXES. */
export const SWING = 0.5;
export const HIP_Y = 0.24;
export const SHOULDER_Y = 0.46;
/** One gait cycle covers two steps of a leg swinging ±SWING from the hip: no foot sliding at any speed. */
export const STRIDE = 4 * HIP_Y * Math.sin(SWING);
/** Ride pose: the body sits this much higher, on the scooter seat. */
export const SEAT_LIFT = 0.06;

const LIMB = { leg: [1, 2], arm: [3, 4] };

/** Pure. "body" up to BEACON_DIST from the camera, "beacon" beyond. */
export function drawMode(dist) {
  if (!Number.isFinite(dist) || dist < 0) throw new Error(`drawMode: bad distance ${dist}`);
  return dist > BEACON_DIST ? "beacon" : "body";
}

/** Pure. Gait phase (rad) after walking d blocks: frequency = speed / STRIDE. */
export const gaitPhase = (d) => (d / STRIDE) * Math.PI * 2;

/**
 * Pure. Chip candidates [{id, x, y, w, h, dist, selected, talking}] → kept (≤ max): selected first, then talking,
 * then nearest; a chip overlapping a kept one is dropped (labels.js cullLabels).
 */
export function chipOrder(candidates, max = MAX_CHIPS) {
  const ranked = candidates.map((c, order) => ({ ...c, order, dist: (c.selected ? 0 : c.talking ? 1 : 2) * 1e9 + c.dist }));
  return cullLabels(ranked, max);
}

/** Pure. The screen-space nearest point within radius px of (sx, sy) → id | null. points: [{id, x, y, visible}] */
export function pickWalker(points, sx, sy, radius = PICK_PX) {
  let best = null, bestD = radius;
  for (const p of points) {
    if (!p.visible) continue;
    const d = Math.hypot(p.x - sx, p.y - sy);
    if (d <= bestD) { best = p.id; bestD = d; }
  }
  return best;
}

function limbAttribute(THREE, geo) {
  const per = geo.attributes.position.count / PIN_BOXES.length;
  if (per !== 36) throw new Error(`walkers: expected 36 vertices per pin box, got ${per}`);
  const limb = new Float32Array(geo.attributes.position.count);
  const seen = { leg: 0, arm: 0 };
  PIN_BOXES.forEach((b, k) => {
    const code = LIMB[b.part] ? LIMB[b.part][seen[b.part]++] : 0;
    limb.fill(code, k * per, (k + 1) * per);
  });
  geo.setAttribute("limb", new THREE.BufferAttribute(limb, 1));
}

const GAIT_GLSL = `
attribute float limb;
attribute float iPhase;
attribute float iSwing;
attribute float iSeat;
float walkerLimbAngle() {
  float s = sin(iPhase) * ${SWING.toFixed(3)} * iSwing;
  if (limb < 0.5) return 0.0;
  if (limb < 1.5) return s - iSeat * 1.4;
  if (limb < 2.5) return -s - iSeat * 1.4;
  if (limb < 3.5) return -s - iSeat * 0.7;
  return s - iSeat * 0.7;
}
vec3 walkerRotX(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c); }
`;

function walkerMaterial(THREE) {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  material.onBeforeCompile = (shader) => {
    tintPatch(THREE, shader);
    for (const inc of ["#include <common>", "#include <beginnormal_vertex>", "#include <begin_vertex>"]) {
      if (!shader.vertexShader.includes(inc)) throw new Error(`walkers: lambert shader has no ${inc}`);
    }
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${GAIT_GLSL}`)
      .replace("#include <beginnormal_vertex>", "#include <beginnormal_vertex>\nobjectNormal = walkerRotX(objectNormal, walkerLimbAngle());")
      .replace("#include <begin_vertex>", `#include <begin_vertex>
{
  float pivot = limb < 2.5 ? ${HIP_Y.toFixed(3)} : ${SHOULDER_Y.toFixed(3)};
  if (limb > 0.5) transformed = walkerRotX(transformed - vec3(0.0, pivot, 0.0), walkerLimbAngle()) + vec3(0.0, pivot, 0.0);
}`);
  };
  return material;
}

/** Scooter boxes, wheels on the ground, facing +z like the body. */
export const SCOOTER_BOXES = Object.freeze([
  { x: 0, y: 0.05, z: 0.17, w: 0.03, h: 0.1, d: 0.1, color: 0x2b2b30 },
  { x: 0, y: 0.05, z: -0.17, w: 0.03, h: 0.1, d: 0.1, color: 0x2b2b30 },
  { x: 0, y: 0.075, z: 0, w: 0.12, h: 0.03, d: 0.42, color: 0x5a6270 },
  { x: 0, y: 0.26, z: 0.19, w: 0.03, h: 0.4, d: 0.03, color: 0x8a919c },
  { x: 0, y: 0.46, z: 0.19, w: 0.2, h: 0.03, d: 0.03, color: 0x2b2b30 },
  { x: 0, y: 0.16, z: -0.08, w: 0.04, h: 0.17, d: 0.04, color: 0x8a919c },
  { x: 0, y: 0.255, z: -0.08, w: 0.1, h: 0.03, d: 0.12, color: 0x2b2b30 },
].map(Object.freeze));

function boxesGeometry(THREE, boxes) {
  const color = new THREE.Color();
  const pos = [], nor = [], col = [];
  for (const b of boxes) {
    const g = new THREE.BoxGeometry(b.w, b.h, b.d).toNonIndexed();
    g.translate(b.x, b.y, b.z);
    pos.push(...g.attributes.position.array);
    nor.push(...g.attributes.normal.array);
    color.setHex(b.color);
    for (let i = 0; i < g.attributes.position.count; i++) col.push(color.r, color.g, color.b);
    g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return geo;
}

function el(doc, tag, cls, text) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * The walker layer over a live state (live.js createLiveState). Draw calls: bodies, scooters, beacons.
 * update(localNow) once per frame. → {update, select(id|null), selected, pick(clientX, clientY), dispose, bodies, scooters, beacons, chipCount}
 */
export function createWalkers(city, live, root, { doc = document, onChipPick = () => {} } = {}) {
  const { THREE } = city;
  if (!THREE) throw new Error("createWalkers: city.THREE is missing");
  const camera = city.stage?.camera;
  if (!camera) throw new Error("createWalkers: city.stage.camera is missing");
  if (typeof city.standY !== "function") throw new Error("createWalkers: city.standY(x, y, z) is missing (curb-lowered carriageway)");

  const bodyGeo = pinGeometry(THREE);
  limbAttribute(THREE, bodyGeo);
  const inst = (n) => new THREE.InstancedBufferAttribute(new Float32Array(MAX_WALKERS * n), n);
  const iPhase = inst(1), iSwing = inst(1), iSeat = inst(1);
  bodyGeo.setAttribute("iPhase", iPhase);
  bodyGeo.setAttribute("iSwing", iSwing);
  bodyGeo.setAttribute("iSeat", iSeat);
  const bodyMat = walkerMaterial(THREE);
  const bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, MAX_WALKERS);
  bodies.name = "city-walkers";
  const scooterMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const scooters = new THREE.InstancedMesh(boxesGeometry(THREE, SCOOTER_BOXES), scooterMat, MAX_WALKERS);
  scooters.name = "city-scooters";
  for (const m of [bodies, scooters]) { m.count = 0; m.frustumCulled = false; m.castShadow = false; m.receiveShadow = false; }
  bodies.setColorAt(0, new THREE.Color(1, 1, 1));

  const beaconGeo = new THREE.BufferGeometry();
  const beaconPos = new THREE.BufferAttribute(new Float32Array(MAX_WALKERS * 3), 3);
  const beaconCol = new THREE.BufferAttribute(new Float32Array(MAX_WALKERS * 3), 3);
  beaconGeo.setAttribute("position", beaconPos);
  beaconGeo.setAttribute("color", beaconCol);
  beaconGeo.setDrawRange(0, 0);
  const beaconMat = new THREE.PointsMaterial({ size: BEACON_PX, sizeAttenuation: false, vertexColors: true, depthTest: false, transparent: true });
  const beacons = new THREE.Points(beaconGeo, beaconMat);
  beacons.name = "city-beacons";
  beacons.frustumCulled = false;
  beacons.renderOrder = 10;
  for (const o of [bodies, scooters, beacons]) city.add(o);

  const layer = el(doc, "div", "cu-walkers");
  root.appendChild(layer);
  const chips = new Map();

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), color = new THREE.Color();
  let selected = null;
  let screenPts = [];

  // a chip hides while voxels stand between the camera and the walker's head (re-tested every OCCLUSION_MS)
  const occlusion = new Map();
  function hidden(id, x, y, z, localNow) {
    if (!city.store) return false;
    const o = occlusion.get(id);
    if (o && localNow < o.until) return o.value;
    const c = camera.position, dx = x - c.x, dy = y - c.y, dz = z - c.z;
    const dist = Math.hypot(dx, dy, dz);
    const hit = dist > 0 ? pickRay(city.store, { x: c.x, y: c.y, z: c.z }, { x: dx / dist, y: dy / dist, z: dz / dist }, dist) : null;
    const value = !!hit && hit.dist < dist - 0.5;
    occlusion.set(id, { until: localNow + OCCLUSION_MS, value });
    return value;
  }

  function chipFor(w) {
    let c = chips.get(w.id);
    if (!c) {
      const node = el(doc, "button", "cu-wchip");
      node.type = "button";
      const name = el(doc, "span", "cu-wname");
      const bubble = el(doc, "span", "cu-bubble");
      bubble.hidden = true;
      node.append(bubble, name);
      node.addEventListener("click", () => onChipPick(w.id));
      layer.appendChild(node);
      c = { node, name, bubble, text: null, label: null, size: null };
      chips.set(w.id, c);
    }
    return c;
  }

  function update(localNow = Date.now()) {
    if (!live.ready) return;
    const tracks = live.tracks();
    if (tracks.length > MAX_WALKERS) throw new Error(`walkers: ${tracks.length} walkers > MAX_WALKERS ${MAX_WALKERS}`);
    let nb = 0, ns = 0, np = 0;
    const cands = [];
    const pts = [];
    const alive = new Set();
    for (const t of tracks) {
      const w = t.walker;
      if (w.inside) continue;
      const p = live.position(w.id, localNow);
      p.y = city.standY(p.x, p.y, p.z);
      const dist = camera.position.distanceTo(v.set(p.x, p.y, p.z));
      const mode = drawMode(dist);
      const riding = w.mode === "ride";
      hueColor(color, w.hue);
      if (mode === "body") {
        q.setFromAxisAngle(up, p.heading);
        bodies.setMatrixAt(nb, m.compose(v.set(p.x, p.y + (riding ? SEAT_LIFT : 0), p.z), q, one));
        bodies.setColorAt(nb, color);
        iPhase.array[nb] = riding ? 0 : gaitPhase(p.d);
        iSwing.array[nb] = p.moving && !riding ? 1 : 0;
        iSeat.array[nb] = riding ? 1 : 0;
        nb++;
        if (riding) { scooters.setMatrixAt(ns, m.compose(v.set(p.x, p.y, p.z), q, one)); ns++; }
      } else {
        beaconPos.setXYZ(np, p.x, p.y + BEACON_LIFT, p.z);
        beaconCol.setXYZ(np, color.r, color.g, color.b);
        np++;
      }
      const head = city.worldToScreen(p.x, p.y + (mode === "body" ? CHIP_LIFT : BEACON_LIFT), p.z);
      const dot = mode === "body" ? city.worldToScreen(p.x, p.y + 0.35, p.z) : head;
      pts.push({ id: w.id, x: dot.x, y: dot.y, visible: dot.visible });
      if (!head.visible || hidden(w.id, p.x, p.y + CHIP_LIFT, p.z, localNow)) continue;
      alive.add(w.id);
      const c = chipFor(w);
      const say = live.sayOf(w.id, localNow);
      if (c.label !== w.name) { c.name.textContent = w.name; c.label = w.name; c.size = null; }
      if (c.text !== say) { c.bubble.textContent = say ?? ""; c.bubble.hidden = say === null; c.text = say; c.size = null; }
      c.node.style.setProperty("--h", String(((w.hue % 360) + 360) % 360));
      c.node.classList.toggle("on", w.id === selected);
      if (!c.size) { c.node.hidden = false; c.size = { w: c.node.offsetWidth, h: c.node.offsetHeight }; }
      cands.push({ id: w.id, x: head.x - c.size.w / 2, y: head.y - c.size.h, w: c.size.w, h: c.size.h, dist, selected: w.id === selected, talking: say !== null });
    }
    bodies.count = nb; scooters.count = ns;
    bodies.instanceMatrix.needsUpdate = true; scooters.instanceMatrix.needsUpdate = true;
    if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
    iPhase.needsUpdate = true; iSwing.needsUpdate = true; iSeat.needsUpdate = true;
    beaconGeo.setDrawRange(0, np);
    beaconPos.needsUpdate = true; beaconCol.needsUpdate = true;
    bodies.visible = nb > 0; scooters.visible = ns > 0; beacons.visible = np > 0;
    screenPts = pts;

    for (const id of occlusion.keys()) if (!live.walker(id)) occlusion.delete(id);
    const kept = new Map(chipOrder(cands).map((c) => [c.id, c]));
    for (const [id, c] of chips) {
      if (!live.walker(id)) { c.node.remove(); chips.delete(id); continue; }
      const k = kept.get(id);
      c.node.hidden = !k || !alive.has(id);
      if (k) c.node.style.transform = `translate(${Math.round(k.x)}px, ${Math.round(k.y)}px)`;
    }
  }

  function dispose() {
    for (const o of [bodies, scooters, beacons]) city.remove(o);
    bodyGeo.dispose(); bodyMat.dispose(); scooters.geometry.dispose(); scooterMat.dispose(); beaconGeo.dispose(); beaconMat.dispose();
    bodies.dispose(); scooters.dispose();
    layer.remove();
  }

  return {
    update,
    select(id) { selected = id; },
    get selected() { return selected; },
    /** Screen-space nearest walker within PICK_PX of a client point → walker id | null. */
    pick(clientX, clientY) {
      const r = city.canvas?.getBoundingClientRect?.() ?? { left: 0, top: 0 };
      return pickWalker(screenPts, clientX - r.left, clientY - r.top);
    },
    dispose,
    bodies,
    scooters,
    beacons,
    get chipCount() { let n = 0; for (const c of chips.values()) if (!c.node.hidden) n++; return n; },
  };
}
