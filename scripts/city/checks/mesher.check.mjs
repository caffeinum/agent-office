// W4 mesher checks (spec §5 W4, spec-v2 §8 W4): triangle counts, neighbour culling, pillars, LOD1 vs LOD0 on the
// fixture, winding, the worker request/reply shape, the import rule for mesher.js / mesher.worker.js; v2: per-column
// top (taper and bowl face counts against an independent reference), facade/cap/accent styling, props, unbuilt
// land and skirts, the landmark instance layer, hill shading and the compass maths.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  ACCENT_NONE, BUILDING_PALETTE, CAP, CHUNK, CITY_VERSION, COLUMNS, FACADE, PALETTE_INDEX, SF_PROJ, SURFACE, SURFACE_COLORS,
  UNBUILT_COLORS, chunkKey, decodeChunk, decodeLandmarks, decodeLandmask, lonLatToBlock, regionOf, validateChunk, validateManifest,
  CROSSWALK_STYLE, ROAD_FLAG, STREET_LINE, STREET_POINT, STREET_Q, TRACK_FLAG, decodeStreet, rotByte,
} from "../../../public/shared/city.js";
import {
  ARCADE_HEIGHT, CANOPY_CELL, HILL_CONTOUR, PROP_QUADS, SLOPE_FLAT, canopyHeight, capColorId, handleMeshRequest, hillShade, linearBytes, meshChunk,
  meshRegion, meshUnbuilt, slopeLevel, slopeShade, srgbToLinear,
} from "../../../public/js/city/mesher.js";
import { landmarkInstances, landmarkTriangles } from "../../../public/js/city/meshlayer.js";
import { binStreet, pointQuads } from "../../../public/js/city/streetmesh.js";
import { CURB } from "../../../public/js/city/streetkit.js";
import { buildNetwork, laneOffsets, pointOn, polyline } from "../../../public/js/city/traffic.js";
import { createUnmapped } from "../../../public/js/city/unmapped.js";
import { northVector, screenNorthDeg } from "../../../public/js/city/compass.js";
import { FRAME_BUDGET, cameraClip, culled, frameBudget } from "../perf.mjs";

const DEFAULT_POLAR_PERF = 0.95;

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
  // grass red channel: sRGB → linear at full brightness, times the hill shade at y = 3 (flat: slope shade 1)
  const red = parseInt(SURFACE_COLORS[SURFACE.GRASS].slice(1, 3), 16);
  assert.equal(opaque.colors[0], Math.round(srgbToLinear(red / 255) * hillShade(SURFACE.GRASS, 3) * 255));
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
  assert.equal(transfer.length, 19, "positions, normals, colors, uvs, indices × 2 meshes + positions, normals, colors, glow, indices of props + positions, normals, colors, indices of decals");
  const r = handleMeshRequest({ id: "r", kind: "region", lod: 2, chunks: [...city.store.values()], skip: [[57, 25]] });
  assert.equal(r.reply.id, "r");
  assert.equal(r.reply.walls, undefined);
  assert.equal(r.transfer.length, 5, "positions, normals, colors, glow, indices");
});

test("mesher.js, streetmesh.js, streetkit.js and mesher.worker.js import only relative plain modules (no three, no importmap)", () => {
  const allowed = {
    "mesher.js": ["../../shared/city.js", "./streetkit.js", "./streetmesh.js"],
    "streetmesh.js": ["../../shared/city.js", "./streetkit.js"],
    "streetkit.js": [],
    "mesher.worker.js": ["./mesher.js"],
  };
  for (const [f, want] of Object.entries(allowed)) {
    const src = readFileSync(join(ROOT, "public/js/city", f), "utf8");
    const specs = [...src.matchAll(/\bimport\s*(?:[^"';]*?\bfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g)].map((m) => m[1] ?? m[2]);
    assert.deepEqual([...new Set(specs)], want, `${f} imports ${specs.join(", ")}`);
  }
});


// ---------- v2: per-column top, styling, props ----------

/** Quads of a mesh with the colour of their top-most vertex (side quads: shade 1 there). */
function quadsWithColor(m) {
  return quads(m).map((q, n) => {
    let best = -Infinity, rgb = null;
    for (let k = 0; k < 4; k++) {
      const v = n * 4 + k;
      const y = m.positions[v * 3 + 1];
      if (y > best) { best = y; rgb = Array.from(m.colors.subarray(v * 3, v * 3 + 3)); }
    }
    return { ...q, rgb, glow: m.glow ? m.glow[n * 4] : undefined };
  });
}
const inBox = (q, [x0, z0, x1, z1]) => q.min[0] >= x0 && q.max[0] <= x1 && q.min[2] >= z0 && q.max[2] <= z1;
const area = (q) => (q.max[1] - q.min[1]) * (q.normal[0] !== 0 ? q.max[2] - q.min[2] : q.max[0] - q.min[0]);
/** Footprint [x0, z0, x1, z1] (local, exclusive end) of the columns whose entry has one of `ids`. */
function footprint(c, ids) {
  let x0 = CHUNK, z0 = CHUNK, x1 = -1, z1 = -1;
  for (let k = 0; k < COLUMNS; k++) {
    if (!c.bldg[k] || !ids.has(c.buildings[c.bldg[k] - 1].id)) continue;
    const x = k % CHUNK, z = Math.floor(k / CHUNK);
    x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x + 1); z1 = Math.max(z1, z + 1);
  }
  assert.ok(x1 > 0, `no columns for ${[...ids]}`);
  return [x0, z0, x1, z1];
}

/**
 * Independent reference for building walls: per boundary line, the exposed interval of each column of `ids`
 * ([max(base, neighbour height), column top)), split at accentFrom and by the arcade pattern; a quad per run of
 * equal (lo, hi, colour, contact) along the line. The footprint must not touch the chunk edge.
 * → {quads, area}
 */
function refWalls(c, ids) {
  const h = (x, z) => {
    const k = z * CHUNK + x;
    return c.bldg[k] ? c.top[k] : c.ground[k];
  };
  let quadsN = 0, areaN = 0;
  for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (let line = 0; line < CHUNK; line++) {
      const last = new Map();
      for (let pos = 0; pos < CHUNK; pos++) {
        const [x, z] = di !== 0 ? [line, pos] : [pos, line];
        const k = z * CHUNK + x;
        if (!c.bldg[k]) continue;
        const B = c.buildings[c.bldg[k] - 1];
        if (!ids.has(B.id)) continue;
        assert.ok(x + di >= 0 && x + di < CHUNK && z + dj >= 0 && z + dj < CHUNK, "reference footprint touches the chunk edge");
        const n1 = h(x + di, z + dj);
        const lo = Math.max(B.base, n1), hi = c.top[k];
        if (hi <= lo) continue;
        const cuts = [lo, hi];
        if (B.accentFrom !== ACCENT_NONE && B.accentFrom > lo && B.accentFrom < hi) cuts.push(B.accentFrom);
        if (B.facade === FACADE.ARCADE && B.base + ARCADE_HEIGHT > lo && B.base + ARCADE_HEIGHT < hi) cuts.push(B.base + ARCADE_HEIGHT);
        cuts.sort((a, b) => a - b);
        for (let t = 0; t + 1 < cuts.length; t++) {
          const a = cuts[t], b = cuts[t + 1];
          const accent = B.accentFrom !== ACCENT_NONE && a >= B.accentFrom;
          const arch = B.facade === FACADE.ARCADE && a < B.base + ARCADE_HEIGHT && pos % 2 === 1;
          const key = `${a},${b},${accent},${arch},${a === n1}`;
          if (last.get(key) !== pos - 1) quadsN++;
          last.set(key, pos);
          areaN += b - a;
        }
      }
    }
  }
  return { quads: quadsN, area: areaN };
}

const sideQuadsIn = (meshes, box) => meshes.flatMap((m) => quadsWithColor(m)).filter((q) => isSide(q) && inBox(q, box));

test("fixture taper: one wall quad per ring face (28), tops at every tier, matches the reference", () => {
  const city = loadCity(FIXTURE);
  const c = city.get(58, 25);
  const taper = c.buildings.find((b) => b.top === 81 && b.facade === FACADE.WINDOWS && b.parent === 0);
  assert.ok(taper, "fixture taper entry (top 81)");
  const ids = new Set([taper.id]);
  const box = footprint(c, ids);
  const m = meshChunk(c, neighboursIn(city, c));
  const sides = sideQuadsIn([m.opaque, m.walls], box);
  const ref = refWalls(c, ids);
  assert.equal(sides.length, 28, "7 rings × 4 faces");
  assert.equal(sides.length, ref.quads);
  assert.equal(sides.reduce((n, q) => n + area(q), 0), ref.area, "exposed wall area");
  assert.ok(sides.every((q) => inBox(q, box)) && quads(m.walls).filter((q) => inBox(q, box)).length === 28, "facade 0: every taper wall is in the window-atlas mesh");
  const tops = new Set(quads(m.opaque).filter((q) => q.normal[1] === 1 && inBox(q, box) && q.min[1] > 1).map((q) => q.min[1]));
  assert.deepEqual([...tops].sort((a, b) => a - b), [40, 50, 58, 64, 70, 76, 80].map((t) => t + taper.base));
});

test("fixture bowl: stand walls match the reference, rows of seats, 6 emissive props", () => {
  const city = loadCity(FIXTURE);
  const c = city.get(56, 27);
  const stands = c.buildings.find((b) => b.cap === CAP.SEATS);
  assert.ok(stands && stands.parent === 1002 && stands.facade === FACADE.ARCADE, "fixture stands entry");
  const ids = new Set([stands.id]);
  const box = footprint(c, ids);
  const m = meshChunk(c, neighboursIn(city, c));
  const ref = refWalls(c, ids);
  const own = (q) => {
    const x = Math.floor((q.min[0] + q.max[0]) / 2 - (q.normal[0] > 0 ? 0.5 : q.normal[0] < 0 ? -0.5 : 0));
    const z = Math.floor((q.min[2] + q.max[2]) / 2 - (q.normal[2] > 0 ? 0.5 : q.normal[2] < 0 ? -0.5 : 0));
    return x >= 0 && z >= 0 && x < CHUNK && z < CHUNK && c.bldg[z * CHUNK + x] && ids.has(c.buildings[c.bldg[z * CHUNK + x] - 1].id);
  };
  const standSides = sideQuadsIn([m.opaque, m.walls], box).filter((q) => q.min[1] >= stands.base && own(q));
  assert.equal(standSides.length, ref.quads, "stand wall quads");
  assert.equal(standSides.reduce((n, q) => n + area(q), 0), ref.area, "stand wall area");
  assert.equal(quads(m.walls).filter((q) => inBox(q, box)).length, 0, "arcade facade: no window-atlas walls");
  const seatRows = quadsWithColor(m.opaque).filter((q) => q.normal[1] === 1 && inBox(q, box) && q.min[1] > stands.base);
  const heights = new Set(seatRows.map((q) => q.min[1]));
  assert.deepEqual([...heights].sort(), [1, 2, 3].map((h) => stands.base + h), "stand rows 1..3 above the field");
  assert.notEqual(capColorId(stands, 2), capColorId(stands, 3), "seat rows alternate colour");
  const field = quads(m.opaque).filter((q) => q.normal[1] === 1 && q.min[1] === 1 && q.min[0] >= 20 && q.max[0] <= 40 && q.min[2] >= 12 && q.max[2] <= 32);
  assert.ok(field.length > 0, "the field is ground (no roof)");
  assert.equal(c.props.length, 6);
  const props = quadsWithColor(m.props);
  assert.equal(props.length, 6 * PROP_QUADS, "6 light towers × 5 quads");
  assert.ok(props.every((q) => q.glow === 255), "light towers are emissive");
  assert.equal(m.props.glow.length, m.props.positions.length / 3);
});

test("fixture: the spire prop sits on the taper, non-emissive", () => {
  const city = loadCity(FIXTURE);
  const c = city.get(58, 25);
  const m = meshChunk(c, neighboursIn(city, c));
  const props = quadsWithColor(m.props);
  assert.equal(props.length, PROP_QUADS);
  const [p] = c.props;
  assert.ok(props.every((q) => q.glow === 0 && q.min[0] >= p.lx && q.max[0] <= p.lx + 1 && q.min[1] >= p.y0 && q.max[1] <= p.y1));
  assert.deepEqual(props.find((q) => q.normal[1] === 1).rgb, linearBytes(BUILDING_PALETTE[p.color]));
});

test("fixture: facade-1 buildings get no window UVs (scoreboard, ferry tower)", () => {
  const city = loadCity(FIXTURE);
  for (const [cx, cz, pick] of [[56, 27, (b) => b.facade === FACADE.BLANK], [58, 25, (b) => b.facade === FACADE.BLANK]]) {
    const c = city.get(cx, cz);
    const B = c.buildings.find(pick);
    assert.ok(B, `facade-1 entry in ${cx},${cz}`);
    const box = footprint(c, new Set([B.id]));
    const m = meshChunk(c, neighboursIn(city, c));
    assert.equal(quads(m.walls).filter((q) => inBox(q, box)).length, 0, `${cx},${cz} id ${B.id}: no atlas walls`);
    const plain = quads(m.opaque).filter((q) => isSide(q) && inBox(q, box) && q.max[1] > B.base);
    assert.ok(plain.length >= 4, `${cx},${cz} id ${B.id}: walls drawn plain`);
  }
});

test("fixture: the ferry tower accent band starts at accentFrom, dome cap in the accent colour", () => {
  const city = loadCity(FIXTURE);
  const c = city.get(58, 25);
  const tower = c.buildings.find((b) => b.accentFrom !== ACCENT_NONE);
  assert.ok(tower && tower.parent === 1001 && tower.cap === CAP.DOME);
  const box = footprint(c, new Set([tower.id]));
  const m = meshChunk(c, neighboursIn(city, c));
  const sides = quadsWithColor(m.opaque).filter((q) => isSide(q) && inBox(q, box) && q.max[1] > tower.base);
  const accent = linearBytes(BUILDING_PALETTE[tower.accent]);
  const body = linearBytes(BUILDING_PALETTE[tower.palette]);
  const above = sides.filter((q) => q.min[1] >= tower.accentFrom);
  const below = sides.filter((q) => q.max[1] <= tower.accentFrom);
  assert.ok(above.length > 0 && below.length > 0, "walls on both sides of the band");
  assert.equal(above.length + below.length, sides.length, "no wall quad straddles accentFrom");
  assert.ok(sides.some((q) => q.min[1] === tower.accentFrom), "a quad starts exactly at accentFrom");
  for (const q of above) assert.deepEqual(q.rgb, accent);
  for (const q of below) assert.deepEqual(q.rgb, body);
  const caps = quads(m.opaque).filter((q) => q.normal[1] === 1 && inBox(q, box) && q.min[1] === tower.top);
  assert.ok(caps.length >= 1, "dome cap face");
});

test("styling: arcade arches alternate per column, ribs split columns, parking bands, crown/spire/green caps", () => {
  const mk = (facade, cap, h = 9) => {
    const c = flatChunk(20, 20, 3);
    for (let x = 20; x < 26; x++) {
      for (let z = 20; z < 23; z++) { c.bldg[z * CHUNK + x] = 1; c.top[z * CHUNK + x] = 3 + h; }
    }
    c.buildings.push({ id: 5, parent: 0, base: 3, top: 3 + h, accentFrom: ACCENT_NONE, palette: 12, cap, facade, accent: 22 });
    const m = meshChunk(validateChunk(c), around(c));
    return { m, south: quads(m.opaque).filter((q) => q.normal[2] === 1 && q.min[2] === 23) };
  };
  assert.equal(mk(FACADE.BLANK, CAP.FLAT).south.length, 1, "blank: one quad");
  assert.equal(mk(FACADE.RIBBED, CAP.FLAT).south.length, 6, "ribbed: one quad per column");
  assert.equal(mk(FACADE.ARCADE, CAP.FLAT).south.length, 6 + 1, "arcade: 6 arch columns + one wall above");
  assert.equal(mk(FACADE.PARKING, CAP.FLAT, 9).south.length, 7, "parking: 9 blocks = 4 deck bands + 3 openings");
  assert.equal(mk(FACADE.WINDOWS, CAP.FLAT).m.walls.indices.length / 6, 4, "windows: the 4 walls are atlas walls");
  const roofOf = (cap) => quadsWithColor(mk(FACADE.BLANK, cap).m.opaque).filter((q) => q.normal[1] === 1 && q.min[1] === 12)[0];
  const centre = (cap) => {
    const m = mk(FACADE.BLANK, cap).m.opaque;
    for (let v = 0; v < m.positions.length / 3; v++) {
      if (m.positions[v * 3 + 1] === 12 && m.normals[v * 3 + 1] > 0) return Array.from(m.colors.subarray(v * 3, v * 3 + 3));
    }
    throw new Error("no roof");
  };
  assert.ok(roofOf(CAP.FLAT));
  const brightest = (rgb) => Math.max(...rgb);
  assert.ok(brightest(centre(CAP.CROWN)) > brightest(centre(CAP.FLAT)), "crown is lighter than a flat roof");
  const green = centre(CAP.GREEN);
  assert.ok(green[1] > green[0] && green[1] > green[2], "green roof is green");
  assert.notDeepEqual(centre(CAP.SPIRE), centre(CAP.FLAT), "spire cap is metal");
});

test("LOD1/2 use the per-column top (taper steps survive downsampling) and LOD1 draws props", () => {
  const city = loadCity(FIXTURE);
  const chunks = [...city.store.values()];
  const lod1 = meshRegion(chunks, [], 1).opaque;
  const tops = new Set(quads(lod1).filter((q) => q.normal[1] === 1 && q.min[0] >= 128 + 12 && q.max[0] <= 128 + 26 && q.min[2] >= 64 + 2 && q.max[2] <= 64 + 16).map((q) => q.min[1]));
  assert.ok(tops.size >= 3, `taper keeps its steps at LOD1 (${[...tops]})`);
  const spire = quads(lod1).filter((q) => q.normal[1] === 1 && q.min[1] === 89);
  assert.equal(spire.length, 1, "spire prop top at LOD1");
  const lod2 = meshRegion(chunks, [], 2).opaque;
  assert.equal(quads(lod2).filter((q) => q.normal[1] === 1 && q.min[1] === 89).length, 0, "no props at LOD2");
});

// ---------- v2: unbuilt land, skirts, landmarks ----------

const loadMask = (dir, manifest) => decodeLandmask(new Uint8Array(gunzipSync(readFileSync(join(dir, manifest.landmask)))), manifest.chunks.grid);

test("fixture unbuilt land: paper tone at coarse height in cx 55 only, none in listed or water chunks", () => {
  const city = loadCity(FIXTURE);
  const mask = loadMask(FIXTURE, city.manifest);
  const { opaque } = meshUnbuilt(mask, city.manifest.chunks.list.map(([cx, cz]) => [cx, cz]), city.manifest.water);
  const qs = quadsWithColor(opaque);
  assert.ok(qs.length > 0);
  const paper = linearBytes(UNBUILT_COLORS.top);
  const tops = qs.filter((q) => q.normal[1] === 1 && q.min[1] === q.max[1]);
  assert.ok(qs.filter((q) => q.min[1] !== q.max[1]).every((q) => q.normal[1] === 1), "paper terrace sides face up (no stripe per step)");
  for (const q of tops) {
    const [cx0, cz0] = [Math.floor(q.min[0] / CHUNK), Math.floor(q.min[2] / CHUNK)];
    const [cx1, cz1] = [Math.floor((q.max[0] - 1) / CHUNK), Math.floor((q.max[2] - 1) / CHUNK)];
    assert.ok(cx0 === 55 && cx1 === 55 && cz0 >= 24 && cz1 <= 27, `unbuilt top ${q.min}–${q.max} outside the unbuilt column`);
    assert.equal(q.min[1], 2);
    // paper tone at the hill shade of y = 2, times a slope hillshade in [slopeShade(0), slopeShade(15)]
    const flat = [0, 1, 2].map((i) => srgbToLinear(parseInt(UNBUILT_COLORS.top.slice(1 + 2 * i, 3 + 2 * i), 16) / 255) * hillShade(68, 2) * 255);
    assert.ok(q.rgb.every((v, i) => v >= Math.floor(flat[i] * slopeShade(0)) - 1 && v <= Math.ceil(flat[i] * slopeShade(15)) + 1), `paper tone ${q.rgb} vs ${paper}`);
  }
  assert.ok(tops.reduce((n, q) => n + (q.max[0] - q.min[0]) * (q.max[2] - q.min[2]), 0) === CHUNK * CHUNK * 4, "4 unbuilt chunks covered");
  const u = createUnmapped(city.manifest, mask);
  assert.equal(u.kind(55, 25), "unbuilt");
  assert.equal(u.kind(59, 27), "water");
  assert.equal(u.kind(57, 25), "listed");
  assert.equal(u.kind(60, 25), "sea");
  assert.equal(u.heightAt(55 * CHUNK + 3, 25 * CHUNK + 3), 2);
  assert.equal(u.heightAt(60 * CHUNK + 3, 25 * CHUNK + 3), null);
  assert.equal(u.neighbour(59, 27, "s"), null, "water chunk: no skirt");
});

test("skirts: a listed chunk next to unbuilt land drops its edge only to the coarse height, in paper tone", () => {
  const c = flatChunk(30, 30, 5);
  const edge = new Int16Array(CHUNK).fill(2);
  const west = (m) => quadsWithColor(m.opaque).filter((q) => q.normal[0] === -1 && q.min[0] === 0);
  const skirt = west(meshChunk(c, { ...NONE, w: { unbuilt: edge } }));
  assert.equal(skirt.length, 1);
  assert.deepEqual([skirt[0].min[1], skirt[0].max[1]], [2, 5], "skirt from the ground down to the coarse height, not to 0");
  assert.deepEqual(skirt[0].rgb, linearBytes(UNBUILT_COLORS.side), "skirt in the paper side tone");
  const water = west(meshChunk(c, { ...NONE, w: null }));
  assert.deepEqual([water[0].min[1], water[0].max[1]], [0, 5], "against water the edge drops to 0");
  edge.fill(0, 0, 32);
  const half = west(meshChunk(c, { ...NONE, w: { unbuilt: edge } }));
  assert.deepEqual(half.map((q) => [q.min[1], q.min[2], q.max[2]]).sort(), [[0, 0, 32], [2, 32, 64]], "sea cells on the edge still drop to 0");
  assert.throws(() => meshChunk(c, { ...NONE, w: { unbuilt: new Int16Array(3) } }), /unbuilt edge must be an Int16Array\[64\]/);
});

test("fixture seam: listed ground 1 next to unbuilt 2 needs no skirt; the unbuilt side drops to the listed mask height", () => {
  const city = loadCity(FIXTURE);
  const mask = loadMask(FIXTURE, city.manifest);
  const u = createUnmapped(city.manifest, mask);
  const c = city.get(56, 25);
  const nb = u.neighbour(55, 25, "w");
  assert.ok(nb && nb.unbuilt.every((h) => h === 2));
  const west = quads(meshChunk(c, { ...neighboursIn(city, c), w: nb }).opaque).filter((q) => q.normal[0] === -1 && q.min[0] === 0);
  assert.equal(west.length, 0, "the higher unbuilt neighbour covers the listed edge");
  const { opaque } = meshUnbuilt(mask, city.manifest.chunks.list.map(([cx, cz]) => [cx, cz]), city.manifest.water);
  const east = quads(opaque).filter((q) => q.min[0] === 56 * CHUNK && q.max[0] === 56 * CHUNK && q.min[1] !== q.max[1]);
  assert.ok(east.length > 0 && east.every((q) => q.max[1] === 2 && q.min[1] === 1), `unbuilt east side 2 → 1 (${east.map((q) => `${q.min[1]}-${q.max[1]}`)})`);
});

test("fixture landmarks.bin: 50 boxes → instanced layer data inside the grid", () => {
  const city = loadCity(FIXTURE);
  const boxes = decodeLandmarks(new Uint8Array(gunzipSync(readFileSync(join(FIXTURE, city.manifest.landmarks)))), city.manifest.chunks.grid);
  assert.equal(boxes.length, 50);
  const inst = landmarkInstances(boxes);
  assert.equal(inst.solid.count + inst.emissive.count, 50);
  assert.equal(inst.solid.matrices.length, inst.solid.count * 16);
  const b = boxes[0];
  const m = inst.solid.matrices;
  assert.deepEqual([m[0], m[5], m[10], m[12], m[13], m[14], m[15]], [b.sx, b.y1 - b.y0, b.sz, b.x, b.y0, b.z, 1]);
  const gg = BUILDING_PALETTE[PALETTE_INDEX["golden-gate"]];
  assert.ok(Math.abs(inst.solid.colors[0] - srgbToLinear(parseInt(gg.slice(1, 3), 16) / 255)) < 1e-6);
  assert.equal(landmarkTriangles(boxes), 600);
  assert.throws(() => landmarkInstances([{ ...b, color: 250 }]), /not a palette index/);
});

test("hill shading: higher ground is lighter, contour every HILL_CONTOUR blocks on natural ground only", () => {
  assert.ok(hillShade(SURFACE.GRASS, 41) > hillShade(SURFACE.GRASS, 5));
  assert.ok(hillShade(SURFACE.GRASS, HILL_CONTOUR * 3) < hillShade(SURFACE.GRASS, HILL_CONTOUR * 3 - 1));
  assert.ok(hillShade(SURFACE.ROAD, HILL_CONTOUR * 3) > hillShade(SURFACE.ROAD, HILL_CONTOUR * 3 - 1), "roads have no contour");
  const c = flatChunk(9, 9, 1);
  for (let k = 0; k < COLUMNS; k++) c.ground[k] = 1 + Math.floor((k % CHUNK) / 2);
  const tops = quadsWithColor(meshChunk(validateChunk(c), NONE).opaque).filter((q) => q.normal[1] === 1);
  const at = (y) => tops.find((q) => q.min[1] === y && q.min[0] > 2 && q.max[0] < 62);
  assert.ok(at(30).rgb[1] < at(29).rgb[1], "contour terrace at y=30 is darker than y=29");
  assert.ok(at(29).rgb[1] > at(5).rgb[1], "y=29 is lighter than y=5");
  assert.ok(SURFACE_COLORS[SURFACE.GRASS]);
});

test("compass: north vector and screen bearing under the option-a rotation", () => {
  const n = northVector(SF_PROJ);
  const a = lonLatToBlock(-122.4, 37.78), b = lonLatToBlock(-122.4, 37.79);
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  assert.ok(Math.abs(n.x - (b.x - a.x) / len) < 1e-9 && Math.abs(n.z - (b.z - a.z) / len) < 1e-9);
  const deg = (Math.atan2(n.x, -n.z) * 180) / Math.PI;
  assert.ok(Math.abs(Math.abs(deg) - SF_PROJ.rotDeg) < 0.05, `north is ${deg}° off block −z, rotDeg ${SF_PROJ.rotDeg}`);
  assert.ok(Math.abs(screenNorthDeg({ x: 0, z: -1 }, 0)) < 1e-9, "camera at +z looking −z: −z is up");
  assert.ok(Math.abs(screenNorthDeg({ x: 1, z: 0 }, 0) - 90) < 1e-9, "+x is to the right");
  assert.ok(Math.abs(Math.abs(screenNorthDeg({ x: 0, z: -1 }, Math.PI)) - 180) < 1e-9, "orbit half way round: −z points down");
  assert.ok(Math.abs(screenNorthDeg(n, 0) - deg) < 1e-9);
});

test("perf frustum: boxes in front of the orbit camera survive, boxes behind it are culled", () => {
  const clip = cameraClip({ x: 1000, y: 0, z: 1000, dist: 400, az: 0, polar: DEFAULT_POLAR_PERF });
  assert.equal(culled(clip, [990, 0, 990], [1010, 20, 1010]), false, "the target");
  assert.equal(culled(clip, [990, 0, 1800], [1010, 20, 1820]), true, "behind the camera");
  assert.equal(culled(clip, [3000, 0, 990], [3010, 20, 1010]), true, "far to the side");
  const fixture = loadCity(FIXTURE);
  const mask = loadMask(FIXTURE, fixture.manifest);
  const boxes = decodeLandmarks(new Uint8Array(gunzipSync(readFileSync(join(FIXTURE, fixture.manifest.landmarks)))), fixture.manifest.chunks.grid);
  const street = binStreet(decodeStreet(new Uint8Array(gunzipSync(readFileSync(join(FIXTURE, fixture.manifest.street)))), fixture.manifest.chunks.grid));
  const f = frameBudget({ ...fixture, mask, boxes, street }, { ...fixture.manifest.spawn, polar: DEFAULT_POLAR_PERF });
  assert.ok(f.triangles > 0 && f.triangles <= FRAME_BUDGET.triangles && f.calls <= FRAME_BUDGET.calls, JSON.stringify(f));
});

test("[post-int] real downtown chunks (Salesforce 74,63 and the largest, 76,56) ≤ 25k triangles at LOD0", () => {
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
  for (const [cx, cz] of [[74, 63], [76, 56]]) {
    const c = city.get(cx, cz);
    assert.ok(c, `sf manifest has no chunk ${cx},${cz}`);
    const m = meshChunk(c, neighboursIn(city, c));
    const n = tris(m.opaque) + tris(m.walls) + (m.props ? tris(m.props) : 0);
    console.log(`  sf ${cx},${cz}: ${n} triangles`);
    assert.ok(n <= 25000, `${cx},${cz} has ${n} triangles`);
  }
});

console.log(`mesher.check: ${passed} passed`);

test("slope hillshade: flat is exactly 1, sun-facing slopes are lighter, slopes away darker, levels clamp", () => {
  assert.equal(slopeLevel(0, 0), SLOPE_FLAT);
  assert.equal(slopeShade(SLOPE_FLAT), 1);
  // the sun sits toward −x, +z: ground rising toward +x tilts toward it (lighter), rising toward −x away (darker)
  assert.ok(slopeShade(slopeLevel(0.3, 0)) > 1);
  assert.ok(slopeShade(slopeLevel(-0.3, 0)) < 1);
  assert.equal(slopeLevel(-50, 50), 0);
  assert.equal(slopeLevel(50, -50), 15);
});

test("tree canopy: LOD0 draws one trunk-and-crown tree per FOREST clump (props), LOD1/2 a 2–4 block leaf crown", () => {
  const c = flatChunk(2, 2, 3);
  for (let k = 0; k < 64 * 8; k++) c.surface[k] = SURFACE.FOREST;
  c.deck[5] = 9;
  const { opaque, props } = meshChunk(c, around(c));
  const tops = quads(opaque).filter((q) => q.normal[1] === 1);
  assert.ok(!tops.some((q) => q.min[1] > 3 && q.min[1] !== 9), "LOD0 terrain stays flat under the trees");
  // world-aligned 3×3 clumps over rows 0..7 of chunk (2, 2): x 128..191, z 128..135 → clumps with ≥ 2 forest columns
  let clumps = 0;
  for (let cz = Math.floor(128 / CANOPY_CELL); cz <= Math.floor(135 / CANOPY_CELL); cz++) {
    for (let cx = Math.floor(128 / CANOPY_CELL); cx <= Math.floor(191 / CANOPY_CELL); cx++) {
      let n = 0;
      for (let z = cz * 3; z < cz * 3 + 3; z++) for (let x = cx * 3; x < cx * 3 + 3; x++) {
        const lx = x - 128, lz = z - 128;
        if (lx >= 0 && lx < 64 && lz >= 0 && lz < 8 && !(lz === 0 && lx === 5)) n++;
      }
      if (n >= 2) clumps++;
    }
  }
  assert.equal(props.indices.length / 6, clumps * 3 * PROP_QUADS, "trunk + two crown boxes per clump");
  const ys = Array.from({ length: props.positions.length / 3 }, (_, v) => props.positions[v * 3 + 1]);
  assert.ok(Math.min(...ys) >= 3 && Math.max(...ys) <= 3 + 4 + 0.35 + 1e-6, `trees between ground 3 and 3 + 4.35, got ${Math.min(...ys)}..${Math.max(...ys)}`);
  const region = meshRegion([c], [], 1).opaque;
  const crown = quads(region).filter((q) => q.normal[1] === 1 && q.min[2] >= 128 && q.min[2] < 136 && q.min[1] > 3 && q.min[1] < 9);
  assert.ok(crown.length > 0, "LOD1 keeps the leaf crown columns");
  for (let x = 0; x < 30; x++) {
    const h = canopyHeight(x, 7);
    assert.ok(h >= 2 && h <= 4);
    assert.equal(h, canopyHeight(Math.floor(x / CANOPY_CELL) * CANOPY_CELL, 7 - (7 % CANOPY_CELL)), "one height per clump");
  }
});

// ---------- street level: curbs, street.bin decals and furniture, binning, traffic ----------

/** A chunk with a 4-wide road (rows 30–33) between 1-wide sidewalks, everything at ground g. */
function streetChunk(cx, cz, g = 5) {
  const c = flatChunk(cx, cz, g, SURFACE.GRASS);
  for (let lz = 29; lz <= 34; lz++) for (let lx = 0; lx < 64; lx++) c.surface[lz * 64 + lx] = lz === 29 || lz === 34 ? SURFACE.SIDEWALK : SURFACE.ROAD;
  return c;
}

test("curb: LOD0 road tops sit CURB below the sidewalk, with a CURB-high face along every non-road edge", () => {
  const c = streetChunk(4, 4);
  const nb = around(c, (x, z) => streetChunk(x, z));
  const { opaque } = meshChunk(c, nb);
  const up = quads(opaque).filter((q) => q.normal[1] === 1);
  const roadTops = up.filter((q) => q.min[2] >= 30 && q.max[2] <= 34);
  assert.ok(roadTops.length > 0 && roadTops.every((q) => Math.abs(q.min[1] - (5 - CURB)) < 1e-6), "road tops at ground − CURB");
  assert.ok(up.filter((q) => q.max[2] <= 30).every((q) => q.min[1] === 5), "sidewalk and grass stay at ground");
  const curbs = quads(opaque).filter((q) => q.normal[1] === 0 && Math.abs(q.max[1] - q.min[1] - CURB) < 1e-6);
  assert.equal(curbs.length, 2 * 64, "one curb face per road column on each kerb");
  assert.ok(curbs.every((q) => q.max[1] === 5), "curb faces reach the sidewalk top");
  assert.ok(curbs.some((q) => q.normal[2] === 1) && curbs.some((q) => q.normal[2] === -1), "they face into the road");
  const lod1 = meshRegion([c], [], 1).opaque;
  assert.ok(!quads(lod1).some((q) => q.normal[1] === 1 && !Number.isInteger(q.min[1])), "LOD1/2 keep integer tops");
});

test("street.bin on a chunk: paint and rails on the road only, furniture on its columns, lamp heads glow", () => {
  const c = streetChunk(4, 4);
  const x4 = (x) => (4 * 64 + x) * STREET_Q, z4 = (z) => (4 * 64 + z) * STREET_Q;
  const street = {
    lines: [
      { kind: STREET_LINE.ROAD, flags: ROAD_FLAG.DOUBLE_YELLOW | ROAD_FLAG.MAJOR, width4: 16, lanes: 4, pts: Int16Array.from([x4(-5), z4(32), x4(70), z4(32)]) },
      { kind: STREET_LINE.CROSSWALK, flags: CROSSWALK_STYLE.LADDER, width4: 4, lanes: 0, pts: Int16Array.from([x4(20.5), z4(28.5), x4(20.5), z4(35.5)]) },
      { kind: STREET_LINE.TRACK, flags: TRACK_FLAG.CABLE, width4: 1, lanes: 0, pts: Int16Array.from([x4(0), z4(31), x4(64), z4(31)]) },
    ],
    points: [
      { kind: STREET_POINT.LAMP, rot: rotByte(0), x4: x4(10.5), z4: z4(29.6) },
      { kind: STREET_POINT.CAR, rot: rotByte(Math.PI / 2), x4: x4(40.5), z4: z4(33.5) },
      { kind: STREET_POINT.BENCH, rot: 0, x4: x4(70), z4: z4(29) },
    ],
  };
  const { decals, props } = meshChunk(c, around(c, (x, z) => streetChunk(x, z)), street);
  assert.ok(decals.indices.length > 0, "decals drawn");
  for (let v = 0; v < decals.positions.length / 3; v++) {
    const x = decals.positions[v * 3], y = decals.positions[v * 3 + 1], z = decals.positions[v * 3 + 2];
    assert.ok(x >= -1 && x <= 65, `decal vertex x ${x} stays in the chunk`);
    assert.ok(y > 5 - CURB && y < 5 - CURB + 0.05, `decal y ${y} just over the sunk road top`);
    assert.ok(z > 29.5 && z < 34.5, `decal z ${z} on the carriageway`);
  }
  const quadsOf = (m) => m.indices.length / 6;
  assert.equal(quadsOf(props), pointQuads(STREET_POINT.LAMP) + pointQuads(STREET_POINT.CAR), "the out-of-chunk bench is not drawn");
  const glowing = [];
  for (let v = 0; v < props.glow.length; v++) if (props.glow[v] === 255) glowing.push(props.positions[v * 3 + 1]);
  assert.ok(glowing.length >= 4 && glowing.every((y) => y > 5 + 2), "the lamp head glows, high on its pole");
  const carYs = [];
  for (let v = 0; v < props.positions.length / 3; v++) if (props.positions[v * 3] > 39 && props.positions[v * 3] < 42) carYs.push(props.positions[v * 3 + 1]);
  assert.ok(Math.abs(Math.min(...carYs) - (5 - CURB)) < 1e-6, "parked car wheels on the sunk road");
  assert.throws(() => meshChunk(c, NONE, { lines: [] }), /street must be \{lines, points\}/);
});

test("binStreet: lines go to every chunk they cross (padded by width), points to their own chunk", () => {
  const q = (v) => v * STREET_Q;
  const bins = binStreet({
    lines: [{ kind: STREET_LINE.ROAD, flags: 0, width4: 16, lanes: 0, pts: Int16Array.from([q(10), q(10), q(200), q(10)]) }],
    points: [{ kind: STREET_POINT.HYDRANT, rot: 0, x4: q(130), z4: q(70) }],
  });
  assert.deepEqual([...bins.keys()].sort(), ["0_0", "1_0", "2_0", "3_0", "2_1"].sort());
  assert.equal(bins.get("2_1").points.length, 1);
  assert.equal(bins.get("0_0").lines.length, 1);
});

test("traffic: lanes keep right of travel inside the carriageway; ways chain through shared vertices", () => {
  const road = (flags, width, lanes, pts) => ({ kind: STREET_LINE.ROAD, flags, width4: width * 4, lanes, pts: Int16Array.from(pts.map((v) => v * 4)) });
  const two = laneOffsets(road(0, 4, 2, [0, 0, 10, 0]));
  assert.ok(two.length === 1 && two[0] > 0.3 && two[0] < 2 - 0.3, `two-way lane ${two}`);
  const one = laneOffsets(road(ROAD_FLAG.ONEWAY, 6, 3, [0, 0, 10, 0]));
  assert.equal(one.length, 3);
  assert.ok(one.every((o) => Math.abs(o) < 3 - 0.3), `one-way lanes ${one} inside the kerbs`);
  assert.ok(one[0] < one[1] && one[1] < one[2]);
  const pl = polyline(Int16Array.from([0, 0, 40, 0, 40, 40]));
  assert.equal(pl.total, 20);
  const p = pointOn(pl, 15);
  assert.deepEqual([p.x, p.z, p.dx, p.dz], [10, 5, 0, 1]);
  const net = buildNetwork([road(0, 4, 2, [0, 0, 10, 0]), road(ROAD_FLAG.ONEWAY, 4, 1, [10, 0, 10, 10]), { ...road(0, 1, 0, [0, 0, 0, 5]), kind: STREET_LINE.CROSSWALK }], (l) => l.kind === STREET_LINE.ROAD, laneOffsets);
  assert.equal(net.ways.length, 2);
  assert.equal(net.ways[1].oneway, true);
  assert.equal(net.at.get("40,0").length, 2, "both ways meet at 10,0");
});
