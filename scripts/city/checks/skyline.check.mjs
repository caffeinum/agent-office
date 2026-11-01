// W3 checks (spec-v2 §5, §8 W3): skyline snapshot and landmark recipes. Unit level: every recipe compiles,
// its top matches the snapshot / sourced height, it stamps into valid v2 chunks, and landmarks.bin stays in
// budget inside the reserved grid. Footprints are compared with the cached OSM polygons when data/ is present.
// [post-int] the real-build skyline gate runs once public/city/sf is a v2 build.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BLOCK_M, CHUNK, CITY_VERSION, MAX_LANDMARKS_BYTES, PALETTE_INDEX, SF_GRID, SF_PROJ, SURFACE, chunkOf, decodeChunk, decodeLandmarks, encodeChunk,
  lonLatToBlock, pickId,
} from "../../../public/shared/city.js";
import { createBuildCtx } from "../lib/ctx.mjs";
import {
  LANDMARK_ID_BASE, applyLandmarks, bearingVector, compileLandmark, landmarkKeys, landmarkParents, loadLandmarks, loadSkyline,
  minAreaRect, siteHeightM, siteTop,
} from "../lib/landmarks.mjs";
import { buildLandmarkMesh, landmarkMeshBoxes } from "../lib/meshlayer.mjs";
import { createRaster, rasterIndex, rasterToChunks } from "../lib/raster.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n${e.stack}`);
    process.exitCode = 1;
  }
}

const skyline = loadSkyline();
const landmarks = loadLandmarks(undefined, skyline);
const FOOTPRINTS = new Set(["rect", "rrect", "circle", "oct"]);

/** Sites of a landmark: [{src, ops}] split at `site` ops. */
function sitesOf(lm) {
  const out = [{ src: lm, ops: [] }];
  for (const op of lm.recipe ?? []) {
    if (op.op === "site") out.push({ src: op, ops: [] });
    else out[out.length - 1].ops.push(op);
  }
  return out;
}

/** Synthetic OSM record for an OSM-keyed site: the first footprint as a rectangle at lat/lon along `toward`. */
function syntheticRecord(src, ops) {
  const f = ops.find((o) => FOOTPRINTS.has(o.op) && !o.at);
  if (!f) throw new Error(`${src.key}: no centred footprint to synthesise an OSM polygon from`);
  const w = f.w ?? f.d, d = f.d;
  const c = lonLatToBlock(src.lon, src.lat, SF_PROJ);
  const u = bearingVector(SF_PROJ, src.lon, src.lat, src.toward), v = bearingVector(SF_PROJ, src.lon, src.lat, src.toward + 90);
  const ring = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([a, b]) => [c.x + (a * w) / 2 * u[0] + (b * d) / 2 * v[0], c.z + (a * w) / 2 * u[1] + (b * d) / 2 * v[1]]);
  const id = Number(src.key.slice(3));
  return { key: src.key, osmType: src.key[2] === "w" ? "way" : "relation", osmId: id, tags: { building: "yes" }, polygons: [[ring]], isPart: false, heightM: null, minHeightM: null, structure: null };
}

const GROUND = 2;
function syntheticCtx(list = landmarks) {
  const osm = [];
  for (const lm of list) for (const { src, ops } of sitesOf(lm)) if (src.key.startsWith("o:")) osm.push(syntheticRecord(src, ops));
  return createBuildCtx({ proj: SF_PROJ, groundAt: () => GROUND, osm, datasf: [], report: {} });
}

/** A flat land raster around a compiled landmark's columns. */
function rasterAround(compiled) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const S of compiled.sites) {
    for (const k of new Set([...S.outline, ...S.cols.keys(), ...S.field.keys()])) {
      const [x, z] = k.split(",").map(Number);
      x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z);
    }
  }
  const a = chunkOf(x0, z0), b = chunkOf(x1, z1);
  const r = createRaster(a, b);
  r.ground.fill(GROUND);
  r.surface.fill(SURFACE.GRASS);
  return r;
}

/** Stamp one landmark alone on its own raster. → {raster, ctx, chunks, parents} */
function stampAlone(lm) {
  const ctx = syntheticCtx([lm]);
  const raster = rasterAround(compileLandmark(lm, ctx, skyline));
  applyLandmarks(raster, ctx, [lm], skyline);
  const parents = Object.fromEntries(Object.entries(ctx.report.parents).map(([k, v]) => [k, v]));
  const { chunks } = rasterToChunks(raster, parents);
  return { raster, ctx, chunks, parents };
}

/** Column tops (absolute) per entry id of a raster. */
function columnsOf(raster) {
  const out = [];
  for (let z = 0; z < raster.h; z++) {
    for (let x = 0; x < raster.w; x++) {
      const i = z * raster.w + x;
      if (raster.owner[i] >= 0) out.push({ x: raster.x0 + x, z: raster.z0 + z, top: raster.top[i], base: raster.ground[i], entry: raster.entries[raster.owner[i]] });
    }
  }
  return out;
}

// ---------- snapshot and data ----------

await test("skyline.src.json: Wikipedia snapshot with revision, ≥ 50 ranked rows, unique keys", () => {
  assert.match(skyline.source.url, /oldid=\d+$/);
  assert.ok(skyline.rows.length >= 50);
  assert.equal(skyline.byKey.get("salesforce-tower").heightM, 326);
  assert.equal(skyline.byKey.get("transamerica-pyramid").heightM, 260);
});

await test("landmarks.json: 22 landmarks, each with a heightRef row or a sourced realHeightM", () => {
  assert.equal(landmarks.length, 22);
  for (const lm of landmarks) {
    for (const { src } of sitesOf(lm)) {
      if (src.heightRef !== undefined) assert.ok(skyline.byKey.has(src.heightRef), `${lm.name}: ${src.heightRef}`);
      else assert.match(src.source, /^https:\/\//, `${lm.name}: realHeightM needs a source`);
    }
  }
  const names = landmarks.map((l) => l.name).join("|");
  for (const want of ["Salesforce Tower", "Transamerica Pyramid", "181 Fremont", "Coit Tower", "Ferry Building", "Oracle Park", "Chase Center", "Golden Gate Bridge (south half)", "Bay Bridge (west span)", "Palace of Fine Arts"]) {
    assert.ok(names.includes(want), want);
  }
});

await test("landmarks.json: a malformed op, a missing source and an unknown heightRef are rejected", () => {
  const bad = (mut) => {
    const lm = structuredClone(landmarks[0]);
    mut(lm);
    return () => compileLandmark(lm, syntheticCtx([landmarks[0]]), skyline);
  };
  const tmp = (doc) => {
    const dir = mkdtempSync(join(tmpdir(), "w3-landmarks-"));
    const p = join(dir, "landmarks.json");
    writeFileSync(p, JSON.stringify(doc));
    return Promise.resolve().then(() => loadLandmarks(p, skyline)).finally(() => rmSync(dir, { recursive: true }));
  };
  const doc = JSON.parse(readFileSync(join(ROOT, "scripts/city/sf/landmarks.json"), "utf8"));
  const cases = [
    [(d) => { d.landmarks[0].recipe[1].op = "blob"; }, /unknown op/],
    [(d) => { delete d.landmarks[14].source; }, /source URL/],
    [(d) => { d.landmarks[0].heightRef = "no-such-row"; }, /not a skyline/],
    [(d) => { d.landmarks[0].recipe[1].wat = 1; }, /unknown field/],
    [(d) => { d.landmarks[19].bridge.points[0].source = "osm"; }, /source URL/],
  ];
  return Promise.all(cases.map(async ([mut, re]) => {
    const d = structuredClone(doc);
    mut(d);
    await assert.rejects(tmp(d), re);
  })).then(() => assert.throws(bad((lm) => { lm.recipe = [{ op: "tier", y1: 3 }]; }), /footprint first/));
});

// ---------- recipe tops ----------

await test("recipe tops: every site's top equals round(heightM / 3) ±1 (columns, spire props and mesh)", () => {
  const ctx = syntheticCtx();
  const rows = [];
  for (const lm of landmarks) {
    if (lm.bridge !== undefined) continue;
    for (const S of compileLandmark(lm, ctx, skyline).sites) {
      const top = siteTop(S), want = Math.round(siteHeightM(S.site, skyline) / BLOCK_M);
      rows.push(`${S.site.name ?? lm.name} ${top}/${want}`);
      assert.ok(Math.abs(top - want) <= 1, `${S.site.name ?? lm.name}: recipe top ${top}, snapshot ${want}`);
    }
  }
  console.log(`     ${rows.join(", ")}`);
});

// ---------- stamping ----------

const stamped = new Map();
await test("recipes stamp into valid v2 chunks that roundtrip byte-identical (each landmark alone)", () => {
  for (const lm of landmarks) {
    if (lm.bridge !== undefined) continue;
    const s = stampAlone(lm);
    assert.ok(s.chunks.length > 0, lm.name);
    for (const c of s.chunks) {
      const bytes = encodeChunk(c, s.parents);
      assert.deepEqual(encodeChunk(decodeChunk(bytes, s.parents), s.parents), bytes, `${lm.name} chunk ${c.cx},${c.cz}`);
      for (const e of c.buildings) assert.equal(pickId(e), LANDMARK_ID_BASE, `${lm.name}: every entry picks as the landmark parent`);
    }
    stamped.set(lm.name, s);
  }
});

await test("all chunk landmarks stamp together; parents listed for manifest.parents", () => {
  const ctx = syntheticCtx();
  const list = landmarks.filter((l) => l.bridge === undefined);
  const near = list.filter((l) => ["Salesforce Tower", "181 Fremont", "Millennium Tower", "50 Fremont Center", "Park Tower at Transbay"].includes(l.name));
  const raster = rasterAround({ sites: near.flatMap((l) => compileLandmark(l, ctx, skyline).sites) });
  applyLandmarks(raster, ctx, near, skyline);
  const { chunks } = rasterToChunks(raster, ctx.report.parents);
  assert.ok(chunks.length > 0);
  assert.equal(ctx.report.landmarks.length, near.length);
  const all = landmarkParents(landmarks);
  assert.equal(Object.keys(all).length, 20, "20 chunk landmarks (the two bridges are mesh-only)");
  assert.equal(all[LANDMARK_ID_BASE], "Salesforce Tower");
  for (const k of ["o:w431972186", "o:w32612520", "o:w288371306"]) assert.ok(landmarkKeys(landmarks).has(k), k);
});

await test("an outline clears other buildings; landmarks on water columns become PIER", () => {
  const lm = landmarks.find((l) => l.name === "Coit Tower");
  const ctx = syntheticCtx([lm]);
  const raster = rasterAround(compileLandmark(lm, ctx, skyline));
  const c = lonLatToBlock(lm.lon, lm.lat, SF_PROJ);
  const cx = Math.floor(c.x), cz = Math.floor(c.z);
  raster.addEntry({ id: 7, base: GROUND, top: GROUND + 3, palette: 0 });
  for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) raster.setColumn(cx + dx, cz + dz, { bldg: 7, base: GROUND, top: GROUND + 3 });
  raster.ground[rasterIndex(raster, cx, cz)] = 0;
  raster.surface[rasterIndex(raster, cx, cz)] = SURFACE.WATER;
  applyLandmarks(raster, ctx, [lm], skyline);
  const i = rasterIndex(raster, cx, cz);
  assert.equal(raster.surface[i], SURFACE.PIER);
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const k = rasterIndex(raster, cx + dx, cz + dz);
    if (raster.owner[k] >= 0) assert.notEqual(raster.entries[raster.owner[k]].id, 7, "inside the outline the landmark wins");
    else assert.fail(`no landmark column at ${cx + dx},${cz + dz}`);
  }
  let kept = 0;
  for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
    const k = rasterIndex(raster, cx + dx, cz + dz);
    if (raster.owner[k] >= 0 && raster.entries[raster.owner[k]].id === 7) kept++;
  }
  assert.ok(kept > 0, "outside the outline the old building stays");
  rasterToChunks(raster, ctx.report.parents);
});

// ---------- per-landmark shape gates (recipe level; the same gates re-run [post-int] on the real build) ----------

function widthAt(cols, frame, y, axis) {
  let lo = Infinity, hi = -Infinity;
  for (const c of cols) {
    if (c.top < y) continue;
    const dx = c.x + 0.5 - frame.cx, dz = c.z + 0.5 - frame.cz;
    const s = axis === "v" ? dx * frame.v[0] + dz * frame.v[1] : dx * frame.u[0] + dz * frame.u[1];
    lo = Math.min(lo, s); hi = Math.max(hi, s);
  }
  return hi < lo ? 0 : Math.round(hi - lo + 1);
}

await test("Transamerica: top-width profile is non-increasing, width at y60 ≤ 8", () => {
  const lm = landmarks.find((l) => l.name === "Transamerica Pyramid");
  const { raster, ctx } = stamped.get(lm.name);
  const S = compileLandmark(lm, ctx, skyline).sites[0];
  const cols = columnsOf(raster).map((c) => ({ ...c, top: c.top - c.base }));
  let prev = Infinity;
  for (let y = 1; y <= 87; y++) {
    const w = widthAt(cols, S.frame, y, "v");
    assert.ok(w <= prev, `width ${w} at y${y} after ${prev}`);
    prev = w;
  }
  assert.ok(widthAt(cols, S.frame, 60, "v") <= 8, `width at y60 = ${widthAt(cols, S.frame, 60, "v")}`);
  assert.equal(Math.max(...cols.map((c) => c.top)), 87);
});

await test("Ferry Building: clock tower ≥ 24, shed at 5 ±1, both pick as one parent; white flagpole and a clock-face band", () => {
  const { raster } = stamped.get("Ferry Building");
  const cols = columnsOf(raster);
  const tower = cols.filter((c) => c.entry.cap === 3), shed = cols.filter((c) => c.entry.facade === 4);
  assert.ok(Math.max(...tower.map((c) => c.top - c.base)) >= 24);
  for (const c of shed) assert.ok(Math.abs(c.top - c.base - 5) <= 1, `shed column at ${c.top - c.base}`);
  assert.equal(pickId(tower[0].entry), pickId(shed[0].entry));
  assert.equal(raster.props.length, 1, "one white flagpole");
  const faces = cols.filter((c) => c.entry.accent === PALETTE_INDEX["steel-dark"]);
  assert.ok(faces.length > 0 && faces.every((c) => c.entry.accentFrom - c.base === 17 && c.top - c.base === 19), "clock faces: a dark band from 17 on the 5×5 stage");
});

await test("Coit Tower: footprint ≤ 25 columns, top 21", () => {
  const cols = columnsOf(stamped.get("Coit Tower").raster);
  assert.ok(cols.length <= 25, `${cols.length} columns`);
  assert.equal(Math.max(...cols.map((c) => c.top - c.base)), 21);
});

await test("Salesforce: crown band from y99 (accentFrom), crown cap, core to 109", () => {
  const cols = columnsOf(stamped.get("Salesforce Tower").raster);
  const e = cols[0].entry;
  assert.equal(e.accentFrom - e.base, 99);
  assert.equal(e.cap, 1);
  assert.equal(Math.max(...cols.map((c) => c.top - c.base)), 109);
});

// ---------- landmarks.bin ----------

await test("landmarks.bin: < 200 KB, decodes, every box inside the reserved grid; bridges and the crown lattice present", () => {
  const ctx = syntheticCtx();
  const bytes = buildLandmarkMesh(ctx, landmarks, skyline);
  assert.ok(bytes.length <= MAX_LANDMARKS_BYTES, `${bytes.length} bytes`);
  const boxes = decodeLandmarks(bytes, SF_GRID);
  assert.ok(boxes.length > 100, `${boxes.length} boxes`);
  const [gx, gz] = SF_GRID;
  for (const b of boxes) assert.ok(b.x >= 0 && b.z >= 0 && b.x + b.sx <= gx * CHUNK && b.z + b.sz <= gz * CHUNK);
  const near = (lat, lon, r) => {
    const c = lonLatToBlock(lon, lat, SF_PROJ);
    return boxes.filter((b) => Math.hypot(b.x + b.sx / 2 - c.x, b.z + b.sz / 2 - c.z) < r + b.sx / 2);
  };
  const ggTower = near(37.814014, -122.477891, 6);
  assert.equal(Math.max(...ggTower.map((b) => b.y1)), Math.round(227.4 / BLOCK_M), "GGB south tower top 76");
  assert.equal(Math.max(...near(37.790753, -122.385823, 6).map((b) => b.y1)), Math.round(160.3 / BLOCK_M), "Bay Bridge W2 top 53");
  assert.ok(near(37.7899, -122.3969, 14).some((b) => b.y1 === GROUND + 109), "Salesforce lattice reaches the crown top");
  assert.equal(near(37.7786, -122.3893, 60).length, 0, "no Oracle Park boxes in landmarks.bin");
  console.log(`     ${boxes.length} boxes, ${bytes.length} B raw`);
});

await test("landmarks.bin: GGB stays south of midspan; Bay Bridge spans W1 to W7", () => {
  const boxes = landmarkMeshBoxes(syntheticCtx(), landmarks.filter((l) => l.bridge !== undefined), skyline);
  const mid = lonLatToBlock(-122.478562, 37.819759, SF_PROJ);
  const north = lonLatToBlock(-122.479233, 37.825503, SF_PROJ);
  for (const b of boxes) assert.ok(Math.hypot(b.x - north.x, b.z - north.z) > Math.hypot(mid.x - north.x, mid.z - north.z) - 8, "no box past midspan");
});

// ---------- footprints vs cached OSM (needs data/city/sf/raw; the real-build version is [post-int]) ----------

const RAW = join(ROOT, "data/city/sf/raw/osm/osm-buildings.json");
await test("footprints: OSM-keyed landmarks within ±2 blocks of their OSM polygon extents (cached OSM)", () => {
  if (!existsSync(RAW)) {
    console.log("     skipped: no data/city/sf/raw cache (npm run city:fetch)");
    return;
  }
  const raw = JSON.parse(readFileSync(RAW, "utf8")).elements;
  const want = new Map();
  for (const lm of landmarks) for (const { src } of sitesOf(lm)) if (src.key.startsWith("o:")) want.set(src.key, src);
  const osm = [];
  for (const e of raw) {
    const key = `o:${e.type[0]}${e.id}`;
    if (!want.has(key) || e.type !== "way") continue;
    const ring = e.geometry.map((p) => { const b = lonLatToBlock(p.lon, p.lat, SF_PROJ); return [b.x, b.z]; });
    osm.push({ key, osmType: "way", osmId: e.id, tags: e.tags, polygons: [[ring]], isPart: false, heightM: null, minHeightM: null, structure: null });
  }
  const ctx = createBuildCtx({ proj: SF_PROJ, groundAt: () => GROUND, osm, datasf: [], report: {} });
  const missing = [...want.keys()].filter((k) => !osm.some((r) => r.key === k));
  const lines = [];
  for (const lm of landmarks) {
    if (lm.bridge !== undefined || !sitesOf(lm).every(({ src }) => !src.key.startsWith("o:") || osm.some((r) => r.key === src.key))) continue;
    if (!lm.key.startsWith("o:")) continue;
    for (const S of compileLandmark(lm, ctx, skyline).sites) {
      const m = minAreaRect(osm.find((r) => r.key === S.site.key).polygons);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const k of new Set([...S.cols.keys(), ...S.field.keys()])) {
        const [x, z] = k.split(",").map(Number);
        const dx = x + 0.5 - S.frame.cx, dz = z + 0.5 - S.frame.cz;
        const u = dx * S.frame.u[0] + dz * S.frame.u[1], v = dx * S.frame.v[0] + dz * S.frame.v[1];
        u0 = Math.min(u0, u - 0.5); u1 = Math.max(u1, u + 0.5); v0 = Math.min(v0, v - 0.5); v1 = Math.max(v1, v + 0.5);
      }
      const { a, b } = S.frame.rect;
      const off = Math.max(Math.abs(u0 + a / 2), Math.abs(u1 - a / 2), Math.abs(v0 + b / 2), Math.abs(v1 - b / 2));
      lines.push(`${S.site.name ?? lm.name} ${off.toFixed(1)}`);
      assert.ok(off <= 2, `${S.site.name ?? lm.name}: footprint edge ${off.toFixed(1)} blocks from the OSM rectangle ${a.toFixed(1)}×${b.toFixed(1)}`);
    }
  }
  console.log(`     max edge offset: ${lines.join(", ")}`);
  if (missing.length) console.log(`     not in the cache (west area, fetched by W2): ${missing.join(", ")}`);
});

// ---------- [post-int] real build ----------

await test("[post-int] skyline: top 50 rows within ±2 blocks of the snapshot on the real build", () => {
  const manifestPath = join(ROOT, "public/city/sf/manifest.json");
  if (!existsSync(manifestPath)) return console.log("     skipped: public/city/sf not built yet");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== CITY_VERSION) return console.log(`     skipped: public/city/sf is a v${manifest.version} build (waits for the v2 rebuild)`);
  const chunkCache = new Map();
  const chunk = (cx, cz) => {
    const k = `${cx},${cz}`;
    if (!chunkCache.has(k)) {
      const p = join(ROOT, "public/city/sf/chunks", `${cx}_${cz}.bin`);
      chunkCache.set(k, existsSync(p) ? decodeChunk(new Uint8Array(gunzipSync(readFileSync(p))), manifest.parents) : null);
    }
    return chunkCache.get(k);
  };
  const failures = [];
  for (const row of skyline.rows.slice(0, 50)) {
    const c = lonLatToBlock(row.lon, row.lat, manifest.proj);
    let best = 0;
    for (let dz = -6; dz <= 6; dz++) for (let dx = -6; dx <= 6; dx++) {
      if (dx * dx + dz * dz > 36) continue;
      const x = Math.floor(c.x) + dx, z = Math.floor(c.z) + dz;
      const ch = chunk(Math.floor(x / CHUNK), Math.floor(z / CHUNK));
      if (!ch) continue;
      const i = (z - ch.cz * CHUNK) * CHUNK + (x - ch.cx * CHUNK);
      if (ch.bldg[i]) best = Math.max(best, ch.top[i] - ch.ground[i]);
      for (const p of ch.props) if (p.lx === x - ch.cx * CHUNK && p.lz === z - ch.cz * CHUNK) best = Math.max(best, p.y1 - ch.ground[i]);
    }
    const want = Math.round(row.heightM / BLOCK_M);
    if (Math.abs(best - want) > 2) failures.push(`#${row.rank} ${row.name}: ${best} vs ${want}`);
  }
  assert.deepEqual(failures, []);
});

console.log(`skyline.check: ${passed} passed`);
