// W5 checks (spec-v2 §7.6, §8 W5): buildWalk on a synthetic road set (y rule, decks, bridges, filters, islands,
// spurs, places), the fixture walk.bin (deck y, ground y, every place reaches the ferry), and the sf graph once the
// v2 rebuild exists [post-int].
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  CHUNK, CITY_VERSION, MAX_WALK_BYTES, WALK_NO_NAME, blockToLonLat, chunkKey, decodeChunk, decodeWalk, edgeIsDeck, encodeWalk,
  validateManifest, validatePlaces,
} from "../../../public/shared/city.js";
import { DECK_MAX_M, buildWalk, isWalkable, streetName } from "../lib/walk.mjs";
import { MAX_WALK_GZ_BYTES, chunkGround, loadDecks, loadRoads } from "../walk-sf.mjs";
import { route } from "../../../src/city/route.ts";

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
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

/** Node n of a graph → [x, z, y] blocks. */
const P = (g, n) => [g.nodes[n * 3] / 10, g.nodes[n * 3 + 1] / 10, g.nodes[n * 3 + 2] / 10];
const deckNodes = (g) => {
  const s = new Set();
  for (let e = 0; e < g.edges.length / 5; e++) if (edgeIsDeck(g.edges, e)) s.add(g.edges[e * 5]).add(g.edges[e * 5 + 1]);
  return s;
};
const nodesNear = (g, x, z, r) => {
  const out = [];
  for (let n = 0; n < g.nodes.length / 3; n++) if (Math.hypot(g.nodes[n * 3] / 10 - x, g.nodes[n * 3 + 1] / 10 - z) <= r) out.push(n);
  return out;
};

// ---------- small pieces ----------

await test("streetName abbreviates only the final suffix", () => {
  assert.equal(streetName("2nd Street"), "2nd St");
  assert.equal(streetName("Howard Street"), "Howard St");
  assert.equal(streetName("Terry A Francois Boulevard"), "Terry A Francois Blvd");
  assert.equal(streetName("The Embarcadero"), "The Embarcadero");
  assert.equal(streetName("Street"), "Street");
  assert.equal(streetName("Willie Mays Plaza"), "Willie Mays Plaza");
  assert.throws(() => streetName(""), /bad name/);
});

await test("isWalkable: spec classes in; motorway, trunk, sidewalks, crossings, tunnels, parking aisles out", () => {
  for (const h of ["footway", "pedestrian", "living_street", "residential", "unclassified", "tertiary", "secondary", "primary", "busway", "primary_link"]) {
    assert.ok(isWalkable({ highway: h }), h);
  }
  assert.ok(isWalkable({ highway: "service", name: "Jack Kerouac Alley" }));
  for (const t of [
    { highway: "motorway" }, { highway: "trunk" }, { highway: "motorway_link" }, { highway: "cycleway" },
    { highway: "footway", footway: "sidewalk" }, { highway: "footway", footway: "crossing" },
    { highway: "residential", tunnel: "yes" }, { highway: "footway", layer: "-1" },
    { highway: "service", service: "parking_aisle", name: "Lot" }, { highway: "service" },
    { highway: "footway", foot: "no" }, { highway: "residential", access: "private" },
  ]) assert.ok(!isWalkable(t), JSON.stringify(t));
  assert.ok(isWalkable({ highway: "footway", access: "private", foot: "yes" }));
});

// ---------- synthetic build ----------

const fixtureManifest = validateManifest(readJson("public/city/fixture/manifest.json"));
const X0 = fixtureManifest.chunks.min[0] * CHUNK, Z0 = fixtureManifest.chunks.min[1] * CHUNK;
const HILL = [X0 + 60, Z0 + 50];
/** Synthetic ground: a cone hill (slope 1/4) at HILL, a water strip at lx 120..130, else 2. */
const synthGround = (x, z) => {
  const lx = x - X0;
  if (lx >= 120 && lx <= 130) return 0;
  return 2 + Math.max(0, Math.round(16 - Math.hypot(x + 0.5 - HILL[0], z + 0.5 - HILL[1]) / 4));
};
let wayId = 1000;
const way = (tags, ...pts) => ({
  type: "way",
  id: ++wayId,
  tags,
  geometry: pts.map(([lx, lz]) => {
    const ll = blockToLonLat(X0 + lx, Z0 + lz, fixtureManifest.proj);
    return { lat: Number(ll.lat.toFixed(7)), lon: Number(ll.lon.toFixed(7)) };
  }),
});
const at = (lx, lz) => blockToLonLat(X0 + lx + 0.5, Z0 + lz + 0.5, fixtureManifest.proj);

function synthInput() {
  wayId = 1000;
  const roads = [
    way({ highway: "residential", name: "Test Avenue" }, [10, 100], [60, 100], [100, 100], [150, 100], [240, 100]),
    way({ highway: "residential", name: "Hill Street" }, [60, 10], [60, 100], [60, 200]),
    way({ highway: "footway", name: "Bank Path" }, [100, 100], [100, 110], [115, 110]),
    way({ highway: "footway", name: "Test Bridge", bridge: "yes", layer: "1" }, [115, 110], [135, 110]),
    way({ highway: "footway", name: "Bank Path" }, [135, 110], [150, 110], [150, 100]),
    way({ highway: "footway", name: "Long Bridge", bridge: "yes" }, [10, 235], [135, 235]),
    way({ highway: "footway", footway: "sidewalk", name: "Sidewalk Ghost" }, [10, 98], [240, 98]),
    way({ highway: "motorway", name: "Fixture Freeway" }, [10, 150], [240, 150]),
    way({ highway: "service", service: "parking_aisle", name: "Lot Aisle" }, [160, 160], [200, 160]),
    way({ highway: "footway" }, [30, 100], [30, 108]),
    way({ highway: "footway" }, [200, 105], [200, 130], [210, 140]),
    way({ highway: "footway" }, [230, 200], [240, 210]),
  ];
  const decks = { [roads[3].id]: 6 };
  const site = (id, name, address, lx, lz) => {
    const ll = at(lx, lz);
    return { id, companyId: id, name, primary: true, address, lat: ll.lat, lon: ll.lon, anchor: { x: X0 + lx, y: synthGround(X0 + lx, Z0 + lz), z: Z0 + lz } };
  };
  const sites = [site("synth-one", "Synth One", "1 Test Avenue", 80, 96), site("synth-two", "Synth Two", "2 Test Avenue, Floor 2", 80, 96), site("synth-three", "Synth Three", "9 Hill Street", 56, 40)];
  const ll = at(140, 104);
  const placesSrc = [{ id: "lm:synth-mark", kind: "landmark", name: "Synth Mark", aliases: ["the mark"], lat: ll.lat, lon: ll.lon, source: { url: "https://example.com/synthetic" } }];
  return { roads, decks, groundAt: synthGround, manifest: fixtureManifest, sites, placesSrc };
}
const synth = buildWalk(synthInput());
const G = synth.walk;
const placeById = (id) => synth.places.places.find((p) => p.id === id);

await test("synthetic: valid graph, deterministic bytes, filters applied", () => {
  const again = buildWalk(synthInput());
  assert.deepEqual(encodeWalk(again.walk, fixtureManifest), encodeWalk(G, fixtureManifest), "same input, same bytes");
  assert.ok(G.names.includes("Test Ave") && G.names.includes("Hill St") && G.names.includes("Test Bridge"), G.names.join(", "));
  for (const gone of ["Long Bridge", "Sidewalk Ghost", "Fixture Freeway", "Lot Aisle"]) assert.ok(!G.names.includes(gone), gone);
  assert.equal(synth.stats.longBridges, 1, `bridges ≥ ${DECK_MAX_M} m are left out`);
  assert.ok(synth.stats.droppedWaterSamples > 0, "Test Ave is cut by the water strip");
});

await test("synthetic: bridge under 300 m without a deck top throws", () => {
  const input = synthInput();
  assert.throws(() => buildWalk({ ...input, decks: {} }), /bridge way \d+ \(Test Bridge, \d+ m\) has no deck top/);
  assert.throws(() => buildWalk({ ...input, decks: { "abc": 3 } }), /not an OSM way id/);
});

await test("synthetic: deck nodes at the deck top, ground nodes at groundAt, vertical connectors at the bridge ends", () => {
  const decks = deckNodes(G);
  assert.ok(decks.size >= 2, "the bridge has deck edges");
  for (const n of decks) assert.equal(G.nodes[n * 3 + 2], 60, `deck node ${n} y`);
  for (let n = 0; n < G.nodes.length / 3; n++) {
    if (decks.has(n)) continue;
    const [x, z, y] = P(G, n);
    assert.equal(y, synthGround(Math.floor(x), Math.floor(z)), `ground node ${n} at ${x},${z}`);
  }
  let connectors = 0;
  for (let e = 0; e < G.edges.length / 5; e++) {
    const [a, b] = [G.edges[e * 5], G.edges[e * 5 + 1]];
    if (G.nodes[a * 3] === G.nodes[b * 3] && G.nodes[a * 3 + 1] === G.nodes[b * 3 + 1]) {
      connectors++;
      assert.equal(G.edges[e * 5 + 2], Math.abs(G.nodes[a * 3 + 2] - G.nodes[b * 3 + 2]), "connector length = |dy|");
      assert.equal(G.edges[e * 5 + 3], WALK_NO_NAME);
    }
  }
  assert.equal(connectors, 4, "one connector per bridge end, both directions");
});

await test("synthetic: along every ground edge the straight y stays within 1 block of the ground (hill street)", () => {
  const decks = deckNodes(G);
  let worst = 0, edges = 0;
  for (let e = 0; e < G.edges.length / 5; e++) {
    const [a, b] = [G.edges[e * 5], G.edges[e * 5 + 1]];
    if (decks.has(a) || decks.has(b) || G.names[G.edges[e * 5 + 3]] !== "Hill St") continue;
    edges++;
    const [pa, pb] = [P(G, a), P(G, b)];
    const L = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
    for (let k = 1; k < L; k++) {
      const t = k / L;
      const [x, z, y] = [pa[0] + t * (pb[0] - pa[0]), pa[1] + t * (pb[1] - pa[1]), pa[2] + t * (pb[2] - pa[2])];
      worst = Math.max(worst, Math.abs(y - synthGround(Math.floor(x), Math.floor(z))));
    }
  }
  assert.ok(edges >= 8, `Hill St over the hill keeps nodes (${edges / 2} edges)`);
  assert.ok(worst <= 1.25, `worst y error ${worst.toFixed(2)} blocks`);
});

await test("synthetic: short unnamed spur pruned, near island linked, far island dropped", () => {
  assert.equal(nodesNear(G, X0 + 30, Z0 + 108, 2).length, 0, "8-block dead-end footway is pruned");
  assert.ok(nodesNear(G, X0 + 210, Z0 + 140, 1).length === 1, "island 5 blocks from Test Ave is linked");
  assert.equal(nodesNear(G, X0 + 235, Z0 + 205, 8).length, 0, "island far from everything is dropped");
  const r = route(G, nodesNear(G, X0 + 210, Z0 + 140, 1)[0], placeById("x:hill-st&test-ave").node);
  assert.ok(r.lengthBlocks > 0);
});

await test("synthetic: places (doors, landmark, intersection) validate and route across the bridge", () => {
  validatePlaces(synth.places, fixtureManifest, G);
  const one = placeById("site:synth-one"), two = placeById("site:synth-two");
  assert.deepEqual(one.door, [X0 + 80, Z0 + 96]);
  assert.equal(one.node, two.node, "two sites on one door column share the door node");
  assert.deepEqual(two.aliases, ["2 Test Avenue, Floor 2", "2 Test Avenue"]);
  const [dx, dz] = P(G, one.node);
  assert.deepEqual([dx, dz], [X0 + 80.5, Z0 + 96.5], "door node at the door column centre");
  const x = placeById("x:hill-st&test-ave");
  assert.equal(x.name, "Hill St & Test Ave");
  assert.deepEqual(x.aliases, ["Test Ave & Hill St"]);
  const [ix, iz] = P(G, x.node);
  assert.ok(Math.hypot(ix - (X0 + 60), iz - (Z0 + 100)) < 1, `intersection node at ${ix},${iz}`);
  const mark = placeById("lm:synth-mark");
  const r = route(G, one.node, mark.node);
  assert.ok(r.via.includes("Test Bridge"), `via ${r.via.join(" → ")}`);
  assert.ok(r.path.some((p) => p[2] === 6), "the path climbs onto the deck");
  assert.throws(() => buildWalk({ ...synthInput(), sites: [{ ...synthInput().sites[0], anchor: { x: X0 + 140, y: 2, z: Z0 + 30 } }] }), /door .* more than 30 blocks/);
});

// ---------- fixture ----------

await test("fixture: walk.bin and places.json decode and agree with the manifest", () => {
  const g = decodeWalk(new Uint8Array(readFileSync(join(ROOT, "public/city/fixture/walk.bin"))), fixtureManifest);
  validatePlaces(readJson("public/city/fixture/places.json"), fixtureManifest, g);
});

await test("fixture: deck nodes at the chunk deck top, ground nodes within 1 block of the chunk ground", () => {
  const g = decodeWalk(new Uint8Array(readFileSync(join(ROOT, "public/city/fixture/walk.bin"))), fixtureManifest);
  const ground = chunkGround(join(ROOT, "public/city/fixture"), fixtureManifest);
  const chunks = new Map();
  const deckAt = (x, z) => {
    const k = chunkKey(Math.floor(x / CHUNK), Math.floor(z / CHUNK));
    if (!chunks.has(k)) chunks.set(k, decodeChunk(new Uint8Array(gunzipSync(readFileSync(join(ROOT, "public/city/fixture/chunks", `${k}.bin`)))), fixtureManifest.parents));
    return chunks.get(k).deck[(z % CHUNK) * CHUNK + (x % CHUNK)];
  };
  const decks = deckNodes(g);
  assert.ok(decks.size > 0, "the fixture bridge has deck nodes");
  for (let n = 0; n < g.nodes.length / 3; n++) {
    const [x, z, y] = P(g, n);
    const [cx, cz] = [Math.floor(x), Math.floor(z)];
    if (decks.has(n)) assert.ok(Math.abs(y - Math.abs(deckAt(cx, cz))) <= 0.5, `deck node ${n} y ${y} vs deck ${deckAt(cx, cz)}`);
    else assert.ok(Math.abs(y - ground(cx, cz)) <= 1, `ground node ${n} y ${y} vs ground ${ground(cx, cz)}`);
  }
});

await test("fixture: every place reaches the ferry", () => {
  const g = decodeWalk(new Uint8Array(readFileSync(join(ROOT, "public/city/fixture/walk.bin"))), fixtureManifest);
  const places = readJson("public/city/fixture/places.json").places;
  const ferry = places.find((p) => p.id === "lm:fixture-ferry");
  for (const p of places) {
    const r = route(g, p.node, ferry.node);
    assert.equal(r.nodes.at(-1), ferry.node, p.id);
    for (const pt of r.path) assert.ok(pt.length === 3 && Number.isFinite(pt[2]), `${p.id}: path point without y`);
  }
});

// ---------- sf (post-integration) ----------

await test("sf: walk.bin gates on the real build [post-int]", () => {
  const dir = join(ROOT, "public/city/sf");
  if (!existsSync(join(dir, "manifest.json"))) return console.log("     skipped: public/city/sf not built yet");
  const version = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).version;
  if (version !== CITY_VERSION) return console.log(`     skipped: public/city/sf is a v${version} build; this check reads v${CITY_VERSION} (waits for the v2 rebuild)`);
  const manifest = validateManifest(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
  const bytes = new Uint8Array(readFileSync(join(dir, manifest.walk)));
  assert.ok(bytes.length <= MAX_WALK_BYTES, `walk.bin ${bytes.length} B raw`);
  assert.ok(gzipSync(bytes, { level: 9 }).length <= MAX_WALK_GZ_BYTES, "walk.bin ≤ 160 KB gzipped");
  const g = decodeWalk(bytes, manifest);
  const places = validatePlaces(JSON.parse(readFileSync(join(dir, manifest.places), "utf8")), manifest, g);

  const n = g.nodes.length / 3;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let e = 0; e < g.edges.length / 5; e++) parent[find(g.edges[e * 5])] = find(g.edges[e * 5 + 1]);
  const sizes = new Map();
  for (let i = 0; i < n; i++) sizes.set(find(i), (sizes.get(find(i)) ?? 0) + 1);
  assert.ok(Math.max(...sizes.values()) / n >= 0.95, "largest component ≥ 95% of nodes");

  const ferry = places.places.find((p) => p.id === "lm:ferry-building");
  assert.ok(ferry, "the Ferry Building is a place");
  const companies = JSON.parse(readFileSync(join(dir, "companies.json"), "utf8"));
  for (const s of companies.sites) assert.ok(places.places.some((p) => p.siteId === s.id), `site ${s.id} has a place`);
  for (const p of places.places) {
    if (p.kind === "intersection") continue;
    assert.equal(route(g, p.node, ferry.node).nodes.at(-1), ferry.node, `${p.id} reaches the Ferry Building`);
  }

  const ground = chunkGround(dir, manifest);
  const decks = deckNodes(g);
  for (let i = 0; i < n; i++) {
    if (decks.has(i)) continue;
    const [x, z, y] = P(g, i);
    assert.ok(Math.abs(y - ground(Math.floor(x), Math.floor(z))) <= 1, `ground node ${i} at ${x},${z}: y ${y} vs ground ${ground(Math.floor(x), Math.floor(z))}`);
  }

  const deckTop = loadDecks(dir, join(ROOT, "data/city/sf/build"));
  const fourth = loadRoads(join(ROOT, "data/city/sf/raw")).filter((w) => w.tags?.name === "4th Street" && w.tags.bridge && w.tags.bridge !== "no");
  const tops = fourth.map((w) => deckTop[w.id]).filter((v) => v !== undefined);
  assert.ok(tops.length > 0, "report.json has a deck top for the 4th St bridge");
  let onBridge = 0;
  for (let e = 0; e < g.edges.length / 5; e++) {
    if (!edgeIsDeck(g.edges, e) || g.names[g.edges[e * 5 + 3]] !== "4th St") continue;
    for (const v of [g.edges[e * 5], g.edges[e * 5 + 1]]) {
      onBridge++;
      assert.ok(tops.some((t) => Math.abs(P(g, v)[2] - t) <= 0.5), `4th St bridge node ${v} y ${P(g, v)[2]} vs deck ${tops.join("/")}`);
    }
  }
  assert.ok(onBridge > 0, "the 4th St bridge is in the walk graph as deck edges");
});

console.log(`walk.check: ${passed} passed`);
