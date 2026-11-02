// Traffic spacing: cars must never sit on top of each other in a lane. Steps the public createTraffic for a fixed
// number of seconds (fixed dt, fixed seed) on a synthetic street grid built to force merges, and on the committed SF
// street.bin, then measures the drawn instances: two cars heading the same way, side by side within a lane's width,
// closer than a car length (centre to centre) are overlapping. Also checks the per-lane order inside createFleetSim.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import * as THREE from "../../../public/vendor/three-0.186.1/three.module.js";
import { ROAD_FLAG, STREET_LINE, STREET_Q, decodeStreet } from "../../../public/shared/city.js";
import { CAR_BOXES } from "../../../public/js/city/streetkit.js";
import { MIN_GAP, buildNetwork, createFleetSim, createTraffic, laneOffsets } from "../../../public/js/city/traffic.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const CAR_LENGTH = Math.max(...CAR_BOXES.map((b) => b.d));
const CAR_WIDTH = Math.max(...CAR_BOXES.map((b) => b.w));
/** Cars in one lane head the same way (within ~8 degrees); merging and crossing traffic at junctions is not a lane. */
const SAME_HEADING = 0.99;
let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`✗ ${name}\n  ${e.stack}`); process.exitCode = 1; }
};

/** A dense grid of two-way and one-way streets (blocks): every crossing is a merge point. */
function gridStreet(n = 9, step = 24) {
  const road = (flags, lanes, pts) => ({ kind: STREET_LINE.ROAD, flags, width4: 6 * STREET_Q, lanes, pts: Int16Array.from(pts.map((v) => v * STREET_Q)) });
  const lines = [];
  for (let i = 0; i < n; i++) {
    const a = i * step;
    for (let j = 0; j + 1 < n; j++) {
      lines.push(road(i % 3 === 1 ? ROAD_FLAG.ONEWAY : 0, 2, [j * step, a, (j + 1) * step, a]));
      lines.push(road(0, 2, [a, j * step, a, (j + 1) * step]));
    }
  }
  return { lines, points: [] };
}

function sfStreet() {
  const manifest = JSON.parse(readFileSync(join(ROOT, "public/city/sf/manifest.json"), "utf8"));
  return decodeStreet(new Uint8Array(gunzipSync(readFileSync(join(ROOT, "public/city/sf/street.bin")))), manifest.chunks.grid);
}

/** Step createTraffic `seconds` at 60 fps around `target`; every half second, count same-lane overlapping car pairs
 *  from the drawn instance matrices (grid-bucketed, not all-pairs). → {overlaps, samples, cars} */
function simulate(street, target, seconds) {
  const scene = { add() {}, remove() {} };
  const traffic = createTraffic({ THREE, scene, street, streetY: () => 0, seed: 7 });
  const mesh = traffic.meshes[0];
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), f = new THREE.Vector3();
  let overlaps = 0, samples = 0, cars = 0;
  const worst = [];
  for (let frame = 1; frame <= seconds * 60; frame++) {
    traffic.update(1 / 60, target, 100);
    if (frame % 30) continue;
    samples++;
    cars = mesh.count;
    const cells = new Map();
    const at = [];
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      m.decompose(p, q, s);
      f.set(0, 0, 1).applyQuaternion(q);
      const c = { x: p.x, z: p.z, fx: f.x, fz: f.z };
      at.push(c);
      const key = `${Math.floor(c.x / 4)},${Math.floor(c.z / 4)}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(c);
    }
    for (const a of at) {
      const cx = Math.floor(a.x / 4), cz = Math.floor(a.z / 4);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        for (const b of cells.get(`${cx + dx},${cz + dz}`) ?? []) {
          if (b === a || a.fx * b.fx + a.fz * b.fz < SAME_HEADING) continue;
          const rx = b.x - a.x, rz = b.z - a.z;
          const along = rx * a.fx + rz * a.fz, side = Math.abs(rx * a.fz - rz * a.fx);
          if (along >= 0 && along < CAR_LENGTH && side < CAR_WIDTH) { overlaps++; if (worst.length < 3) worst.push({ a, b, along, side }); }
        }
      }
    }
  }
  return { overlaps, samples, cars, worst };
}

test("traffic: synthetic grid, 60 s: no two cars overlap in a lane", () => {
  const r = simulate(gridStreet(), { x: 96, z: 96 }, 60);
  assert.ok(r.cars > 40, `expected a dense grid, got ${r.cars} cars`);
  assert.equal(r.overlaps, 0, `${r.overlaps} same-lane overlaps over ${r.samples} samples of ${r.cars} cars: ${JSON.stringify(r.worst)}`);
});

test("traffic: SF street.bin downtown, 60 s: no two cars overlap in a lane", () => {
  const r = simulate(sfStreet(), { x: 4083, z: 3631 }, 60);
  assert.ok(r.cars > 200, `expected downtown traffic, got ${r.cars} cars`);
  assert.equal(r.overlaps, 0, `${r.overlaps} same-lane overlaps over ${r.samples} samples of ${r.cars} cars: ${JSON.stringify(r.worst)}`);
});

test("traffic: createFleetSim keeps every lane ordered at least a car length + MIN_GAP apart, and cars keep moving", () => {
  const net = buildNetwork(gridStreet().lines, (l) => l.kind === STREET_LINE.ROAD, laneOffsets);
  let seed = 3;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const length = CAR_LENGTH;
  const sim = createFleetSim({ net, speed: 3.6, every: 6, max: 400, radius: 150, length, random });
  const start = new Map();
  let worst = Infinity;
  for (let frame = 1; frame <= 90 * 60; frame++) {
    sim.step(1 / 60, { x: 96, z: 96 });
    if (frame === 60 * 30) for (const c of sim.cars) start.set(c, { way: c.way, s: c.s });
    if (frame % 15) continue;
    const lanes = new Map();
    for (const c of sim.cars) {
      if (!c.way) continue;
      const k = `${c.way.index},${c.dir},${c.li}`;
      if (!lanes.has(k)) lanes.set(k, []);
      lanes.get(k).push(c.s);
    }
    for (const ss of lanes.values()) {
      ss.sort((a, b) => a - b);
      for (let i = 1; i < ss.length; i++) worst = Math.min(worst, ss[i] - ss[i - 1]);
    }
  }
  assert.ok(sim.cars.length > 100, `dense: ${sim.cars.length} cars`);
  assert.ok(worst >= length + MIN_GAP - 1e-6, `closest same-lane pair ${worst.toFixed(3)} < ${(length + MIN_GAP).toFixed(3)}`);
  const moved = sim.cars.filter((c) => { const a = start.get(c); return a && (a.way !== c.way || Math.abs(a.s - c.s) > 1); }).length;
  assert.ok(moved > sim.cars.length * 0.8, `only ${moved} of ${sim.cars.length} cars moved in the last minute (gridlock)`);
});

console.log(`traffic: ${passed} passed`);
