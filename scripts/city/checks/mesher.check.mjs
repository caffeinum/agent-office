// W4 mesher checks (spec §5 W4): triangle counts, neighbour culling, pillars, LOD1 vs LOD0 on the fixture,
// winding, the worker request/reply shape, and the import rule for mesher.js / mesher.worker.js.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { ACCENT_NONE, CHUNK, CITY_VERSION, COLUMNS, SURFACE, chunkKey, decodeChunk, regionOf, validateChunk, validateManifest } from "../../../public/shared/city.js";
import { handleMeshRequest, meshChunk, meshRegion } from "../../../public/js/city/mesher.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`✗ ${name}\n  ${e.stack}`); process.exitCode = 1; }
};

function flatChunk(cx, cz, ground = 3, surface = SURFACE.GRASS) {
  return validateChunk({
    cx, cz, frame: 0,
    ground: new Int16Array(COLUMNS).fill(ground),
    surface: new Uint8Array(COLUMNS).fill(surface),
    bldg: new Uint16Array(COLUMNS),
    deck: new Int16Array(COLUMNS),
    top: new Int16Array(COLUMNS),
    buildings: [],
    props: [],
  });
}
const NONE = { n: null, s: null, e: null, w: null };
const around = (c, make = (x, z) => flatChunk(x, z, c.ground[0], c.surface[0])) => ({
  n: make(c.cx, c.cz - 1), s: make(c.cx, c.cz + 1), e: make(c.cx + 1, c.cz), w: make(c.cx - 1, c.cz),
});
const tris = (m) => m.indices.length / 3;

/** Every quad's triangles, as [a, b, c] vertex positions (local). */
function* triangles(m) {
  for (let t = 0; t < m.indices.length; t += 3) {
    yield [0, 1, 2].map((k) => Array.from(m.positions.subarray(m.indices[t + k] * 3, m.indices[t + k] * 3 + 3)));
  }
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Quads of a mesh, as {normal, min, max} boxes (4 vertices each, in emission order). */
function quads(m) {
  const out = [];
  for (let v = 0; v < m.positions.length / 3; v += 4) {
    const p = [0, 1, 2, 3].map((k) => Array.from(m.positions.subarray((v + k) * 3, (v + k) * 3 + 3)));
    const min = [0, 1, 2].map((a) => Math.min(...p.map((q) => q[a])));
    const max = [0, 1, 2].map((a) => Math.max(...p.map((q) => q[a])));
    out.push({ normal: Array.from(m.normals.subarray(v * 3, v * 3 + 3)).map((n) => Math.sign(n)), min, max });
  }
  return out;
}
const isSide = (q) => q.normal[1] === 0;

test("flat single-class chunk, four equal neighbours: exactly 2 top triangles, no sides", () => {
  const c = flatChunk(10, 10);
  const { opaque, walls } = meshChunk(c, around(c));
  assert.equal(tris(opaque), 2);
  assert.equal(tris(walls), 0);
  assert.equal(quads(opaque).filter(isSide).length, 0);
});

test("same chunk with absent neighbours: border sides down to y=0", () => {
  const c = flatChunk(10, 10, 3);
  const { opaque } = meshChunk(c, NONE);
  const sides = quads(opaque).filter(isSide);
  assert.equal(sides.length, 4);
  for (const q of sides) {
    assert.equal(q.min[1], 0);
    assert.equal(q.max[1], 3);
  }
  const normals = sides.map((q) => q.normal.join(",")).sort();
  assert.deepEqual(normals, ["-1,0,0", "0,0,-1", "0,0,1", "1,0,0"]);
  assert.equal(quads(opaque).filter((q) => q.normal[1] === 1).length, 1);
});

function towerChunk(h, ground = 3) {
  const c = flatChunk(20, 20, ground);
  const k = 30 * CHUNK + 30;
  c.bldg[k] = 1;
  c.top[k] = ground + h;
  c.buildings.push({ id: 42, parent: 0, base: ground, top: ground + h, accentFrom: ACCENT_NONE, palette: 15, cap: 0, facade: 0, accent: 15 });
  return validateChunk(c);
}

test("1×1 tower of height h on flat ground: 1 top quad + 4 side quads of its own", () => {
  for (const h of [1, 7, 100]) {
    const c = towerChunk(h);
    const { opaque, walls } = meshChunk(c, around(c));
    const own = (q) => q.min[0] >= 30 && q.max[0] <= 31 && q.min[2] >= 30 && q.max[2] <= 31;
    const tops = quads(opaque).filter((q) => q.normal[1] === 1 && q.min[1] === 3 + h);
    assert.equal(tops.length, 1, `h=${h} roof quads`);
    assert.ok(own(tops[0]));
    const sides = quads(walls);
    assert.equal(sides.length, 4, `h=${h} wall quads`);
    for (const q of sides) {
      assert.ok(own(q) && isSide(q), JSON.stringify(q));
      assert.equal(q.min[1], 3);
      assert.equal(q.max[1], 3 + h);
    }
    assert.equal(quads(opaque).filter(isSide).length, 0, "no terrain sides on flat ground");
    assert.equal(walls.uvs.length, (walls.positions.length / 3) * 2);
  }
});

test("neighbour culling: two equal-height adjacent chunks emit no border sides", () => {
  const a = flatChunk(5, 5, 4), b = flatChunk(6, 5, 4);
  const ma = meshChunk(a, { n: null, s: null, w: null, e: b });
  const mb = meshChunk(b, { n: null, s: null, e: null, w: a });
  assert.equal(quads(ma.opaque).filter((q) => q.normal[0] === 1).length, 0, "a has no east side");
  assert.equal(quads(mb.opaque).filter((q) => q.normal[0] === -1).length, 0, "b has no west side");
  assert.equal(quads(ma.opaque).filter((q) => q.normal[0] === -1).length, 1, "a still has its absent west side");
});

test("a lower neighbour chunk gets one border quad from the difference only", () => {
  const a = flatChunk(5, 5, 6), b = flatChunk(6, 5, 2);
  const { opaque } = meshChunk(a, { ...NONE, e: b });
  const east = quads(opaque).filter((q) => q.normal[0] === 1);
  assert.equal(east.length, 1);
  assert.deepEqual([east[0].min[1], east[0].max[1], east[0].min[0]], [2, 6, 64]);
});

test("a negative deck column emits a pillar; a positive deck does not", () => {
  const mk = (sign) => {
    const c = flatChunk(7, 7, 2, SURFACE.ROAD);
    for (let x = 10; x < 20; x++) c.deck[20 * CHUNK + x] = 6;
    c.deck[20 * CHUNK + 14] = sign * 6;
    return meshChunk(validateChunk(c), around(c));
  };
  const pillarSides = (m) => quads(m.opaque).filter((q) => isSide(q) && q.min[1] === 2 && q.max[1] === 5 && q.min[0] >= 14 && q.max[0] <= 15);
  assert.equal(pillarSides(mk(-1)).length, 4, "pillar from ground 2 to slab bottom 5 on all four sides");
  assert.equal(pillarSides(mk(1)).length, 0);
  const slabTop = quads(mk(1).opaque).filter((q) => q.normal[1] === 1 && q.min[1] === 6);
  assert.ok(slabTop.length >= 1, "deck slab top at y=6");
  const under = quads(mk(1).opaque).filter((q) => q.normal[1] === -1 && q.min[1] === 5);
  assert.ok(under.length >= 1, "deck underside at y=5");
});

test("winding: every triangle is counter-clockwise from outside (matches its normal)", () => {
  const c = towerChunk(9);
  c.deck[5 * CHUNK + 5] = -8;
  c.deck[5 * CHUNK + 6] = 8;
  for (const m of Object.values(meshChunk(validateChunk(c), NONE))) {
    let t = 0;
    for (const [a, b, d] of triangles(m)) {
      const n = cross(sub(b, a), sub(d, a));
      const v = m.indices[t * 3];
      const want = Array.from(m.normals.subarray(v * 3, v * 3 + 3));
      const dot = n[0] * want[0] + n[1] * want[1] + n[2] * want[2];
      assert.ok(dot > 0, `triangle ${t} winds against its normal ${want}`);
      t++;
    }
  }
});

test("AO: a top face next to a tall column is darker at the touching corners", () => {
  const c = towerChunk(5);
  const { opaque } = meshChunk(c, around(c));
  let darker = 0;
  for (let v = 0; v < opaque.positions.length / 3; v++) {
    const [x, y, z] = opaque.positions.subarray(v * 3, v * 3 + 3);
    if (y === 3 && opaque.normals[v * 3 + 1] > 0 && (x === 30 || x === 31) && (z === 30 || z === 31)) {
      if (opaque.colors[v * 3 + 1] < 255 * 0.9 * 0.5) darker++;
    }
  }
  assert.ok(darker > 0, "ground vertices around the tower are occluded");
});

test("colours are linear bytes, buffers are typed and local to the chunk origin", () => {
  const c = flatChunk(3, 4, 3);
  const { opaque } = meshChunk(c, around(c));
  assert.ok(opaque.positions instanceof Float32Array && opaque.colors instanceof Uint8Array && opaque.indices instanceof Uint32Array);
  assert.ok(opaque.normals instanceof Int8Array && opaque.uvs instanceof Float32Array);
  assert.deepEqual(opaque.origin, [3 * CHUNK, 0, 4 * CHUNK]);
  assert.ok(Math.max(...opaque.positions) <= CHUNK && Math.min(...opaque.positions) >= 0);
  // grass #7cbf5a: sRGB 0x7c = 124 → linear ≈ 0.202 → 51
  assert.equal(opaque.colors[0], 51);
});

test("bad input fails loudly", () => {
  const c = flatChunk(1, 1);
  assert.throws(() => meshChunk(c, {}), /neighbour n missing/);
  assert.throws(() => meshChunk(c, { ...NONE, e: flatChunk(5, 5) }), /neighbour e of 1,1 is 5,5/);
  assert.throws(() => meshChunk({ cx: 1, cz: 1 }, NONE), /ground must be/);
  assert.throws(() => meshRegion([flatChunk(0, 0), flatChunk(4, 0)], [], 1), /outside region/);
  assert.throws(() => meshRegion([flatChunk(0, 0)], [], 3), /lod must be 1 or 2/);
  assert.throws(() => handleMeshRequest({ id: 1, kind: "blob" }), /unknown kind/);
});

// ---------- fixture ----------

const FIXTURE = join(ROOT, "public/city/fixture");
function loadCity(dir) {
  const manifest = validateManifest(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
  const store = new Map();
  for (const [cx, cz] of manifest.chunks.list) {
    store.set(chunkKey(cx, cz), decodeChunk(new Uint8Array(gunzipSync(readFileSync(join(dir, "chunks", `${chunkKey(cx, cz)}.bin`)))), manifest.parents));
  }
  return { manifest, store, get: (cx, cz) => store.get(chunkKey(cx, cz)) ?? null };
}
const neighboursIn = (city, c) => ({ n: city.get(c.cx, c.cz - 1), s: city.get(c.cx, c.cz + 1), e: city.get(c.cx + 1, c.cz), w: city.get(c.cx - 1, c.cz) });

test("fixture: LOD1 region triangles ≤ 30% of LOD0 for the same chunks; LOD2 below LOD1", () => {
  const city = loadCity(FIXTURE);
  const chunks = [...city.store.values()];
  const [rx, rz] = regionOf(chunks[0].cx, chunks[0].cz);
  assert.ok(chunks.every((c) => regionOf(c.cx, c.cz).join() === `${rx},${rz}`), "fixture is one region");
  let lod0 = 0;
  for (const c of chunks) {
    const m = meshChunk(c, neighboursIn(city, c));
    lod0 += tris(m.opaque) + tris(m.walls);
    assert.ok(tris(m.opaque) + tris(m.walls) <= 25000, `chunk ${c.cx},${c.cz} over the 25k LOD0 budget`);
  }
  const lod1 = tris(meshRegion(chunks, [], 1).opaque);
  const lod2 = tris(meshRegion(chunks, [], 2).opaque);
  console.log(`  fixture triangles: LOD0 ${lod0}, LOD1 ${lod1} (${((100 * lod1) / lod0).toFixed(1)}%), LOD2 ${lod2}`);
  assert.ok(lod1 <= 0.3 * lod0, `LOD1 ${lod1} > 30% of LOD0 ${lod0}`);
  assert.ok(lod2 < lod1);
});

test("fixture: region skip drops the LOD0 chunks and glow marks building walls", () => {
  const city = loadCity(FIXTURE);
  const chunks = [...city.store.values()];
  const full = meshRegion(chunks, [], 1).opaque;
  const skipped = meshRegion(chunks, [[57, 26], [58, 26]], 1).opaque;
  assert.ok(tris(skipped) < tris(full));
  assert.equal(full.glow.length, full.positions.length / 3);
  assert.ok(full.glow.some((g) => g === 255) && full.glow.some((g) => g === 0));
  for (let v = 0; v < skipped.positions.length / 3; v++) {
    const x = skipped.positions[v * 3], z = skipped.positions[v * 3 + 2];
    const inside = x > 64 && x < 192 && z > 128 && z < 192;
    assert.ok(!inside, `vertex ${x},${z} inside a skipped chunk`);
  }
});

test("fixture: worker request/reply shape with transferables", () => {
  const city = loadCity(FIXTURE);
  const c = city.get(57, 25);
  const { reply, transfer } = handleMeshRequest({ id: 7, kind: "chunk", lod: 0, chunk: c, ...neighboursIn(city, c) });
  assert.equal(reply.id, 7);
  assert.ok(reply.opaque && reply.walls);
  assert.ok(transfer.every((b) => b instanceof ArrayBuffer));
  assert.equal(new Set(transfer).size, transfer.length);
  assert.equal(transfer.length, 10, "positions, normals, colors, uvs, indices × 2 meshes");
  const r = handleMeshRequest({ id: "r", kind: "region", lod: 2, chunks: [...city.store.values()], skip: [[57, 25]] });
  assert.equal(r.reply.id, "r");
  assert.equal(r.reply.walls, undefined);
  assert.equal(r.transfer.length, 5, "positions, normals, colors, glow, indices");
});

test("mesher.js and mesher.worker.js import only shared/city.js (no three, no importmap)", () => {
  for (const f of ["mesher.js", "mesher.worker.js"]) {
    const src = readFileSync(join(ROOT, "public/js/city", f), "utf8");
    const specs = [...src.matchAll(/\bimport\s*(?:[^"';]*?\bfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g)].map((m) => m[1] ?? m[2]);
    const allowed = f === "mesher.js" ? ["../../shared/city.js"] : ["./mesher.js"];
    assert.deepEqual([...new Set(specs)], allowed, `${f} imports ${specs.join(", ")}`);
  }
});

test("[post-int] real downtown chunk 56,26 ≤ 25k triangles at LOD0", () => {
  const dir = join(ROOT, "public/city/sf");
  if (!existsSync(join(dir, "manifest.json"))) {
    console.log("  skip: public/city/sf not built yet (post-int gate)");
    return;
  }
  const version = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).version;
  if (version !== CITY_VERSION) {
    console.log(`  skip: public/city/sf is a v${version} build; this check reads v${CITY_VERSION} (waits for the v2 rebuild, post-int gate)`);
    return;
  }
  const city = loadCity(dir);
  const c = city.get(56, 26);
  assert.ok(c, "sf manifest has no chunk 56,26");
  const m = meshChunk(c, neighboursIn(city, c));
  const n = tris(m.opaque) + tris(m.walls);
  console.log(`  sf 56,26: ${n} triangles`);
  assert.ok(n <= 25000, `56,26 has ${n} triangles`);
});

console.log(`mesher.check: ${passed} passed`);
