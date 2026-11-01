// W2 pipeline checks: raster → chunks split, base/top rule, building merge, OSM tag rules, terrain decode,
// and the HTTP content-type guard. Offline and deterministic.
import assert from "node:assert/strict";
import { CHUNK, SF_GRID, SURFACE, decodeChunk, encodeChunk, landmaskHeight, validateLandmask } from "../../../public/shared/city.js";
import { createRaster, rasterIndex, rasterToChunks, resetChunkToSea } from "../lib/raster.mjs";
import { baseTop, mergeBuildings, OSM_DEFAULT_HEIGHT_M, startYear } from "../lib/buildings.mjs";
import {
  dropBuildingReason, isBridge, keepHighway, landcoverSurface, osmHeightM, osmMinHeightM, overpassQueries, parseHeightM, roadSpec,
} from "../lib/osm.mjs";
import { applyParts, mergeColumnSpans } from "../lib/parts.mjs";
import { buildLandmask, percentile, skirtHeights } from "../lib/mask.mjs";
import { decodeTerrarium, terrariumFile, terrariumUrl, tilesForBbox, tilesForBboxes } from "../lib/terrain.mjs";
import { assertContentType, USER_AGENT } from "../lib/http.mjs";
import { areaSources, coarseTerrainTiles, sourceList, terrainTiles } from "../fetch-sf.mjs";
import { AREAS } from "../sf/config.mjs";

const FETCH_BBOX = AREAS.find((a) => a.id === "east").fetch;

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
  r.addEntry({ id: 42, base: 2, top: 9, palette: 7 });
  for (let z = 10; z < 14; z++) for (let x = 60; x < 68; x++) r.setColumn(x, z, { bldg: 42, base: 2, top: 9 });
  const { chunks, water } = rasterToChunks(r);
  assert.deepEqual(water, [[2, 0]]);
  assert.deepEqual(chunks.map((c) => [c.cx, c.cz]), [[0, 0], [1, 0]]);
  const want = { id: 42, parent: 0, base: 2, top: 9, accentFrom: 0x7fff, palette: 7, cap: 0, facade: 0, accent: 7 };
  assert.deepEqual(chunks[0].buildings, [want]);
  assert.deepEqual(chunks[1].buildings, [want]);
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
  r.addEntry({ id: 1, base: 1, top: 4, palette: 0 });
  r.owner[0] = 0;
  r.top[0] = 4;
  assert.throws(() => rasterToChunks(r), /must equal its base/);
  r.owner[0] = 5;
  assert.throws(() => rasterToChunks(r), /no entry/);
});

test("baseTop: base is the lowest ground, top the highest plus the height", () => {
  assert.deepEqual(baseTop([5, 7, 12], 21), { base: 5, top: 19 });
  assert.deepEqual(baseTop([1], 0.5), { base: 1, top: 2 });
  assert.deepEqual(baseTop([3, 3], 327), { base: 3, top: 112 });
  assert.throws(() => baseTop([], 9), /no ground/);
  assert.throws(() => baseTop([1], NaN), /height/);
});

const ds = (key, poly, heightM, maxM = heightM) => ({ key, polygons: [[poly]], heightM, maxM });
const om = (key, poly, heightM, tags = {}, structure = null) => ({ key, polygons: [[poly]], heightM, explicitHeightM: tags.height !== undefined ? heightM : null, tags, structure });

test("mergeBuildings: explicit OSM height raises a DataSF parcel, guarded by area and centroid (spec-v2 §3.4)", () => {
  const datasf = [ds("d:1", square(0, 0, 10, 10), 30), ds("d:2", square(20, 0, 30, 10), 40), ds("d:3", square(40, 0, 60, 20), 10), ds("d:4", square(70, 0, 80, 10), 12)];
  const osm = [
    om("o:w100", square(1, 1, 9, 9), 50, { height: "50" }), // 50 > 30 + 6, but the 100-block² parcel is > 1.2 × the 64-block² outline
    om("o:w101", square(21, 1, 29, 9), 44, { height: "44" }), // within 6 m: d:2 keeps 40
    om("o:w102", square(48, 8, 52, 12), 30, { height: "30" }), // parcel 400 > 1.2 × 16: never copied
    om("o:w103", square(100, 100, 104, 104), null), // unmatched, default height
    om("o:w104", square(70, 0, 80, 10), 21, { "building:levels": "6" }), // levels only: rank 5 < DataSF median, no raise
  ];
  const { buildings, report } = mergeBuildings({ datasf, osm, overrides: { "d:2": { heightM: 45 } } });
  const by = Object.fromEntries(buildings.map((b) => [b.key, b]));
  assert.deepEqual(buildings.map((b) => b.key), ["d:1", "d:2", "d:3", "d:4", "o:w103"]);
  assert.deepEqual(buildings.map((b) => b.id), [1, 2, 3, 4, 5]);
  assert.equal(by["d:1"].heightM, 30, "100 blocks² parcel > 1.2 × 64 of the outline: blocked");
  assert.equal(by["d:2"].heightM, 45);
  assert.equal(by["d:3"].heightM, 10);
  assert.equal(by["d:4"].heightM, 12);
  assert.equal(by["o:w103"].heightM, OSM_DEFAULT_HEIGHT_M);
  assert.deepEqual(report.heightCopyBlocked.map((b) => b.parcel), ["d:1", "d:3"]);
  const fit = mergeBuildings({ datasf: [ds("d:1", square(0, 0, 10, 10), 30)], osm: [om("o:w1", square(0, 0, 10, 10), 50, { height: "50" })], overrides: {} });
  assert.equal(fit.buildings[0].heightM, 50, "same footprint: raised");
  assert.equal(fit.buildings[0].medianM, 30, "the DataSF median is kept for the tower report");
  assert.throws(() => mergeBuildings({ datasf, osm, overrides: { "o:w999": { palette: 1 } } }), /matches no building/);
  assert.throws(() => mergeBuildings({ datasf, osm, overrides: { "o:w1": { colour: 1 } } }), /unknown field/);
  assert.throws(() => mergeBuildings({ datasf, osm, overrides: { "x:1": {} } }), /bad key/);
});

test("mergeBuildings rank 3: tall, new, structure or DataSF gap → OSM outline wins and deletes parcels inside", () => {
  const datasf = [ds("d:1", square(1, 1, 4, 4), 20), ds("d:2", square(5, 5, 9, 9), 25), ds("d:3", square(20, 20, 24, 24), 50, 200)];
  const tall = mergeBuildings({ datasf, osm: [om("o:w5", square(0, 0, 10, 10), 120, { height: "120" })], overrides: {} });
  assert.deepEqual(tall.buildings.map((b) => b.key), ["d:3", "o:w5"]);
  assert.deepEqual(tall.report.deletedParcels, [{ key: "o:w5", reason: "height>60m", heightM: 120, parcels: ["d:1", "d:2"] }]);
  const recent = mergeBuildings({ datasf, osm: [om("o:w5", square(0, 0, 10, 10), null, { start_date: "2016-05" })], overrides: {} });
  assert.equal(recent.report.deletedParcels[0].reason, "start_date>2010");
  assert.equal(recent.buildings.find((b) => b.key === "o:w5").heightM, 25, "no OSM height: the tallest deleted parcel's median");
  const old = mergeBuildings({ datasf, osm: [om("o:w5", square(0, 0, 10, 10), null, { start_date: "1925" })], overrides: {} });
  assert.deepEqual(old.buildings.map((b) => b.key), ["d:1", "d:2", "d:3"], "1925, ≤ 60 m: DataSF stays");
  const kind = mergeBuildings({ datasf, osm: [om("o:w5", square(0, 0, 10, 10), 12, {}, "arena")], overrides: {} });
  assert.equal(kind.report.deletedParcels[0].reason, "structure:arena");
  const gap = mergeBuildings({ datasf, osm: [om("o:w6", square(19, 19, 25, 25), 180, { "building:levels": "45" })], overrides: {} });
  assert.equal(gap.report.deletedParcels[0].reason, "datasf-gap>40m");
  const w6 = gap.buildings.find((b) => b.key === "o:w6");
  assert.deepEqual([w6.heightM, w6.maxM, w6.medianM], [180, 200, 50]);
  assert.equal(startYear({ start_date: "~1925" }), 1925);
  assert.equal(startYear({ start_date: "C19" }), null);
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
  assert.deepEqual(roadSpec({ highway: "secondary" }), { roadway: 5, sidewalk: 1, surface: SURFACE.ROAD_MAJOR });
  assert.deepEqual(roadSpec({ highway: "pedestrian" }), { roadway: 3, sidewalk: 0, surface: SURFACE.PLAZA });
  assert.deepEqual(roadSpec({ highway: "steps" }), { roadway: 1, sidewalk: 0, surface: SURFACE.SIDEWALK });
  assert.equal(roadSpec({ highway: "motorway_link" }).roadway, 5);
  assert.equal(roadSpec({ highway: "service_link" }).roadway, 2);
  assert.deepEqual(roadSpec({ highway: "primary", name: "Market Street" }), { roadway: 7, sidewalk: 2, surface: SURFACE.ROAD_MAJOR });
  assert.equal(roadSpec({ highway: "residential", lanes: "2" }).roadway, 4, "2 lanes + parking = 11.2 m");
  assert.equal(roadSpec({ highway: "residential", lanes: "1" }).roadway, 3, "a one-lane street is narrower than the class");
  assert.equal(roadSpec({ highway: "secondary", lanes: "4" }).roadway, 6, "4 lanes + parking = 17.6 m");
  assert.equal(roadSpec({ highway: "primary", lanes: "6" }).roadway, 8);
  assert.equal(roadSpec({ highway: "tertiary", lanes: "3;2" }).roadway, 5, "first value of a list");
  assert.equal(roadSpec({ highway: "tertiary", lanes: "x" }).roadway, 4, "unparseable lanes keep the class width");
  assert.equal(roadSpec({ highway: "primary_link", lanes: "4" }).roadway, 4, "links ignore lanes");
  assert.equal(roadSpec({ highway: "residential", lanes: "6", width: "9" }).roadway, 3, "an explicit width wins over lanes");
  assert.equal(roadSpec({ highway: "primary", lanes: "2", name: "Market Street" }).roadway, 7, "name overrides win over lanes");
  for (const h of ["trunk", "primary", "secondary"]) assert.equal(roadSpec({ highway: h }).surface, SURFACE.ROAD_MAJOR, `${h} is arterial asphalt`);
  for (const h of ["tertiary", "residential", "service", "busway"]) assert.equal(roadSpec({ highway: h }).surface, SURFACE.ROAD, `${h} is plain asphalt`);
  assert.equal(roadSpec({ highway: "primary", name: "Van Ness Avenue" }).roadway, 8);
  assert.equal(roadSpec({ highway: "residential", width: "15" }).roadway, 5);
  assert.deepEqual(roadSpec({ highway: "busway" }), { roadway: 3, sidewalk: 0, surface: SURFACE.ROAD });
  assert.equal(roadSpec({ highway: "raceway" }), null);
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

// ---------- spec-v2 W2 ----------

test("raster v2: newId stays above entries and parents, addParent names virtual parents, resetChunkToSea", () => {
  const r = createRaster([0, 0], [1, 0]);
  r.addEntry({ id: 7, base: 1, top: 5, palette: 0 });
  assert.equal(r.newId(), 8);
  assert.equal(r.addParent(r.newId(), "Ferry Building"), 9);
  assert.deepEqual(r.parents, { 9: "Ferry Building" });
  assert.throws(() => r.addParent(7, "x"), /already an entry/);
  assert.throws(() => r.addParent(9, "Other"), /already "Ferry Building"/);
  assert.throws(() => r.addParent(10, ""), /non-empty/);
  r.addEntry({ id: 10, parent: 9, base: 1, top: 5, palette: 0 });
  assert.equal(r.newId(), 11);
  for (let x = 60; x < 70; x++) {
    r.ground[x] = 1;
    r.surface[x] = SURFACE.GRASS;
  }
  r.setColumn(62, 0, { bldg: 7, base: 1, top: 5 });
  r.setColumn(66, 0, { bldg: 10, base: 1, top: 5 });
  r.addProp(66, 0, { y0: 5, y1: 9, color: 0, flags: 0 });
  resetChunkToSea(r, 1, 0);
  assert.equal(r.props.length, 0);
  const { chunks, water } = rasterToChunks(r, r.parents);
  assert.deepEqual(water, [[1, 0]]);
  assert.deepEqual(chunks[0].buildings.map((b) => b.id), [7]);
  assert.throws(() => resetChunkToSea(r, 5, 0), /outside the raster/);
});

test("osm v2: building filter, heights (4 m office levels), min heights, bridges", () => {
  assert.equal(dropBuildingReason({ building: "train_station", layer: "-1" }), "layer<0");
  assert.equal(dropBuildingReason({ building: "yes", location: "underground" }), "location=underground");
  assert.equal(dropBuildingReason({ building: "yes", "building:levels": "0" }), "building:levels=0 without height");
  assert.equal(dropBuildingReason({ building: "roof", "building:levels": "0", height: "6" }), null);
  assert.equal(dropBuildingReason({ building: "yes", layer: "1" }), null);
  assert.equal(osmHeightM({ height: "120 m", "building:levels": "30" }), 120);
  assert.equal(osmHeightM({ "building:levels": "12" }), 42);
  assert.equal(osmHeightM({ building: "office", "building:levels": "12" }), 48);
  assert.equal(osmHeightM({ "building:part": "office", "building:levels": "9" }), 31.5);
  assert.equal(osmHeightM({ "building:levels": "0" }), null);
  assert.equal(osmHeightM({}), null);
  assert.equal(osmMinHeightM({ min_height: "0" }), 0);
  assert.equal(osmMinHeightM({ min_height: "30" }), 30);
  assert.equal(osmMinHeightM({ "building:min_level": "4" }), 14);
  assert.equal(osmMinHeightM({}), null);
  assert.equal(isBridge({ bridge: "movable" }), true);
  assert.equal(isBridge({ bridge: "no" }), false);
  assert.equal(isBridge({}), false);
});

test("landcover v2: underground parking, paved parks, pitch surfaces, dirt, ponds/fountains/pools, dog parks", () => {
  assert.equal(landcoverSurface({ amenity: "parking", parking: "underground" }), null);
  assert.equal(landcoverSurface({ amenity: "parking", layer: "-1" }), null);
  assert.equal(landcoverSurface({ amenity: "parking", parking: "surface" }), SURFACE.PARKING);
  assert.equal(landcoverSurface({ leisure: "park", surface: "paving_stones" }), SURFACE.PLAZA);
  assert.equal(landcoverSurface({ leisure: "park", surface: "grass" }), SURFACE.PARK);
  assert.equal(landcoverSurface({ leisure: "pitch", surface: "asphalt" }), SURFACE.COURT);
  assert.equal(landcoverSurface({ leisure: "pitch", surface: "concrete" }), SURFACE.COURT);
  assert.equal(landcoverSurface({ leisure: "pitch", surface: "tartan" }), SURFACE.TRACK);
  assert.equal(landcoverSurface({ leisure: "pitch", surface: "grass" }), SURFACE.GRASS);
  assert.equal(landcoverSurface({ leisure: "track" }), SURFACE.TRACK);
  assert.equal(landcoverSurface({ natural: "sand", sport: "baseball" }), SURFACE.DIRT);
  assert.equal(landcoverSurface({ natural: "sand", surface: "dirt" }), SURFACE.DIRT);
  assert.equal(landcoverSurface({ natural: "sand" }), SURFACE.SAND);
  assert.equal(landcoverSurface({ natural: "water", water: "pond" }), SURFACE.POOL);
  assert.equal(landcoverSurface({ natural: "water", layer: "2", amenity: "fountain" }), SURFACE.POOL);
  assert.equal(landcoverSurface({ natural: "water", layer: "1" }), SURFACE.POOL);
  assert.equal(landcoverSurface({ natural: "water", water: "lagoon" }), SURFACE.WATER);
  assert.equal(landcoverSurface({ amenity: "fountain" }), SURFACE.POOL);
  assert.equal(landcoverSurface({ leisure: "swimming_pool" }), SURFACE.POOL);
  assert.equal(landcoverSurface({ leisure: "dog_park" }), SURFACE.GRASS);
});

test("overpass v2: v1 strings unchanged, plus building:part/sports/fountain extras, point features and trees", () => {
  const q = overpassQueries(FETCH_BBOX);
  for (const k of ["extra", "points", "trees"]) assert.ok(q[k].startsWith("[out:json][timeout:300][maxsize:1073741824];"), k);
  assert.ok(q.extra.includes('wr["building:part"](37.7501,-122.434,37.8157,-122.3769);'));
  assert.ok(q.extra.includes("stadium|track|sports_centre"));
  assert.ok(q.points.includes('node["tower:type"="lighting"]') && q.points.includes("mast|tower|flagpole"));
  assert.ok(q.trees.includes('node["natural"="tree"]'));
  assert.equal(q.buildings, `[out:json][timeout:300][maxsize:1073741824];wr["building"](37.7501,-122.434,37.8157,-122.3769);out geom;`);
});

test("fetch v2: east keeps its v1 cache ids and files; west gets its own; tiles cover both areas plus z12 city-wide", () => {
  const east = areaSources(AREAS[0]), west = areaSources(AREAS[1]);
  assert.deepEqual([east.roads.id, east.roads.file, east.footprints.id, east.footprints.file], ["osm-roads", "osm/osm-roads.json", "datasf-footprints", "datasf/footprints.geojson"]);
  assert.ok(east.footprints.url.includes("within_box(shape,37.8157,-122.4340,37.7501,-122.3769)"), "v1 DataSF URL kept byte-identical");
  assert.deepEqual([west.roads.id, west.roads.file, west.extra.id, west.footprints.file], ["osm-roads-west", "osm/osm-roads-west.json", "osm-extra-west", "datasf/datasf-footprints-west.geojson"]);
  const ids = sourceList().map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "source ids are unique");
  assert.equal(new Set(sourceList().map((s) => s.file)).size, ids.length, "source files are unique");
  const fine = terrainTiles();
  assert.ok(fine.every((t) => t.z === 15));
  assert.ok(fine.length > tilesForBbox(FETCH_BBOX).length, "the west area adds z15 tiles");
  assert.equal(new Set(fine.map((t) => `${t.x}/${t.y}`)).size, fine.length, "deduplicated");
  const coarse = coarseTerrainTiles();
  assert.ok(coarse.every((t) => t.z === 12) && coarse.length >= 4 && coarse.length <= 30, `${coarse.length} z12 tiles`);
  assert.equal(terrariumUrl(655, 1582, 12), "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/655/1582.png");
  assert.equal(terrariumFile(655, 1582, 12), "terrarium/12/655/1582.png");
  assert.throws(() => terrariumUrl(1, 1, 16), /zoom/);
  assert.equal(tilesForBboxes([FETCH_BBOX, FETCH_BBOX]).length, tilesForBbox(FETCH_BBOX).length);
});

test("parts: spans merge bottom-up, floating parts drop, inside a part the outline height is replaced", () => {
  assert.deepEqual(mergeColumnSpans([{ minM: 0, topM: 30, key: "a" }, { minM: 30, topM: 90, key: "b" }, { minM: 120, topM: 130, key: "c" }]), { topM: 90, floating: ["c"] });
  assert.deepEqual(mergeColumnSpans([{ minM: 40, topM: 60, key: "sky" }]), { topM: null, floating: ["sky"] });
  assert.deepEqual(mergeColumnSpans([{ minM: 0, topM: 12, key: "low" }, { minM: 6, topM: 9, key: "in" }]), { topM: 12, floating: [] });
  assert.throws(() => mergeColumnSpans([{ minM: 10, topM: 10, key: "flat" }]), /not above/);
  const r = createRaster([0, 0], [0, 0]);
  for (let i = 0; i < CHUNK * CHUNK; i++) {
    r.ground[i] = 2;
    r.surface[i] = SURFACE.GRASS;
  }
  r.addEntry({ id: 1, base: 2, top: 12, palette: 0 });
  for (let z = 0; z < 10; z++) for (let x = 0; x < 10; x++) r.setColumn(x, z, { bldg: 1, base: 2, top: 12 });
  const part = (key, poly, minHeightM, heightM) => ({ key, isPart: true, polygons: [[poly]], minHeightM, heightM });
  const rep = applyParts(r, [
    part("o:w1", square(0, 0, 5, 10), 0, 90), // tower part: 30 blocks over the roof reference
    part("o:w2", square(5, 0, 10, 10), null, 6), // low podium part: replaces the outline's 10 blocks with 2
    part("o:w3", square(2, 2, 8, 4), 150, 160), // skybridge at 150 m: above the tower (90 m) and the podium → floating on all 12 columns
    part("o:w4", square(20, 20, 22, 22), 0, 9), // no building owns these columns
    part("o:w5", square(0, 0, 1, 1), null, null), // no height
  ], () => ({ roofRef: 2, base: 2 }));
  assert.equal(r.top[0], 32);
  assert.equal(r.top[7], 4);
  assert.equal(r.top[11 * CHUNK], 0, "outside the footprint untouched");
  assert.deepEqual(rep.droppedFloatingParts, [{ key: "o:w3", columns: 12 }]);
  assert.equal(rep.orphanColumns, 4);
  assert.deepEqual(rep.withoutHeight, ["o:w5"]);
  assert.equal(rep.lowered, 50);
  assert.throws(() => applyParts(r, [{ key: "o:w9", isPart: false, polygons: [] }], () => ({})), /not a building:part/);
  const { chunks } = rasterToChunks(r);
  assert.equal(chunks[0].buildings[0].top, 32, "entry top = max column top");
});

test("landmask + skirts: cells over the grid, sea 0, height + 1; skirts compare listed edges with unbuilt cells", () => {
  const land = [[square(0, 0, 128, 64)]];
  const mask = buildLandmask({ grid: [3, 2], chunk: CHUNK, cell: 4, landPolygons: land, heightAt: (x) => (x < 64 ? 5 : 7) });
  validateLandmask(mask, [3, 2]);
  assert.deepEqual([mask.cellsX, mask.cellsZ], [48, 32]);
  assert.equal(landmaskHeight(mask, 10, 10), 5);
  assert.equal(landmaskHeight(mask, 100, 10), 7);
  assert.equal(landmaskHeight(mask, 150, 10), null, "outside the land polygon: sea");
  assert.equal(landmaskHeight(mask, 10, 100), null);
  assert.throws(() => buildLandmask({ grid: [1, 1], chunk: CHUNK, cell: 4, landPolygons: land, heightAt: () => 0 }), /integer ≥ 1/);
  assert.throws(() => buildLandmask({ grid: [1, 1], chunk: CHUNK, cell: 4, landPolygons: [], heightAt: () => 1 }), /no land/);
  const chunk = { cx: 0, cz: 0, ground: new Int16Array(CHUNK * CHUNK).fill(6) };
  const s = skirtHeights([chunk], new Set(["0,0"]), new Set(["0,1"]), mask);
  assert.equal(s.length, CHUNK, "only the east edge borders unbuilt land; south is a water chunk");
  assert.ok(s.every((d) => d === 1));
  assert.equal(percentile([0, 0, 1, 1, 1, 1, 1, 1, 1, 3], 0.9), 3);
  assert.equal(percentile([], 0.9), 0);
  assert.deepEqual(SF_GRID, [112, 112]);
});

console.log(`raster.check: ${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
