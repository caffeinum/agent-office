// Ambient traffic: cars driving the street.bin ROAD graph and cable cars / streetcars on its TRACK lines, around
// the orbit target only. Three InstancedMeshes (cars, cable cars, streetcars) = three draw calls; nothing runs
// or draws while the camera is farther than TRAFFIC_DIST. Vehicles keep to the right of travel, one-ways run
// forward only, and at a way's end a vehicle carries on along any way through that vertex (else it respawns).
// Each lane (way, direction, lane index) keeps its vehicles in order: a vehicle follows the one ahead at a gap of
// at least MIN_GAP bumper to bumper, looks into the lane it will turn into, and waits at the stop line until that
// lane's entry is clear. Cost per frame is a sort of each lane's few vehicles, never all-pairs.

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
/** Bumper-to-bumper standstill gap (blocks) between vehicles in a lane. */
export const MIN_GAP = 0.6;
/** Distance (blocks) from a way's end at which a vehicle picks its next lane and starts watching it. */
const LOOK = 8;
/** A waiting vehicle's centre stops a car length plus this (blocks) short of its way's end, so its nose stays clear
 *  of a vehicle crossing the junction vertex. */
const HOLD_MARGIN = 0.2;
const ACCEL = 3;
/** Seconds of headway: a vehicle's speed is capped at (free gap) / HEADWAY, so it eases in behind its leader. */
const HEADWAY = 0.7;
/** Seconds held at a stop line before picking another exit; seconds the head of a queue may stand still before it
 *  respawns elsewhere (breaks gridlock cycles of vehicles waiting on each other's junctions). */
const REPICK = 3;
const STUCK = 10;

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
 * Pure. A drivable network from street lines that pass `keep(line)`: ways {pl, line, oneway, offsets[], box} and
 * vertex key → [{way, k (vertex index)}] for continuing at a way's end; `grid` buckets ways by WAY_CELL cells of
 * their bounding box. Which lanes are driven (way.drive) is decided lazily, near the camera: ensureDrive.
 */
export function buildNetwork(lines, keep, lateral) {
  const ways = [];
  const at = new Map();
  const grid = new Map();
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
    const { xs, zs } = way.pl;
    way.box = [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
    forCells(way.box, 0, (k) => {
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(way);
    });
  }
  return { ways, at, grid };
}

const WAY_CELL = 32;
function forCells([x0, z0, x1, z1], pad, fn) {
  for (let cx = Math.floor((x0 - pad) / WAY_CELL); cx <= Math.floor((x1 + pad) / WAY_CELL); cx++) {
    for (let cz = Math.floor((z0 - pad) / WAY_CELL); cz <= Math.floor((z1 + pad) / WAY_CELL); cz++) fn(cx * 65536 + cz);
  }
}

/** Pure. Sets way.drive (shadowLanes) on each of `ways` that lacks it, against every network way nearby. */
export function ensureDrive(net, ways) {
  const todo = ways.filter((w) => !w.drive);
  if (!todo.length) return;
  const near = new Set(todo);
  for (const w of todo) forCells(w.box, 2, (k) => { for (const o of net.grid.get(k) ?? []) near.add(o); });
  shadowLanes(todo, [...near]);
}

/** Lanes closer than this (blocks, same heading) are the same strip of road. */
const SHADOW_DIST = 0.6;
/** A lane this far (blocks) inside a wider way's kerb line is on that way's asphalt. */
const KERB_INSET = 0.25;

/** Points (X[i], Z[i]) bucketed in square cells of `size`. → visit(x, z, reach, fn(i)) over cells within `reach` */
function pointGrid(X, Z, size) {
  const cellOf = (cx, cz) => cx * 65536 + cz;
  const at = (i) => cellOf(Math.floor(X[i] / size), Math.floor(Z[i] / size));
  const count = new Map();
  for (let i = 0; i < X.length; i++) { const k = at(i); count.set(k, (count.get(k) ?? 0) + 1); }
  const first = new Map();
  let o = 0;
  for (const [k, c] of count) { first.set(k, o); o += c; }
  const fill = new Map(first);
  const order = new Int32Array(X.length);
  for (let i = 0; i < X.length; i++) { const k = at(i); const p = fill.get(k); order[p] = i; fill.set(k, p + 1); }
  return (x, z, reach, fn) => {
    const r = Math.ceil(reach / size), cx = Math.floor(x / size), cz = Math.floor(z / size);
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      const k = cellOf(cx + i, cz + j), f = first.get(k);
      if (f === undefined) continue;
      for (let q = f, e = f + count.get(k); q < e; q++) if (fn(order[q])) return true;
    }
    return false;
  };
}

/** Samples every block along each lane (way, dir, lane index) of `ways`. → {lanes: [{way, dir, li, from, to}], X, Z, DX, DZ, L} */
function laneSamples(ways, lanesOf) {
  const lanes = [];
  let n = 0;
  for (const way of ways) for (const [dir, li, off] of lanesOf(way)) {
    const count = Math.max(0, Math.ceil(way.pl.total - 0.5));
    lanes.push({ way, dir, li, off, from: n, to: n + count });
    n += count;
  }
  const X = new Float32Array(n), Z = new Float32Array(n), DX = new Float32Array(n), DZ = new Float32Array(n), L = new Int32Array(n);
  lanes.forEach((lane, l) => {
    for (let i = lane.from, s = 0.5; i < lane.to; i++, s += 1) {
      const p = pointOn(lane.way.pl, s);
      const dx = p.dx * lane.dir, dz = p.dz * lane.dir;
      X[i] = p.x - dz * lane.off; Z[i] = p.z + dx * lane.off; DX[i] = dx; DZ[i] = dz; L[i] = l;
    }
  });
  return { lanes, X, Z, DX, DZ, L };
}

/**
 * Pure. Sets way.drive = {1: [lane index], -1: [...]} on each of `decide`: the lanes vehicles use in each direction.
 * OSM draws some streets twice (Van Ness's busway between and beside its carriageways, slip lanes along a main road).
 * When any lane of a way spends at least half its length on another way's asphalt (parallel to it and inside its
 * kerbs, for a wider way) or within SHADOW_DIST of a same-heading lane of a way as wide (listed earlier), that
 * direction of the way is a second drawing of the same road: vehicles on it would drive through the other way's.
 * It gets no lanes. `ways` must include `decide` and everything near it.
 */
export function shadowLanes(decide, ways = decide) {
  const lane = laneSamples(ways, (w) => (w.oneway ? [1] : [1, -1]).flatMap((dir) => w.offsets.map((off, li) => [dir, li, off])));
  const centre = laneSamples(ways, () => [[1, 0, 0]]);
  const nearLane = pointGrid(lane.X, lane.Z, 1);
  const nearCentre = pointGrid(centre.X, centre.Z, 4);
  const maxHalf = Math.max(0, ...ways.map((w) => w.line.width4 / STREET_Q / 2));
  const D2 = SHADOW_DIST * SHADOW_DIST;
  const deciding = new Set(decide);
  const dup = new Set();
  for (const l of lane.lanes) {
    const way = l.way;
    if (!deciding.has(way)) continue;
    let inside = 0;
    for (let a = l.from; a < l.to; a++) {
      const ax = lane.X[a], az = lane.Z[a], adx = lane.DX[a], adz = lane.DZ[a];
      const onWider = nearCentre(ax, az, maxHalf + 1, (b) => {
        const other = centre.lanes[centre.L[b]].way;
        if (other.line.width4 <= way.line.width4) return false;
        const bdx = centre.DX[b], bdz = centre.DZ[b];
        if (Math.abs(adx * bdx + adz * bdz) < 0.95) return false;
        const ex = ax - centre.X[b], ez = az - centre.Z[b];
        return Math.abs(ex * bdx + ez * bdz) <= 0.5 && Math.abs(ex * bdz - ez * bdx) < other.line.width4 / STREET_Q / 2 - KERB_INSET;
      });
      const besideTwin = onWider || nearLane(ax, az, 1, (b) => {
        const other = lane.lanes[lane.L[b]].way;
        if (other === way || other.line.width4 !== way.line.width4 || other.index > way.index) return false;
        if (adx * lane.DX[b] + adz * lane.DZ[b] < 0.95) return false;
        const ex = ax - lane.X[b], ez = az - lane.Z[b];
        return ex * ex + ez * ez < D2;
      });
      if (besideTwin) inside++;
    }
    if (inside && inside * 2 >= l.to - l.from) dup.add(`${way.index},${l.dir}`);
  }
  for (const way of decide) {
    const all = way.offsets.map((_, li) => li);
    way.drive = { 1: dup.has(`${way.index},1`) ? [] : all, [-1]: way.oneway || dup.has(`${way.index},-1`) ? [] : all };
  }
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
 * No three.js. Vehicles {way, s, dir, li (lane index), lane (offset), v} driving `net` within `radius` of the target, with
 * car-following per lane: each frame cars are bucketed by lane (way, direction, lane index) and sorted by progress,
 * so a car only looks at the car ahead of it, or, near its way's end, at the lane it will turn into. A car never
 * closes to less than `length + MIN_GAP` (centre to centre) on its leader, and enters a lane only when the entry is
 * clear; otherwise it waits at the stop line. → {cars, step(dt, target)}
 */
export function createFleetSim({ net, speed, every, max, radius, length, random }) {
  const cars = [];
  const lanes = new Map();
  const exitCache = new Map();
  /** Lane key → cars that picked it as car.next (stale entries are skipped by checking o.next). */
  const incoming = new Map();
  const SPACE = length + MIN_GAP;
  const HOLD = length + HOLD_MARGIN;
  /** Past its stop line: a vehicle this close to its way's end is in the junction. */
  const committed = (rem) => rem < HOLD - 0.05;
  let active = [];
  let centre = null;
  let frame = 0;

  const near = (way, x, z) => {
    const { xs, zs } = way.pl;
    for (let k = 0; k < xs.length; k++) if (Math.abs(xs[k] - x) < radius && Math.abs(zs[k] - z) < radius) return true;
    return false;
  };
  const inRange = (x, z) => Math.abs(x - centre.x) < radius * 1.15 && Math.abs(z - centre.z) < radius * 1.15;
  const keyOf = (way, dir, li) => (way.index * 2 + (dir > 0 ? 1 : 0)) * 16 + li;
  const listIn = (map, key) => {
    let b = map.get(key);
    if (!b) map.set(key, (b = []));
    return b;
  };
  const bucket = (key) => listIn(lanes, key);
  const remainingOf = (car) => (car.dir > 0 ? car.way.pl.total - car.s : car.s);

  /** Signed distance along travel from `s` to the nearest car in lane `key` at or ahead of the entry (Infinity if none),
   *  and whether the entry at `s` is clear: nobody within SPACE ahead or SPACE + HOLD behind. */
  function probe(key, s, dir, self) {
    let ahead = Infinity, clear = true;
    for (const o of lanes.get(key) ?? []) {
      if (o === self || o.key !== key) continue;
      const d = (o.s - s) * dir;
      if (d > -(SPACE + HOLD) && d < SPACE) clear = false;
      if (d >= 0 && d < ahead) ahead = d;
    }
    return { ahead, clear };
  }

  function place(car, way, s, dir, li) {
    car.way = way; car.s = s; car.dir = dir; car.li = li; car.lane = way.offsets[li];
    car.key = keyOf(way, dir, li);
    car.next = null; car.held = 0;
    bucket(car.key).push(car);
  }
  function spawn(car) {
    for (let tries = 0; tries < 8 && active.length; tries++) {
      const way = active[Math.floor(random() * active.length)];
      if (way.pl.total < 2 * SPACE + HOLD) continue;
      const s = SPACE + random() * (way.pl.total - 2 * SPACE);
      const dir = way.oneway || random() < 0.5 ? 1 : -1;
      const drive = way.drive[dir];
      if (!drive.length) continue;
      const li = drive[Math.floor(random() * drive.length)];
      if (!probe(keyOf(way, dir, li), s, dir, car).clear) continue;
      place(car, way, s, dir, li);
      car.v = speed; car.stuck = 0; car.y = null;
      return true;
    }
    car.way = null; car.key = -1;
    return false;
  }
  /** Lanes to carry on along at this car's way end: [{way, s, dir, li, key}], continuing ways first, else a U-turn. */
  function exits(car) {
    const { way, dir } = car;
    const ck = way.index * 2 + (dir > 0 ? 1 : 0);
    if (exitCache.has(ck)) return exitCache.get(ck);
    const k = dir > 0 ? way.pl.xs.length - 1 : 0;
    const out = [];
    exitCache.set(ck, out);
    const vertex = net.at.get(`${way.line.pts[k * 2]},${way.line.pts[k * 2 + 1]}`) ?? [];
    ensureDrive(net, vertex.map((o) => o.way));
    const add = (w, s, d) => { for (const li of w.drive[d]) out.push({ way: w, s, dir: d, li, key: keyOf(w, d, li) }); };
    for (const o of vertex) {
      if (o.way === way) continue;
      if (o.k < o.way.pl.xs.length - 1) add(o.way, o.way.pl.cum[o.k], 1);
      if (o.k > 0 && !o.way.oneway) add(o.way, o.way.pl.cum[o.k], -1);
    }
    if (!out.length && !way.oneway) add(way, dir > 0 ? way.pl.total : 0, -dir);
    const leaving = [...out];
    if (out.length && !way.oneway) for (const li of way.drive[-dir]) leaving.push({ way, s: dir > 0 ? way.pl.total : 0, dir: -dir, li, key: keyOf(way, -dir, li) });
    out.leaving = leaving;
    return out;
  }
  /** A lane entry with nobody ahead in the lane: when its run to the way's end is shorter than `budget`, the gap to
   *  the nearest vehicle just past that end on any lane leaving it, or waiting in that junction (Infinity if none).
   *  Short ways (OSM splits streets every few metres at junctions and bridges) would otherwise hide a queue. */
  function beyond(n, self, budget, depth) {
    const run = n.dir > 0 ? n.way.pl.total - n.s : n.s;
    if (run >= budget || depth === 0) return Infinity;
    let best = Infinity;
    for (const e of exits({ way: n.way, dir: n.dir }).leaving) {
      let near = Infinity;
      for (const o of lanes.get(e.key) ?? []) {
        if (o === self || o.key !== e.key) continue;
        const d = (o.s - e.s) * e.dir;
        if (d > -length * 0.5) near = Math.min(near, Math.max(0, d));
      }
      for (const o of incoming.get(e.key) ?? []) {
        if (o !== self && o.next?.key === e.key && committed(remainingOf(o))) near = 0;
      }
      if (near === Infinity) near = beyond(e, self, budget - run, depth - 1);
      best = Math.min(best, run + near);
    }
    return best;
  }
  /** May this car cross its way's end into car.next now? The next lane's entry must be clear, and no other vehicle
   *  may be in the junction: within a car length past the vertex on any other lane leaving it. `ahead` is the gap
   *  from the entry to the next car in that lane, counting cars still on other ways that are nearer their own entry
   *  into it (merging traffic goes in arrival order) at their distance short of it. */
  function free(car) {
    const n = car.next;
    let { ahead, clear } = probe(n.key, n.s, n.dir, car);
    if (ahead === Infinity) ahead = beyond(n, car, LOOK, 2);
    const mine = remainingOf(car);
    for (const o of incoming.get(n.key) ?? []) {
      if (o === car || o.next?.key !== n.key) continue;
      const rem = remainingOf(o);
      if (rem > mine || (rem === mine && o.id > car.id)) continue;
      ahead = Math.min(ahead, (o.next.s - o.next.dir * rem - n.s) * n.dir);
    }
    if (!clear) return { ahead, ok: false };
    const inJunction = committed(mine);
    for (const e of exits(car).leaving) {
      if (e.key === n.key) continue;
      for (const o of lanes.get(e.key) ?? []) {
        if (o === car || o.key !== e.key) continue;
        const d = (o.s - e.s) * e.dir;
        if (d > -length * 0.5 && d < length) return { ahead, ok: false };
      }
      for (const o of incoming.get(e.key) ?? []) {
        if (o === car || o.next?.key !== e.key || !committed(remainingOf(o))) continue;
        if (!inJunction || o.id < car.id) return { ahead, ok: false };
      }
    }
    return { ahead, ok: true };
  }
  /** Pick the lane to turn into, preferring one whose entry is clear now. false at a dead end. */
  function choose(car) {
    const opts = exits(car);
    if (!opts.length) return false;
    const clear = opts.filter((o) => probe(o.key, o.s, o.dir, car).clear);
    const pool = clear.length ? clear : opts;
    car.next = pool[Math.floor(random() * pool.length)];
    car.held = 0;
    listIn(incoming, car.next.key).push(car);
    return true;
  }

  function index() {
    for (const b of lanes.values()) b.length = 0;
    for (const b of incoming.values()) b.length = 0;
    for (const car of cars) {
      if (!car.way) continue;
      bucket(car.key).push(car);
      if (car.next) listIn(incoming, car.next.key).push(car);
    }
  }

  function rebuild(target) {
    centre = { x: target.x, z: target.z };
    lanes.clear();
    incoming.clear();
    active = net.ways.filter((w) => near(w, centre.x, centre.z));
    ensureDrive(net, active);
    const activeLen = active.reduce((n, w) => n + w.pl.total * (w.oneway ? 1 : 2), 0);
    const want = Math.min(max, Math.round(activeLen / every));
    cars.length = Math.min(cars.length, want);
    index();
    for (const car of cars) {
      if (!car.way) { spawn(car); continue; }
      const p = pointOn(car.way.pl, car.s);
      if (!inRange(p.x, p.z)) spawn(car);
    }
    while (cars.length < want) {
      const car = { id: cars.length, way: null, key: -1, s: 0, dir: 1, li: 0, lane: 0, v: speed, next: null, held: 0, stuck: 0, y: null, pitch: 0, moved: -1, color: Math.floor(random() * 1e6) };
      cars.push(car);
      spawn(car);
    }
  }

  /** How far this car may move along its lane (blocks), given its leader `lead` (already moved this frame) or the lane ahead. */
  function room(car, lead, dt) {
    const remaining = car.dir > 0 ? car.way.pl.total - car.s : car.s;
    if (remaining < LOOK && !car.next) choose(car);
    else if (car.next && car.held > REPICK) choose(car);
    let r = lead ? (lead.s - car.s) * car.dir - SPACE : Infinity;
    if (car.next && remaining < LOOK) {
      const { ahead, ok } = free(car);
      r = Math.min(r, ok ? remaining + ahead - SPACE : Math.max(0, remaining - HOLD));
      car.held = ok ? 0 : car.held + dt;
    }
    return Math.max(0, r);
  }

  function advance(car, lead, dt) {
    const r = room(car, lead, dt);
    car.v = Math.min(speed, car.v + ACCEL * dt, r / HEADWAY);
    const move = Math.min(car.v * dt, r);
    const queued = lead !== null && (lead.s - car.s) * car.dir - SPACE <= r + 1e-6;
    car.stuck = move < 1e-4 && !queued ? car.stuck + dt : 0;
    if (car.stuck > STUCK) { spawn(car); return; }
    car.s += car.dir * move;
    const over = car.s < 0 ? -car.s : car.s - car.way.pl.total;
    if (over <= 0) return;
    if (!car.next) { spawn(car); return; }
    const n = car.next;
    const f = free(car);
    if (!f.ok || f.ahead < SPACE) { car.s = car.dir > 0 ? car.way.pl.total : 0; car.v = 0; return; }
    car.key = -1;
    place(car, n.way, n.s + n.dir * over, n.dir, n.li);
  }

  function step(dt, target) {
    if (!centre || Math.hypot(target.x - centre.x, target.z - centre.z) > REBUILD_MOVE) rebuild(target);
    frame++;
    index();
    const order = [];
    for (const b of lanes.values()) {
      if (!b.length) continue;
      b.sort((a, c) => (c.s - a.s) * c.dir);
      order.push(b.slice());
    }
    for (const b of order) {
      const key = b[0].key;
      let lead = null;
      for (const car of b) {
        if (car.moved === frame || car.key !== key) continue;
        car.moved = frame;
        advance(car, lead, dt);
        if (!car.way) continue;
        const p = pointOn(car.way.pl, car.s);
        if (!inRange(p.x, p.z)) spawn(car);
        if (car.key === key) lead = car;
      }
    }
  }
  return { cars, step };
}

/**
 * One fleet drawn as an InstancedMesh: createFleetSim plus terrain-following height and pitch per car.
 * → {update(dt, target), count}
 */
function createFleet({ mesh, streetY, length, colors, ...sim }) {
  const { THREE } = mesh.userData;
  const fleet = createFleetSim({ ...sim, length });
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, "YXZ"), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  const c = new THREE.Color();

  function update(dt, target) {
    fleet.step(dt, target);
    let n = 0;
    for (const car of fleet.cars) {
      if (!car.way) continue;
      const p = pointOn(car.way.pl, car.s);
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
