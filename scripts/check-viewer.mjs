// Viewer checks: the pure parts of the office viewer (public/js/model.js + furniture models vs. the
// shared catalog). Plain node, no deps: `node scripts/check-viewer.mjs`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { KINDS, KIND_NAMES, GRID, defaultLayout, applyOp, seatOf, footprint } from "../public/shared/catalog.js";
import { DEFAULT_THEME, brandTheme, mergeTheme } from "../public/shared/theme.js";
import { ACTIVITIES, validateKindDef } from "../public/shared/kinds.js";
import {
  applyFrame, poseFor, limbAngles, deskSeating, idleSpots, pickSpot, assignSpots, blockedCells, route, entryPoint, layoutBatches,
  wallOf, cullLabels, labelPriority, chatWith, roomChat, lastLineOf, speakerName, activeSay, CHAT_KEEP, SAY_MS, SEATED,
  themeLook, CLASSIC_COLORS, MOODS, mergeBoxes, kindGeometryPlan, usableSpots,
} from "../public/js/model.js";
import { arcadeDef, brickWallDef, coffeeBarDef, huddleDef } from "../public/js/demo-design.js";

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`✗ ${name}\n  ${e.stack}`); process.exitCode = 1; }
};

const items = defaultLayout(0);
const desks = items.filter((i) => i.kind === "desk");
const agent = (id, extra = {}) => ({ id, name: id, hue: 10, status: "idle", joinedAt: 1, lastSeen: 1, ...extra });
const snap = (over = {}) => ({ type: "snapshot", state: { id: "o", name: "O", grid: { ...GRID }, items, agents: [], chat: [], theme: DEFAULT_THEME, customKinds: [], assets: [], designer: null, ...over } });

test("applyFrame: snapshot then deltas", () => {
  let s = applyFrame(null, snap());
  s = applyFrame(s, { type: "agent", agent: agent("a") });
  s = applyFrame(s, { type: "agent", agent: agent("a", { status: "working" }) });
  assert.equal(s.agents.length, 1);
  assert.equal(s.agents[0].status, "working");
  s = applyFrame(s, { type: "agent-left", id: "a" });
  assert.equal(s.agents.length, 0);
  const moved = { ...items[0], x: items[0].x + 1 };
  s = applyFrame(s, { type: "item", item: moved });
  assert.equal(s.items.find((i) => i.id === moved.id).x, moved.x);
  assert.equal(s.items.length, items.length);
  s = applyFrame(s, { type: "item-removed", id: moved.id });
  assert.equal(s.items.length, items.length - 1);
  s = applyFrame(s, { type: "item", item: { ...moved, id: "plant-99" } });
  assert.equal(s.items.length, items.length);
});

test("applyFrame: chat is deduped and capped", () => {
  let s = applyFrame(null, snap());
  for (let i = 0; i < CHAT_KEEP + 20; i++) s = applyFrame(s, { type: "chat", msg: { id: `m${i}`, from: "a", to: null, text: "hi", ts: i } });
  assert.equal(s.chat.length, CHAT_KEEP);
  assert.equal(s.chat.at(-1).id, `m${CHAT_KEEP + 19}`);
  const same = applyFrame(s, { type: "chat", msg: s.chat.at(-1) });
  assert.equal(same, s);
});

test("applyFrame: fails loudly on bad input", () => {
  assert.throws(() => applyFrame(null, { type: "agent", agent: agent("a") }), /before the snapshot/);
  assert.throws(() => applyFrame(null, { type: "snapshot", state: { id: "x" } }), /missing "grid"/);
  assert.throws(() => applyFrame(applyFrame(null, snap()), { type: "agent" }), /missing "agent"/);
  assert.throws(() => applyFrame(null, null), /bad frame/);
});

test("poseFor: status → pose and place", () => {
  assert.deepEqual(poseFor(agent("a", { status: "working" }), true), { pose: "type", place: "desk" });
  assert.deepEqual(poseFor(agent("a", { status: "waiting" }), true), { pose: "handup", place: "desk" });
  assert.deepEqual(poseFor(agent("a", { status: "away" }), true), { pose: "doze", place: "desk" });
  assert.deepEqual(poseFor(agent("a", { status: "idle" }), true), { pose: "lounge", place: "lounge" });
  assert.equal(poseFor(agent("a", { status: "working" }), false).place, "lounge");
  assert.throws(() => poseFor(agent("a", { status: "dancing" }), true), /unknown status/);
});

test("limbAngles: seated poses sit, walking swings, hand up raises the right arm", () => {
  for (const p of SEATED) assert.equal(limbAngles(p, 1).seated, true, p);
  assert.equal(limbAngles("walk", 1).seated, false);
  const w1 = limbAngles("walk", 0.1), w2 = limbAngles("walk", 0.45);
  assert.notEqual(Math.sign(w1.legL), Math.sign(w2.legL));
  assert.ok(limbAngles("handup", 0).armR < -2.5);
  for (const p of ["walk", "type", "handup", "doze", "sit", "sip", "wave", "stand"]) {
    for (const v of Object.values(limbAngles(p, 2.3, 0.7))) if (typeof v === "number") assert.ok(Number.isFinite(v), p);
  }
});

test("deskSeating: only real desks, first joiner keeps a contested desk", () => {
  const ag = [agent("late", { joinedAt: 5, deskId: desks[0].id }), agent("early", { joinedAt: 2, deskId: desks[0].id }), agent("ghost", { deskId: "desk-999" }), agent("b", { deskId: desks[1].id })];
  const m = deskSeating(ag, items);
  assert.equal(m.get("early").id, desks[0].id);
  assert.equal(m.has("late"), false);
  assert.equal(m.has("ghost"), false);
  assert.equal(m.get("b").id, desks[1].id);
});

test("seatOf: the sitter sits on the desk's seat row facing the desk top", () => {
  for (const rot of [0, 90, 180, 270]) {
    const d = { kind: "desk", x: 4, z: 4, rot };
    const s = seatOf(d);
    const f = footprint(d);
    assert.ok(s.x > f.x && s.x < f.x + f.w && s.z > f.z && s.z < f.z + f.d, `rot ${rot} inside footprint`);
    const cx = f.x + f.w / 2, cz = f.z + f.d / 2;
    // facing direction points from the seat towards the footprint centre
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
    assert.ok(fx * (cx - s.x) + fz * (cz - s.z) > 0.4, `rot ${rot} faces the desk`);
  }
  const facing = desks.filter((d) => d.z === 5).map(seatOf);
  for (const s of facing) assert.ok(Math.abs(s.z - 5.5) < 1e-9, "row at z=5 (rot 180) sits on its low row");
});

test("idleSpots + pickSpot: deterministic, skip taken", () => {
  const spots = idleSpots(items);
  assert.ok(spots.length >= 6);
  assert.ok(spots.some((s) => s.pose === "coffee"));
  assert.ok(spots.some((s) => s.pose === "sit" && s.seatY > 0.2 && s.seatY < 0.6));
  const a = pickSpot("juniper", spots, new Set());
  assert.deepEqual(pickSpot("juniper", spots, new Set()), a);
  const b = pickSpot("juniper", spots, new Set([a.id]));
  assert.notEqual(b.id, a.id);
  assert.equal(pickSpot("x", spots, new Set(spots.map((s) => s.id))), null);
  assert.equal(pickSpot("x", [], new Set()), null);
});

test("route: A* walks around furniture, never through a blocked cell", () => {
  const blocked = blockedCells(items, GRID);
  const from = entryPoint(blocked, GRID);
  assert.equal(blocked[Math.floor(from.z) * GRID.w + Math.floor(from.x)], 0);
  for (const d of desks) {
    const seat = seatOf(d);
    const path = route(blocked, GRID, from, seat);
    assert.deepEqual(path.at(-1), { x: seat.x, z: seat.z });
    let prev = from;
    for (const p of path) {
      const n = Math.ceil(Math.hypot(p.x - prev.x, p.z - prev.z) * 8);
      for (let k = 1; k < n; k++) {
        const x = prev.x + ((p.x - prev.x) * k) / n, z = prev.z + ((p.z - prev.z) * k) / n;
        const i = Math.floor(z) * GRID.w + Math.floor(x);
        const own = footprint(d);
        const inOwn = x >= own.x && x < own.x + own.w && z >= own.z && z < own.z + own.d;
        if (!inOwn && Math.hypot(x - seat.x, z - seat.z) > 0.8) assert.equal(blocked[i], 0, `desk ${d.id}: walks through cell ${Math.floor(x)},${Math.floor(z)}`);
      }
      prev = p;
    }
  }
});

test("route: unreachable goal degrades to a straight line (still ends at the goal)", () => {
  const grid = { w: 5, d: 5 };
  const wall = new Uint8Array(25);
  for (let z = 0; z < 5; z++) wall[z * 5 + 2] = 1;
  assert.deepEqual(route(wall, grid, { x: 0.5, z: 0.5 }, { x: 4.5, z: 4.5 }), [{ x: 4.5, z: 4.5 }]);
});

test("layoutBatches: every item lands in exactly one batch; wall items keyed by wall", () => {
  const { batches, texts } = layoutBatches(items);
  const n = [...batches.values()].reduce((s, b) => s + b.length, 0);
  assert.equal(n, items.length);
  assert.ok(batches.has("window@back") && batches.has("window@left"));
  assert.ok(batches.has("whiteboard@left"));
  assert.equal(texts.length, items.filter((i) => KINDS[i.kind].textable).length);
  for (const b of batches.values()) for (const inst of b) {
    const it = items.find((i) => i.id === inst.id);
    const f = footprint(it);
    assert.equal(inst.x, f.x + f.w / 2);
    assert.equal(inst.z, f.z + f.d / 2);
  }
  assert.throws(() => layoutBatches([{ id: "q-1", kind: "spaceship", x: 0, z: 0, rot: 0 }]), /unknown kind/);
  assert.throws(() => wallOf({ id: "w", kind: "window", x: 3, z: 3, rot: 0 }), /not on a wall/);
});

test("layoutBatches: add/remove ops reflect in batches", () => {
  const { items: more } = applyOp(items, { op: "add", kind: "plant", x: 20, z: 10 }, "t");
  assert.equal(layoutBatches(more).batches.get("plant").length, layoutBatches(items).batches.get("plant").length + 1);
});

test("cullLabels: priority wins overlaps, disjoint labels all survive", () => {
  const r = (id, x, priority, depth = 0) => ({ id, x, y: 0, w: 50, h: 20, priority, depth });
  assert.deepEqual([...cullLabels([r("a", 0, 10), r("b", 20, 40)])], ["b"]);
  assert.deepEqual(new Set(cullLabels([r("a", 0, 10), r("b", 100, 10)])), new Set(["a", "b"]));
  assert.deepEqual([...cullLabels([r("far", 0, 10, 9), r("near", 10, 10, 2)])], ["near"]);
  assert.ok(labelPriority({ selected: true }) > labelPriority({ speaking: true }));
  assert.ok(labelPriority({ status: "waiting" }) > labelPriority({ status: "working" }));
  assert.ok(labelPriority({ status: "working" }) > labelPriority({ status: "away" }));
});

test("chat filters", () => {
  const chat = [
    { id: "1", from: "a", to: null, text: "room", ts: 1 },
    { id: "2", from: "human:Aleks", to: "a", text: "dm", ts: 2 },
    { id: "3", from: "b", to: "c", text: "other", ts: 3 },
    { id: "4", from: "a", to: "b", text: "a→b", ts: 4 },
  ];
  assert.deepEqual(chatWith(chat, "a").map((m) => m.id), ["1", "2", "4"]);
  assert.deepEqual(roomChat(chat).map((m) => m.id), ["1"]);
  assert.equal(lastLineOf(chat, "a").id, "4");
  assert.equal(lastLineOf(chat, "zz"), null);
  assert.equal(speakerName("human:Aleks", []), "Aleks");
  assert.equal(speakerName("a", [agent("a", { name: "Ada" })]), "Ada");
  assert.equal(activeSay({ says: { text: "hi", ts: 1000 } }, 1000 + SAY_MS - 1), "hi");
  assert.equal(activeSay({ says: { text: "hi", ts: 1000 } }, 1000 + SAY_MS + 1), null);
});

test("furniture: a model for every catalog kind", () => {
  // furniture.js pulls in three via voxel.js, so check its source (the module also throws at load on a gap)
  const src = readFileSync(new URL("../public/js/furniture.js", import.meta.url), "utf8");
  for (const k of KIND_NAMES) assert.ok(src.includes(`${/^[a-z]+$/.test(k) ? k : JSON.stringify(k)}: () =>`), `model for ${k}`);
});

test("defaultLayout: 8 desks, all reachable from the entrance", () => {
  assert.equal(desks.length, 8);
  const blocked = blockedCells(items, GRID);
  const from = entryPoint(blocked, GRID);
  for (const d of desks) {
    const path = route(blocked, GRID, from, seatOf(d));
    assert.ok(path.length > 1, `${d.id} reached by a real path, not a straight-line fallback`);
  }
});

/* ── round 2: theme, custom kinds, seats & stations, design frames ── */

const ember = brandTheme({ primary: "#e94d3d", dark: "#141414", accent: "#d28f88" });

test("applyFrame: theme, kind, kind-removed, asset, asset-removed, designer", () => {
  let s = applyFrame(null, snap({ customKinds: [validateKindDef(arcadeDef())] }));
  assert.deepEqual(Object.keys(s.customKinds), ["arcade-cabinet"]);
  assert.equal(s.designer, null);
  s = applyFrame(s, { type: "theme", theme: ember });
  assert.equal(s.theme, ember);
  const wall = validateKindDef(brickWallDef());
  s = applyFrame(s, { type: "kind", kind: wall });
  assert.equal(s.customKinds["brick-wall"], wall);
  const v2 = { ...wall, label: "brick wall v2" };
  s = applyFrame(s, { type: "kind", kind: v2 });
  assert.equal(s.customKinds["brick-wall"].label, "brick wall v2");
  s = applyFrame(s, { type: "kind-removed", kind: "arcade-cabinet" });
  assert.deepEqual(Object.keys(s.customKinds), ["brick-wall"]);
  const asset = { id: "a0123456789abcdef0123456", url: "/o/o/assets/a0123456789abcdef0123456", w: 64, h: 64 };
  s = applyFrame(s, { type: "asset", asset });
  s = applyFrame(s, { type: "asset", asset });
  assert.equal(s.assets.length, 1);
  s = applyFrame(s, { type: "asset-removed", id: asset.id });
  assert.equal(s.assets.length, 0);
  s = applyFrame(s, { type: "designer", id: "ada" });
  assert.equal(s.designer, "ada");
  s = applyFrame(s, { type: "designer", id: null });
  assert.equal(s.designer, null);
  assert.throws(() => applyFrame(s, { type: "designer" }), /missing "id"/);
  assert.throws(() => applyFrame(s, { type: "kind", kind: { label: "x" } }), /slug/);
  assert.throws(() => applyFrame(null, snap({ theme: undefined })), /missing "theme"/);
  assert.throws(() => applyFrame(null, snap({ customKinds: { a: 1 } })), /must be a list/);
});

test("themeLook: the default theme keeps the classic colours; a brand drives every surface", () => {
  const classic = themeLook(DEFAULT_THEME);
  assert.deepEqual(classic.kindColors, CLASSIC_COLORS);
  assert.equal(classic.floor.material, "wood");
  assert.equal(classic.walls.accent, null);
  assert.equal(classic.mood, MOODS.warm);
  const look = themeLook(ember);
  assert.equal(look.floor.material, "concrete", "near-black brand → polished concrete");
  assert.equal(look.walls.accent.material, "brick");
  assert.equal(look.desk.rail, "#e94d3d");
  assert.equal(look.kindColors.chair, "#e94d3d");
  assert.equal(look.kindColors.desk, "#e94d3d");
  assert.equal(look.signBg, "#141414", "signage and screens are inked in the darkest brand colour");
  assert.equal(look.screenBg, "#141414");
  for (const v of Object.values(look.kindColors)) assert.match(v, /^#[0-9a-f]{6}$/);
  for (const m of ["wood", "tile", "concrete", "carpet"]) {
    const l = themeLook(mergeTheme(ember, { floor: { material: m } }));
    assert.equal(l.floor.material, m);
    assert.ok(l.floor.roughness > 0 && l.floor.roughness <= 1);
  }
  assert.equal(themeLook(mergeTheme(ember, { lighting: "cool" })).mood, MOODS.cool);
  assert.equal(themeLook(mergeTheme(ember, { walls: { accent: null } })).walls.accent, null);
  assert.equal(themeLook(mergeTheme(ember, { walls: { accent: { material: "wood-panels", wall: "left" } } })).walls.accent.wall, "left");
  assert.throws(() => themeLook({ ...DEFAULT_THEME, floor: { material: "lava", color: "#000000" } }), /floor.material/);
});

test("mergeBoxes: same-looking boxes sharing a full face merge; different colours/materials don't", () => {
  const b = (x, y, z, w, h, d, color = "#ff0000", extra = {}) => ({ x, y, z, w, h, d, color, ...extra });
  assert.equal(mergeBoxes([b(0, 0, 0, 1, 1, 1), b(1, 0, 0, 1, 1, 1), b(2, 0, 0, 1, 1, 1)]).length, 1);
  assert.deepEqual(mergeBoxes([b(0, 0, 0, 1, 1, 1), b(1, 0, 0, 1, 1, 1)])[0], b(0, 0, 0, 2, 1, 1));
  // a 4×4×1 slab of unit voxels collapses to one box
  const slab = [];
  for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) slab.push(b(x, 0, z, 1, 1, 1));
  assert.deepEqual(mergeBoxes(slab), [b(0, 0, 0, 4, 1, 4)]);
  assert.equal(mergeBoxes([b(0, 0, 0, 1, 1, 1), b(1, 0, 0, 1, 1, 1, "#00ff00")]).length, 2);
  assert.equal(mergeBoxes([b(0, 0, 0, 1, 1, 1), b(1, 0, 0, 1, 1, 1, "#ff0000", { material: "glass" })]).length, 2);
  assert.equal(mergeBoxes([b(0, 0, 0, 1, 1, 1), b(1, 0, 0, 1, 1, 1, "#ff0000", { emissive: true })]).length, 2);
  assert.equal(mergeBoxes([b(0, 0, 0, 1, 1, 1), b(1, 0, 0, 1, 2, 1)]).length, 2, "partial faces stay apart");
  assert.equal(mergeBoxes([b(0, 0, 0, 1, 1, 1), b(2, 0, 0, 1, 1, 1)]).length, 2, "gaps stay apart");
});

test("kindGeometryPlan: boxes → item-frame buckets by material, centred on the footprint", () => {
  const arcade = validateKindDef(arcadeDef());
  const p = kindGeometryPlan(arcade);
  assert.equal(p.input, arcade.boxes.length);
  assert.equal(p.screen.length, 1);
  assert.ok(p.emissive.length >= 3);
  assert.equal(p.glass.length, 0);
  const total = p.matte.length + p.glossy.length + p.glass.length + p.screen.length + p.emissive.length;
  assert.equal(total, p.merged);
  for (const bk of ["matte", "glossy", "glass", "screen", "emissive"]) for (const q of p[bk]) {
    assert.ok(q.cx - q.w / 2 >= -0.5 - 1e-9 && q.cx + q.w / 2 <= 0.5 + 1e-9, "inside the 1-cell footprint (x)");
    assert.ok(q.cz - q.d / 2 >= -0.5 - 1e-9 && q.cz + q.d / 2 <= 0.5 + 1e-9, "inside the 1-cell footprint (z)");
    assert.ok(q.y0 >= 0 && q.y0 + q.h <= 4);
  }
  const bar = kindGeometryPlan(validateKindDef(coffeeBarDef()));
  assert.equal(bar.glass.length, 1);
  assert.equal(bar.glossy.length, 1);
  // the brick wall's bricks in three tones: merging only ever reduces, never loses volume
  const wall = validateKindDef(brickWallDef());
  const wp = kindGeometryPlan(wall);
  assert.ok(wp.merged <= wall.boxes.length);
  const vol = (list) => list.reduce((s, q) => s + q.w * q.h * q.d, 0);
  const inVol = wall.boxes.reduce((s, q) => s + (q.w * q.h * q.d) / 4096, 0);
  assert.ok(Math.abs(vol(wp.matte) - inVol) < 1e-9);
  // unit voxels in one colour collapse hard
  const cube = validateKindDef({ kind: "cube", label: "cube", footprint: { w: 1, d: 1 }, boxes: Array.from({ length: 64 }, (_, i) => ({ x: i % 4, y: Math.floor(i / 16), z: Math.floor(i / 4) % 4, w: 1, h: 1, d: 1, color: "#123456" })) });
  assert.equal(kindGeometryPlan(cube).merged, 1);
  assert.throws(() => kindGeometryPlan({ kind: "x" }), /no w\/d\/boxes/);
});

test("custom kinds: layout, blocking and spots work like built-ins", () => {
  const kinds = Object.fromEntries([arcadeDef(), huddleDef()].map((d) => { const k = validateKindDef(d); return [k.kind, k]; }));
  const { items: more } = applyOp(items, { op: "add", kind: "arcade-cabinet", x: 20, z: 9 }, "t", { kinds });
  const { items: more2 } = applyOp(more, { op: "add", kind: "huddle-table", x: 17, z: 12 }, "t", { kinds });
  const { batches } = layoutBatches(more2, kinds);
  assert.equal(batches.get("arcade-cabinet").length, 1);
  assert.throws(() => layoutBatches(more2), /unknown kind/);
  const blocked = blockedCells(more2, GRID, kinds);
  assert.equal(blocked[9 * GRID.w + 20], 1);
  const spots = idleSpots(more2, kinds);
  const play = spots.find((s) => s.activity === "play");
  assert.ok(play && Math.abs(play.x - 20.5) < 0.01 && Math.abs(play.z - 10.625) < 0.01, "arcade station in front of the cabinet");
  assert.ok(Math.abs(Math.cos(play.yaw) + 1) < 1e-3, "the player faces the cabinet (-z)");
  assert.equal(spots.filter((s) => s.itemId.startsWith("huddle-table") && s.activity === "chat").length, 3);
});

test("assignSpots: one agent per spot, stable while settled, restless agents move on", () => {
  const spots = idleSpots(items);
  const w = (id, extra = {}) => ({ id, joinedAt: 1, salt: 0, current: null, restless: false, ...extra });
  const wanters = ["a", "b", "c", "d", "e", "f"].map((id, i) => w(id, { joinedAt: i }));
  const m1 = assignSpots(wanters, spots);
  assert.equal(m1.size, 6);
  assert.equal(new Set([...m1.values()].map((s) => s.id)).size, 6, "no two agents on one spot");
  // stable: feeding current spots back changes nothing, even when an earlier joiner would hash onto them
  const again = assignSpots(wanters.map((x) => ({ ...x, current: m1.get(x.id).id })), spots);
  for (const [id, s] of m1) assert.equal(again.get(id).id, s.id);
  const late = assignSpots([w("zz", { joinedAt: -5, current: null }), ...wanters.map((x) => ({ ...x, current: m1.get(x.id).id }))], spots);
  for (const [id, s] of m1) assert.equal(late.get(id).id, s.id, "a newcomer never bumps a settled agent");
  // restless: leaves its spot for another free one
  const r = assignSpots(wanters.map((x) => ({ ...x, current: m1.get(x.id).id, restless: x.id === "c", salt: x.id === "c" ? 1 : 0 })), spots);
  assert.notEqual(r.get("c").id, m1.get("c").id);
  assert.equal(new Set([...r.values()].map((s) => s.id)).size, 6);
  // more agents than spots: the extras get none (they mill about), nobody doubles up
  const crowd = Array.from({ length: spots.length + 5 }, (_, i) => w(`x${i}`, { joinedAt: i }));
  const mc = assignSpots(crowd, spots);
  assert.equal(mc.size, spots.length);
  assert.equal(new Set([...mc.values()].map((s) => s.id)).size, spots.length);
  assert.equal(assignSpots(wanters, []).size, 0);
});

test("usableSpots: stations off the floor or under furniture are dropped, seats stay", () => {
  assert.equal(usableSpots(idleSpots(items), blockedCells(items, GRID), GRID).length, idleSpots(items).length, "every default spot is reachable");
  const plant = { id: "plant-front", kind: "plant", x: 5, z: GRID.d - 1, rot: 0 };
  const chair = { id: "chair-on-station", kind: "chair", x: 0, z: 3, rot: 0 };
  const layout = [...items, plant, chair];
  const blocked = blockedCells(layout, GRID);
  const all = idleSpots(layout);
  const ok = usableSpots(all, blocked, GRID);
  assert.ok(all.some((s) => s.itemId === plant.id), "a front-wall plant facing the wall has a station…");
  assert.ok(!ok.some((s) => s.itemId === plant.id), "…but it sits off the floor, so it's dropped");
  assert.ok(all.some((s) => s.id === "table-1:t0") && !ok.some((s) => s.id === "table-1:t0"), "a chair over the table's chat station blocks it");
  for (const s of ok) {
    assert.ok(s.x >= 0 && s.z >= 0 && s.x < GRID.w && s.z < GRID.d);
    if (s.pose !== "sit") assert.equal(blocked[Math.floor(s.z) * GRID.w + Math.floor(s.x)], 0, s.id);
  }
  assert.ok(ok.filter((s) => s.pose === "sit").length === all.filter((s) => s.pose === "sit").length);
});

test("limbAngles: every activity has its own finite, distinct animation", () => {
  const poses = [...ACTIVITIES, "sit"];
  const sigs = new Set();
  for (const p of poses) {
    const a = limbAngles(p, 1.7, 0.3);
    for (const v of Object.values(a)) if (typeof v === "number") assert.ok(Number.isFinite(v), p);
    sigs.add(JSON.stringify([a.armL, a.armR, a.armLz, a.armRz, a.headTilt, a.lean].map((v) => v.toFixed(3))));
  }
  assert.equal(sigs.size, poses.length, "no two activities share a pose");
  assert.equal(limbAngles("play", 1).seated, false);
  assert.ok(limbAngles("whiteboard", 1).armR < -1.8, "writing on the board raises the right arm");
});

process.on("exit", () => { if (!process.exitCode) console.log(`check-viewer: ${passed} checks passed`); });
