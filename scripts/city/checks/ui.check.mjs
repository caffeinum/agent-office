// W6 checks: the pure parts of the city UI (label cull, pin layout and size, panel info, search) against the fixture.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import * as THREE from "../../../public/vendor/three-0.186.1/three.module.js";
import { CHUNK, decodeChunk, chunkKey, validateCompanies, validateManifest } from "../../../public/shared/city.js";
import { cullLabels, labelGroups, LABEL_LIFT, MAX_LABELS } from "../../../public/js/city/labels.js";
import {
  PIN_BOXES, PIN_SIZE, PINS_MAX_DIST, PINS_PER_COLUMN, PINS_PER_COMPANY, createPins, demoPresence, layoutPins, pinBounds, stepAway,
} from "../../../public/js/city/pins.js";
import { buildingInfo, panelTitle, siteInfo } from "../../../public/js/city/panel.js";
import { searchSites } from "../../../public/js/city/search.js";
import { focusDistance, pinScale } from "../../../public/js/city/ui.js";
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
  chunks.set(chunkKey(cx, cz), decodeChunk(gunzipSync(readFileSync(join(FIXTURE_DIR, "chunks", `${cx}_${cz}.bin`)))));
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

test("pins: demo presence is deterministic and covers every non-former primary company", () => {
  const a = demoPresence(sites), b = demoPresence(sites);
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((p) => p.companyId), ["fixture-labs", "example-robotics", "sample-bakery"]);
  for (const p of a) {
    assert.ok(p.agents.length >= 1 && p.agents.length <= 16);
    for (const ag of p.agents) assert.ok(Number.isFinite(ag.hue) && ag.name && ag.id && ag.status);
  }
  assert.equal(demoPresence([{ ...sites[0], status: "former" }]).length, 0);
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
  assert.deepEqual(counts.get("fixture-labs"), { agents: 15, overflow: 3, pinsVisible: true });
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
  assert.equal(focusDistance(sites[0]), 250);
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

console.log(`ui.check: ${passed} passed`);
