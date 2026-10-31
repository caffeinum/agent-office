// W4 picking checks (spec §5 W4, spec-v2 §8 W4): voxel DDA over the decoded fixture store; v2: per-column top,
// parent resolution (stands → ballpark, ferry tower + shed → one parent), props pick as their building, unbuilt land.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  CAP, CHUNK, COLUMNS, FACADE, SURFACE, chunkKey, chunkOf, decodeChunk, decodeLandmask, pickId, validateChunk, validateCompanies, validateManifest,
} from "../../../public/shared/city.js";
import { createUnmapped } from "../../../public/js/city/unmapped.js";
import { pickRay } from "../../../public/js/city/pick.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../../../public/city/fixture");
let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`✗ ${name}\n  ${e.stack}`); process.exitCode = 1; }
};

const manifest = validateManifest(JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8")));
const companies = validateCompanies(JSON.parse(readFileSync(join(FIXTURE, "companies.json"), "utf8")), manifest);
const chunks = new Map();
for (const [cx, cz] of manifest.chunks.list) {
  chunks.set(chunkKey(cx, cz), decodeChunk(new Uint8Array(gunzipSync(readFileSync(join(FIXTURE, "chunks", `${chunkKey(cx, cz)}.bin`)))), manifest.parents));
}
const store = { get: (cx, cz) => chunks.get(chunkKey(cx, cz)) };
const column = (x, z) => {
  const [cx, cz] = chunkOf(x, z);
  const c = store.get(cx, cz);
  const k = (z - cz * CHUNK) * CHUNK + (x - cx * CHUNK);
  return { c, k, b: c.bldg[k] ? c.buildings[c.bldg[k] - 1] : null };
};
const DOWN = { x: 0, y: -1, z: 0 };

test("straight down onto a tower returns its buildingId at the roof", () => {
  const site = companies.sites.find((s) => s.id === "fixture-labs");
  const { b } = column(site.block.x, site.block.z);
  const hit = pickRay(store, { x: site.block.x + 0.5, y: 500, z: site.block.z + 0.5 }, DOWN, 1000);
  assert.equal(hit.kind, "building");
  assert.equal(hit.buildingId, site.buildingId);
  assert.equal(hit.buildingId, b.id);
  assert.equal(hit.y, b.top);
  assert.deepEqual([hit.x, hit.z], [site.block.x, site.block.z]);
  assert.deepEqual([hit.cx, hit.cz], site.chunk);
});

test("a ray over water returns water", () => {
  const x = 56 * CHUNK + 240, z = 24 * CHUNK + 20;
  const { c, k } = column(x, z);
  assert.equal(c.ground[k], 0, "fixture column is water");
  const hit = pickRay(store, { x: x + 0.5, y: 200, z: z + 0.5 }, { x: 0.3, y: -1, z: 0.2 }, 1000);
  assert.equal(hit.kind, "water");
  assert.equal(hit.y, 0);
  assert.ok(hit.surface === SURFACE.WATER || hit.surface === SURFACE.SHALLOW);
});

test("unlisted chunk 59,27 (open water) picks as water", () => {
  assert.equal(store.get(59, 27), undefined);
  const hit = pickRay(store, { x: 59 * CHUNK + 30.5, y: 50, z: 27 * CHUNK + 30.5 }, DOWN, 100);
  assert.deepEqual([hit.kind, hit.cx, hit.cz, hit.surface], ["water", 59, 27, SURFACE.WATER]);
});

test("a horizontal ray hits the tower's wall, not the ground beyond", () => {
  const site = companies.sites.find((s) => s.id === "example-robotics");
  const { b } = column(site.block.x, site.block.z);
  const y = (b.base + b.top) / 2;
  const hit = pickRay(store, { x: site.block.x + 0.5, y, z: site.block.z - 20.5 }, { x: 0, y: 0, z: 1 }, 100);
  assert.equal(hit.kind, "building");
  assert.equal(hit.buildingId, b.id);
  assert.equal(hit.point.y, y);
  assert.ok(hit.dist > 0 && hit.dist < 21);
});

test("oblique rays agree with the column they report", () => {
  let n = 0;
  for (let a = 0; a < 60; a++) {
    const ang = (a / 60) * Math.PI * 2;
    const o = { x: 57 * CHUNK + 40.3, y: 60, z: 25 * CHUNK + 30.7 };
    const hit = pickRay(store, o, { x: Math.cos(ang), y: -0.6, z: Math.sin(ang) }, 2000);
    assert.ok(hit, `ray ${a} missed`);
    if (!store.get(hit.cx, hit.cz)) {
      assert.equal(hit.kind, "water", "outside the listed chunks is open water");
      continue;
    }
    const { c, k, b } = column(hit.x, hit.z);
    n++;
    if (hit.kind === "building") assert.deepEqual([hit.buildingId, hit.entryId], [pickId(b), b.id]);
    if (hit.kind === "water") assert.equal(c.ground[k], 0);
    if (hit.kind === "ground") assert.ok(c.ground[k] >= 1 && hit.point.y <= c.ground[k] + 1e-9);
    assert.ok(hit.point.x >= hit.x - 1e-9 && hit.point.x <= hit.x + 1 + 1e-9);
    assert.ok(hit.point.z >= hit.z - 1e-9 && hit.point.z <= hit.z + 1 + 1e-9);
  }
  assert.ok(n > 20, `only ${n} rays landed inside the fixture`);
});

test("decks: slab and pillar pick as deck; a ray under a positive deck reaches the ground", () => {
  const c = validateChunk({
    cx: 0, cz: 0, frame: 0, ground: new Int16Array(COLUMNS).fill(2), surface: new Uint8Array(COLUMNS).fill(SURFACE.ROAD),
    bldg: new Uint16Array(COLUMNS), deck: new Int16Array(COLUMNS), top: new Int16Array(COLUMNS), buildings: [], props: [],
  });
  c.deck[10 * CHUNK + 10] = 8;
  c.deck[10 * CHUNK + 11] = -8;
  const s = { get: (cx, cz) => (cx === 0 && cz === 0 ? c : undefined) };
  const top = pickRay(s, { x: 10.5, y: 50, z: 10.5 }, DOWN, 100);
  assert.deepEqual([top.kind, top.y], ["deck", 8]);
  const under = pickRay(s, { x: 0.5, y: 4, z: 10.5 }, { x: 1, y: 0, z: 0 }, 30);
  assert.deepEqual([under.kind, under.x], ["deck", 11], "passes under the slab at x=10, hits the pillar at x=11");
  const ground = pickRay(s, { x: 10.5, y: 5, z: 10.5 }, DOWN, 30);
  assert.deepEqual([ground.kind, ground.y], ["ground", 2]);
});

/** World column of the first column in chunk (cx, cz) whose entry satisfies `want`. */
function columnOf(cx, cz, want) {
  const c = store.get(cx, cz);
  for (let k = 0; k < COLUMNS; k++) {
    if (c.bldg[k] && want(c.buildings[c.bldg[k] - 1], k, c)) return { x: cx * CHUNK + (k % CHUNK), z: cz * CHUNK + Math.floor(k / CHUNK), c, k, B: c.buildings[c.bldg[k] - 1] };
  }
  throw new Error(`no matching column in ${cx},${cz}`);
}
const down = (x, z, y = 500) => pickRay(store, { x: x + 0.5, y, z: z + 0.5 }, DOWN, 1000);

test("a stand column picks as the ballpark parent, at its own column top", () => {
  const { x, z, c, k, B } = columnOf(56, 27, (b) => b.cap === CAP.SEATS);
  const hit = down(x, z);
  assert.deepEqual([hit.kind, hit.buildingId, hit.entryId], ["building", 1002, B.id]);
  assert.equal(hit.y, c.top[k]);
  assert.equal(manifest.parents[hit.buildingId], "Fixture Park");
  const board = columnOf(56, 27, (b) => b.facade === FACADE.BLANK);
  assert.equal(down(board.x, board.z).buildingId, 1002, "the scoreboard is the same ballpark");
});

test("the ferry clock tower and the shed resolve to the same parent", () => {
  const tower = columnOf(58, 25, (b) => b.cap === CAP.DOME);
  const shed = columnOf(58, 25, (b) => b.facade === FACADE.ARCADE);
  const a = down(tower.x, tower.z), b = down(shed.x, shed.z);
  assert.notEqual(a.entryId, b.entryId);
  assert.equal(a.buildingId, 1001);
  assert.equal(b.buildingId, 1001);
  assert.equal(a.y, tower.c.top[tower.k]);
});

test("a prop picks as the building it stands on (spire on the taper, light tower on the stands)", () => {
  const spireChunk = store.get(58, 25);
  const [spire] = spireChunk.props;
  const sx = 58 * CHUNK + spire.lx, sz = 25 * CHUNK + spire.lz;
  const onTop = down(sx, sz, spire.y1 + 50);
  assert.equal(onTop.y, spire.y1, "the ray stops on the spire top");
  const B = spireChunk.buildings[spireChunk.bldg[spire.lz * CHUNK + spire.lx] - 1];
  assert.deepEqual([onTop.kind, onTop.buildingId], ["building", B.id]);
  const side = pickRay(store, { x: sx + 0.5, y: (spire.y0 + spire.y1) / 2, z: sz - 10.5 }, { x: 0, y: 0, z: 1 }, 50);
  assert.deepEqual([side.kind, side.buildingId, side.x, side.z], ["building", B.id, sx, sz], "a horizontal ray hits the spire");
  const lights = store.get(56, 27).props.filter((p) => p.flags === 1);
  assert.equal(lights.length, 6);
  for (const p of lights) {
    const hit = down(56 * CHUNK + p.lx, 27 * CHUNK + p.lz, p.y1 + 20);
    assert.deepEqual([hit.y, hit.buildingId], [p.y1, 1002]);
  }
});

test("the taper picks at each column's own top, not the entry max", () => {
  const ring = columnOf(58, 25, (b, k, c) => b.top === 81 && c.top[k] < b.top);
  const hit = down(ring.x, ring.z);
  assert.equal(hit.y, ring.c.top[ring.k]);
  assert.ok(hit.y < ring.B.top);
});

test("unbuilt land picks as unbuilt at its coarse height; sea stays water", () => {
  const mask = decodeLandmask(new Uint8Array(gunzipSync(readFileSync(join(FIXTURE, manifest.landmask)))), manifest.chunks.grid);
  const u = createUnmapped(manifest, mask);
  const hit = pickRay(store, { x: 55 * CHUNK + 20.5, y: 80, z: 25 * CHUNK + 20.5 }, DOWN, 200, { unbuiltAt: u.heightAt });
  assert.deepEqual([hit.kind, hit.y, hit.cx], ["unbuilt", 2, 55]);
  const sea = pickRay(store, { x: 60 * CHUNK + 20.5, y: 80, z: 25 * CHUNK + 20.5 }, DOWN, 200, { unbuiltAt: u.heightAt });
  assert.equal(sea.kind, "water");
  assert.throws(() => pickRay(store, { x: 0, y: 0, z: 0 }, DOWN, 10, { unbuiltAt: 3 }), /unbuiltAt must be a function/);
});

test("misses and bad input", () => {
  assert.equal(pickRay(store, { x: 3600, y: 200, z: 1600 }, { x: 0, y: 1, z: 0 }, 500), null);
  assert.equal(pickRay(store, { x: 3600, y: 200, z: 1600 }, DOWN, 50), null, "maxDist stops before the ground");
  assert.throws(() => pickRay(store, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 10), /zero direction/);
  assert.throws(() => pickRay(store, { x: NaN, y: 0, z: 0 }, DOWN, 10), /bad vector/);
  assert.throws(() => pickRay({}, { x: 0, y: 0, z: 0 }, DOWN, 10), /store.get/);
});

console.log(`pick.check: ${passed} passed`);
