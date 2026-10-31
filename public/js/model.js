// Pure viewer logic: state reducer for ws frames, agent → pose, desk seating, idle spots, A* routes on
// the cell grid, layout → instance batches, label culling, chat filters. No DOM, no three.js — checked
// by scripts/check-viewer.mjs with plain node.

import { KINDS, footprint, seatOf } from "../shared/catalog.js";

export const CHAT_KEEP = 200;
export const SAY_MS = 9000;
const D2R = Math.PI / 180;

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function clip(text, n) {
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function relTime(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/* ── state reducer ──────────────────────────────────────────────────────────────────────────── */

function requireField(frame, key) {
  if (frame[key] === undefined || frame[key] === null) throw new Error(`frame ${frame.type} is missing "${key}"`);
  return frame[key];
}

/** Pure: (state | null, frame) → new state. Throws on a malformed or out-of-order frame. */
export function applyFrame(state, frame) {
  if (!frame || typeof frame.type !== "string") throw new Error(`bad frame ${JSON.stringify(frame)}`);
  if (frame.type === "snapshot") {
    const s = requireField(frame, "state");
    for (const key of ["id", "grid", "items", "agents", "chat"]) {
      if (s[key] === undefined) throw new Error(`snapshot state is missing "${key}"`);
    }
    return { ...s, chat: s.chat.slice(-CHAT_KEEP) };
  }
  if (!state) throw new Error(`frame ${frame.type} arrived before the snapshot`);
  switch (frame.type) {
    case "agent": {
      const a = requireField(frame, "agent");
      const has = state.agents.some((x) => x.id === a.id);
      return { ...state, agents: has ? state.agents.map((x) => (x.id === a.id ? a : x)) : [...state.agents, a] };
    }
    case "agent-left": {
      const id = requireField(frame, "id");
      return { ...state, agents: state.agents.filter((x) => x.id !== id) };
    }
    case "item": {
      const it = requireField(frame, "item");
      const has = state.items.some((x) => x.id === it.id);
      return { ...state, items: has ? state.items.map((x) => (x.id === it.id ? it : x)) : [...state.items, it] };
    }
    case "item-removed": {
      const id = requireField(frame, "id");
      return { ...state, items: state.items.filter((x) => x.id !== id) };
    }
    case "chat": {
      const msg = requireField(frame, "msg");
      if (state.chat.some((m) => m.id === msg.id)) return state;
      return { ...state, chat: [...state.chat, msg].slice(-CHAT_KEEP) };
    }
    default:
      return state;
  }
}

/* ── poses ──────────────────────────────────────────────────────────────────────────────────── */

/** Where an agent should be and what it does there: {pose, place: "desk" | "lounge"}. */
export function poseFor(agent, hasDesk) {
  switch (agent.status) {
    case "working": return hasDesk ? { pose: "type", place: "desk" } : { pose: "stand", place: "lounge" };
    case "waiting": return hasDesk ? { pose: "handup", place: "desk" } : { pose: "wave", place: "lounge" };
    case "away": return hasDesk ? { pose: "doze", place: "desk" } : { pose: "stand", place: "lounge" };
    case "idle": return { pose: "lounge", place: "lounge" };
    default: throw new Error(`agent ${agent.id}: unknown status ${JSON.stringify(agent.status)}`);
  }
}

export const SEATED = new Set(["type", "handup", "doze", "sit"]);

export function statusLabel(status) {
  return { working: "working", idle: "idle", waiting: "needs input", away: "away" }[status] ?? status;
}

/** Limb angles (radians) for the blocky rig. t in seconds; phase de-syncs characters. */
export function limbAngles(pose, t, phase = 0) {
  const a = { legL: 0, legR: 0, armL: 0, armR: 0, armLz: 0, armRz: 0, head: 0, headTilt: 0, lean: 0, bob: 0, seated: false };
  const s = t + phase;
  if (pose === "walk") {
    const w = Math.sin(s * 9);
    a.legL = 38 * D2R * w; a.legR = -38 * D2R * w;
    a.armL = -32 * D2R * w; a.armR = 32 * D2R * w;
    a.bob = Math.abs(Math.cos(s * 9)) * 0.05;
    return a;
  }
  if (SEATED.has(pose)) {
    a.seated = true;
    a.legL = a.legR = -88 * D2R;
    a.bob = Math.sin(s * 2) * 0.006;
    if (pose === "type") {
      a.armL = -72 * D2R + Math.sin(s * 14) * 7 * D2R;
      a.armR = -72 * D2R + Math.sin(s * 14 + Math.PI) * 7 * D2R;
      a.lean = 7 * D2R;
      a.head = Math.sin(s * 0.45) * 7 * D2R;
      a.headTilt = 6 * D2R + Math.max(0, Math.sin(s * 0.9)) * 4 * D2R;
    } else if (pose === "handup") {
      a.armL = -45 * D2R;
      a.armR = -170 * D2R; a.armRz = Math.sin(s * 5) * 14 * D2R;
      a.head = Math.sin(s * 0.8) * 18 * D2R;
      a.headTilt = -6 * D2R;
    } else if (pose === "doze") {
      a.armL = a.armR = -55 * D2R;
      a.lean = 22 * D2R;
      a.headTilt = 24 * D2R + Math.sin(s * 1.2) * 3 * D2R;
    } else {
      a.armL = a.armR = -18 * D2R;
      a.head = Math.sin(s * 0.3) * 25 * D2R;
    }
    return a;
  }
  if (pose === "sip") {
    a.armR = -115 * D2R + Math.sin(s * 1.4) * 14 * D2R; a.armRz = 18 * D2R;
    a.headTilt = -6 * D2R;
    a.bob = Math.sin(s * 2) * 0.008;
    return a;
  }
  if (pose === "wave") {
    a.armR = -168 * D2R; a.armRz = Math.sin(s * 8) * 26 * D2R;
    a.bob = Math.sin(s * 2) * 0.008;
    return a;
  }
  // stand: breathing and an occasional glance
  a.bob = Math.sin(s * 2) * 0.008;
  a.armL = Math.sin(s * 1.1) * 3 * D2R; a.armR = -a.armL;
  a.head = Math.max(0, Math.sin(s * 0.5) - 0.6) * 70 * D2R * (Math.sin(s * 0.17) > 0 ? 1 : -1);
  return a;
}

/* ── seating & spots ────────────────────────────────────────────────────────────────────────── */

/** agentId → desk item, only for agents whose deskId names an existing desk. Two agents claiming one
 *  desk: the earlier joiner keeps it, the other stands (the server should never do this; it's shown). */
export function deskSeating(agents, items) {
  const desks = new Map(items.filter((it) => it.kind === "desk").map((d) => [d.id, d]));
  const taken = new Set();
  const out = new Map();
  for (const a of [...agents].sort((x, y) => x.joinedAt - y.joinedAt || (x.id < y.id ? -1 : 1))) {
    if (!a.deskId || taken.has(a.deskId)) continue;
    const d = desks.get(a.deskId);
    if (!d) continue;
    taken.add(a.deskId);
    out.set(a.id, d);
  }
  return out;
}

/** Rotate a local offset (lx, lz) by rot degrees around an item's footprint centre. */
export function itemPoint(item, lx, lz) {
  const f = footprint(item);
  const cx = f.x + f.w / 2, cz = f.z + f.d / 2;
  const r = item.rot * D2R;
  return { x: cx + lx * Math.cos(r) + lz * Math.sin(r), z: cz - lx * Math.sin(r) + lz * Math.cos(r), yaw: r };
}

/** Places an idle agent can hang out: sofa seats, beanbags, chairs, standing at the coffee machine. */
export function idleSpots(items) {
  const spots = [];
  for (const it of items) {
    const add = (lx, lz, pose, faceBack = false) => {
      const p = itemPoint(it, lx, lz);
      spots.push({ id: `${it.id}:${spots.length}`, itemId: it.id, x: p.x, z: p.z, yaw: p.yaw + (faceBack ? Math.PI : 0), pose });
    };
    if (it.kind === "sofa") for (const lx of [-0.95, 0, 0.95]) add(lx, 0.05, "sit");
    else if (it.kind === "beanbag") add(0, 0, "sit");
    else if (it.kind === "chair") add(0, 0, "sit");
    else if (it.kind === "coffee-machine") add(0, 0.95, "sip", true);
    else if (it.kind === "fridge") add(0, 0.95, "sip", true);
    else if (it.kind === "whiteboard") add(0, 1.2, "stand", true);
  }
  return spots;
}

/** Deterministic spot choice: hash order, skipping spots already taken. null if every spot is taken. */
export function pickSpot(agentId, spots, taken, salt = 0) {
  if (!spots.length) return null;
  const start = hashStr(`${agentId}:${salt}`) % spots.length;
  for (let i = 0; i < spots.length; i++) {
    const s = spots[(start + i) % spots.length];
    if (!taken.has(s.id)) return s;
  }
  return null;
}

/* ── grid routes ────────────────────────────────────────────────────────────────────────────── */

/** Cells blocked by object-layer furniture (floor rugs and wall items don't block walking). */
export function blockedCells(items, grid) {
  const b = new Uint8Array(grid.w * grid.d);
  for (const it of items) {
    if (KINDS[it.kind]?.layer !== "object") continue;
    const f = footprint(it);
    for (let x = f.x; x < f.x + f.w; x++) for (let z = f.z; z < f.z + f.d; z++) {
      if (x >= 0 && z >= 0 && x < grid.w && z < grid.d) b[z * grid.w + x] = 1;
    }
  }
  return b;
}

const cellOf = (p, grid) => ({ x: Math.min(grid.w - 1, Math.max(0, Math.floor(p.x))), z: Math.min(grid.d - 1, Math.max(0, Math.floor(p.z))) });

/** A* over cells, 8-way without corner cutting. Start and goal cells are always walkable. Returns world
 *  waypoints (cell centres, then the exact goal), smoothed; a straight line if no path exists. */
export function route(blocked, grid, from, to) {
  const W = grid.w, D = grid.d;
  const s = cellOf(from, grid), g = cellOf(to, grid);
  const si = s.z * W + s.x, gi = g.z * W + g.x;
  const free = (x, z) => x >= 0 && z >= 0 && x < W && z < D && (!blocked[z * W + x] || z * W + x === gi || z * W + x === si);
  const gScore = new Float32Array(W * D).fill(Infinity);
  const came = new Int32Array(W * D).fill(-1);
  const closed = new Uint8Array(W * D);
  const h = (i) => Math.hypot((i % W) - g.x, Math.floor(i / W) - g.z);
  const open = [si];
  gScore[si] = 0;
  const f = new Float32Array(W * D).fill(Infinity);
  f[si] = h(si);
  let found = si === gi;
  while (open.length && !found) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (f[open[i]] < f[open[bi]]) bi = i;
    const cur = open[bi];
    open[bi] = open[open.length - 1];
    open.pop();
    if (cur === gi) { found = true; break; }
    closed[cur] = 1;
    const cx = cur % W, cz = Math.floor(cur / W);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue;
      const nx = cx + dx, nz = cz + dz;
      if (!free(nx, nz)) continue;
      if (dx && dz && (!free(cx + dx, cz) || !free(cx, cz + dz))) continue;
      const ni = nz * W + nx;
      if (closed[ni]) continue;
      const ng = gScore[cur] + (dx && dz ? Math.SQRT2 : 1);
      if (ng < gScore[ni]) {
        gScore[ni] = ng;
        came[ni] = cur;
        f[ni] = ng + h(ni);
        if (!open.includes(ni)) open.push(ni);
      }
    }
  }
  if (!found) return [{ x: to.x, z: to.z }];
  const cells = [];
  for (let i = gi; i !== -1 && i !== si; i = came[i]) cells.push(i);
  cells.reverse();
  const pts = cells.slice(0, -1).map((i) => ({ x: (i % W) + 0.5, z: Math.floor(i / W) + 0.5 }));
  pts.push({ x: to.x, z: to.z });
  return smooth([{ x: from.x, z: from.z }, ...pts], blocked, grid, si, gi).slice(1);
}

/** Drop waypoints whose neighbours see each other over walkable cells. */
function smooth(pts, blocked, grid, si, gi) {
  if (pts.length < 3) return pts;
  const W = grid.w;
  const clear = (a, b) => {
    const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) * 4);
    for (let k = 1; k < n; k++) {
      const x = a.x + ((b.x - a.x) * k) / n, z = a.z + ((b.z - a.z) * k) / n;
      for (const [ox, oz] of [[0.22, 0.22], [-0.22, 0.22], [0.22, -0.22], [-0.22, -0.22]]) {
        const cx = Math.floor(x + ox), cz = Math.floor(z + oz);
        if (cx < 0 || cz < 0 || cx >= W || cz >= grid.d) return false;
        const i = cz * W + cx;
        if (blocked[i] && i !== si && i !== gi) return false;
      }
    }
    return true;
  };
  const out = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !clear(pts[i], pts[j])) j--;
    out.push(pts[j]);
    i = j;
  }
  return out;
}

/** The nearest walkable cell centre to the front-middle of the office, where agents walk in from. */
export function entryPoint(blocked, grid) {
  const tx = grid.w / 2, tz = grid.d - 0.5;
  let best = null, bd = Infinity;
  for (let z = 0; z < grid.d; z++) for (let x = 0; x < grid.w; x++) {
    if (blocked[z * grid.w + x]) continue;
    const d = Math.hypot(x + 0.5 - tx, z + 0.5 - tz);
    if (d < bd) { bd = d; best = { x: x + 0.5, z: z + 0.5 }; }
  }
  if (!best) throw new Error("office: no walkable cell left on the floor");
  return best;
}

export { seatOf };

/* ── instancing ─────────────────────────────────────────────────────────────────────────────── */

/** Which wall a wall-layer item hangs on. */
export function wallOf(item) {
  if (KINDS[item.kind]?.layer !== "wall") return null;
  if (item.rot === 0 && item.z === 0) return "back";
  if (item.rot === 90 && item.x === 0) return "left";
  throw new Error(`item ${item.id}: ${item.kind} is not on a wall (rot ${item.rot}, x ${item.x}, z ${item.z})`);
}

/** Items → instance batches keyed "kind" (floor/object) or "kind@back"/"kind@left" (wall items), each
 *  instance {id, x, z (footprint centre), yaw, color}. Textable items also go in `texts`. */
export function layoutBatches(items) {
  const batches = new Map();
  const texts = [];
  for (const it of items) {
    const kind = KINDS[it.kind];
    if (!kind) throw new Error(`item ${it.id}: unknown kind "${it.kind}"`);
    const wall = wallOf(it);
    const key = wall ? `${it.kind}@${wall}` : it.kind;
    const f = footprint(it);
    const inst = { id: it.id, kind: it.kind, x: f.x + f.w / 2, z: f.z + f.d / 2, yaw: it.rot * D2R, color: it.color ?? null, wall };
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key).push(inst);
    if (kind.textable) texts.push({ ...inst, text: it.text ?? "" });
  }
  return { batches, texts };
}

/* ── labels ─────────────────────────────────────────────────────────────────────────────────── */

export function labelPriority({ selected, status, speaking }) {
  if (selected) return 100;
  if (speaking) return 60;
  return { waiting: 50, working: 40, idle: 20, away: 10 }[status] ?? 0;
}

/** Greedy: keep the highest-priority (then nearest) rects that don't overlap a kept one. */
export function cullLabels(rects) {
  const sorted = [...rects].sort((a, b) => b.priority - a.priority || (a.depth ?? 0) - (b.depth ?? 0));
  const kept = [];
  for (const r of sorted) {
    const hit = kept.some((k) => r.x < k.x + k.w && r.x + r.w > k.x && r.y < k.y + k.h && r.y + r.h > k.y);
    if (!hit) kept.push(r);
  }
  return new Set(kept.map((r) => r.id));
}

/* ── chat ───────────────────────────────────────────────────────────────────────────────────── */

export const isHuman = (from) => typeof from === "string" && from.startsWith("human:");

/** The conversation with one agent: room lines it said plus DMs to/from it. */
export function chatWith(chat, agentId) {
  return chat.filter((m) => m.from === agentId || m.to === agentId);
}

export const roomChat = (chat) => chat.filter((m) => m.to === null || m.to === undefined);

export function lastLineOf(chat, agentId) {
  for (let i = chat.length - 1; i >= 0; i--) if (chat[i].from === agentId) return chat[i];
  return null;
}

export function speakerName(from, agents) {
  if (isHuman(from)) return from.slice(6);
  const a = agents.find((x) => x.id === from);
  return a ? a.name : from;
}

/** The current speech bubble text, or null once it's older than SAY_MS. */
export function activeSay(agent, now = Date.now()) {
  if (!agent.says || !agent.says.text) return null;
  return now - agent.says.ts < SAY_MS ? agent.says.text : null;
}

/** Shirt / accent colours from a persona hue. */
export function hueColors(hue) {
  const h = ((Math.round(hue) % 360) + 360) % 360;
  return { shirt: `hsl(${h} 62% 58%)`, shirtDark: `hsl(${h} 52% 44%)`, accent: `hsl(${h} 80% 72%)`, css: `hsl(${h} 70% 60%)` };
}
