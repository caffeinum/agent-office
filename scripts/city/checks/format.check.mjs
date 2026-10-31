// W1 contract checks: projection, chunk encode/decode, validators, and the committed fixture.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { join } from "node:path";
import {
  CHUNK, COLUMNS, SF_PROJ, SURFACE, assertGzip, blockToLonLat, chunkKey, chunkOf, decodeChunk, encodeChunk, isGzip,
  lonLatToBlock, regionOf, validateChunk, validateCompanies, validateManifest,
} from "../../../public/shared/city.js";
import { FIXTURE_DIR, generateFixture } from "../fixture.mjs";

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

function sampleChunk(seed = 7) {
  const r = rng(seed);
  const c = { cx: 56, cz: -3, ground: new Int16Array(COLUMNS), surface: new Uint8Array(COLUMNS), bldg: new Uint16Array(COLUMNS), deck: new Int16Array(COLUMNS), buildings: [] };
  c.buildings = [
    { id: 4000000000, base: 3, top: 112, palette: 15, roof: 0 },
    { id: 7, base: 1, top: 5, palette: 2, roof: 0 },
  ];
  for (let i = 0; i < COLUMNS; i++) {
    const v = r();
    if (v < 0.15) { c.ground[i] = 0; c.surface[i] = r() < 0.5 ? SURFACE.WATER : SURFACE.SHALLOW; }
    else if (v < 0.25) { c.bldg[i] = 1; c.ground[i] = 3; c.surface[i] = SURFACE.SIDEWALK; }
    else if (v < 0.3) { c.bldg[i] = 2; c.ground[i] = 1; c.surface[i] = SURFACE.PIER; }
    else { c.ground[i] = 1 + Math.floor(r() * 40); c.surface[i] = 3 + Math.floor(r() * 11); }
    if (c.ground[i] > 0 && r() < 0.05) c.deck[i] = (r() < 0.5 ? -1 : 1) * (c.ground[i] + 3);
  }
  return c;
}

test("projection: anchor table (spec §1) within 0.2 block and exact chunk", () => {
  const rows = [
    ["Salesforce Tower", 37.7897744, -122.3969321, 3609.8, 1666.9, [56, 26]],
    ["Ferry Building", 37.7955, -122.3937, 3704.6, 1455.9, [57, 22]],
    ["Transamerica", 37.7952, -122.4028, 3437.7, 1466.9, [53, 22]],
    ["Grace Cathedral", 37.7919, -122.4134, 3126.8, 1588.6, [48, 24]],
    ["Coit Tower", 37.8024, -122.4058, 3349.7, 1201.6, [52, 18]],
    ["Pier 39", 37.8087, -122.4098, 3232.4, 969.4, [50, 15]],
    ["Ghirardelli", 37.8059, -122.4229, 2848.1, 1072.6, [44, 16]],
    ["OpenAI, 1455 3rd St (provisional)", 37.770045, -122.388788, 3848.7, 2394.1, [60, 37]],
  ];
  for (const [name, lat, lon, x, z, chunk] of rows) {
    const p = lonLatToBlock(lon, lat);
    assert.ok(Math.abs(p.x - x) < 0.2, `${name}: x ${p.x} vs ${x}`);
    assert.ok(Math.abs(p.z - z) < 0.2, `${name}: z ${p.z} vs ${z}`);
    assert.deepEqual(chunkOf(p.x, p.z), chunk, name);
  }
});

test("projection: constants and v1 bbox", () => {
  assert.ok(Math.abs(SF_PROJ.mPerDegLon - 111320 * Math.cos((SF_PROJ.latRef * Math.PI) / 180)) < 0.1);
  const nw = lonLatToBlock(-122.42836, 37.81069);
  const se = lonLatToBlock(-122.38254, 37.75513);
  assert.ok(Math.abs(nw.x - 2688) < 1 && Math.abs(nw.z - 896) < 1, JSON.stringify(nw));
  assert.ok(Math.abs(se.x - 4032) < 1 && Math.abs(se.z - 2944) < 1, JSON.stringify(se));
});

test("projection: roundtrip error < 0.01 block", () => {
  const r = rng(11);
  for (let k = 0; k < 2000; k++) {
    const x = r() * 4842, z = r() * 4681;
    const ll = blockToLonLat(x, z);
    const p = lonLatToBlock(ll.lon, ll.lat);
    assert.ok(Math.hypot(p.x - x, p.z - z) < 0.01, `${x},${z}`);
  }
  assert.throws(() => lonLatToBlock(NaN, 37.7), /finite/);
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

test("chunk: encode → decode → encode is byte-identical, including negative deck", () => {
  const c = sampleChunk();
  assert.ok(c.deck.some((d) => d < 0) && c.deck.some((d) => d > 0));
  const bytes = encodeChunk(c);
  assert.equal(bytes.length, 16 + 8192 + 4096 + 8192 + 8192 + 12 * 2);
  const d = decodeChunk(bytes);
  assert.deepEqual(d, c);
  assert.deepEqual(encodeChunk(d), bytes);
  assert.deepEqual(decodeChunk(new Uint8Array(gunzipSync(gzipSync(bytes)))), c);
});

test("chunk: decode reads from a subarray with an offset", () => {
  const bytes = encodeChunk(sampleChunk(3));
  const padded = new Uint8Array(bytes.length + 5);
  padded.set(bytes, 5);
  assert.deepEqual(encodeChunk(decodeChunk(padded.subarray(5))), bytes);
});

test("chunk: decodeChunk on HTML bytes throws; gzip guards", () => {
  const html = new TextEncoder().encode("<!doctype html><html><body>app</body></html>" + " ".repeat(30000));
  assert.throws(() => decodeChunk(html), /not a city chunk \(got HTML\?\)/);
  assert.throws(() => assertGzip(html, "56_26.bin"), /not a city chunk \(got HTML\?\)/);
  assert.equal(isGzip(html), false);
  const gz = gzipSync(encodeChunk(sampleChunk()));
  assert.equal(isGzip(gz), true);
  assertGzip(gz);
  assert.throws(() => decodeChunk(new Uint8Array(gz)), /still gzipped/);
});

test("chunk: decode fails loudly on corrupt bytes", () => {
  const good = encodeChunk(sampleChunk());
  const mut = (fn) => { const b = good.slice(); fn(b, new DataView(b.buffer)); return b; };
  assert.throws(() => decodeChunk(mut((b) => { b[0] = 0x58; })), /magic/);
  assert.throws(() => decodeChunk(mut((b, dv) => dv.setUint16(4, 2, true))), /version 2/);
  assert.throws(() => decodeChunk(mut((b, dv) => dv.setUint16(10, 32, true))), /size 32/);
  assert.throws(() => decodeChunk(mut((b, dv) => dv.setUint16(14, 1, true))), /reserved/);
  assert.throws(() => decodeChunk(good.subarray(0, good.length - 1)), /expected/);
  assert.throws(() => decodeChunk(good.subarray(0, 100)), /shorter/);
  const surf = 16 + 8192;
  assert.throws(() => decodeChunk(mut((b) => { b[surf] = 99; })), /unknown surface 99/);
  const bldg = surf + 4096;
  assert.throws(() => decodeChunk(mut((b, dv) => dv.setUint16(bldg, 9, true))), /past the 2-entry table/);
});

test("chunk: validator rejects bad semantics", () => {
  const bad = (fn, re) => { const c = sampleChunk(); fn(c); assert.throws(() => encodeChunk(c), re); };
  bad((c) => { c.ground[0] = 0; c.surface[0] = SURFACE.GRASS; c.bldg[0] = 0; c.deck[0] = 0; }, /water iff ground 0/);
  bad((c) => { const i = c.bldg.indexOf(1); c.ground[i] = 9; }, /must equal its base/);
  bad((c) => { c.buildings[0].top = 3; }, /top 3 must be above base 3/);
  bad((c) => { c.buildings[1].id = c.buildings[0].id; }, /duplicate id/);
  bad((c) => { c.buildings[0].palette = 200; }, /palette/);
  bad((c) => { c.buildings[0].roof = 1; }, /roof/);
  bad((c) => { const i = c.deck.findIndex((d) => d !== 0); c.deck[i] = c.ground[i]; }, /deck top/);
  bad((c) => { c.ground = new Int16Array(10); }, /columns/);
  bad((c) => { c.surface = Array.from(c.surface); }, /Uint8Array/);
  assert.throws(() => validateChunk(null), /not an object/);
});

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const manifest = readJson(join(FIXTURE_DIR, "manifest.json"));
const companies = readJson(join(FIXTURE_DIR, "companies.json"));

function loadFixtureChunks() {
  const chunks = new Map();
  for (const [cx, cz, bytes] of manifest.chunks.list) {
    const p = join(FIXTURE_DIR, "chunks", `${chunkKey(cx, cz)}.bin`);
    const gz = readFileSync(p);
    assert.equal(gz.length, bytes, `${p}: manifest says ${bytes} bytes`);
    assertGzip(gz, p);
    const c = decodeChunk(new Uint8Array(gunzipSync(gz)));
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

test("fixture: manifest validates; listed chunks exist and decode; no stray files", () => {
  validateManifest(manifest);
  const onDisk = readdirSync(join(FIXTURE_DIR, "chunks")).sort();
  const listed = manifest.chunks.list.map(([cx, cz]) => `${chunkKey(cx, cz)}.bin`).sort();
  assert.deepEqual(onDisk, listed);
  assert.equal(chunks.size, 15);
  assert.ok(!chunks.has("59_27"), "the all-water chunk is not written");
});

test("fixture: is up to date (npm run city:fixture regenerates it byte-identically)", () => {
  for (const [rel, bytes] of generateFixture()) {
    const p = join(FIXTURE_DIR, rel);
    assert.ok(existsSync(p), `missing ${p}`);
    assert.ok(readFileSync(p).equals(bytes), `${rel} differs from the generator; run npm run city:fixture`);
  }
});

test("fixture: under 200 KB", () => {
  const size = (p) => (statSync(p).isDirectory() ? readdirSync(p).reduce((n, f) => n + size(join(p, f)), 0) : statSync(p).size);
  const total = size(FIXTURE_DIR);
  assert.ok(total < 200 * 1024, `${total} bytes`);
});

test("fixture: required features", () => {
  let hill = 0, negDeck = 0, posDeck = 0, roadSidewalk = 0;
  const heights = new Map();
  let pierBuilding = false;
  for (const c of chunks.values()) {
    for (let i = 0; i < COLUMNS; i++) {
      if (c.bldg[i] === 0) hill = Math.max(hill, c.ground[i]);
      if (c.deck[i] < 0) negDeck++;
      if (c.deck[i] > 0) posDeck++;
      if (c.surface[i] === SURFACE.ROAD) roadSidewalk |= 1;
      if (c.surface[i] === SURFACE.SIDEWALK) roadSidewalk |= 2;
      if (c.bldg[i] && c.surface[i] === SURFACE.PIER) pierBuilding = true;
    }
    for (const b of c.buildings) heights.set(b.id, b.top - b.base);
  }
  assert.equal(hill, 30);
  assert.ok(negDeck > 0 && posDeck > 0);
  assert.equal(roadSidewalk, 3);
  assert.ok(pierBuilding, "a building stands on the pier");
  const towers = [...heights.values()].filter((h) => h >= 16).sort((a, b) => b - a);
  assert.equal(towers.length, 10);
  assert.equal(towers[0], 100);
  const { c, i } = columnAt(3584 + 30, 1536 + 138);
  const b = c.buildings[c.bldg[i] - 1];
  assert.deepEqual([b.base, b.top], [5, 12], "sloped lot: base = min ground 5, top = max ground 8 + 4");
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
  }
  const byBuilding = Map.groupBy(companies.sites, (s) => s.buildingId);
  assert.ok([...byBuilding.values()].some((g) => g.length === 2), "two companies share a building");
});

test("validateManifest / validateCompanies reject bad data", () => {
  const m = () => structuredClone(manifest);
  const bad = (fn, re) => { const x = m(); fn(x); assert.throws(() => validateManifest(x), re); };
  bad((x) => { x.version = 2; }, /version 2/);
  bad((x) => { x.extra = 1; }, /unknown field "extra"/);
  bad((x) => { delete x.spawn; }, /missing "spawn"/);
  bad((x) => { x.chunks.list.push([99, 99, 10]); }, /outside min\/max/);
  bad((x) => { x.chunks.list.push([...x.chunks.list[0]]); }, /duplicate chunk/);
  bad((x) => { x.chunks.list[0][2] = 70000; }, /bytes outside/);
  bad((x) => { x.attribution = []; }, /attribution/);
  bad((x) => { x.builtAt = "yesterday"; }, /builtAt/);
  const cbad = (fn, re) => { const x = structuredClone(companies); fn(x); assert.throws(() => validateCompanies(x, manifest), re); };
  cbad((x) => { x.sites[0].sources = [{ url: "https://x", kind: "registry" }]; }, /occupancy source/);
  cbad((x) => { x.sites[0].status = "former"; }, /dated news or company/);
  cbad((x) => { x.sites[1].id = x.sites[0].id; }, /duplicate site id/);
  cbad((x) => { x.sites[1].companyId = x.sites[0].companyId; }, /2 primary sites/);
  cbad((x) => { x.sites[0].block.x += 1; }, /not the column/);
  cbad((x) => { x.sites[0].chunk = [0, 0]; }, /does not hold block/);
  cbad((x) => { x.sites[0].placementDistM = 5; }, /placement contains/);
  cbad((x) => { x.sites[0].hint = {}; }, /unknown field "hint"/);
  cbad((x) => { x.city = "sf"; }, /does not match manifest/);
});

console.log(`format.check: ${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
