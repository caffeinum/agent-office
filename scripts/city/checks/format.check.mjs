// W1 contract checks (spec-v2 §1, §4, §8 W1): projection (option a), chunk v2 encode/decode, landmarks / landmask /
// walk formats, validators (one rejected mutation per rule), palette, raster API, build ctx, hook stubs and the
// committed v2 fixture.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { join } from "node:path";
import {
  ACCENT_NONE, CAP, CHUNK, CITY_VERSION, COLUMNS, FACADE, PALETTE_GROUPS, PALETTE_INDEX, ROT_DEG, SF_BOX, SF_GRID, SF_MARGIN,
  SF_PIVOT, SF_PROJ, STRUCTURE_KINDS, SURFACE, SURFACE_COLORS, TERRAIN_SIDE_COLORS, BUILDING_PALETTE, WALK_NO_NAME,
  assertGzip, blockToLonLat, chunkByteLength, chunkKey, chunkOf, decodeChunk, decodeLandmarks, decodeLandmask, decodeWalk,
  edgeHalfWidth10, edgeIsDeck, encodeChunk, encodeLandmarks, encodeLandmask, encodeWalk, fitProjection, hashId, isGzip,
  landmaskHeight, lonLatToBlock, osmColourToHex, osmMaterial, packEdgeWidth, paletteFor, pickId, regionOf, validateChunk,
  validateCompanies, validateLandmarks, validateManifest, validatePlaces, validateWalk,
} from "../../../public/shared/city.js";
import { FIXTURE_DIR, FIXTURE_GRID, FIXTURE_PARENTS, generateFixture } from "../fixture.mjs";
import { createRaster, rasterToChunks } from "../lib/raster.mjs";
import { TOPDOWN_SURFACE } from "../lib/topdown.mjs";
import { createBuildCtx } from "../lib/ctx.mjs";
import { applyStructures, structureKind } from "../lib/structures.mjs";
import { applyLandmarks } from "../lib/landmarks.mjs";
import { buildLandmarkMesh } from "../lib/meshlayer.mjs";
import { buildWalk } from "../lib/walk.mjs";

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`✗ ${name}\n  ${e.stack}`); process.exitCode = 1; }
};

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
const V1_BASE = { lon0: -122.52, lat0: 37.835, latRef: 37.77, mPerDegLat: 110574, mPerDegLon: 87995.8 };

// ---------- projection ----------

test("projection: SF_PROJ and SF_GRID are fitProjection(option a) exactly", () => {
  assert.equal(ROT_DEG, 44.7);
  const { proj, grid } = fitProjection(V1_BASE, ROT_DEG, SF_PIVOT, SF_BOX, SF_MARGIN);
  assert.deepEqual(proj, { ...SF_PROJ });
  assert.deepEqual(grid, [...SF_GRID]);
  assert.deepEqual([SF_PROJ.x0, SF_PROJ.z0, ...SF_GRID], [3456, 3712, 112, 112]);
  assert.ok(Math.abs(SF_PROJ.pivotX - 2390.6) < 0.1 && Math.abs(SF_PROJ.pivotZ - 2340.5) < 0.1, "pivot = v1 equirect of the city centre");
  assert.ok(Math.abs(SF_PROJ.mPerDegLon - 111320 * Math.cos((SF_PROJ.latRef * Math.PI) / 180)) < 0.1);
  // the review's provisional grids (spec-v2 §1.1): d 89×93, a 112×112
  assert.deepEqual(fitProjection(V1_BASE, 9.2, SF_PIVOT, SF_BOX, SF_MARGIN).grid, [89, 93]);
});

test("projection: the full-city box plus a 64-block margin lies inside the reserved grid", () => {
  for (const lon of [SF_BOX.west, SF_BOX.east]) for (const lat of [SF_BOX.south, SF_BOX.north]) {
    const p = lonLatToBlock(lon, lat);
    assert.ok(p.x >= SF_MARGIN && p.z >= SF_MARGIN, `${lon},${lat} → ${p.x},${p.z}`);
    assert.ok(p.x <= SF_GRID[0] * CHUNK - SF_MARGIN && p.z <= SF_GRID[1] * CHUNK - SF_MARGIN, `${lon},${lat} → ${p.x},${p.z}`);
  }
});

// Frozen anchor table, option a (spec-v2 §1.1). Sources: v1 anchor table points; Firegoat = SF EAS 366241,
// 501 2nd St (data/city/sf/raw/eas/firegoat-501-2nd.json); Fort Point = en.wikipedia.org/wiki/Fort_Point,_San_Francisco
// (37°48′38″N 122°28′38″W).
const ANCHORS = [
  ["Salesforce Tower", 37.7897744, -122.3969321, 4796.4, 4090.9, [74, 63]],
  ["Ferry Building", 37.7955, -122.3937, 5012.3, 4007.5, [78, 62]],
  ["Transamerica", 37.7952, -122.4028, 4814.8, 3827.7, [75, 59]],
  ["Grace Cathedral", 37.7919, -122.4134, 4508.2, 3695.4, [70, 57]],
  ["Coit Tower", 37.8024, -122.4058, 4938.9, 3577.1, [77, 55]],
  ["Pier 39", 37.8087, -122.4098, 5018.8, 3329.5, [78, 52]],
  ["Ghirardelli", 37.8059, -122.4229, 4673.1, 3132.6, [73, 48]],
  ["OpenAI, 1455 3rd St (EAS 489890)", 37.770061, -122.3887726, 4455.5, 4775.7, [69, 74]],
  ["Firegoat, 501 2nd St (EAS 366241)", 37.78293133749337, -122.39320537355528, 4696.7, 4347.0, [73, 67]],
  ["Fort Point", 37.81056, -122.47722, 3661.4, 1889.8, [57, 29]],
];

test("projection: rotated anchor table within 0.2 block and exact chunk", () => {
  for (const [name, lat, lon, x, z, chunk] of ANCHORS) {
    const p = lonLatToBlock(lon, lat);
    assert.ok(Math.abs(p.x - x) < 0.2, `${name}: x ${p.x} vs ${x}`);
    assert.ok(Math.abs(p.z - z) < 0.2, `${name}: z ${p.z} vs ${z}`);
    assert.deepEqual(chunkOf(p.x, p.z), chunk, name);
  }
});

test("projection: option a straightens SoMa — 2nd St runs along a grid axis", () => {
  // 2nd St & Market (37.7887, -122.4012) to 2nd St & Bryant (37.7826, -122.3934): both points on 2nd St
  const a = lonLatToBlock(-122.4012, 37.7887), b = lonLatToBlock(-122.3934, 37.7826);
  const ang = (Math.atan2(b.z - a.z, b.x - a.x) * 180) / Math.PI;
  const off = Math.min(...[0, 90, 180, -90, -180].map((t) => Math.abs(ang - t)));
  assert.ok(off < 3, `2nd St is ${off.toFixed(1)}° off a grid axis`);
});

test("projection: roundtrip error < 0.01 block for rotDeg 0, 9.2 and 44.7; rigid (1 block = 3 m)", () => {
  for (const rot of [0, 9.2, 44.7]) {
    const { proj, grid } = fitProjection(V1_BASE, rot, SF_PIVOT, SF_BOX, SF_MARGIN);
    const r = rng(11 + rot * 10);
    for (let k = 0; k < 2000; k++) {
      const x = r() * grid[0] * CHUNK, z = r() * grid[1] * CHUNK;
      const ll = blockToLonLat(x, z, proj);
      const p = lonLatToBlock(ll.lon, ll.lat, proj);
      assert.ok(Math.hypot(p.x - x, p.z - z) < 0.01, `rot ${rot}: ${x},${z}`);
    }
    const a = lonLatToBlock(-122.4, 37.79, proj), b = lonLatToBlock(-122.39, 37.78, proj);
    const v1a = lonLatToBlock(-122.4, 37.79, { ...V1_BASE, rotDeg: 0, pivotX: 0, pivotZ: 0, x0: 0, z0: 0 });
    const v1b = lonLatToBlock(-122.39, 37.78, { ...V1_BASE, rotDeg: 0, pivotX: 0, pivotZ: 0, x0: 0, z0: 0 });
    assert.ok(Math.abs(Math.hypot(a.x - b.x, a.z - b.z) - Math.hypot(v1a.x - v1b.x, v1a.z - v1b.z)) < 1e-6, `rot ${rot} is rigid`);
  }
  assert.throws(() => lonLatToBlock(NaN, 37.7), /finite/);
  assert.throws(() => lonLatToBlock(-122.4, 37.7, V1_BASE), /rotDeg/);
});

test("chunkOf / chunkKey / regionOf", () => {
  assert.deepEqual(chunkOf(0, 0), [0, 0]);
  assert.deepEqual(chunkOf(63.99, 64), [0, 1]);
  assert.deepEqual(chunkOf(-0.5, -64), [-1, -1]);
  assert.equal(chunkKey(56, 26), "56_26");
  assert.throws(() => chunkKey(1.5, 2), /integer/);
  assert.deepEqual(regionOf(42, 14), [10, 3]);
  assert.deepEqual(regionOf(43, 15), [10, 3]);
  assert.deepEqual(regionOf(44, 16), [11, 4]);
});

// ---------- chunk v2 ----------

const PARENTS = { 900: "Sample Landmark" };
const entry = (o) => ({ parent: 0, accentFrom: ACCENT_NONE, cap: 0, facade: 0, accent: o.palette, ...o });

function sampleChunk(seed = 7) {
  const r = rng(seed);
  const c = {
    cx: 56, cz: -3, frame: 0, ground: new Int16Array(COLUMNS), surface: new Uint8Array(COLUMNS), bldg: new Uint16Array(COLUMNS),
    deck: new Int16Array(COLUMNS), top: new Int16Array(COLUMNS), buildings: [], props: [],
  };
  c.buildings = [
    entry({ id: 4000000000, base: 3, top: 112, palette: 19, cap: CAP.CROWN, facade: FACADE.CURTAIN, accent: 22, accentFrom: 99 }),
    entry({ id: 7, parent: 4000000000, base: 1, top: 5, palette: 2, facade: FACADE.ARCADE }),
  ];
  for (let i = 0; i < COLUMNS; i++) {
    const v = r();
    if (v < 0.15) { c.ground[i] = 0; c.surface[i] = r() < 0.5 ? SURFACE.WATER : SURFACE.SHALLOW; }
    else if (v < 0.25) { c.bldg[i] = 1; c.ground[i] = 3; c.top[i] = 4 + Math.floor(r() * 108); c.surface[i] = SURFACE.SIDEWALK; }
    else if (v < 0.3) { c.bldg[i] = 2; c.ground[i] = 1; c.top[i] = 2 + Math.floor(r() * 4); c.surface[i] = SURFACE.PIER; }
    else { c.ground[i] = 1 + Math.floor(r() * 40); c.surface[i] = 3 + Math.floor(r() * 15); }
    if (c.ground[i] > 0 && c.bldg[i] === 0 && r() < 0.05) c.deck[i] = (r() < 0.5 ? -1 : 1) * (c.ground[i] + 3);
  }
  c.top[c.bldg.indexOf(1)] = 112;
  c.top[c.bldg.indexOf(2)] = 5;
  c.props = [
    { lx: 0, lz: 0, y0: 112, y1: 120, color: PALETTE_INDEX.metal, flags: 0 },
    { lx: 63, lz: 63, y0: 1, y1: 15, color: PALETTE_INDEX.light, flags: 1 },
  ];
  return c;
}

test("chunk: encode → decode → encode is byte-identical, including props, top, parent and accentFrom", () => {
  const c = sampleChunk();
  assert.ok(c.deck.some((d) => d < 0) && c.deck.some((d) => d > 0));
  assert.ok(c.surface.some((s) => s === SURFACE.POOL) && c.surface.some((s) => s === SURFACE.TRACK));
  const bytes = encodeChunk(c, PARENTS);
  assert.equal(bytes.length, 16 + 8192 + 4096 + 8192 + 8192 + 8192 + 20 * 2 + 2 + 8 * 2);
  assert.equal(bytes.length, chunkByteLength(2, 2));
  const d = decodeChunk(bytes, PARENTS);
  assert.deepEqual(d, c);
  assert.deepEqual(encodeChunk(d, PARENTS), bytes);
  assert.deepEqual(decodeChunk(new Uint8Array(gunzipSync(gzipSync(bytes))), PARENTS), c);
  assert.equal(pickId(d.buildings[0]), 4000000000);
  assert.equal(pickId(d.buildings[1]), 4000000000);
  const ext = sampleChunk();
  ext.buildings[0].parent = 900;
  ext.buildings[1].parent = 900;
  const extBytes = encodeChunk(ext, PARENTS);
  assert.equal(pickId(decodeChunk(extBytes, PARENTS).buildings[0]), 900);
  assert.throws(() => decodeChunk(extBytes), /parent 900 is neither/, "manifest.parents is required for external parents");
  assert.equal(pickId({ id: 5, parent: 0 }), 5);
});

test("chunk: decode reads from a subarray with an offset", () => {
  const bytes = encodeChunk(sampleChunk(3), PARENTS);
  const padded = new Uint8Array(bytes.length + 5);
  padded.set(bytes, 5);
  assert.deepEqual(encodeChunk(decodeChunk(padded.subarray(5), PARENTS), PARENTS), bytes);
});

test("chunk: a v1 chunk throws the version message; HTML and gzip guards", () => {
  const v1 = new Uint8Array(16 + 8192 + 4096 + 8192 + 8192);
  v1.set([0x53, 0x46, 0x43, 0x31, 1, 0]);
  assert.throws(() => decodeChunk(v1), /^Error: city chunk version 1, this viewer reads 2$/);
  const html = new TextEncoder().encode("<!doctype html><html><body>app</body></html>" + " ".repeat(30000));
  assert.throws(() => decodeChunk(html), /not a city chunk \(got HTML\?\)/);
  assert.throws(() => assertGzip(html, "56_26.bin"), /not a city chunk \(got HTML\?\)/);
  assert.equal(isGzip(html), false);
  const gz = gzipSync(encodeChunk(sampleChunk(), PARENTS));
  assert.equal(isGzip(gz), true);
  assertGzip(gz);
  assert.throws(() => decodeChunk(new Uint8Array(gz)), /still gzipped/);
});

test("chunk: decode fails loudly on corrupt bytes", () => {
  const good = encodeChunk(sampleChunk(), PARENTS);
  const mut = (fn) => { const b = good.slice(); fn(b, new DataView(b.buffer)); return b; };
  const dec = (b) => decodeChunk(b, PARENTS);
  assert.throws(() => dec(mut((b) => { b[0] = 0x58; })), /magic/);
  assert.throws(() => dec(mut((b, dv) => dv.setUint16(4, 3, true))), /version 3/);
  assert.throws(() => dec(mut((b, dv) => dv.setUint16(10, 32, true))), /size 32/);
  assert.throws(() => dec(mut((b) => { b[14] = 1; })), /frame 1/);
  assert.throws(() => dec(mut((b) => { b[15] = 1; })), /reserved header byte/);
  assert.throws(() => dec(good.subarray(0, good.length - 1)), /expected/);
  assert.throws(() => dec(good.subarray(0, 100)), /shorter/);
  const surf = 16 + 8192;
  assert.throws(() => dec(mut((b) => { b[surf] = 99; })), /unknown surface 99/);
  const bldg = surf + 4096;
  assert.throws(() => dec(mut((b, dv) => dv.setUint16(bldg, 9, true))), /past the 2-entry table/);
  const table = 16 + 8192 + 4096 + 8192 + 8192 + 8192;
  assert.throws(() => dec(mut((b) => { b[table + 18] = 1; })), /building\[0\] reserved/);
  assert.throws(() => dec(mut((b) => { b[table + 15] = 6; })), /cap/);
  assert.throws(() => dec(mut((b) => { b[table + 16] = 7; })), /facade/);
  assert.throws(() => dec(mut((b) => { b[table + 17] = 250; })), /accent/);
  assert.throws(() => dec(mut((b, dv) => dv.setUint16(table + 40, 3, true))), /expected/);
});

test("chunk: validator rejects each semantic rule", () => {
  const bad = (fn, re) => { const c = sampleChunk(); fn(c); assert.throws(() => encodeChunk(c, PARENTS), re); };
  const col = (c, b) => c.bldg.indexOf(b);
  bad((c) => { const i = c.surface.indexOf(SURFACE.GRASS); c.ground[i] = 0; c.deck[i] = 0; }, /water iff ground 0/);
  bad((c) => { c.ground[col(c, 1)] = 9; }, /must equal its base/);
  bad((c) => { c.buildings[1].top = 1; }, /top 1 must be above base 1/);
  bad((c) => { c.buildings[1].id = c.buildings[0].id; }, /duplicate id/);
  bad((c) => { c.buildings[1].id = 0; }, /id must be an integer in 1/);
  bad((c) => { c.buildings[0].palette = 200; }, /palette/);
  bad((c) => { c.buildings[0].accent = BUILDING_PALETTE.length; }, /accent/);
  bad((c) => { c.buildings[0].cap = 6; }, /cap/);
  bad((c) => { c.buildings[0].facade = 7; }, /facade/);
  bad((c) => { c.buildings[0].parent = 901; }, /parent 901 is neither/);
  bad((c) => { c.buildings[1].parent = 7; }, /parent is its own id/);
  bad((c) => { c.buildings[0].parent = 900; }, /no chains/);
  bad((c) => { c.buildings[0].accentFrom = 3; }, /accentFrom 3 must be above base 3/);
  bad((c) => { c.buildings[0].roof = 0; }, /unknown field "roof"/);
  bad((c) => { delete c.buildings[0].accent; }, /missing "accent"/);
  bad((c) => { const i = c.bldg.indexOf(0); c.top[i] = 5; }, /no building \(must be 0\)/);
  bad((c) => { c.top[col(c, 1)] = 3; }, /must be above base 3/);
  bad((c) => { c.buildings[0].top = 111; }, /above its entry top 111/);
  bad((c) => { c.buildings[0].top = 113; }, /top 113 != max column top 112/);
  bad((c) => { c.bldg.fill(0, 0); c.top.fill(0); }, /has no columns in this chunk/);
  bad((c) => { const i = c.deck.findIndex((d) => d !== 0); c.deck[i] = c.ground[i]; }, /deck top/);
  bad((c) => { c.props[0].y1 = c.props[0].y0; }, /y1 112 must be above y0 112/);
  bad((c) => { c.props[0].lx = 64; }, /lx/);
  bad((c) => { c.props[0].color = 250; }, /color/);
  bad((c) => { c.props[0].flags = 2; }, /flags/);
  bad((c) => { c.props[0].extra = 1; }, /unknown field "extra"/);
  bad((c) => { c.frame = 1; }, /frame 1/);
  bad((c) => { delete c.top; }, /missing "top"/);
  bad((c) => { delete c.props; }, /missing "props"/);
  bad((c) => { c.ground = new Int16Array(10); }, /columns/);
  bad((c) => { c.surface = Array.from(c.surface); }, /Uint8Array/);
  assert.throws(() => validateChunk(null), /not an object/);
});

// ---------- landmarks / landmask / walk ----------

test("landmarks.bin: roundtrip, bounds, size cap, guards", () => {
  const boxes = [{ x: 10, z: 20, y0: 0, y1: 53, sx: 2, sz: 3, color: PALETTE_INDEX["bay-bridge"], flags: 0 }, { x: 0, z: 0, y0: -2, y1: 1, sx: 255, sz: 1, color: 0, flags: 1 }];
  const bytes = encodeLandmarks(boxes, SF_GRID);
  assert.equal(bytes.length, 12 + 24);
  assert.deepEqual(decodeLandmarks(bytes, SF_GRID), boxes);
  assert.deepEqual(encodeLandmarks(decodeLandmarks(bytes)), bytes);
  assert.deepEqual(decodeLandmarks(encodeLandmarks([])), []);
  const bad = (b, re) => assert.throws(() => validateLandmarks([{ ...boxes[0], ...b }], SF_GRID), re);
  bad({ x: SF_GRID[0] * CHUNK - 1 }, /outside the 112×112-chunk grid/);
  bad({ x: -1 }, /outside/);
  bad({ y1: 0 }, /y1 0 must be above y0 0/);
  bad({ sx: 0 }, /sx/);
  bad({ color: 250 }, /color/);
  bad({ flags: 3 }, /flags/);
  assert.throws(() => validateLandmarks(Array.from({ length: 17100 }, () => boxes[0])), /bytes > 204800/);
  assert.throws(() => decodeLandmarks(bytes.subarray(0, bytes.length - 1)), /expected/);
  assert.throws(() => decodeLandmarks(new Uint8Array([0x53, 0x46, 0x4c, 0x32, 1, 0, 0, 0, 0, 0, 0, 0])), /magic/);
});

test("landmask.bin: roundtrip, grid size, height lookup", () => {
  const grid = [2, 1];
  const mask = { cellsX: 32, cellsZ: 16, cells: new Uint8Array(32 * 16) };
  mask.cells[1 * 32 + 2] = 6;
  const bytes = encodeLandmask(mask, grid);
  assert.equal(bytes.length, 10 + 512);
  const d = decodeLandmask(bytes, grid);
  assert.deepEqual(d, mask);
  assert.equal(landmaskHeight(d, 8, 4), 5);
  assert.equal(landmaskHeight(d, 11.9, 7.9), 5);
  assert.equal(landmaskHeight(d, 0, 0), null);
  assert.equal(landmaskHeight(d, -1, 0), null);
  assert.throws(() => decodeLandmask(bytes, [3, 1]), /the grid needs 48×16/);
  assert.throws(() => decodeLandmask(bytes.subarray(0, 100)), /expected/);
  assert.throws(() => encodeLandmask({ ...mask, cells: new Uint8Array(3) }), /cells, expected/);
});

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const manifest = readJson(join(FIXTURE_DIR, "manifest.json"));
const companies = readJson(join(FIXTURE_DIR, "companies.json"));
const walkBytes = new Uint8Array(readFileSync(join(FIXTURE_DIR, "walk.bin")));
const walk = decodeWalk(walkBytes, manifest);
const places = readJson(join(FIXTURE_DIR, "places.json"));

const cloneWalk = (g) => ({ builtAt: g.builtAt, nodes: g.nodes.slice(), edges: g.edges.slice(), names: [...g.names] });

test("walk.bin: decode → encode is byte-identical; fields and deck bit", () => {
  assert.deepEqual(encodeWalk(walk, manifest), walkBytes);
  const nE = walk.edges.length / 5;
  assert.ok([...Array(nE).keys()].some((e) => edgeIsDeck(walk.edges, e)));
  assert.equal(packEdgeWidth(20, true) & 0x7fffffff, 20);
  const e0 = { nodes: new Int32Array([0, 0, 10, 30, 0, 10]), edges: new Int32Array([0, 1, 30, 0, packEdgeWidth(15, true), 1, 0, 30, 0, packEdgeWidth(15, true)]) };
  assert.equal(edgeHalfWidth10(e0.edges, 1), 15);
  assert.equal(edgeIsDeck(e0.edges, 1), true);
  const tiny = encodeWalk({ builtAt: 1, ...e0, names: ["Bridge Wy"] });
  const odd = new Uint8Array(tiny.length + 1);
  odd.set(tiny, 1);
  assert.deepEqual(decodeWalk(odd.subarray(1)).nodes, e0.nodes, "unaligned input is copied, not viewed");
});

test("validateWalk rejects each rule (one mutation per rule)", () => {
  const bad = (fn, re) => { const g = cloneWalk(walk); fn(g); assert.throws(() => validateWalk(g, manifest), re); };
  bad((g) => { g.edges[0] = 9999; }, /outside 0\.\.39/);
  bad((g) => { g.edges[1] = g.edges[0]; }, /self loop/);
  bad((g) => { g.edges[2] = 0; }, /len10 0/);
  bad((g) => { g.edges[3] = 99; }, /nameIdx 99/);
  bad((g) => { g.edges[4] = 0; }, /halfWidth10 must be ≥ 1/);
  bad((g) => { g.edges[2] += 1; }, /disagree/);
  bad((g) => { g.edges = g.edges.slice(5); }, /no reverse edge/);
  bad((g) => { g.edges = Int32Array.from([...g.edges, ...g.edges.slice(0, 5)]); }, /duplicate edge/);
  bad((g) => { g.nodes[2] = 3001; }, /y10 3001/);
  bad((g) => { g.nodes[2] = -1; }, /y10 -1/);
  bad((g) => { g.nodes[0] = FIXTURE_GRID[0] * CHUNK * 10; }, /outside the reserved grid/);
  bad((g) => { g.builtAt += 1; }, /!= manifest\.builtAt/);
  bad((g) => { g.names.push(g.names[0]); }, /duplicate name/);
  bad((g) => { g.nodes = Array.from(g.nodes); }, /Int32Array/);
  const b = walkBytes.slice();
  b[0] = 0x58;
  assert.throws(() => decodeWalk(b), /magic/);
  const v = walkBytes.slice();
  v[4] = 2;
  assert.throws(() => decodeWalk(v), /version 2/);
  assert.throws(() => decodeWalk(walkBytes.subarray(0, walkBytes.length - 1)), /expected/);
  const r = walkBytes.slice();
  r[20] = 1;
  assert.throws(() => decodeWalk(r), /reserved/);
});

test("validatePlaces rejects each rule", () => {
  validatePlaces(places, manifest, walk);
  const bad = (fn, re) => { const p = structuredClone(places); fn(p); assert.throws(() => validatePlaces(p, manifest, walk), re); };
  const find = (p, kind) => p.places.find((x) => x.kind === kind);
  bad((p) => { p.builtAt = "2026-01-01T00:00:00Z"; }, /places\.builtAt/);
  bad((p) => { p.places[0].kind = "shop"; }, /kind must be one of/);
  bad((p) => { p.places[0].node = 40; }, /node must be an integer in 0\.\.39/);
  bad((p) => { p.places[0].x += 1; }, /is not lat\/lon projected/);
  bad((p) => { delete find(p, "company").siteId; }, /needs a siteId/);
  bad((p) => { find(p, "landmark").siteId = "x"; }, /siteId on a landmark/);
  bad((p) => { find(p, "area").door = [1, 2]; }, /door on a area/);
  bad((p) => { find(p, "intersection").aliases = []; }, /aliases must include "Test St & Fixture Ave"/);
  bad((p) => { find(p, "intersection").name = "Fixture Ave"; }, /"A & B"/);
  bad((p) => { p.places[1].id = p.places[0].id; }, /duplicate place id/);
  bad((p) => { p.places[0].note = "x"; }, /unknown field "note"/);
  bad((p) => { p.places[0].aliases = [""]; }, /aliases\[0\]/);
});

// ---------- palette ----------

test("palette: groups, ~25% glass above 30 blocks, colour/material/structure options", () => {
  let glass = 0;
  for (let id = 1; id <= 4000; id++) {
    const p = paletteFor(40, id);
    assert.ok(PALETTE_GROUPS.tall.indices.includes(p) || PALETTE_GROUPS.glass.indices.includes(p));
    if (PALETTE_GROUPS.glass.indices.includes(p)) glass++;
  }
  assert.ok(glass / 4000 > 0.2 && glass / 4000 < 0.3, `glass share ${glass / 4000}`);
  assert.deepEqual(PALETTE_GROUPS.tall.indices.map((i) => BUILDING_PALETTE[i]), ["#e6e1d6", "#d9d4c9", "#cfc8bb", "#bfb8ab"]);
  assert.deepEqual(PALETTE_GROUPS.glass.indices.map((i) => BUILDING_PALETTE[i]), ["#8ea3b3", "#6f8799"]);
  assert.ok(PALETTE_GROUPS.pastel.indices.includes(paletteFor(3, 5)));
  assert.ok(PALETTE_GROUPS.midrise.indices.includes(paletteFor(3, 5, { structure: "church" })), "structures never pastel");
  assert.ok(PALETTE_GROUPS.stone.indices.includes(paletteFor(20, 5)));
  assert.equal(paletteFor(40, 5, { colour: "#8c4a3a" }), PALETTE_INDEX["brick-dark"]);
  assert.equal(paletteFor(3, 5, { material: "glass" }), PALETTE_INDEX.glass);
  assert.equal(paletteFor(3, 5, { material: "brick" }), PALETTE_INDEX.brick);
  assert.equal(osmColourToHex("#ABC"), "#aabbcc");
  assert.equal(osmColourToHex("Light Grey"), "#cfcac0");
  assert.equal(osmColourToHex("grey;white"), null);
  assert.equal(osmMaterial("Brick"), "brick");
  assert.equal(osmMaterial("adobe"), null);
  assert.throws(() => paletteFor(3, 5, { material: "adobe" }), /unknown material/);
  assert.throws(() => paletteFor(3, 5, { colour: "grey" }), /#rrggbb/);
  assert.throws(() => paletteFor(3, 5, { structure: "castle" }), /unknown structure/);
  assert.throws(() => paletteFor(3, 5, { roof: 1 }), /unknown option/);
  assert.throws(() => paletteFor(0, 5), /height/);
  assert.equal(hashId(7), hashId(7));
  assert.equal(new Set(BUILDING_PALETTE).size, BUILDING_PALETTE.length, "palette entries are distinct");
});

test("surfaces: v2 ids, every surface has a colour, a terrain side and a topdown colour", () => {
  assert.deepEqual([SURFACE.DIRT, SURFACE.COURT, SURFACE.TRACK, SURFACE.POOL], [14, 15, 16, 17]);
  assert.deepEqual([SURFACE_COLORS[14], SURFACE_COLORS[15], SURFACE_COLORS[16], SURFACE_COLORS[17]], ["#a8754d", "#7d8c7a", "#b5523b", "#6fa8c0"]);
  for (const s of Object.values(SURFACE)) {
    assert.match(SURFACE_COLORS[s], /^#[0-9a-f]{6}$/, `colour ${s}`);
    assert.match(TERRAIN_SIDE_COLORS[s], /^#[0-9a-f]{6}$/, `side ${s}`);
    assert.equal(TOPDOWN_SURFACE[s].length, 3, `topdown ${s}`);
  }
});

// ---------- raster API, build ctx, hook stubs ----------

test("raster API: addEntry / setColumn / clearBuilding / setSurface / addProp → per-chunk tops and props", () => {
  const r = createRaster([0, 0], [1, 0]);
  for (let z = 0; z < CHUNK; z++) for (let x = 0; x < 2 * CHUNK; x++) { r.ground[z * r.w + x] = 2; r.surface[z * r.w + x] = SURFACE.GRASS; }
  assert.equal(r.addEntry({ id: 42, base: 2, top: 30, palette: 7, parent: 900 }), 42);
  assert.throws(() => r.addEntry({ id: 42, base: 2, top: 9, palette: 7 }), /duplicate id/);
  assert.throws(() => r.addEntry({ id: 43, base: 2, top: 9, palette: 7, roof: 0 }), /unknown field "roof"/);
  for (let x = 60; x < 68; x++) r.setColumn(x, 10, { bldg: 42, base: 2, top: x < 64 ? 9 : 30 });
  r.clearBuilding(67, 10);
  r.setSurface(5, 5, SURFACE.COURT);
  r.addProp(65, 10, { y0: 30, y1: 36, color: PALETTE_INDEX.metal, flags: 0 });
  assert.throws(() => r.setColumn(1000, 0, { bldg: 42, base: 2, top: 5 }), /outside the raster/);
  assert.throws(() => r.setColumn(0, 0, { bldg: 99, base: 2, top: 5 }), /no entry with id 99/);
  assert.throws(() => r.setColumn(0, 0, { bldg: 42, base: 2, top: 2 }), /above base/);
  const { chunks, water } = rasterToChunks(r, PARENTS);
  assert.deepEqual(water, []);
  assert.deepEqual(chunks[0].buildings, [entry({ id: 42, parent: 900, base: 2, top: 9, palette: 7 })]);
  assert.equal(chunks[1].buildings[0].top, 30, "per-chunk entry top = max column top in that chunk");
  assert.equal(chunks[1].bldg[10 * CHUNK + 3], 0, "cleared column");
  assert.deepEqual(chunks[1].props, [{ lx: 1, lz: 10, y0: 30, y1: 36, color: PALETTE_INDEX.metal, flags: 0 }]);
  assert.equal(chunks[0].surface[5 * CHUNK + 5], SURFACE.COURT);
  for (const c of chunks) assert.deepEqual(decodeChunk(encodeChunk(c, PARENTS), PARENTS), c);
  assert.throws(() => rasterToChunks(r), /parent 900 is neither/);
  const w = createRaster([0, 0], [0, 0]);
  w.ground[0] = 3; w.surface[0] = SURFACE.GRASS; w.owner[0] = 0;
  assert.throws(() => rasterToChunks(w), /no top; write it with setColumn/);
  assert.deepEqual(rasterToChunks(createRaster([4, 4], [4, 4])).water, [[4, 4]]);
});

const square = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]];
const osmRec = (o = {}) => ({ key: "o:w5", osmType: "way", osmId: 5, tags: { building: "yes" }, polygons: [[square(0, 0, 4, 4)]], isPart: false, heightM: null, minHeightM: null, structure: null, ...o });
const dsRec = (o = {}) => ({ key: "d:77", areaId: "77", polygons: [[square(0, 0, 4, 4)]], heightM: 20, maxM: 31.5, gndMinM: 4, peakM: null, ...o });

test("build ctx: createBuildCtx freezes the ctx and the ctx.osm / ctx.datasf record shapes", () => {
  const ctx = createBuildCtx({ proj: { ...SF_PROJ }, groundAt: () => 1, osm: [osmRec(), osmRec({ key: "o:r9", osmType: "relation", osmId: 9, isPart: true, structure: "ballpark" })], datasf: [dsRec()], report: {} });
  assert.ok(Object.isFrozen(ctx));
  const bad = (o, d, re) => assert.throws(() => createBuildCtx({ proj: { ...SF_PROJ }, groundAt: () => 1, osm: [osmRec(o)], datasf: [dsRec(d)], report: {} }), re);
  bad({ osmType: "relation" }, {}, /does not match key/);
  bad({ osmId: 6 }, {}, /osmId 6/);
  bad({ tags: { height: 30 } }, {}, /tags\.height must be a string/);
  bad({ structure: "castle" }, {}, /STRUCTURE_KINDS/);
  bad({ heightM: "30" }, {}, /heightM/);
  bad({ polygons: [[[[0, 0], [1, 0], [1, 1], [0, 2]]]] }, {}, /not closed/);
  bad({ extra: 1 }, {}, /unknown field "extra"/);
  bad({}, { maxM: null }, /maxM/);
  bad({}, { key: "d:78" }, /does not match areaId/);
  bad({}, { hgt_maxcm: 3150 }, /unknown field "hgt_maxcm"/);
  assert.throws(() => createBuildCtx({ proj: { ...SF_PROJ }, groundAt: 1, osm: [], datasf: [], report: {} }), /groundAt/);
  assert.throws(() => createBuildCtx({ proj: { ...SF_PROJ }, groundAt: () => 1, osm: [], datasf: [], report: {}, raster: {} }), /unknown field/);
  assert.deepEqual(STRUCTURE_KINDS.length, 9);
});

test("hook signatures: W3 hooks keep the frozen signatures and fail loudly without their OSM records; buildWalk fails loudly on bad input", () => {
  const r = createRaster([0, 0], [0, 0]);
  const ctx = createBuildCtx({ proj: { ...SF_PROJ }, groundAt: () => 1, osm: [], datasf: [], report: {} });
  assert.equal(applyStructures(r, ctx), r);
  assert.throws(() => applyLandmarks(r, ctx), /is not in ctx\.osm/);
  assert.throws(() => buildLandmarkMesh(ctx), /is not in ctx\.osm/);
  assert.equal(structureKind({ building: "yes" }, null), null);
  assert.equal(applyStructures.length, 2);
  assert.equal(applyLandmarks.length, 2);
  assert.equal(buildLandmarkMesh.length, 1);
  assert.throws(() => buildWalk({}), /buildWalk: roads must be an array/);
});

// ---------- fixture ----------

function loadFixtureChunks() {
  const chunks = new Map();
  for (const [cx, cz, bytes] of manifest.chunks.list) {
    const p = join(FIXTURE_DIR, "chunks", `${chunkKey(cx, cz)}.bin`);
    const gz = readFileSync(p);
    assert.equal(gz.length, bytes, `${p}: manifest says ${bytes} bytes`);
    assertGzip(gz, p);
    const c = decodeChunk(new Uint8Array(gunzipSync(gz)), manifest.parents);
    assert.deepEqual([c.cx, c.cz], [cx, cz], `${p}: header cx/cz`);
    chunks.set(chunkKey(cx, cz), c);
  }
  return chunks;
}
const chunks = loadFixtureChunks();
const columnAt = (x, z) => {
  const [cx, cz] = chunkOf(x, z);
  const c = chunks.get(chunkKey(cx, cz));
  const i = (z - cz * CHUNK) * CHUNK + (x - cx * CHUNK);
  return { c, i };
};
const allEntries = () => [...chunks.values()].flatMap((c) => c.buildings);

test("fixture: manifest validates; listed chunks exist and decode; no stray files", () => {
  validateManifest(manifest);
  assert.equal(manifest.version, CITY_VERSION);
  const onDisk = readdirSync(join(FIXTURE_DIR, "chunks")).sort();
  const listed = manifest.chunks.list.map(([cx, cz]) => `${chunkKey(cx, cz)}.bin`).sort();
  assert.deepEqual(onDisk, listed);
  assert.equal(chunks.size, 15);
  assert.deepEqual(manifest.water, [[59, 27]], "the all-water chunk is listed as water, not written");
  assert.deepEqual(manifest.parents, Object.fromEntries(Object.entries(FIXTURE_PARENTS)));
  assert.deepEqual(readdirSync(FIXTURE_DIR).sort(), ["chunks", "companies.json", "landmarks.bin", "landmask.bin", "manifest.json", "places.json", "topdown.png", "walk.bin"]);
});

test("validateManifest rejects each rule (one mutation per rule)", () => {
  const bad = (fn, re) => { const x = structuredClone(manifest); fn(x); assert.throws(() => validateManifest(x), re); };
  bad((x) => { x.version = 1; }, /version 1, this viewer reads 2/);
  bad((x) => { x.extra = 1; }, /unknown field "extra"/);
  for (const k of ["water", "areas", "landmask", "landmarks", "walk", "places", "parents", "terrainExaggeration"]) bad((x) => { delete x[k]; }, new RegExp(`missing "${k}"`));
  bad((x) => { delete x.proj.rotDeg; }, /missing "rotDeg"/);
  bad((x) => { x.proj.frames = []; }, /unknown field "frames"/);
  bad((x) => { x.proj.x0 = 3457; }, /x0 must be a multiple of 64/);
  bad((x) => { x.proj.rotDeg = 270; }, /rotDeg 270/);
  bad((x) => { x.terrainExaggeration = 5; }, /terrainExaggeration 5/);
  bad((x) => { x.chunks.grid = [0, 29]; }, /grid must be ≥ 1/);
  bad((x) => { x.chunks.max = [61, 27]; }, /outside the 61×29 grid/);
  bad((x) => { delete x.chunks.grid; }, /missing "grid"/);
  bad((x) => { x.chunks.list.push([99, 99, 10]); }, /outside min\/max/);
  bad((x) => { x.chunks.list.push([...x.chunks.list[0]]); }, /duplicate chunk/);
  bad((x) => { x.chunks.list[0][2] = 70000; }, /bytes outside/);
  bad((x) => { x.water.push([x.chunks.list[0][0], x.chunks.list[0][1]]); }, /listed or already water/);
  bad((x) => { x.water.push([0, 0]); }, /outside min\/max/);
  bad((x) => { x.water = {}; }, /water must be an array/);
  bad((x) => { x.areas = []; }, /areas must be a non-empty array/);
  bad((x) => { x.areas.push({ ...x.areas[0] }); }, /duplicate area id/);
  bad((x) => { x.areas[0].west = x.areas[0].east; }, /west\/south must be below/);
  bad((x) => { x.areas[0].bbox = []; }, /unknown field "bbox"/);
  bad((x) => { x.landmask = "../landmask.bin"; }, /file name next to the manifest/);
  bad((x) => { x.walk = "walk.exe"; }, /file name next to the manifest/);
  bad((x) => { x.parents = { abc: "x" }; }, /parents: bad id/);
  bad((x) => { x.parents = { 5: "" }; }, /parents\[5\]/);
  bad((x) => { x.parents = []; }, /parents must be an object/);
  bad((x) => { delete x.spawn.az; }, /missing "az"/);
  bad((x) => { x.attribution = []; }, /attribution/);
  bad((x) => { x.builtAt = "yesterday"; }, /builtAt/);
});

test("fixture: is up to date (npm run city:fixture regenerates it byte-identically)", () => {
  for (const [rel, bytes] of generateFixture()) {
    const p = join(FIXTURE_DIR, rel);
    assert.ok(existsSync(p), `missing ${p}`);
    assert.ok(readFileSync(p).equals(bytes), `${rel} differs from the generator; run npm run city:fixture`);
  }
});

test("fixture: under 250 KB", () => {
  const size = (p) => (statSync(p).isDirectory() ? readdirSync(p).reduce((n, f) => n + size(join(p, f)), 0) : statSync(p).size);
  const total = size(FIXTURE_DIR);
  assert.ok(total < 250 * 1024, `${total} bytes`);
});

test("fixture: v1 features kept (hill, decks, road + sidewalk, pier building, 10 flat towers, sloped lot)", () => {
  let hill = 0, negDeck = 0, posDeck = 0, roadSidewalk = 0, pierBuilding = false;
  for (const c of chunks.values()) {
    for (let i = 0; i < COLUMNS; i++) {
      if (c.bldg[i] === 0) hill = Math.max(hill, c.ground[i]);
      if (c.deck[i] < 0) negDeck++;
      if (c.deck[i] > 0) posDeck++;
      if (c.surface[i] === SURFACE.ROAD) roadSidewalk |= 1;
      if (c.surface[i] === SURFACE.SIDEWALK) roadSidewalk |= 2;
      if (c.bldg[i] && c.surface[i] === SURFACE.PIER) pierBuilding = true;
    }
  }
  assert.equal(hill, 30);
  assert.ok(negDeck > 0 && posDeck > 0);
  assert.equal(roadSidewalk, 3);
  assert.ok(pierBuilding, "a building stands on the pier");
  const towers = new Map(allEntries().filter((b) => b.id >= 8 && b.id <= 17 && b.parent === 0).map((b) => [b.id, b.top - b.base]));
  assert.deepEqual([...towers.values()].sort((a, b) => b - a), [100, 90, 80, 70, 60, 50, 40, 32, 24, 16]);
  const { c, i } = columnAt(3584 + 30, 1536 + 138);
  const b = c.buildings[c.bldg[i] - 1];
  assert.deepEqual([b.base, b.top, c.top[i]], [5, 12, 12], "sloped lot: base = min ground 5, top = max ground 8 + 4");
});

test("fixture: v2 features", () => {
  const entries = allEntries();
  // taper tower: one entry, ≥ 5 distinct column tops, monotonic toward the centre, a 1×1 spire prop on top
  const taperCol = columnAt(3584 + 146, 1536 + 72);
  const taper = taperCol.c.buildings[taperCol.c.bldg[taperCol.i] - 1];
  const tops = new Set();
  for (let lx = 0; lx < CHUNK; lx++) for (let lz = 0; lz < CHUNK; lz++) {
    const k = lz * CHUNK + lx;
    if (taperCol.c.buildings[taperCol.c.bldg[k] - 1]?.id === taper.id) tops.add(taperCol.c.top[k]);
  }
  assert.ok(tops.size >= 5, `taper tops ${[...tops]}`);
  assert.equal(taper.top, Math.max(...tops));
  assert.ok(taperCol.c.props.some((p) => p.y0 === taper.top && p.y1 > p.y0 && p.flags === 0), "spire prop on the taper top");
  // sawtooth slab: face row alternates building / not building every 2 columns
  const row = [...Array(8).keys()].map((k) => { const { c, i } = columnAt(3584 + 112 + 2 * k, 1536 + 100); return c.bldg[i] !== 0; });
  assert.deepEqual(row, [true, false, true, false, true, false, true, false]);
  // two-part landmark sharing a parent, one part with an accent band
  const ferry = entries.filter((b) => b.parent === 1001);
  assert.equal(new Set(ferry.map((b) => b.id)).size, 2);
  assert.ok(ferry.some((b) => b.accentFrom !== ACCENT_NONE && b.accentFrom > b.base && b.accentFrom < b.top && b.cap === CAP.DOME));
  assert.ok(ferry.some((b) => b.facade === FACADE.ARCADE && b.accentFrom === ACCENT_NONE));
  assert.equal(new Set(ferry.map(pickId)).size, 1);
  // bowl: stands up to 3 blocks, a field of GRASS/DIRT with no building, 6 emissive light props
  const park = entries.filter((b) => b.parent === 1002);
  const stands = park.find((b) => b.cap === CAP.SEATS);
  assert.equal(stands.top - stands.base, 3);
  assert.equal(stands.facade, FACADE.ARCADE);
  const fieldSurfaces = new Set();
  for (let dz = -10; dz <= 10; dz++) for (let dx = -10; dx <= 10; dx++) {
    if (Math.hypot(dx, dz) >= 11) continue;
    const { c, i } = columnAt(3584 + 30 + dx, 1536 + 214 + dz);
    assert.equal(c.bldg[i], 0, "the field is ground, not roof");
    fieldSurfaces.add(c.surface[i]);
  }
  assert.deepEqual([...fieldSurfaces].sort(), [SURFACE.GRASS, SURFACE.DIRT].sort());
  const bowlChunk = chunks.get("56_27");
  assert.equal(bowlChunk.props.filter((p) => p.flags === 1).length, 6);
  // POOL above ground; COURT and TRACK present
  const pool = columnAt(3584 + 32, 1536 + 94);
  assert.equal(pool.c.surface[pool.i], SURFACE.POOL);
  assert.ok(pool.c.ground[pool.i] > 1, "pool sits on the hill");
  const surfaces = new Set([...chunks.values()].flatMap((c) => [...c.surface]));
  for (const s of [SURFACE.COURT, SURFACE.TRACK, SURFACE.DIRT, SURFACE.POOL]) assert.ok(surfaces.has(s), `surface ${s}`);
  // short bridge deck over water, walk nodes at deck y
  const over = columnAt(3584 + 196, 1536 + 65);
  assert.equal(over.c.ground[over.i], 0);
  assert.equal(over.c.deck[over.i], 4);
  const nE = walk.edges.length / 5;
  const deckEdges = [...Array(nE).keys()].filter((e) => edgeIsDeck(walk.edges, e));
  assert.ok(deckEdges.length >= 2);
  for (const e of deckEdges) for (const n of [walk.edges[e * 5], walk.edges[e * 5 + 1]]) assert.equal(walk.nodes[n * 3 + 2], 40, "deck node y = deck top");
  // chunk kinds: listed, water, unbuilt (landmask land), sea
  const landmask = decodeLandmask(new Uint8Array(gunzipSync(readFileSync(join(FIXTURE_DIR, "landmask.bin")))), manifest.chunks.grid);
  assert.equal(landmaskHeight(landmask, 55 * CHUNK + 10, 25 * CHUNK + 10), 2, "chunk 55,25 is unbuilt land");
  assert.equal(landmaskHeight(landmask, 60 * CHUNK + 10, 25 * CHUNK + 10), null, "chunk 60,25 is sea");
  assert.equal(landmaskHeight(landmask, 59 * CHUNK + 30, 27 * CHUNK + 30), null, "the water chunk is sea in the mask");
  assert.ok(landmaskHeight(landmask, 56 * CHUNK + 64, 24 * CHUNK + 64) >= 28, "the hill shows in the mask");
  // walk graph and places
  assert.equal(walk.nodes.length / 3, 40);
  assert.equal(places.places.filter((p) => p.kind === "company").length, 3);
  assert.deepEqual(new Set(places.places.map((p) => p.kind)), new Set(["company", "landmark", "intersection", "area"]));
  // landmarks.bin: 50 boxes inside the grid
  const boxes = decodeLandmarks(new Uint8Array(gunzipSync(readFileSync(join(FIXTURE_DIR, "landmarks.bin")))), manifest.chunks.grid);
  assert.equal(boxes.length, 50);
});

test("fixture: companies validate and place (one shared building)", () => {
  validateCompanies(companies, manifest);
  assert.equal(companies.sites.length, 3);
  for (const s of companies.sites) {
    const { c, i } = columnAt(s.block.x, s.block.z);
    assert.ok(c, `${s.id}: chunk loaded`);
    assert.equal(c.buildings[c.bldg[i] - 1]?.id, s.buildingId, `${s.id}: building at block`);
    const a = columnAt(s.anchor.x, s.anchor.z);
    assert.equal(a.c.bldg[a.i], 0, `${s.id}: anchor not a building`);
    assert.equal(a.c.surface[a.i], SURFACE.SIDEWALK, `${s.id}: anchor on sidewalk`);
    assert.equal(a.c.ground[a.i], s.anchor.y);
    const place = places.places.find((p) => p.siteId === s.id);
    assert.deepEqual(place.door, [s.anchor.x, s.anchor.z]);
    assert.deepEqual([walk.nodes[place.node * 3], walk.nodes[place.node * 3 + 1]], [s.anchor.x * 10 + 5, s.anchor.z * 10 + 5], `${s.id}: door node`);
  }
  const byBuilding = Map.groupBy(companies.sites, (s) => s.buildingId);
  assert.ok([...byBuilding.values()].some((g) => g.length === 2), "two companies share a building");
  const cbad = (fn, re) => { const x = structuredClone(companies); fn(x); assert.throws(() => validateCompanies(x, manifest), re); };
  cbad((x) => { x.version = 1; }, /version 1, expected 2/);
  cbad((x) => { x.sites[0].sources = [{ url: "https://x", kind: "registry" }]; }, /occupancy or operator source/);
  cbad((x) => { x.sites[0].sources = [{ kind: "operator", date: "2026-10-31" }]; }, /statement/);
  cbad((x) => { x.sites[0].placement = "guess"; }, /placement/);
  cbad((x) => { x.sites[0].status = "former"; }, /dated news or company/);
  cbad((x) => { x.sites[1].id = x.sites[0].id; }, /duplicate site id/);
  cbad((x) => { x.sites[1].companyId = x.sites[0].companyId; }, /2 primary sites/);
  cbad((x) => { x.sites[0].block.x += 1; }, /not the column/);
  cbad((x) => { x.sites[0].chunk = [0, 0]; }, /does not hold block/);
  cbad((x) => { x.sites[0].placementDistM = 5; }, /placement contains/);
  cbad((x) => { x.city = "sf"; }, /does not match manifest/);
});

console.log(`format.check: ${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
