// W3 checks (spec-v2 §5, §8 W3): structureKind on hand-written tag records, every generic structure recipe on a
// synthetic raster W2-style, the Oracle Park ballpark and Chase Center arena recipes. [post-int] the same
// gates on the real build once public/city/sf is a v2 build.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAP, CHUNK, CITY_VERSION, FACADE, SF_PROJ, STRUCTURE_KINDS, SURFACE, chunkOf, encodeChunk, decodeChunk, decodeLandmarks, lonLatToBlock, pickId,
} from "../../../public/shared/city.js";
import { gunzipSync } from "node:zlib";
import { createBuildCtx } from "../lib/ctx.mjs";
import { applyLandmarks, compileLandmark, landmarkKeys, loadLandmarks, loadSkyline } from "../lib/landmarks.mjs";
import { landmarkMeshBoxes } from "../lib/meshlayer.mjs";
import { createRaster, rasterIndex, rasterToChunks } from "../lib/raster.mjs";
import { NO_WINDOW_KINDS, STRUCTURE_ID_BASE, applyStructures, arenaTop, structureKind } from "../lib/structures.mjs";

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
const ds = (heightM, maxM) => ({ key: "d:1", areaId: "1", polygons: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]], heightM, maxM, gndMinM: 0, peakM: null });

// ---------- structureKind ----------

await test("structureKind: each class from hand-written tags", () => {
  const cases = [
    [{ building: "stadium", sport: "baseball", name: "Oracle Park" }, null, "ballpark"],
    [{ building: "yes", leisure: "stadium", sport: "soccer;baseball" }, null, "ballpark"],
    [{ building: "yes", leisure: "stadium", sport: "basketball", name: "Chase Center" }, null, "arena"],
    [{ building: "arena" }, null, "arena"],
    [{ building: "yes", amenity: "conference_centre", name: "Moscone Convention Center West" }, null, "conference"],
    [{ building: "yes", height: "8", name: "Pier 9" }, null, "pier_shed"],
    [{ building: "warehouse", name: "Pier 15" }, null, "pier_shed"],
    [{ building: "yes", man_made: "pier", name: "Pier 1" }, null, "pier_shed"],
    [{ building: "terminal", amenity: "ferry_terminal", name: "San Francisco Ferry Building" }, ds(15.17, 71.39), "terminal_tower"],
    [{ building: "church", amenity: "place_of_worship" }, null, "church"],
    [{ building: "yes", amenity: "place_of_worship", religion: "christian" }, null, "church"],
    [{ building: "parking", amenity: "parking", parking: "multi-storey" }, null, "parking_garage"],
    [{ building: "yes", amenity: "parking", parking: "multi-storey", name: "Pier 39 Garage" }, null, "parking_garage"],
    [{ building: "roof", height: "6", layer: "1" }, null, "canopy"],
    [{ building: "transportation", name: "Salesforce Transit Center", layer: "-1" }, null, "transit_roofpark"],
  ];
  for (const [tags, d, want] of cases) assert.equal(structureKind(tags, d), want, JSON.stringify(tags));
  assert.deepEqual([...new Set(cases.map((c) => c[2]))].sort(), [...STRUCTURE_KINDS].sort(), "every class has a case");
});

await test("structureKind: ordinary buildings and near misses are null", () => {
  const cases = [
    [{ building: "yes" }, null],
    [{ building: "office", height: "183" }, null],
    [{ building: "terminal" }, ds(15, 30)],
    [{ building: "terminal" }, null],
    [{ building: "yes", amenity: "parking" }, null],
    [{ building: "yes", name: "Pier 39 Building P" }, null],
    [{ building: "transportation", name: "Muni substation" }, null],
    [{ leisure: "pitch", sport: "baseball" }, null],
  ];
  for (const [tags, d] of cases) assert.equal(structureKind(tags, d), null, JSON.stringify(tags));
  assert.throws(() => structureKind(null, null), /tags/);
  assert.throws(() => structureKind({}, { heightM: 1 }), /DataSF record/);
});

// ---------- applyStructures on a W2-style synthetic raster ----------

const X0 = 64 * 70, Z0 = 64 * 60;
const rectRing = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]];
function scene() {
  const r = createRaster([70, 60], [71, 61]);
  r.ground.fill(3);
  r.surface.fill(SURFACE.SIDEWALK);
  // water east of x0+100 for the pier
  for (let z = 0; z < r.h; z++) for (let x = 100; x < r.w; x++) { r.ground[z * r.w + x] = 0; r.surface[z * r.w + x] = SURFACE.WATER; }
  const recs = [];
  let id = 1;
  const add = (tags, x0, z0, x1, z1, heightBlocks, extra = {}) => {
    const rec = { key: `o:w${1000 + id}`, osmType: "way", osmId: 1000 + id, tags, polygons: [[rectRing(X0 + x0, Z0 + z0, X0 + x1, Z0 + z1)]], isPart: false, heightM: heightBlocks * 3, minHeightM: null, structure: structureKind(tags, extra.ds ?? null) };
    recs.push(rec);
    const base = 3;
    r.addEntry({ id, base, top: base + heightBlocks, palette: 7 });
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
      if (extra.surface) r.surface[(z) * r.w + x] = extra.surface(x, z);
      if (r.ground[z * r.w + x] === 0) { r.ground[z * r.w + x] = base; r.surface[z * r.w + x] = SURFACE.PIER; }
      r.setColumn(X0 + x, Z0 + z, { bldg: id, base, top: base + heightBlocks });
    }
    id++;
    return rec;
  };
  const recIds = {
    arena: add({ building: "arena", name: "Arena" }, 10, 10, 40, 40, 12),
    conference: add({ building: "yes", amenity: "conference_centre", name: "Conf" }, 50, 10, 70, 30, 6, { surface: (x) => (x < 60 ? SURFACE.PARK : SURFACE.SIDEWALK) }),
    pier: add({ building: "warehouse", name: "Pier 5" }, 95, 50, 125, 58, 4),
    church: add({ building: "church", amenity: "place_of_worship", name: "St Test" }, 10, 60, 30, 70, 5),
    parking: add({ building: "parking", amenity: "parking", parking: "multi-storey" }, 40, 60, 50, 70, 4),
    canopy: add({ building: "roof" }, 60, 60, 66, 64, 2),
    transit: add({ building: "transportation", name: "Test Transit Center" }, 10, 80, 60, 86, 9),
    terminal: add({ building: "terminal", amenity: "ferry_terminal" }, 70, 80, 80, 90, 5, { ds: ds(5, 60) }),
    skipped: add({ building: "parking", amenity: "parking", parking: "multi-storey" }, 70, 40, 80, 50, 4),
  };
  const churchDs = { key: "d:9", areaId: "9", polygons: [[rectRing(X0 + 9, Z0 + 59, X0 + 31, Z0 + 71)]], heightM: 15, maxM: 45, gndMinM: 9, peakM: null };
  const ctx = createBuildCtx({ proj: SF_PROJ, groundAt: () => 3, osm: recs, datasf: [churchDs], report: {} });
  return { r, ctx, recIds };
}
const colsOfEntry = (r, pred) => {
  const out = [];
  for (let i = 0; i < r.owner.length; i++) if (r.owner[i] >= 0 && pred(r.entries[r.owner[i]])) out.push({ x: r.x0 + (i % r.w), z: r.z0 + Math.floor(i / r.w), top: r.top[i], base: r.ground[i], e: r.entries[r.owner[i]] });
  return out;
};
const colsOfRec = (r, rec) => {
  const [[ring]] = rec.polygons;
  const [x0, z0] = ring[0], [x1, z1] = ring[2];
  const out = [];
  for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
    const i = rasterIndex(r, x, z);
    out.push({ x, z, i, top: r.top[i], base: r.ground[i], deck: r.deck[i], e: r.owner[i] >= 0 ? r.entries[r.owner[i]] : null });
  }
  return out;
};

const S = scene();
await test("applyStructures: restyles every class and the result encodes as valid chunks", () => {
  applyStructures(S.r, S.ctx, { skipKeys: new Set([S.recIds.skipped.key]) });
  const { chunks } = rasterToChunks(S.r, S.ctx.report.parents);
  for (const c of chunks) decodeChunk(encodeChunk(c, S.ctx.report.parents), S.ctx.report.parents);
  const log = S.ctx.report.structures;
  for (const k of ["arena", "conference", "pier_shed", "church", "parking_garage", "canopy", "transit_roofpark"]) assert.equal(log.restyled[k], 1, k);
  assert.deepEqual(log.leftToLandmarks, [{ key: S.recIds.terminal.key, kind: "terminal_tower" }]);
  for (const c of colsOfRec(S.r, S.recIds.skipped)) assert.ok(c.e.id < STRUCTURE_ID_BASE, "a landmark-covered key is left alone");
});

await test("arena: dome profile (centre highest, wall at the rim), ribbed facade", () => {
  const cols = colsOfRec(S.r, S.recIds.arena);
  const h = (x, z) => cols.find((c) => c.x === X0 + x && c.z === Z0 + z).top - 3;
  assert.equal(cols[0].e.facade, FACADE.RIBBED);
  assert.equal(h(25, 25), 12);
  assert.ok(h(25, 25) > h(15, 25) && h(15, 25) >= h(10, 25), "falls off toward the rim");
  assert.equal(arenaTop(0, 20, 10, 3), 13);
  assert.equal(arenaTop(20, 20, 10, 3), 10);
});

await test("conference: curtain facade, green-cap part over the park, one virtual parent", () => {
  const cols = colsOfRec(S.r, S.recIds.conference);
  for (const c of cols) assert.equal(c.e.facade, FACADE.CURTAIN);
  const green = cols.filter((c) => c.e.cap === CAP.GREEN), plain = cols.filter((c) => c.e.cap !== CAP.GREEN);
  assert.ok(green.length > 0 && plain.length > 0);
  assert.equal(green[0].e.parent, plain[0].e.parent);
  assert.equal(S.ctx.report.parents[green[0].e.parent], "Conf");
});

await test("pier shed: gable along the long axis, bulkhead +2 at the shore end, concrete-warm ribbed", () => {
  const cols = colsOfRec(S.r, S.recIds.pier);
  assert.equal(cols[0].e.facade, FACADE.RIBBED);
  const h = (x, z) => cols.find((c) => c.x === X0 + x && c.z === Z0 + z).top - 3;
  assert.ok(h(110, 54) > h(110, 50), "ridge above the eave");
  assert.equal(h(96, 54) - h(110, 54), 2, "bulkhead on the land (west) end");
  assert.equal(h(124, 54), h(110, 54), "no bulkhead on the water end");
});

await test("church: tower 3×3 → 1×1 at the street end, height from DataSF max", () => {
  const cols = colsOfRec(S.r, S.recIds.church);
  const top = Math.max(...cols.map((c) => c.top - 3));
  assert.equal(top, 15, "45 m DataSF max → 15 blocks");
  assert.equal(cols.filter((c) => c.top - 3 === 15).length, 1);
  assert.equal(cols.filter((c) => c.top - 3 === 12).length, 8);
});

await test("parking garage: facade 3 (open deck), concrete", () => {
  for (const c of colsOfRec(S.r, S.recIds.parking)) assert.equal(c.e.facade, FACADE.PARKING);
});

await test("canopy: no building left, a deck at the roof with 4 corner pillars", () => {
  const cols = colsOfRec(S.r, S.recIds.canopy);
  for (const c of cols) assert.equal(c.e, null);
  assert.equal(cols.filter((c) => c.deck < 0).length, 4);
  for (const c of cols) assert.equal(Math.abs(c.deck), 5);
});

await test("transit roof park: street + 7, green cap, ribbed", () => {
  for (const c of colsOfRec(S.r, S.recIds.transit)) {
    assert.equal(c.top - c.base, 7);
    assert.equal(c.e.cap, CAP.GREEN);
    assert.equal(c.e.facade, FACADE.RIBBED);
  }
});

await test("no stadium/arena/conference structure keeps facade 0", () => {
  for (const rec of S.ctx.osm) {
    if (!NO_WINDOW_KINDS.includes(rec.structure)) continue;
    for (const c of colsOfRec(S.r, rec)) if (c.e) assert.notEqual(c.e.facade, FACADE.WINDOWS, rec.key);
  }
});

// ---------- Oracle Park and Chase Center recipes ----------

function stampLandmark(name) {
  const lm = landmarks.find((l) => l.name === name);
  const osm = [];
  if (lm.key.startsWith("o:")) {
    const c = lonLatToBlock(lm.lon, lm.lat, SF_PROJ);
    const d = lm.recipe.find((o) => o.op === "circle").d / 2;
    osm.push({ key: lm.key, osmType: "way", osmId: Number(lm.key.slice(3)), tags: { building: "yes" }, polygons: [[rectRing(c.x - d, c.z - d, c.x + d, c.z + d)]], isPart: false, heightM: null, minHeightM: null, structure: null });
  }
  const ctx = createBuildCtx({ proj: SF_PROJ, groundAt: () => 2, osm, datasf: [], report: {} });
  const compiled = compileLandmark(lm, ctx, skyline);
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const s of compiled.sites) for (const k of [...s.outline]) {
    const [x, z] = k.split(",").map(Number);
    x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z);
  }
  const r = createRaster(chunkOf(x0, z0), chunkOf(x1, z1));
  r.ground.fill(2);
  r.surface.fill(SURFACE.SIDEWALK);
  applyLandmarks(r, ctx, [lm], skyline);
  const { chunks } = rasterToChunks(r, ctx.report.parents);
  return { lm, r, ctx, chunks, site: compiled.sites[0] };
}

const oracle = stampLandmark("Oracle Park");
await test("Oracle Park: field ≥ 60% GRASS/DIRT with bldg 0; infield and warning track are DIRT", () => {
  const { site, r } = oracle;
  let fieldCols = 0, grass = 0, dirt = 0;
  for (const k of site.field.keys()) {
    const [x, z] = k.split(",").map(Number);
    const i = rasterIndex(r, x, z);
    assert.equal(r.owner[i], -1, "field is ground, not roof");
    fieldCols++;
    if (r.surface[i] === SURFACE.GRASS) grass++;
    if (r.surface[i] === SURFACE.DIRT) dirt++;
  }
  assert.ok((grass + dirt) / fieldCols >= 0.6);
  assert.ok(grass > dirt && dirt > 0, `${grass} grass, ${dirt} dirt`);
  const fieldShare = fieldCols / site.outline.size;
  console.log(`     field ${fieldCols} columns (${(100 * fieldShare).toFixed(0)}% of the outline), ${grass} grass, ${dirt} dirt`);
});

await test("Oracle Park: stands rise with distance from the field, Hmax ≤ 11, outfield arc ≤ 3, facade 4 + seats", () => {
  const { r, site } = oracle;
  const stands = colsOfEntry(r, (e) => e.facade === FACADE.ARCADE);
  assert.ok(stands.length > 500, `${stands.length} stand columns`);
  for (const c of stands) assert.equal(c.e.cap, CAP.SEATS);
  const tops = stands.map((c) => c.top - c.base);
  assert.ok(Math.max(...tops) <= 11, `Hmax ${Math.max(...tops)}`);
  assert.equal(Math.max(...tops), 10);
  const { home: [hx, hz], centre: [fx, fz] } = site.ballpark;
  const ang = (c) => (Math.acos(((c.x + 0.5 - fx) * hx + (c.z + 0.5 - fz) * hz) / Math.hypot(c.x + 0.5 - fx, c.z + 0.5 - fz)) * 180) / Math.PI;
  for (const c of stands) if (ang(c) >= 150) assert.ok(c.top - c.base <= 3, `outfield column ${c.x},${c.z} at ${c.top - c.base}`);
  // rising with distance: along the home ray the stand tops never drop going outward
  const ray = stands.filter((c) => ang(c) < 8).map((c) => ({ d: Math.hypot(c.x + 0.5 - fx, c.z + 0.5 - fz), t: c.top - c.base })).sort((a, b) => a.d - b.d);
  assert.ok(ray.length > 5);
  for (let i = 1; i < ray.length; i++) assert.ok(ray[i].t >= ray[i - 1].t - 1, `drop at d=${ray[i].d.toFixed(1)}`);
  assert.ok(ray[ray.length - 1].t > ray[0].t);
});

await test("Oracle Park: exactly 6 emissive light props on the stands, scoreboard facade 1, one parent; no boxes in landmarks.bin", () => {
  const { r, chunks, ctx } = oracle;
  assert.equal(r.props.length, 6);
  for (const p of r.props) {
    assert.equal(p.flags, 1);
    assert.equal(r.entries[r.owner[rasterIndex(r, p.x, p.z)]].facade, FACADE.ARCADE);
  }
  const sb = colsOfEntry(r, (e) => e.facade === FACADE.BLANK);
  assert.ok(sb.length >= 12 && sb.length <= 20, `8×2 scoreboard, ${sb.length} columns`);
  const pids = new Set(chunks.flatMap((c) => c.buildings.map(pickId)));
  assert.equal(pids.size, 1);
  assert.equal(chunks.reduce((n, c) => n + c.props.filter((p) => p.flags === 1).length, 0), 6);
  const outline = [...oracle.site.outline].map((k) => k.split(",").map(Number));
  const boxes = landmarkMeshBoxes({ ...ctx, osm: [] }, landmarks.filter((l) => l.bridge !== undefined), skyline);
  const xs = outline.map((p) => p[0]), zs = outline.map((p) => p[1]);
  for (const b of boxes) assert.ok(b.x + b.sx < Math.min(...xs) || b.x > Math.max(...xs) || b.z + b.sz < Math.min(...zs) || b.z > Math.max(...zs), "no Oracle box");
});

await test("Chase Center: dome profile (wall 10, centre 13), ribbed drum, curtain glass band at the street", () => {
  const { r, site } = stampLandmark("Chase Center");
  const drum = colsOfEntry(r, (e) => e.facade === FACADE.RIBBED);
  const band = colsOfEntry(r, (e) => e.facade === FACADE.CURTAIN);
  assert.ok(drum.length > 1000 && band.length > 50);
  for (const c of band) assert.equal(c.top - c.base, 2);
  const at = (c) => Math.hypot(c.x + 0.5 - site.frame.cx, c.z + 0.5 - site.frame.cz);
  assert.equal(Math.max(...drum.map((c) => c.top - c.base)), 13);
  for (const c of drum) assert.equal(c.top - c.base, arenaTop(at(c), 25, 10, 3), `${c.x},${c.z}`);
  assert.equal(new Set([...drum, ...band].map((c) => pickId(c.e))).size, 1);
});

await test("landmark keys: covered OSM ways are skipped by applyStructures", () => {
  const keys = landmarkKeys(landmarks);
  assert.ok(keys.has("o:w579646390") && keys.has("o:w288371310"));
});

// ---------- [post-int] ----------

await test("[post-int] structures on the real build (Oracle Park, Chase Center, no windowed stadium/arena/conference)", () => {
  const manifestPath = join(ROOT, "public/city/sf/manifest.json");
  if (!existsSync(manifestPath)) return console.log("     skipped: public/city/sf not built yet");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== CITY_VERSION) return console.log(`     skipped: public/city/sf is a v${manifest.version} build (waits for the v2 rebuild)`);
  const report = JSON.parse(readFileSync(join(ROOT, "public/city/sf/report.json"), "utf8"));
  assert.ok(Array.isArray(report.landmarks) && report.landmarks.some((l) => l.name === "Oracle Park"), "report.landmarks lists Oracle Park");
  assert.ok(report.structures && report.structures.restyled, "report.structures written by applyStructures");

  const dir = join(ROOT, "public/city/sf");
  const chunks = manifest.chunks.list.map(([cx, cz]) => decodeChunk(new Uint8Array(gunzipSync(readFileSync(join(dir, "chunks", `${cx}_${cz}.bin`)))), manifest.parents));
  const columnsOf = (parent) => {
    const out = [];
    for (const c of chunks) {
      const byId = new Map(c.buildings.map((b, k) => [k + 1, b]));
      for (let i = 0; i < CHUNK * CHUNK; i++) {
        const b = byId.get(c.bldg[i]);
        if (b && pickId(b) === parent) out.push({ x: c.cx * CHUNK + (i % CHUNK), z: c.cz * CHUNK + Math.floor(i / CHUNK), h: c.top[i] - c.ground[i], b });
      }
    }
    return out;
  };
  const bbox = (cols) => ({ x0: Math.min(...cols.map((c) => c.x)), x1: Math.max(...cols.map((c) => c.x)), z0: Math.min(...cols.map((c) => c.z)), z1: Math.max(...cols.map((c) => c.z)) });
  const columnsIn = (bb, fn) => {
    for (const c of chunks) {
      for (let i = 0; i < CHUNK * CHUNK; i++) {
        const x = c.cx * CHUNK + (i % CHUNK), z = c.cz * CHUNK + Math.floor(i / CHUNK);
        if (x >= bb.x0 && x <= bb.x1 && z >= bb.z0 && z <= bb.z1) fn(c, i, x, z);
      }
    }
  };

  const oracle = report.landmarks.find((l) => l.name === "Oracle Park");
  const ocols = columnsOf(oracle.parent);
  assert.ok(ocols.length > 500, `Oracle Park has ${ocols.length} columns`);
  const obb = bbox(ocols);
  const standKey = new Set(ocols.map((c) => `${c.x},${c.z}`));
  const rowsX = new Map(), rowsZ = new Map();
  for (const c of ocols) {
    const rx = rowsX.get(c.z) ?? [Infinity, -Infinity]; rowsX.set(c.z, [Math.min(rx[0], c.x), Math.max(rx[1], c.x)]);
    const rz = rowsZ.get(c.x) ?? [Infinity, -Infinity]; rowsZ.set(c.x, [Math.min(rz[0], c.z), Math.max(rz[1], c.z)]);
  }
  let enclosed = 0, field = 0, fieldBldg = 0;
  columnsIn(obb, (c, i, x, z) => {
    if (standKey.has(`${x},${z}`)) return;
    const rx = rowsX.get(z), rz = rowsZ.get(x);
    if (!rx || !rz || x <= rx[0] || x >= rx[1] || z <= rz[0] || z >= rz[1]) return;
    enclosed++;
    if (c.surface[i] === SURFACE.GRASS || c.surface[i] === SURFACE.DIRT) { field++; if (c.bldg[i]) fieldBldg++; }
  });
  console.log(`     Oracle Park: ${ocols.length} stand columns, field ${field}/${enclosed} enclosed columns GRASS/DIRT`);
  assert.ok(field >= 0.6 * enclosed && field > 500, `Oracle field ${field} of ${enclosed} enclosed columns is GRASS/DIRT`);
  assert.equal(fieldBldg, 0, "no building on the field");
  const stands = ocols.filter((c) => c.b.cap === CAP.SEATS);
  assert.ok(stands.length > 0 && stands.every((c) => c.b.facade === FACADE.ARCADE), "stands: cap seats, facade 4 (brick arcade)");
  assert.ok(Math.max(...stands.map((c) => c.h)) <= 11, `stands Hmax ${Math.max(...stands.map((c) => c.h))} ≤ 11`);
  assert.ok(ocols.every((c) => c.b.facade !== FACADE.WINDOWS), "no Oracle Park entry uses the window atlas");
  let lights = 0;
  for (const c of chunks) for (const p of c.props) {
    const x = c.cx * CHUNK + p.lx, z = c.cz * CHUNK + p.lz;
    if ((p.flags & 1) && x >= obb.x0 - 2 && x <= obb.x1 + 2 && z >= obb.z0 - 2 && z <= obb.z1 + 2) lights++;
  }
  assert.equal(lights, 6, "exactly 6 emissive light props at Oracle Park");
  const boxes = decodeLandmarks(new Uint8Array(gunzipSync(readFileSync(join(dir, manifest.landmarks)))), manifest.chunks.grid);
  assert.equal(boxes.filter((b) => b.x + b.sx > obb.x0 && b.x < obb.x1 && b.z + b.sz > obb.z0 && b.z < obb.z1).length, 0, "no landmarks.bin boxes over Oracle Park");

  const chase = report.landmarks.find((l) => l.name === "Chase Center");
  const ccols = columnsOf(chase.parent);
  const cbb = bbox(ccols);
  const cx = (cbb.x0 + cbb.x1) / 2, cz = (cbb.z0 + cbb.z1) / 2, R = Math.min(cbb.x1 - cbb.x0, cbb.z1 - cbb.z0) / 2;
  const centre = Math.max(...ccols.filter((c) => Math.hypot(c.x - cx, c.z - cz) < R * 0.2).map((c) => c.h));
  const rim = Math.max(...ccols.filter((c) => Math.hypot(c.x - cx, c.z - cz) > R * 0.85 && c.b.cap !== CAP.FLAT).map((c) => c.h), 0);
  const drum = ccols.filter((c) => Math.hypot(c.x - cx, c.z - cz) > R * 0.85).map((c) => c.h);
  console.log(`     Chase Center: centre ${centre}, rim ${Math.min(...drum)}..${Math.max(...drum)} (dome rim ${rim})`);
  assert.ok(centre > Math.min(...drum), "Chase Center dome: the centre is above the rim");
  assert.ok(centre <= 14, `Chase Center top ${centre} ≤ 14`);
  assert.ok(ccols.every((c) => c.b.facade !== FACADE.WINDOWS), "no Chase Center entry uses the window atlas");
});

console.log(`structures.check: ${passed} passed`);
