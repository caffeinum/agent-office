// Viewer checks: the pure parts of the office viewer (public/js/model.js + furniture models vs. the
// shared catalog). Plain node, no deps: `node scripts/check-viewer.mjs`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { KINDS, KIND_NAMES, GRID, defaultLayout, applyOp, seatOf, footprint } from "../public/shared/catalog.js";
import {
  applyFrame, poseFor, limbAngles, deskSeating, idleSpots, pickSpot, blockedCells, route, entryPoint, layoutBatches,
  wallOf, cullLabels, labelPriority, chatWith, roomChat, lastLineOf, speakerName, activeSay, CHAT_KEEP, SAY_MS, SEATED,
} from "../public/js/model.js";

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`✗ ${name}\n  ${e.stack}`); process.exitCode = 1; }
};

const items = defaultLayout(0);
const desks = items.filter((i) => i.kind === "desk");
const agent = (id, extra = {}) => ({ id, name: id, hue: 10, status: "idle", joinedAt: 1, lastSeen: 1, ...extra });
const snap = (over = {}) => ({ type: "snapshot", state: { id: "o", name: "O", grid: { ...GRID }, items, agents: [], chat: [], ...over } });

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
  assert.ok(spots.some((s) => s.pose === "sip"));
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

process.on("exit", () => { if (!process.exitCode) console.log(`check-viewer: ${passed} checks passed`); });
