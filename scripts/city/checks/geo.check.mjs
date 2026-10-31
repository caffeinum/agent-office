// W2 geometry checks: point-in-polygon, scanline, line stamping, ring assembly, coastline closing.
import assert from "node:assert/strict";
import {
  assembleRings, pointInPolygon, polygonArea, ringArea, ringCentroid, ringsToPolygons, scanPolygon, stampLine,
} from "../lib/geo.mjs";
import { buildWaterMask, closeCoastline } from "../lib/mask.mjs";
import { createRaster } from "../lib/raster.mjs";

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`✗ ${name}\n  ${e.stack}`); process.exitCode = 1; }
};
const cols = (fn) => {
  const out = [];
  fn((x, z) => out.push(`${x},${z}`));
  return out.sort();
};
const square = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]];

test("pointInPolygon: inside, outside, inside a hole", () => {
  const poly = [square(0, 0, 10, 10), square(4, 4, 6, 6)];
  assert.equal(pointInPolygon(1, 1, poly), true);
  assert.equal(pointInPolygon(11, 1, poly), false);
  assert.equal(pointInPolygon(5, 5, poly), false);
});

test("scanPolygon visits exactly the columns whose centres are inside", () => {
  assert.equal(cols((v) => scanPolygon([square(0, 0, 4, 3)], v)).length, 12);
  assert.equal(cols((v) => scanPolygon([square(0, 0, 10, 10), square(4, 4, 6, 6)], v)).length, 96);
  // centre (0.5, 0.5) sits outside a 0.4-block square: nothing is visited
  assert.equal(cols((v) => scanPolygon([square(0, 0, 0.4, 0.4)], v)).length, 0);
  // a triangle: half of a 4×4 square, centres strictly below the diagonal
  assert.equal(cols((v) => scanPolygon([[[0, 0], [4, 0], [0, 4]]], v)).length, 6);
});

test("stampLine: a 4-wide horizontal road covers 4 rows, each column once", () => {
  const out = cols((v) => stampLine([[0, 10], [20, 10]], 4, v));
  assert.equal(new Set(out).size, out.length);
  const rows = new Set(out.map((k) => k.split(",")[1]));
  assert.deepEqual([...rows].sort(), ["10", "11", "8", "9"]);
  assert.throws(() => stampLine([[0, 0], [1, 1]], 0, () => {}), /width/);
});

test("ringArea is signed, ringCentroid is the area centroid", () => {
  assert.equal(Math.abs(ringArea(square(0, 0, 4, 2))), 8);
  assert.equal(ringArea(square(0, 0, 4, 2)), -ringArea(square(0, 0, 4, 2).slice().reverse()));
  assert.deepEqual(ringCentroid(square(2, 2, 6, 4)), [4, 3]);
  assert.equal(polygonArea([square(0, 0, 10, 10), square(4, 4, 6, 6)]), 96);
});

test("assembleRings: two-way outer", () => {
  const r = assembleRings([
    { id: 1, role: "outer", geometry: [[0, 0], [10, 0], [10, 10]] },
    { id: 2, role: "outer", geometry: [[10, 10], [0, 10], [0, 0]] },
  ]);
  assert.equal(r.outers.length, 1);
  assert.equal(r.inners.length, 0);
  assert.equal(r.unclosable.length, 0);
  assert.equal(Math.abs(ringArea(r.outers[0])), 100);
});

test("assembleRings: outer with an inner hole", () => {
  const r = assembleRings([
    { id: 1, role: "outer", geometry: square(0, 0, 10, 10) },
    { id: 2, role: "inner", geometry: square(4, 4, 6, 6) },
  ]);
  assert.equal(r.outers.length, 1);
  assert.equal(r.inners.length, 1);
  const polys = ringsToPolygons(r.outers, r.inners);
  assert.equal(polys.length, 1);
  assert.equal(polys[0].length, 2);
  assert.equal(pointInPolygon(5, 5, polys[0]), false);
  assert.equal(polygonArea(polys[0]), 96);
});

test("assembleRings: reversed member", () => {
  const r = assembleRings([
    { id: 1, role: "outer", geometry: [[0, 0], [10, 0], [10, 10]] },
    { id: 2, role: "outer", geometry: [[0, 0], [0, 10]] },
    { id: 3, role: "outer", geometry: [[10, 10], [0, 10]] },
  ]);
  assert.equal(r.outers.length, 1);
  assert.equal(r.unclosable.length, 0);
  assert.equal(Math.abs(ringArea(r.outers[0])), 100);
});

test("assembleRings: unclosable ring is reported, closed ones still come out", () => {
  const r = assembleRings([
    { id: 1, role: "outer", geometry: [[0, 0], [10, 0], [10, 10]] },
    { id: 2, role: "outer", geometry: [[10, 10], [0, 10]] },
    { id: 3, role: "outer", geometry: square(20, 20, 30, 30) },
  ]);
  assert.equal(r.outers.length, 1);
  assert.deepEqual(r.unclosable, [{ role: "outer", ids: [1, 2] }]);
});

test("buildWaterMask: columns inside land polygons are land, the rest water", () => {
  const raster = createRaster([0, 0], [0, 0]);
  const water = buildWaterMask(raster, [[square(0, 0, 32, 64)]]);
  assert.equal(water[0], 0);
  assert.equal(water[31], 0);
  assert.equal(water[32], 1);
  assert.equal(water.reduce((s, v) => s + v, 0), 32 * 64);
  assert.throws(() => buildWaterMask(raster, []), /no land/);
});

test("closeCoastline: open coastline closed along the bbox with the sea on its right", () => {
  // coast runs north along x = 5 (z decreasing); travelling north, the right side (east) is sea, land is west
  const box = { minX: 0, minZ: 0, maxX: 10, maxZ: 10 };
  const polys = closeCoastline([{ id: 1, geometry: [[5, 12], [5, 5]] }, { id: 2, geometry: [[5, 5], [5, -2]] }], box);
  assert.equal(polys.length, 1);
  assert.equal(pointInPolygon(2, 5, polys[0]), true);
  assert.equal(pointInPolygon(8, 5, polys[0]), false);
  assert.equal(Math.round(polygonArea(polys[0])), 50);
  // reversed direction flips land and sea
  const flipped = closeCoastline([{ id: 1, geometry: [[5, -2], [5, 12]] }], box);
  assert.equal(pointInPolygon(8, 5, flipped[0]), true);
  assert.equal(pointInPolygon(2, 5, flipped[0]), false);
  // a closed island inside the box passes through
  const island = closeCoastline([{ id: 3, geometry: [[2, 2], [2, 4], [4, 4], [4, 2], [2, 2]] }], box);
  assert.equal(island.length, 1);
  assert.throws(() => closeCoastline([{ id: 4, geometry: [[20, 20], [30, 30]] }], box), /no coastline/);
});

console.log(`geo.check: ${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
