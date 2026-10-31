// City UI checks (v1 W6 + v2 W7): label cull, pin layout and size, panel info, search, and the live characters
// (feed interpolation, sidewalk offset, beacons, chips, chat as text, follow, badges) against the fixture and a
// mock WS feed. No real DOM: a tiny fake document stands in, and it throws if anything touches innerHTML.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "../../../public/vendor/three-0.186.1/three.module.js";
import { CHUNK, SURFACE, decodeChunk, decodeWalk, chunkKey, validateCompanies, validateManifest, validatePlaces } from "../../../public/shared/city.js";
import { cullLabels, labelGroups, LABEL_LIFT, MAX_LABELS } from "../../../public/js/city/labels.js";
import {
  PIN_BOXES, PIN_SIZE, PINS_MAX_DIST, PINS_PER_COLUMN, PINS_PER_COMPANY, createPins, layoutPins, pinBounds, stepAway,
} from "../../../public/js/city/pins.js";
import { buildingInfo, chatLine, panelTitle, siteInfo, whoIsHere } from "../../../public/js/city/panel.js";
import { searchAll, searchSites } from "../../../public/js/city/search.js";
import {
  applyBadges, camState, createFollow, focusDistance, formatCam, liveUrlFor, parseCam, pinScale,
} from "../../../public/js/city/ui.js";
import {
  SAY_MS, SIDEWALK_OUT, badgeText, sidewalkOffset, connectLive, createLiveState, createWireAdapter, graphIndex, insideCounts, presenceForPins, segmentWidths, validatePath,
} from "../../../public/js/city/live.js";
import { BEACON_DIST, MAX_CHIPS, STRIDE, chipOrder, createWalkers, drawMode, gaitPhase, pickWalker } from "../../../public/js/city/walkers.js";
import { FIXTURE_DIR } from "../fixture.mjs";

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`✗ ${name}\n  ${e.stack}`); process.exitCode = 1; }
};

const manifest = validateManifest(JSON.parse(readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8")));
const companies = validateCompanies(JSON.parse(readFileSync(join(FIXTURE_DIR, "companies.json"), "utf8")), manifest);
const { sites } = companies;
const chunks = new Map();
for (const [cx, cz] of manifest.chunks.list) {
  chunks.set(chunkKey(cx, cz), decodeChunk(gunzipSync(readFileSync(join(FIXTURE_DIR, "chunks", `${cx}_${cz}.bin`))), manifest.parents));
}
function column(x, z) {
  const c = chunks.get(chunkKey(Math.floor(x / CHUNK), Math.floor(z / CHUNK)));
  if (!c) return null;
  const i = (z - c.cz * CHUNK) * CHUNK + (x - c.cx * CHUNK);
  return { ground: c.ground[i], b: c.bldg[i] ? c.buildings[c.bldg[i] - 1] : null };
}

const rect = (id, x, y, dist, order, w = 50, h = 20) => ({ id, x, y, w, h, dist, order });

test("cullLabels: overlap drops the farther label, list order breaks distance ties", () => {
  const kept = cullLabels([rect("far", 10, 10, 90, 0), rect("near", 20, 15, 10, 1), rect("apart", 300, 10, 50, 2)]);
  assert.deepEqual(kept.map((r) => r.id), ["near", "apart"]);
  const tie = cullLabels([rect("b", 0, 0, 5, 1), rect("a", 10, 0, 5, 0)]);
  assert.deepEqual(tie.map((r) => r.id), ["a"]);
  const touching = cullLabels([rect("l", 0, 0, 1, 0), rect("r", 50, 0, 2, 1)]);
  assert.equal(touching.length, 2, "edge-touching rects do not overlap");
});

test("cullLabels: at most 24 by default, max honoured, bad input throws", () => {
  const many = Array.from({ length: 60 }, (_, i) => rect(`l${i}`, (i % 10) * 60, Math.floor(i / 10) * 30, i, i));
  assert.equal(MAX_LABELS, 24);
  assert.equal(cullLabels(many).length, 24);
  assert.deepEqual(cullLabels(many).map((r) => r.id), many.slice(0, 24).map((r) => r.id));
  assert.equal(cullLabels(many, 5).length, 5);
  assert.throws(() => cullLabels([{ id: "x", x: 0, y: 0, w: 1, h: 1, order: 0 }]), /no numeric dist/);
  assert.throws(() => cullLabels([], -1), /max/);
});

test("labelGroups: fixture gives 2 chips holding all 3 companies, shared tower in one chip at roofY+2", () => {
  const groups = labelGroups(sites);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.flatMap((g) => g.sites.map((s) => s.companyId)).sort(), ["example-robotics", "fixture-labs", "sample-bakery"]);
  const tower = groups.find((g) => g.buildingId === 8);
  assert.deepEqual(tower.sites.map((s) => s.companyId), ["fixture-labs", "example-robotics"]);
  assert.equal(tower.y, 101 + LABEL_LIFT);
  assert.equal(tower.order, 0);
});

test("labelGroups: only primary sites get a chip; former stays in", () => {
  const extra = [
    ...sites,
    { ...sites[2], id: "bakery-2", primary: false, buildingId: 99 },
    { ...sites[2], id: "gone", companyId: "gone", status: "former", buildingId: 98 },
  ];
  const groups = labelGroups(extra);
  assert.ok(!groups.some((g) => g.buildingId === 99));
  assert.equal(groups.find((g) => g.buildingId === 98).sites[0].status, "former");
});

test("pins: one pin is under 1 block tall and at most 0.25 block wide (and deep)", () => {
  const b = pinBounds();
  assert.ok(Math.abs(b.h - PIN_SIZE.h) < 1e-9, `height ${b.h}`);
  assert.ok(b.h < 1, `height ${b.h} < 1`);
  assert.ok(b.w <= PIN_SIZE.w + 1e-9 && PIN_SIZE.w <= 0.25, `width ${b.w}`);
  assert.ok(b.d <= 0.25, `depth ${b.d}`);
  assert.ok(Math.abs(b.minY) < 1e-9, "feet at y=0");
  assert.deepEqual([...new Set(PIN_BOXES.map((p) => p.part))].sort(), ["arm", "head", "leg", "torso"]);
});

test("pins: layout puts ≤ 4 per column, ≤ 12 per company, +N beyond, columns step away from the door", () => {
  const anchor = { x: 100, y: 3, z: 200 };
  const step = stepAway(anchor, { x: 100, z: 205 });
  assert.deepEqual(step, { dx: 0, dz: -1 });
  for (const n of [0, 1, 4, 5, 12, 13, 40]) {
    const { pins, overflow } = layoutPins(anchor, n, step);
    assert.equal(pins.length, Math.min(n, PINS_PER_COMPANY), `n=${n}`);
    assert.equal(overflow, Math.max(0, n - PINS_PER_COMPANY), `n=${n}`);
    const perColumn = new Map();
    for (const p of pins) {
      const key = `${Math.floor(p.x)},${Math.floor(p.z)}`;
      perColumn.set(key, (perColumn.get(key) ?? 0) + 1);
      assert.equal(p.y, anchor.y);
    }
    for (const [key, c] of perColumn) assert.ok(c <= PINS_PER_COLUMN, `n=${n}: ${c} pins in column ${key}`);
  }
  const { pins } = layoutPins(anchor, 12, step);
  assert.deepEqual([...new Set(pins.map((p) => `${Math.floor(p.x)},${Math.floor(p.z)}`))], ["100,200", "100,199", "100,198"]);
  const firstCol = pins.slice(0, 4).map((p) => [p.x - 100, p.z - 200]);
  assert.deepEqual(firstCol, [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]], "2×2 sub-grid, pins never touch");
  assert.equal(stepAway({ x: 5, z: 5 }, { x: 5, z: 5 }), null);
  assert.throws(() => layoutPins(anchor, 3, { dx: 1, dz: 1 }), /unit axis step/);
  assert.throws(() => layoutPins({ x: 1.5, y: 1, z: 1 }, 3, step), /anchor\.x/);
  assert.throws(() => layoutPins(anchor, -1, step), /count/);
});

function mockCity({ dist = 150 } = {}) {
  const added = [];
  const city = {
    THREE, manifest, distance: dist,
    add: (o) => added.push(o),
    remove: (o) => added.splice(added.indexOf(o), 1),
    cameraDistance: () => city.distance,
    buildingAt: (x, z) => column(Math.floor(x), Math.floor(z))?.b ?? null,
    groundAt: (x, z) => column(Math.floor(x), Math.floor(z))?.ground ?? 0,
  };
  return { city, added };
}

test("createPins: one InstancedMesh (one draw call), real geometry within pin size, hidden beyond 200 with badge counts", () => {
  const { city, added } = mockCity();
  let counts = null;
  const pins = createPins(city, sites, { onCounts: (c) => { counts = new Map(c); } });
  assert.equal(added.length, 1);
  assert.ok(added[0].isInstancedMesh);
  pins.mesh.geometry.computeBoundingBox();
  const bb = pins.mesh.geometry.boundingBox;
  assert.ok(bb.max.y - bb.min.y < 1 && bb.max.x - bb.min.x <= 0.25 + 1e-6 && bb.max.z - bb.min.z <= 0.25 + 1e-6);

  pins.setPresence([{ companyId: "fixture-labs", agents: Array.from({ length: 15 }, (_, i) => ({ id: `a${i}`, name: `a${i}`, hue: i * 20, status: "working" })) }]);
  assert.equal(pins.mesh.count, 12);
  assert.ok(pins.mesh.visible);
  assert.deepEqual(counts.get("fixture-labs"), { agents: 15, overflow: 3, pinsVisible: true, here: 15, inside: 0, text: "15 here" });
  const m = new THREE.Matrix4(), p = new THREE.Vector3();
  const site = sites[0];
  for (let i = 0; i < 12; i++) {
    pins.mesh.getMatrixAt(i, m);
    p.setFromMatrixPosition(m);
    const col = column(Math.floor(p.x), Math.floor(p.z));
    assert.equal(col.b, null, `pin ${i} at ${p.x},${p.z} stands on a building column`);
    assert.ok(Math.abs(p.z - site.anchor.z) < 4 && Math.abs(p.x - site.anchor.x) < 4, `pin ${i} near the anchor`);
  }

  city.distance = PINS_MAX_DIST + 1;
  pins.update();
  assert.equal(pins.mesh.visible, false);
  assert.equal(counts.get("fixture-labs").pinsVisible, false);
  assert.throws(() => pins.setPresence([{ companyId: "nope", agents: [] }]), /no primary site/);
  assert.throws(() => pins.setPresence([{ companyId: "fixture-labs", agents: [{ id: "x", name: "x" }] }]), /hue/);
  pins.dispose();
  assert.equal(added.length, 0);
});

test("buildingInfo: the shared fixture tower lists both companies with address and sources; height from base/top", () => {
  const tower = column(sites[0].block.x, sites[0].block.z).b;
  assert.equal(tower.id, 8);
  const info = buildingInfo(sites, tower);
  assert.equal(info.heightM, 300);
  assert.deepEqual(info.sites.map((s) => s.name), ["Fixture Labs", "Example Robotics"]);
  for (const s of info.sites) assert.ok(s.address && s.sources.length && s.verifiedAt);
  assert.equal(panelTitle(info), "2 companies · 300 m");
  assert.deepEqual(siteInfo(sites, sites[1]), info);
});

test("buildingInfo: a building with no company is 'building · N m'; bad buildings throw", () => {
  let empty = null;
  for (const c of chunks.values()) for (const b of c.buildings) if (!sites.some((s) => s.buildingId === b.id)) empty ??= b;
  assert.ok(empty, "fixture has a company-free building");
  const info = buildingInfo(sites, empty);
  assert.equal(info.sites.length, 0);
  assert.equal(panelTitle(info), `building · ${(empty.top - empty.base) * 3} m`);
  assert.throws(() => buildingInfo(sites, null), /bad building/);
  assert.throws(() => buildingInfo(sites, { id: 1, base: 5, top: 5 }), /base\/top/);
});

test("searchSites: case-insensitive, prefix before substring, primary first, empty query → none", () => {
  assert.deepEqual(searchSites(sites, "FIXTURE").map((s) => s.id), ["fixture-labs"]);
  assert.deepEqual(searchSites(sites, "rob").map((s) => s.id), ["example-robotics"]);
  assert.deepEqual(searchSites(sites, "  ").map((s) => s.id), []);
  assert.deepEqual(searchSites(sites, "co").map((s) => s.id), ["sample-bakery"]);
  const campus = [{ ...sites[2], id: "b2", primary: false }, ...sites];
  assert.deepEqual(searchSites(campus, "bakery").map((s) => s.id), ["sample-bakery", "b2"]);
  assert.throws(() => searchSites(sites, null), /string/);
});

test("focusDistance and pinScale: a pin projects shorter than a 1-block column at distance 150", () => {
  assert.equal(focusDistance(sites[2]), 160);
  assert.equal(focusDistance(sites[0]), 450);
  const cam = new THREE.PerspectiveCamera(30, 390 / 844, 1, 6000);
  const target = new THREE.Vector3(sites[0].anchor.x + 0.5, sites[0].anchor.y, sites[0].anchor.z + 0.5);
  cam.position.copy(target).add(new THREE.Vector3(0, Math.cos(0.9), Math.sin(0.9)).multiplyScalar(150));
  cam.lookAt(target);
  cam.updateMatrixWorld();
  const v = new THREE.Vector3();
  const city = {
    cameraDistance: () => cam.position.distanceTo(target),
    worldToScreen: (x, y, z) => {
      v.set(x, y, z).project(cam);
      return { x: (v.x + 1) * 195, y: (1 - v.y) * 422, visible: v.z < 1 };
    },
  };
  const r = pinScale(city, target.x, target.y, target.z);
  assert.ok(Math.abs(r.dist - 150) < 1e-6);
  assert.ok(r.ok && r.pinPx < r.blockPx, JSON.stringify(r));
});

/* ── v2 W7: live characters ──────────────────────────────────────────────────────────────────── */

const walk = decodeWalk(new Uint8Array(readFileSync(join(FIXTURE_DIR, "walk.bin"))), manifest);
const placesDoc = JSON.parse(readFileSync(join(FIXTURE_DIR, "places.json"), "utf8"));
validatePlaces(placesDoc, manifest, walk);
const node = (i) => [walk.nodes[i * 3] / 10, walk.nodes[i * 3 + 1] / 10, walk.nodes[i * 3 + 2] / 10];
// fixture graph: Fixture Ave nodes 0..11 (E-W, halfWidth 2), Test St 12..24 (N-S, through node 5, halfWidth 2),
// Fixture Bridge 10, 25..32 (N-S footway, halfWidth 1) with deck nodes 28..30 at y 4
assert.deepEqual(node(0), [3584.5, 1665.5, 1]);
assert.deepEqual([28, 29, 30].map((i) => node(i)[2]), [4, 4, 4], "fixture deck nodes at y 4");

const S = 1_000_000_000_000, L = 5_000;
const walker = (id, path, over = {}) => ({ id, name: id, hue: 200, status: "working", path, t0: S, speed: 2, mode: "walk", inside: false, siteId: null, ...over });
const snapshot = (over = {}) => ({ type: "snapshot", now: S, walkers: [], presence: [], chatTail: [], ...over });
const wireWalker = (id, path, over = {}) => ({ id, name: id, hue: 200, status: "working", site: "fixture-labs", path, t0: S, speed: 2, mode: "walk", ...over });
const wireSnapshot = (over = {}) => ({ type: "snapshot", now: S, builtAt: manifest.builtAt, sites: [], walkers: [], chatTail: [], ...over });
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);

/** Independent centreline reference: lerp along 3-D segment lengths, no offsets. */
function centreline(path, d) {
  let left = Math.max(0, d);
  for (let i = 0; i + 1 < path.length; i++) {
    const [a, b] = [path[i], path[i + 1]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (left <= len) { const f = len ? left / len : 0; return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]; }
    left -= len;
  }
  return path[path.length - 1];
}

test("live: snapshot + 3 walk frames interpolate x, z, y within 0.1 block at 3 timestamps (one on a deck), with the server clock offset", () => {
  const live = createLiveState({ graph: walk });
  live.apply(snapshot({ walkers: [walker("a", [node(0), node(5)])] }), L);
  live.apply({ type: "walk", walker: walker("b", [27, 28, 29, 30, 31].map(node)) }, L + 10);
  live.apply({ type: "walk", walker: walker("c", [node(5), node(20)], { mode: "ride", speed: 8 }) }, L + 20);
  live.apply({ type: "walk", walker: walker("a", [node(5), node(20)], { t0: S + 5000 }) }, L + 30);

  // t1: c rides south on Test St (halfWidth 2): right-hand side of +z is −x, 2 − inset off the centreline
  let p = live.position("c", L + 2000);
  near(p.x, 3685.5 - (2 + SIDEWALK_OUT), 0.1, "c.x"); near(p.z, 1665.5 + 16, 0.1, "c.z"); near(p.y, 1, 0.1, "c.y");
  assert.equal(p.mode, "ride");
  // t2: b on the bridge deck between nodes 28 and 29, heading north: right-hand is +x, 1 − inset
  const d = Math.hypot(1, 3) + 3.5;
  p = live.position("b", L + (d / 2) * 1000);
  near(p.x, 3780.5 + 0.5, 0.1, "b.x"); near(p.z, 1605, 0.1, "b.z"); near(p.y, 4, 0.1, "b.y (deck top, from the graph)");
  assert.equal(walk.nodes[28 * 3 + 2] / 10, 4);
  // t3: a re-routed by the third walk frame: 4 blocks south of node 5 at L + 7000
  p = live.position("a", L + 7000);
  near(p.x, 3685.5 - (2 + SIDEWALK_OUT), 0.1, "a.x"); near(p.z, 1669.5, 0.1, "a.z"); near(p.y, 1, 0.1, "a.y");
  assert.ok(p.moving);
  // before t0 a walker waits at its first point; past the end it stands at the last one
  assert.equal(live.position("a", L).d, 0);
  assert.equal(live.position("b", L + 600_000).moving, false);
  assert.equal(live.serverNow(L + 1), S + 1);
});

test("live: a path point without y throws, and so do frames before the snapshot, unknown fields and DMs", () => {
  assert.throws(() => validatePath([[1, 2, 3], [4, 5]]), /has no y/);
  const live = createLiveState({ graph: walk });
  assert.throws(() => live.apply({ type: "walk", walker: walker("a", [node(0)]) }, L), /before the snapshot/);
  assert.throws(() => live.apply(snapshot({ walkers: [walker("a", [[3584.5, 1665.5], node(1)])] }), L), /has no y/);
  live.apply(snapshot(), L);
  assert.throws(() => live.apply({ type: "walk", walker: walker("a", [node(0), [3600, 1665.5]]) }, L), /path\[1\] has no y/);
  assert.throws(() => live.apply({ type: "walk", walker: { ...walker("a", [node(0)]), activity: "secret" } }, L), /unknown field "activity"/);
  assert.throws(() => live.apply({ type: "chat", chat: { seq: 1, ts: S, from: "a", name: "a", scope: "dm", text: "psst", x: 0, z: 0 } }, L), /DMs never reach viewers/);
  assert.throws(() => live.apply({ type: "dance" }, L), /unknown frame type/);
  assert.throws(() => live.apply({ type: "walk", walker: walker("a", [node(0)], { mode: "fly" }) }, L), /mode/);
});

test("live: sidewalk widths come from walk.bin, including a simplified segment and an off-graph spur", () => {
  const idx = graphIndex(walk);
  assert.deepEqual(segmentWidths([node(0), node(1)], idx), [2]);
  assert.deepEqual(segmentWidths([node(5), node(20)], idx), [2], "simplified: the edge leaving node 5 toward node 20");
  assert.deepEqual(segmentWidths([node(27), node(28), node(30)], idx), [1, 1]);
  assert.deepEqual(segmentWidths([[3590, 1700, 1], [3591, 1700, 1]], idx), [null], "off the graph: centreline");
  assert.equal(sidewalkOffset(null), 0);
  assert.equal(sidewalkOffset(1), 0.5, "footway: right half");
  assert.equal(sidewalkOffset(2), 2 + SIDEWALK_OUT, "street: beyond the carriageway");
  assert.throws(() => sidewalkOffset(0), /halfWidth/);
  // walkers on Fixture Ave, both directions, stand on fixture SIDEWALK columns
  const live = createLiveState({ graph: walk });
  live.apply(snapshot({ walkers: [walker("e", [node(0), node(5)]), walker("w", [node(5), node(0)])] }), L);
  for (const id of ["e", "w"]) {
    for (const t of [1000, 9000, 30000]) {
      const p = live.position(id, L + t);
      const c = chunks.get(chunkKey(Math.floor(p.x / CHUNK), Math.floor(p.z / CHUNK)));
      const i = (Math.floor(p.z) - c.cz * CHUNK) * CHUNK + (Math.floor(p.x) - c.cx * CHUNK);
      assert.equal(c.surface[i], SURFACE.SIDEWALK, `${id} at ${p.x.toFixed(1)},${p.z.toFixed(1)}: surface ${c.surface[i]}`);
    }
  }
});

test("live: say bubbles expire after SAY_MS, left removes, presence and inside counts feed the pins", () => {
  const live = createLiveState({ graph: walk });
  live.apply([snapshot({ walkers: [walker("a", [node(0)]), walker("in", [node(37)], { inside: true, siteId: "fixture-labs" })] }), { type: "say", id: "a", text: "hi", ts: S }], L);
  assert.equal(live.sayOf("a", L + 100), "hi");
  assert.equal(live.sayOf("a", L + SAY_MS + 1), null);
  live.apply({ type: "presence", presence: [{ companyId: "fixture-labs", agentCount: 1, agents: [{ name: "claude@x", hue: 30, status: "working" }], inside: 1 }] }, L);
  assert.deepEqual([...insideCounts(live.presence())], [["fixture-labs", 1]]);
  assert.deepEqual(presenceForPins(live.presence()), [{ companyId: "fixture-labs", agents: [{ id: "fixture-labs:claude@x", name: "claude@x", hue: 30, status: "working" }] }]);
  assert.throws(() => live.apply({ type: "presence", presence: [{ companyId: "x", agentCount: 2, agents: [], inside: 0 }] }, L), /agentCount/);
  live.apply({ type: "left", id: "a" }, L);
  assert.equal(live.walker("a"), null);
  assert.equal(live.position("a", L), null);
});

test("wire adapter: City DO frames (sites, per-site presence, msg chat, standing walkers) become internal frames", () => {
  const fromWire = createWireAdapter();
  const live = createLiveState({ graph: walk });
  const site = (siteId, companyId, agents, inside) => ({ siteId, companyId, agentCount: agents.length, agents, inside });
  const a = { name: "claude@fg", hue: 20, status: "working" };
  live.apply(fromWire(wireSnapshot({
    sites: [site("fg-1", "firegoat", [a], 0), site("fg-2", "firegoat", [{ ...a, name: "codex@fg" }], 1)],
    walkers: [wireWalker("w1", [node(0)], { speed: 0 })],
    chatTail: [{ seq: 3, ts: S, from: { id: "w1", name: "w1" }, scope: "near", say: true, text: "hi", x: 1, z: 2 }],
  })), L);
  assert.deepEqual(live.presence().map((p) => [p.companyId, p.agentCount, p.inside]), [["firegoat", 2, 1]]);
  assert.deepEqual([...insideCounts(live.presence())], [["firegoat", 1]]);
  assert.equal(live.walker("w1").siteId, "fixture-labs");
  assert.equal(live.walker("w1").inside, false);
  assert.deepEqual(live.chat().map((c) => [c.from, c.name, c.text]), [["w1", "w1", "hi"]]);
  const p0 = live.position("w1", L + 5000);
  assert.ok(Math.abs(p0.y - node(0)[2]) < 1e-9 && !p0.moving, "a standing walker (speed 0) stays put");
  live.apply(fromWire({ type: "presence", site: site("fg-2", "firegoat", [], 0) }), L);
  assert.deepEqual(live.presence().map((p) => [p.companyId, p.agentCount, p.inside]), [["firegoat", 1, 0]]);
  live.apply(fromWire({ type: "chat", msg: { seq: 4, ts: S, from: { id: "w1", name: "w1" }, scope: "city", text: "yo", x: 0, z: 0 } }), L);
  assert.equal(live.chat().at(-1).text, "yo");
  live.apply(fromWire({ type: "left", id: "w1", inside: true }), L);
  assert.equal(live.walker("w1"), null);
  assert.throws(() => fromWire({ type: "walk", walker: { ...wireWalker("x", [node(0)]), officeId: "o1" } }), /unknown field "officeId"/);
  assert.throws(() => fromWire({ type: "error", error: "the city socket is view-only" }), /view-only/);
});

test("connectLive: opens with a snapshot, reports live/offline, reconnects with backoff, a bad frame goes to onError", () => {
  const sockets = [];
  class FakeWS { constructor(url) { this.url = url; this.closed = false; sockets.push(this); } close() { this.closed = true; } }
  const statuses = [], errors = [];
  const timers = [];
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  globalThis.clearTimeout = () => {};
  try {
    const live = createLiveState({ graph: walk });
    const conn = connectLive("ws://x/city/fixture/ws", live, { WebSocketImpl: FakeWS, onStatus: (s, d) => statuses.push([s, d?.retryMs ?? null]), onError: (e) => errors.push(e.message) });
    sockets[0].onopen();
    sockets[0].onmessage({ data: JSON.stringify(wireSnapshot({ walkers: [wireWalker("a", [node(0)])] })) });
    assert.ok(live.ready);
    sockets[0].onclose();
    assert.deepEqual(timers.map((t) => t.ms), [1000]);
    timers[0].fn();
    sockets[1].onmessage({ data: JSON.stringify({ type: "left", id: "a" }) });
    assert.match(errors[0], /must open with a snapshot/);
    assert.ok(sockets[1].closed);
    sockets[1].onclose();
    assert.deepEqual(timers.map((t) => t.ms), [1000, 2000]);
    assert.deepEqual(statuses, [["connecting", null], ["live", null], ["offline", 1000], ["connecting", null], ["offline", 2000]]);
    conn.close();
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});

/* a fake DOM: enough for walkers, panel rows and labels; innerHTML / insertAdjacentHTML throw */
class FakeEl {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this._text = ""; this.hidden = false; this.className = ""; this.dataset = {};
    this.style = { transform: "", props: {}, setProperty(k, v) { this.props[k] = v; } };
    const cls = new Set();
    this.classList = { toggle: (c, on) => (on ?? !cls.has(c) ? cls.add(c) : cls.delete(c)), add: (c) => cls.add(c), contains: (c) => cls.has(c) };
    this.listeners = {}; this.attrs = {};
  }
  get offsetWidth() { return 8 + 6 * this.textContent.length; }
  get offsetHeight() { return 18; }
  get clientWidth() { return 1280; }
  get clientHeight() { return 800; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set innerHTML(v) { throw new Error(`innerHTML used with ${JSON.stringify(v)}`); }
  get innerHTML() { throw new Error("innerHTML read"); }
  insertAdjacentHTML() { throw new Error("insertAdjacentHTML used"); }
  append(...c) { this.children.push(...c); }
  appendChild(c) { this.children.push(c); return c; }
  replaceChildren(...c) { this.children = c; }
  remove() { this.removed = true; }
  addEventListener(t, f) { this.listeners[t] = f; }
  setAttribute(k, v) { this.attrs[k] = v; }
  all() { return [this, ...this.children.flatMap((c) => c.all())]; }
}
const fakeDoc = () => ({ created: [], createElement(tag) { const e = new FakeEl(tag); this.created.push(e); return e; } });

function walkerCity(camPos, target) {
  const cam = new THREE.PerspectiveCamera(30, 1280 / 800, 1, 6000);
  cam.position.set(...camPos);
  cam.lookAt(new THREE.Vector3(...target));
  cam.updateMatrixWorld();
  const v = new THREE.Vector3();
  const added = [];
  return {
    THREE, added, stage: { camera: cam },
    add: (o) => added.push(o), remove: (o) => added.splice(added.indexOf(o), 1),
    worldToScreen: (x, y, z) => { v.set(x, y, z).project(cam); return { x: (v.x + 1) * 640, y: (1 - v.y) * 400, visible: v.z > -1 && v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 }; },
  };
}

test("walkers: beacon mode switches at camera distance 120 (bodies → beacons), riders add a scooter; 3 draw calls", () => {
  assert.equal(BEACON_DIST, 120);
  assert.equal(drawMode(119.9), "body");
  assert.equal(drawMode(120), "body");
  assert.equal(drawMode(120.1), "beacon");
  assert.throws(() => drawMode(NaN), /bad distance/);
  const [wx, wz, wy] = node(2);
  for (const [dist, mode] of [[119, "body"], [121, "beacon"]]) {
    const city = walkerCity([wx, wy + dist, wz], [wx, wy, wz + 0.001]);
    const live = createLiveState({ graph: walk });
    live.apply(snapshot({ walkers: [walker("a", [node(2), node(3)], { t0: S + 1e9 }), walker("r", [node(2), node(3)], { mode: "ride", speed: 8, t0: S + 1e9 })] }), L);
    const w = createWalkers(city, live, new FakeEl("div"), { doc: fakeDoc() });
    assert.equal(city.added.length, 3, "bodies, scooters, beacons");
    w.update(L);
    if (mode === "body") {
      assert.equal(w.bodies.count, 2); assert.equal(w.scooters.count, 1); assert.equal(w.beacons.geometry.drawRange.count, 0);
    } else {
      assert.equal(w.bodies.count, 0); assert.equal(w.scooters.count, 0); assert.equal(w.beacons.geometry.drawRange.count, 2);
      assert.equal(w.beacons.material.sizeAttenuation, false, "constant-pixel beacons");
    }
    w.dispose();
    assert.equal(city.added.length, 0);
  }
});

test("walkers: gait phase is distance / stride, so feet never slide; picking takes the nearest within 12 px", () => {
  assert.ok(STRIDE > 0.3 && STRIDE < 0.6, `stride ${STRIDE}`);
  assert.ok(Math.abs(gaitPhase(STRIDE) - 2 * Math.PI) < 1e-9);
  const pts = [{ id: "a", x: 100, y: 100, visible: true }, { id: "b", x: 108, y: 100, visible: true }, { id: "c", x: 103, y: 100, visible: false }];
  assert.equal(pickWalker(pts, 105, 100), "b");
  assert.equal(pickWalker(pts, 101, 100), "a");
  assert.equal(pickWalker(pts, 130, 100), null);
});

test("walkers: at most 24 chips, selected first then talking then nearest", () => {
  const cands = Array.from({ length: 40 }, (_, i) => ({ id: `w${i}`, x: (i % 8) * 100, y: Math.floor(i / 8) * 40, w: 60, h: 18, dist: i, selected: i === 39, talking: i === 38 }));
  const kept = chipOrder(cands);
  assert.equal(MAX_CHIPS, 24);
  assert.equal(kept.length, 24);
  assert.deepEqual(kept.slice(0, 3).map((k) => k.id), ["w39", "w38", "w0"]);
  const overlapping = chipOrder([{ id: "far", x: 0, y: 0, w: 60, h: 18, dist: 1, selected: false, talking: false }, { id: "sel", x: 10, y: 0, w: 60, h: 18, dist: 90, selected: true, talking: false }]);
  assert.deepEqual(overlapping.map((k) => k.id), ["sel"]);

  // 40 walkers on screen through the real layer: never more than 24 chips visible
  const [x0, z0] = node(0);
  const city = walkerCity([x0 + 40, 60, z0 + 60], [x0 + 40, 1, z0]);
  const live = createLiveState({ graph: walk });
  live.apply(snapshot({ walkers: Array.from({ length: 40 }, (_, i) => walker(`w${i}`, [[x0 + (i % 20) * 4, z0 + Math.floor(i / 20) * 6, 1]])) }), L);
  const w = createWalkers(city, live, new FakeEl("div"), { doc: fakeDoc() });
  w.update(L);
  assert.ok(w.chipCount > 0 && w.chipCount <= 24, `chips ${w.chipCount}`);
  w.dispose();
});

test("chat and names: <b> and a URL render as literal text, never an <a>, never innerHTML", () => {
  const doc = fakeDoc();
  const text = "<b>bold</b> see https://evil.example/x";
  const li = chatLine({ seq: 1, ts: S, from: "a", name: "<i>mallory</i>", scope: "near", text, x: 0, z: 0 }, doc);
  assert.ok(li.textContent.includes(text));
  assert.ok(li.textContent.includes("<i>mallory</i>"));
  assert.ok(!doc.created.some((e) => e.tagName === "A"), "no anchor element");
  assert.ok(!doc.created.some((e) => e.tagName === "B" && e.textContent === "bold"), "markup never parsed");

  // the same through a walker's speech bubble and nameplate
  const [wx, wz, wy] = node(2);
  const city = walkerCity([wx, wy + 30, wz + 30], [wx, wy, wz]);
  const live = createLiveState({ graph: walk });
  live.apply([snapshot({ walkers: [walker("<b>x</b>", [node(2)])] }), { type: "say", id: "<b>x</b>", text, ts: S }], L);
  const wdoc = fakeDoc();
  const root = new FakeEl("div");
  const w = createWalkers(city, live, root, { doc: wdoc });
  w.update(L);
  const all = root.all();
  assert.ok(all.some((e) => e.className === "cu-bubble" && e.textContent === text && !e.hidden));
  assert.ok(all.some((e) => e.className === "cu-wname" && e.textContent === "<b>x</b>"));
  assert.ok(!wdoc.created.some((e) => e.tagName === "A"));
  w.dispose();
});

test("follow: the target stays within 1 block of the walker over a 10 s walk across the deck, through a mid-walk re-route", () => {
  let getPos = null, unfollowed = 0;
  const city = { follow: (fn) => { getPos = fn; }, unfollow: () => { unfollowed++; getPos = null; } };
  const live = createLiveState({ graph: walk });
  const first = [27, 28, 29, 30, 31, 32].map(node);
  live.apply(snapshot({ walkers: [walker("f", first)] }), L);
  const changes = [];
  let ms = 0;
  const f = createFollow(city, live, { onChange: (id) => changes.push(id), now: () => L + ms });
  assert.throws(() => f.follow("ghost"), /no walker "ghost"/);
  f.follow("f");
  assert.equal(f.following, "f");
  let path = first, t0 = S, worst = 0, sawDeck = false;
  for (; ms <= 10_000; ms += 1000 / 60) {
    if (ms >= 5000 && path === first) {
      // the server re-routes from where the walker is now (same centreline point), back toward node 27
      const here = centreline(first, 2 * 5);
      path = [here, node(28), node(27), node(26)];
      t0 = S + 5000;
      live.apply({ type: "walk", walker: walker("f", path, { t0 }) }, L + ms);
    }
    const target = getPos();
    const truth = centreline(path, (2 * (S + ms - t0)) / 1000);
    worst = Math.max(worst, Math.hypot(target.x - truth[0], target.z - truth[1], target.y - truth[2]));
    if (truth[2] === 4) sawDeck = true;
  }
  assert.ok(sawDeck, "the walk crosses the deck");
  assert.ok(worst <= 1, `worst follow error ${worst.toFixed(3)} blocks`);
  f.unfollow();
  assert.equal(unfollowed, 1);
  assert.deepEqual(changes, ["f", null]);
  assert.throws(() => createFollow({}, live), /follow\(getPos\)\/unfollow\(\)/);
});

test("pins + labels: setPresence with Firegoat shows the badge \"2 here\"; inside walkers add \"/ M inside\"", () => {
  const firegoat = { ...sites[2], id: "firegoat-501-2nd", companyId: "firegoat", name: "Firegoat", buildingId: 4242 };
  const all = [...sites, firegoat];
  const { city } = mockCity();
  let counts = null;
  const pins = createPins(city, all, { onCounts: (c) => { counts = c; } });
  pins.setPresence([{ companyId: "firegoat", agents: [{ id: "f1", name: "claude@firegoat", hue: 20, status: "working" }, { id: "f2", name: "codex@firegoat", hue: 200, status: "idle" }] }]);
  assert.equal(counts.get("firegoat").text, "2 here");
  const badge = new FakeEl("span");
  const labels = { setBadges() {}, groups: [{ rows: new Map([["firegoat", badge]]), size: { w: 1, h: 1 } }] };
  applyBadges(labels, counts);
  assert.equal(badge.textContent, "2 here");
  assert.equal(badge.hidden, false);
  assert.equal(labels.groups[0].size, null, "chip re-measured");
  pins.setInside(new Map([["firegoat", 1]]));
  applyBadges(labels, counts);
  assert.equal(badge.textContent, "2 here / 1 inside");
  assert.equal(badgeText(0, 0), "");
  assert.equal(badgeText(0, 3), "3 inside");
  assert.throws(() => pins.setInside(new Map([["nope", 1]])), /no primary site/);
  pins.dispose();
});

test("whoIsHere: office agents, walkers inside, walkers at the door; nobody from elsewhere", () => {
  const live = createLiveState({ graph: walk });
  const door = sites[0].anchor;
  live.apply(snapshot({
    walkers: [
      walker("in", [node(37)], { inside: true, siteId: "fixture-labs" }),
      walker("door", [[door.x + 0.5, door.z + 0.5, 1]]),
      walker("far", [node(0)]),
    ],
    presence: [{ companyId: "fixture-labs", agentCount: 1, agents: [{ name: "claude@lab", hue: 1, status: "working" }], inside: 1 }, { companyId: "sample-bakery", agentCount: 1, agents: [{ name: "baker", hue: 2, status: "idle" }], inside: 0 }],
  }), L);
  const info = siteInfo(sites, sites[0]);
  const rows = whoIsHere(info, { presence: live.presence(), walkers: live.walkers(), positionOf: (id) => live.position(id, L) });
  assert.deepEqual(rows.map((r) => [r.name, r.where]), [["claude@lab", "office"], ["in", "inside"], ["door", "outside"]]);
});

test("searchAll: companies, then places (by name or alias), then agents; company places are not repeated", () => {
  const walkers = [walker("fixture-bot", [node(0)])];
  const r = searchAll({ sites, places: placesDoc.places, walkers }, "fixture");
  assert.deepEqual(r.map((x) => [x.kind, x.name]), [["company", "Fixture Labs"], ["place", "Fixture Ferry"], ["place", "Fixture Ave & Test St"], ["place", "Fixture Park"], ["agent", "fixture-bot"]]);
  assert.deepEqual(searchAll({ sites, places: placesDoc.places, walkers }, "the ferry").map((x) => x.id), ["lm:fixture-ferry"]);
  assert.deepEqual(searchAll({ sites, places: placesDoc.places, walkers }, "test st & fixture").map((x) => x.kind), ["place"]);
  assert.deepEqual(searchAll({ sites, places: [], walkers: [] }, " "), []);
});

test("?cam= parse/format/camState round-trip; live URL follows the page scheme", () => {
  assert.deepEqual(parseCam("3712,1664,400,0.565,0.950"), { x: 3712, z: 1664, dist: 400, az: 0.565, polar: 0.95 });
  assert.equal(parseCam(null), null);
  for (const bad of ["1,2,3", "1,2,0,0,1", "1,2,3,0,2", "a,2,3,0,1"]) assert.throws(() => parseCam(bad), /\?cam=/);
  const target = { x: 100, y: 5, z: 200 };
  const off = new THREE.Vector3().setFromSphericalCoords(300, 0.95, 0.565);
  const s = camState({ x: target.x + off.x, y: target.y + off.y, z: target.z + off.z }, target);
  near(s.dist, 300, 1e-9, "dist"); near(s.az, 0.565, 1e-9, "az"); near(s.polar, 0.95, 1e-9, "polar");
  assert.equal(formatCam(s), "100,200,300,0.565,0.950");
  assert.deepEqual(parseCam(formatCam(s)), { x: 100, z: 200, dist: 300, az: 0.565, polar: 0.95 });
  assert.equal(liveUrlFor("https://office.example/city/sf?cam=1", "sf"), "wss://office.example/city/sf/ws");
  assert.equal(liveUrlFor("http://localhost:8799/city/fixture", "fixture"), "ws://localhost:8799/city/fixture/ws");
});

test("no demo presence anywhere in the viewer or the checks (rg check)", () => {
  const word = ["demo", "Presence"].join("");
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const hits = [];
  const walkDir = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (f === "node_modules" || f === "vendor" || f.startsWith(".")) continue;
      if (statSync(p).isDirectory()) walkDir(p);
      else if (/\.(m?js|ts|html)$/.test(f) && readFileSync(p, "utf8").includes(word)) hits.push(p);
    }
  };
  for (const d of ["public", "scripts", "src"]) walkDir(join(root, d));
  assert.deepEqual(hits, []);
});

console.log(`ui.check: ${passed} passed`);
