// Ambient traffic: cars driving the street.bin ROAD graph and cable cars / streetcars on its TRACK lines, around
// the orbit target only. Three InstancedMeshes (cars, cable cars, streetcars) = three draw calls; nothing runs
// or draws while the camera is farther than TRAFFIC_DIST. Vehicles keep to the right of travel, one-ways run
// forward only, and at a way's end a vehicle carries on along any way through that vertex (else it respawns).
// Speeds are one per class, so vehicles in a lane never overtake each other.

import { ROAD_FLAG, STREET_LINE, STREET_Q, TRACK_FLAG } from "../../shared/city.js";
import { BODY, CABLE_CAR_BOXES, CAR_BOXES, CAR_COLORS, STREETCAR_BOXES } from "./streetkit.js";

export const TRAFFIC_DIST = 700;
export const TRAFFIC_RADIUS = 150;
export const MAX_CARS = 320;
/** Road length (blocks, per direction) per moving car. */
export const CAR_EVERY = 16;
export const SPEED = Object.freeze({ car: 3.6, cable: 1.4, streetcar: 3 });
const PARKING_LANE = 0.8;
const REBUILD_MOVE = 24;
const MIN_GAP = 3;

/** Pure. Polyline (x4,z4 pairs) → {xs, zs, cum, total}. */
export function polyline(pts) {
  const n = pts.length / 2;
  const xs = new Float32Array(n), zs = new Float32Array(n), cum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = pts[i * 2] / STREET_Q;
    zs[i] = pts[i * 2 + 1] / STREET_Q;
    if (i) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
  }
  return { xs, zs, cum, total: cum[n - 1] };
}

/** Pure. Point and unit direction at arc length s on a polyline. → {x, z, dx, dz, i (segment start)} */
export function pointOn(pl, s) {
  const { xs, zs, cum, total } = pl;
  const t = Math.max(0, Math.min(total, s));
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= t) lo = mid; else hi = mid; }
  const len = cum[hi] - cum[lo] || 1;
  const f = (t - cum[lo]) / len;
  const dx = (xs[hi] - xs[lo]) / len, dz = (zs[hi] - zs[lo]) / len;
  return { x: xs[lo] + (xs[hi] - xs[lo]) * f, z: zs[lo] + (zs[hi] - zs[lo]) * f, dx, dz, i: lo };
}

/**
 * Pure. A drivable network from street lines that pass `keep(line)`: ways {pl, line, oneway, offsets[]} and
 * vertex key → [{way, k (vertex index)}] for continuing at a way's end.
 */
export function buildNetwork(lines, keep, lateral) {
  const ways = [];
  const at = new Map();
  for (const line of lines) {
    if (!keep(line)) continue;
    const way = { line, pl: polyline(line.pts), oneway: line.kind === STREET_LINE.TRACK || (line.flags & ROAD_FLAG.ONEWAY) !== 0, offsets: lateral(line) };
    if (way.pl.total < 1) continue;
    way.index = ways.length;
    ways.push(way);
    for (let k = 0; k < way.pl.xs.length; k++) {
      const key = `${line.pts[k * 2]},${line.pts[k * 2 + 1]}`;
      if (!at.has(key)) at.set(key, []);
      at.get(key).push({ way, k });
    }
  }
  return { ways, at };
}

/** Pure. Lateral offsets (right of travel) of the driving lanes of a road line. */
export function laneOffsets(line) {
  const half = line.width4 / STREET_Q / 2;
  if (line.kind !== STREET_LINE.ROAD) return [0];
  const oneway = (line.flags & ROAD_FLAG.ONEWAY) !== 0;
  if (oneway) {
    const n = Math.max(1, line.lanes || Math.round((2 * half - 2 * PARKING_LANE) / 1.1));
    const lane = Math.max(0.6, (2 * half - 2 * PARKING_LANE) / n);
    return Array.from({ length: n }, (_, k) => -half + PARKING_LANE + lane * (k + 0.5)).filter((o) => Math.abs(o) < half - 0.3);
  }
  const n = Math.max(1, Math.floor((line.lanes || 2) / 2));
  const lane = Math.max(0.6, (half - PARKING_LANE) / n);
  return Array.from({ length: n }, (_, k) => Math.min(half - 0.4, lane * (k + 0.5) + 0.15));
}

function boxesGeometry(THREE, boxes, bodyHex) {
  const color = new THREE.Color();
  const pos = [], nor = [], col = [];
  for (const b of boxes) {
    const g = new THREE.BoxGeometry(b.w, b.h, b.d).toNonIndexed();
    g.translate(b.x, b.y + b.h / 2, b.z);
    pos.push(...g.attributes.position.array);
    nor.push(...g.attributes.normal.array);
    color.set(b.color === BODY ? bodyHex : b.color);
    for (let i = 0; i < g.attributes.position.count; i++) col.push(color.r, color.g, color.b);
    g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return geo;
}

/** A small deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One fleet over a network: vehicles {way, s, dir, lane, y, pitch} kept within `radius` of the target.
 * → {update(dt, target), count}
 */
function createFleet({ net, mesh, speed, every, max, radius, streetY, length, random, colors }) {
  const { THREE } = mesh.userData;
  const cars = [];
  let active = [];
  let activeLen = 0;
  let centre = null;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, "YXZ"), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  const c = new THREE.Color();

  const near = (way, x, z) => {
    const { xs, zs } = way.pl;
    for (let k = 0; k < xs.length; k++) if (Math.abs(xs[k] - x) < radius && Math.abs(zs[k] - z) < radius) return true;
    return false;
  };
  const inRange = (x, z) => Math.abs(x - centre.x) < radius * 1.15 && Math.abs(z - centre.z) < radius * 1.15;

  function place(car, way, s, dir) {
    car.way = way; car.s = s; car.dir = dir;
    car.lane = way.offsets[Math.floor(random() * way.offsets.length)];
  }
  function spawn(car) {
    for (let tries = 0; tries < 8 && active.length; tries++) {
      const way = active[Math.floor(random() * active.length)];
      const s = random() * way.pl.total;
      const dir = way.oneway || random() < 0.5 ? 1 : -1;
      if (cars.some((o) => o !== car && o.way === way && o.dir === dir && Math.abs(o.s - s) < length + MIN_GAP)) continue;
      place(car, way, s, dir);
      car.y = null;
      return true;
    }
    car.way = null;
    return false;
  }
  /** At a way's end: carry on along a way through this vertex, else respawn. */
  function turn(car) {
    const { way, dir } = car;
    const k = dir > 0 ? way.pl.xs.length - 1 : 0;
    const key = `${way.line.pts[k * 2]},${way.line.pts[k * 2 + 1]}`;
    const opts = [];
    for (const o of net.at.get(key) ?? []) {
      if (o.way === way) continue;
      const last = o.way.pl.xs.length - 1;
      if (o.k < last) opts.push([o.way, o.way.pl.cum[o.k], 1]);
      if (o.k > 0 && !o.way.oneway) opts.push([o.way, o.way.pl.cum[o.k], -1]);
    }
    if (!opts.length && !way.oneway) opts.push([way, dir > 0 ? way.pl.total : 0, -dir]);
    if (!opts.length) return spawn(car);
    const [w, s, d] = opts[Math.floor(random() * opts.length)];
    place(car, w, s, d);
    return true;
  }

  function rebuild(target) {
    centre = { x: target.x, z: target.z };
    active = net.ways.filter((w) => near(w, centre.x, centre.z));
    activeLen = active.reduce((n, w) => n + w.pl.total * (w.oneway ? 1 : 2), 0);
    const want = Math.min(max, Math.round(activeLen / every));
    while (cars.length < want) {
      const car = { way: null, s: 0, dir: 1, lane: 0, y: null, pitch: 0, color: Math.floor(random() * colors) };
      cars.push(car);
      spawn(car);
    }
    cars.length = Math.min(cars.length, want);
    for (const car of cars) {
      if (!car.way) { spawn(car); continue; }
      const p = pointOn(car.way.pl, car.s);
      if (!inRange(p.x, p.z)) spawn(car);
    }
  }

  function update(dt, target) {
    if (!centre || Math.hypot(target.x - centre.x, target.z - centre.z) > REBUILD_MOVE) rebuild(target);
    let n = 0;
    for (const car of cars) {
      if (!car.way) continue;
      car.s += car.dir * speed * dt;
      if (car.s < 0 || car.s > car.way.pl.total) {
        const over = car.s < 0 ? -car.s : car.s - car.way.pl.total;
        if (!turn(car)) continue;
        car.s += car.dir * over;
      }
      const p = pointOn(car.way.pl, car.s);
      if (!inRange(p.x, p.z)) { if (!spawn(car)) continue; continue; }
      const dx = p.dx * car.dir, dz = p.dz * car.dir;
      const x = p.x - dz * car.lane, z = p.z + dx * car.lane;
      const yNow = streetY(x, z);
      const yF = streetY(x + dx * length * 0.45, z + dz * length * 0.45), yB = streetY(x - dx * length * 0.45, z - dz * length * 0.45);
      const k = 1 - Math.exp(-dt * 8);
      car.y = car.y === null ? yNow : car.y + (Math.max(yNow, (yF + yB) / 2) - car.y) * k;
      car.pitch += (Math.atan2(yB - yF, length * 0.9) - car.pitch) * k;
      e.set(car.pitch, Math.atan2(dx, dz), 0);
      q.setFromEuler(e);
      mesh.setMatrixAt(n, m.compose(v.set(x, car.y, z), q, one));
      if (mesh.instanceColor || colors > 1) mesh.setColorAt(n, c.set(CAR_COLORS[car.color % CAR_COLORS.length]));
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return n;
  }
  return { update, get count() { return mesh.count; } };
}

/**
 * Ambient traffic over decoded street.bin. opts: {THREE, scene, street, streetY(x, z), seed?}. update(dt, target,
 * cameraDist) once per frame. → {update, stats(), dispose, meshes}
 */
export function createTraffic({ THREE, scene, street, streetY, seed = 1 }) {
  if (!street || !Array.isArray(street.lines)) throw new Error("createTraffic: street (decoded street.bin) is required");
  if (typeof streetY !== "function") throw new Error("createTraffic: streetY(x, z) is required");
  const random = rng(seed);
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const make = (boxes, bodyHex, max, name) => {
    const mesh = new THREE.InstancedMesh(boxesGeometry(THREE, boxes, bodyHex), material, max);
    mesh.name = name;
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.THREE = THREE;
    scene.add(mesh);
    return mesh;
  };
  const roads = buildNetwork(street.lines, (l) => l.kind === STREET_LINE.ROAD, laneOffsets);
  const cable = buildNetwork(street.lines, (l) => l.kind === STREET_LINE.TRACK && (l.flags & TRACK_FLAG.CABLE) !== 0, () => [0]);
  const trams = buildNetwork(street.lines, (l) => l.kind === STREET_LINE.TRACK && (l.flags & TRACK_FLAG.CABLE) === 0, () => [0]);
  const carMesh = make(CAR_BOXES, "#ffffff", MAX_CARS, "city-traffic-cars");
  carMesh.setColorAt(0, new THREE.Color(1, 1, 1));
  const cableMesh = make(CABLE_CAR_BOXES, "#7d2430", 24, "city-traffic-cable");
  const tramMesh = make(STREETCAR_BOXES, "#d9d6cf", 24, "city-traffic-streetcars");
  const fleets = [
    createFleet({ net: roads, mesh: carMesh, speed: SPEED.car, every: CAR_EVERY, max: MAX_CARS, radius: TRAFFIC_RADIUS, streetY, length: 1.45, random, colors: CAR_COLORS.length }),
    createFleet({ net: cable, mesh: cableMesh, speed: SPEED.cable, every: 160, max: 8, radius: TRAFFIC_RADIUS * 1.4, streetY, length: 2.8, random, colors: 1 }),
    createFleet({ net: trams, mesh: tramMesh, speed: SPEED.streetcar, every: 220, max: 8, radius: TRAFFIC_RADIUS * 1.4, streetY, length: 5, random, colors: 1 }),
  ];
  const meshes = [carMesh, cableMesh, tramMesh];
  let on = false;
  return {
    meshes,
    update(dt, target, cameraDist) {
      const want = cameraDist < TRAFFIC_DIST;
      if (want !== on) { on = want; for (const m of meshes) m.visible = want; }
      if (!on) return;
      for (const f of fleets) f.update(Math.min(dt, 0.1), target);
    },
    stats: () => ({ cars: carMesh.count, cableCars: cableMesh.count, streetcars: tramMesh.count, roadWays: roads.ways.length, cableWays: cable.ways.length, tramWays: trams.ways.length }),
    dispose() {
      for (const m of meshes) { scene.remove(m); m.geometry.dispose(); m.dispose(); }
      material.dispose();
    },
  };
}
