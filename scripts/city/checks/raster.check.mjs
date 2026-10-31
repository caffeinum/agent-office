// W2 pipeline checks: raster → chunks split, base/top rule, building merge, OSM tag rules, terrain decode,
// and the HTTP content-type guard. Offline and deterministic.
import assert from "node:assert/strict";
import { CHUNK, SURFACE, decodeChunk, encodeChunk } from "../../../public/shared/city.js";
import { createRaster, rasterIndex, rasterToChunks } from "../lib/raster.mjs";
import { baseTop, mergeBuildings, OSM_DEFAULT_HEIGHT_M } from "../lib/buildings.mjs";
import { keepHighway, landcoverSurface, overpassQueries, parseHeightM, roadSpec } from "../lib/osm.mjs";
import { decodeTerrarium, terrariumUrl, tilesForBbox } from "../lib/terrain.mjs";
import { assertContentType, USER_AGENT } from "../lib/http.mjs";
import { FETCH_BBOX } from "../sf/config.mjs";

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`✗ ${name}\n  ${e.stack}`); process.exitCode = 1; }
};
const square = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]];

test("createRaster spans the chunk range, all water", () => {
  const r = createRaster([10, 20], [11, 22]);
  assert.equal(r.x0, 10 * CHUNK);
  assert.equal(r.z0, 20 * CHUNK);
  assert.equal(r.w, 2 * CHUNK);
  assert.equal(r.h, 3 * CHUNK);
  assert.equal(r.ground.length, r.w * r.h);
  assert.ok(r.surface.every((s) => s === SURFACE.WATER));
  assert.ok(r.owner.every((o) => o === -1));
  assert.equal(rasterIndex(r, 10 * CHUNK, 20 * CHUNK), 0);
  assert.equal(rasterIndex(r, 10 * CHUNK - 1, 20 * CHUNK), -1);
  assert.throws(() => createRaster([2, 2], [1, 2]), /before min/);
});

test("rasterToChunks: drops all-water chunks, builds per-chunk building tables, roundtrips", () => {
  const r = createRaster([0, 0], [2, 0]);
  // chunk 0: land with a building straddling into chunk 1; chunk 1: shallow only; chunk 2: open water
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < 70; x++) {
      const i = z * r.w + x;
      r.ground[i] = 2;
      r.surface[i] = SURFACE.GRASS;
    }
    r.surface[z * r.w + 80] = SURFACE.SHALLOW;
  }
  const buildings = [{ id: 42, base: 2, top: 9, palette: 7, roof: 0 }];
  for (let z = 10; z < 14; z++) for (let x = 60; x < 68; x++) r.owner[z * r.w + x] = 0;
  const { chunks, allWater } = rasterToChunks(r, buildings);
  assert.equal(allWater, 1);
  assert.deepEqual(chunks.map((c) => [c.cx, c.cz]), [[0, 0], [1, 0]]);
  assert.deepEqual(chunks[0].buildings, [buildings[0]]);
  assert.deepEqual(chunks[1].buildings, [buildings[0]]);
  assert.equal(chunks[0].bldg[10 * CHUNK + 60], 1);
  assert.equal(chunks[1].bldg[10 * CHUNK + 3], 1);
  assert.equal(chunks[1].bldg[10 * CHUNK + 4], 0);
  assert.equal(chunks[1].surface[16], SURFACE.SHALLOW);
  for (const c of chunks) assert.deepEqual(decodeChunk(encodeChunk(c)), c);
});

test("rasterToChunks fails loudly on invalid data", () => {
  const r = createRaster([0, 0], [0, 0]);
  r.ground[0] = 3;
  r.surface[0] = SURFACE.GRASS;
  r.owner[0] = 0;
  assert.throws(() => rasterToChunks(r, [{ id: 1, base: 1, top: 4, palette: 0, roof: 0 }]), /must equal its base/);
  assert.throws(() => rasterToChunks(r, []), /no building/);
});

test("baseTop: base is the lowest ground, top the highest plus the height", () => {
  assert.deepEqual(baseTop([5, 7, 12], 21), { base: 5, top: 19 });
  assert.deepEqual(baseTop([1], 0.5), { base: 1, top: 2 });
  assert.deepEqual(baseTop([3, 3], 327), { base: 3, top: 112 });
  assert.throws(() => baseTop([], 9), /no ground/);
  assert.throws(() => baseTop([1], NaN), /height/);
});

test("mergeBuildings: OSM height raises a DataSF footprint, tower footprint replaces, unmatched added, overrides", () => {
  const datasf = [
    { key: "d:1", polygons: [[square(0, 0, 10, 10)]], heightM: 30 },
    { key: "d:2", polygons: [[square(20, 0, 30, 10)]], heightM: 40 },
    { key: "d:3", polygons: [[square(40, 0, 44, 4)]], heightM: 100 },
    { key: "d:4", polygons: [[square(60, 0, 70, 10)]], heightM: 12 },
  ];
  const osm = [
    { key: "o:w100", polygons: [[square(1, 1, 9, 9)]], heightM: 50 }, // raises d:1 (50 > 30 + 6)
    { key: "o:w101", polygons: [[square(21, 1, 29, 9)]], heightM: 44 }, // within 6 m: d:2 keeps 40
    { key: "o:w102", polygons: [[square(38, -2, 48, 8)]], heightM: 326 }, // 100 > 1.5 × 16 and > 60 m: replaces d:3
    { key: "o:w103", polygons: [[square(100, 100, 104, 104)]], heightM: null }, // unmatched, default height
    { key: "o:w104", polygons: [[square(59, -1, 71, 11)]], heightM: 20 }, // 1.5× area but 20 m and no override: d:4 stays, raised
  ];
  const { buildings, report } = mergeBuildings({ datasf, osm, overrides: { "o:w102": { palette: 17 }, "d:2": { heightM: 45 } } });
  const by = Object.fromEntries(buildings.map((b) => [b.key, b]));
  assert.deepEqual(buildings.map((b) => b.key), ["d:1", "d:2", "d:4", "o:w102", "o:w103"]);
  assert.deepEqual(buildings.map((b) => b.id), [1, 2, 3, 4, 5]);
  assert.equal(by["d:1"].heightM, 50);
  assert.equal(by["d:2"].heightM, 45);
  assert.equal(by["d:4"].heightM, 20);
  assert.equal(by["o:w102"].heightM, 326);
  assert.equal(by["o:w102"].palette, 17);
  assert.equal(by["o:w103"].heightM, OSM_DEFAULT_HEIGHT_M);
  assert.deepEqual(report.footprintReplaced, [{ key: "o:w102", heightM: 326, replaced: ["d:3"] }]);
  assert.throws(() => mergeBuildings({ datasf, osm, overrides: { "o:w999": { palette: 1 } } }), /matches no building/);
  assert.throws(() => mergeBuildings({ datasf, osm, overrides: { "o:w1": { colour: 1 } } }), /unknown field/);
  assert.throws(() => mergeBuildings({ datasf, osm, overrides: { "x:1": {} } }), /bad key/);
});

test("mergeBuildings: an OSM override lets a small-height footprint replace (post-2010 tower rule)", () => {
  const datasf = [{ key: "d:1", polygons: [[square(0, 0, 4, 4)]], heightM: 10 }];
  const osm = [{ key: "o:w5", polygons: [[square(-2, -2, 6, 6)]], heightM: 40 }];
  assert.deepEqual(mergeBuildings({ datasf, osm, overrides: {} }).buildings.map((b) => b.key), ["d:1"]);
  assert.deepEqual(mergeBuildings({ datasf, osm, overrides: { "o:w5": { heightM: 40 } } }).buildings.map((b) => b.key), ["o:w5"]);
});

test("keepHighway: the spec section 2 filter", () => {
  assert.equal(keepHighway({ highway: "residential" }), true);
  for (const h of ["proposed", "construction", "abandoned", "corridor", "platform", "elevator", "bus_stop"]) assert.equal(keepHighway({ highway: h }), false, h);
  assert.equal(keepHighway({ highway: "footway", indoor: "yes" }), false);
  assert.equal(keepHighway({ highway: "primary", layer: "-1" }), false);
  assert.equal(keepHighway({ highway: "primary", tunnel: "yes" }), false);
  assert.equal(keepHighway({ highway: "service", area: "yes" }), false);
  assert.equal(keepHighway({ highway: "pedestrian", area: "yes" }), true);
  assert.equal(keepHighway({ highway: "footway", footway: "sidewalk" }), false);
  assert.equal(keepHighway({ highway: "footway", footway: "crossing" }), false);
  assert.equal(keepHighway({ highway: "motorway", bridge: "yes", layer: "2" }), true);
});

test("roadSpec: widths, sidewalks, links, name overrides, width tag", () => {
  assert.deepEqual(roadSpec({ highway: "motorway" }), { roadway: 7, sidewalk: 0, surface: SURFACE.ROAD });
  assert.deepEqual(roadSpec({ highway: "residential" }), { roadway: 4, sidewalk: 1, surface: SURFACE.ROAD });
  assert.deepEqual(roadSpec({ highway: "secondary" }), { roadway: 5, sidewalk: 1, surface: SURFACE.ROAD });
  assert.deepEqual(roadSpec({ highway: "pedestrian" }), { roadway: 3, sidewalk: 0, surface: SURFACE.PLAZA });
  assert.deepEqual(roadSpec({ highway: "steps" }), { roadway: 1, sidewalk: 0, surface: SURFACE.SIDEWALK });
  assert.equal(roadSpec({ highway: "motorway_link" }).roadway, 5);
  assert.equal(roadSpec({ highway: "service_link" }).roadway, 2);
  assert.deepEqual(roadSpec({ highway: "primary", name: "Market Street" }), { roadway: 7, sidewalk: 2, surface: SURFACE.ROAD });
  assert.equal(roadSpec({ highway: "primary", name: "Van Ness Avenue" }).roadway, 8);
  assert.equal(roadSpec({ highway: "residential", width: "15" }).roadway, 5);
  assert.equal(roadSpec({ highway: "busway" }), null);
});

test("landcoverSurface: the spec table, unknown tags → null", () => {
  assert.equal(landcoverSurface({ leisure: "park" }), SURFACE.PARK);
  assert.equal(landcoverSurface({ landuse: "cemetery" }), SURFACE.PARK);
  assert.equal(landcoverSurface({ leisure: "pitch" }), SURFACE.GRASS);
  assert.equal(landcoverSurface({ natural: "scrub" }), SURFACE.FOREST);
  assert.equal(landcoverSurface({ natural: "beach" }), SURFACE.SAND);
  assert.equal(landcoverSurface({ natural: "water" }), SURFACE.WATER);
  assert.equal(landcoverSurface({ landuse: "railway" }), SURFACE.RAIL);
  assert.equal(landcoverSurface({ amenity: "parking" }), SURFACE.PARKING);
  assert.equal(landcoverSurface({ highway: "pedestrian", area: "yes" }), SURFACE.PLAZA);
  assert.equal(landcoverSurface({ man_made: "pier", leisure: "park" }), SURFACE.PIER);
  assert.equal(landcoverSurface({ landuse: "commercial" }), null);
});

test("parseHeightM: metres and feet, junk → null", () => {
  assert.equal(parseHeightM("12"), 12);
  assert.equal(parseHeightM("12.5 m"), 12.5);
  assert.equal(parseHeightM("12,5"), 12.5);
  assert.ok(Math.abs(parseHeightM("100'") - 30.48) < 1e-9);
  assert.ok(Math.abs(parseHeightM("100 ft") - 30.48) < 1e-9);
  assert.ok(Math.abs(parseHeightM("10'6\"") - 3.2004) < 1e-9);
  for (const junk of ["tall", "", "-3", "0", "12;14", undefined]) assert.equal(parseHeightM(junk), null, String(junk));
});

test("overpass queries carry the prefix and the fetch bbox", () => {
  const q = overpassQueries(FETCH_BBOX);
  for (const k of ["roads", "land", "buildings"]) {
    assert.ok(q[k].startsWith("[out:json][timeout:300][maxsize:1073741824];"), k);
    assert.ok(q[k].includes("(37.7501,-122.434,37.8157,-122.3769)"), k);
  }
  assert.ok(!q.land.includes("coastline"));
  assert.ok(q.land.includes('"man_made"="pier"'));
});

test("terrarium: decode formula, tile URL, bbox tiles", () => {
  assert.equal(decodeTerrarium(128, 0, 0), 0);
  assert.equal(decodeTerrarium(128, 100, 128), 100.5);
  assert.equal(terrariumUrl(5241, 12663), "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/15/5241/12663.png");
  const tiles = tilesForBbox(FETCH_BBOX);
  assert.ok(tiles.length > 20 && tiles.length < 100, `${tiles.length} tiles`);
  assert.ok(tiles.some((t) => t.x === 5241 && t.y === 12663), "Salesforce Tower's tile is in the set");
});

test("http: UA and content-type guard (HTML/XML rejected with the first 200 bytes)", () => {
  assert.equal(USER_AGENT, "agent-office-city-build/0.1 (+https://github.com/caffeinum/agent-office)");
  assertContentType("application/json; charset=utf-8", Buffer.from("{}"), "u");
  assertContentType("application/vnd.geo+json; charset=UTF-8", Buffer.from("{}"), "u");
  assertContentType("image/png", Buffer.from([0x89]), "u");
  assert.throws(() => assertContentType("text/html", Buffer.from("<html><meta http-equiv=refresh>"), "u"), /meta http-equiv=refresh/);
  assert.throws(() => assertContentType("application/xml", Buffer.from("<?xml"), "u"), /not one of/);
});

console.log(`raster.check: ${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
