// Pure viewer logic: state reducer for ws frames, agent → pose, desk seating, idle spots, A* routes on
// the cell grid, layout → instance batches, label culling, chat filters. No DOM, no three.js — checked
// by scripts/check-viewer.mjs with plain node.

import { footprint, kindOf, seatOf } from "../shared/catalog.js";
import { BOX_MATERIALS, UNITS, allSpots, blockedCells, spotReachable } from "../shared/kinds.js";
import { DEFAULT_THEME, hexToHsl, hslToHex, luminance, mixHex, validateTheme } from "../shared/theme.js";

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

/** Custom kinds arrive as a list; the viewer keeps a {slug: kind} map (the catalog's `custom`). */
export function kindMap(kinds) {
  if (!Array.isArray(kinds)) throw new Error(`snapshot customKinds must be a list, got ${JSON.stringify(kinds)}`);
  return Object.fromEntries(kinds.map((k) => [k.kind, k]));
}

/** Pure: (state | null, frame) → new state. Throws on a malformed or out-of-order frame. */
export function applyFrame(state, frame) {
  if (!frame || typeof frame.type !== "string") throw new Error(`bad frame ${JSON.stringify(frame)}`);
  if (frame.type === "snapshot") {
    const s = requireField(frame, "state");
    for (const key of ["id", "grid", "items", "agents", "chat", "theme", "customKinds", "assets"]) {
      if (s[key] === undefined) throw new Error(`snapshot state is missing "${key}"`);
    }
    return {
      ...s,
      chat: s.chat.slice(-CHAT_KEEP),
      customKinds: kindMap(s.customKinds),
      designer: s.designer ?? null,
    };
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
    case "theme": {
      return { ...state, theme: requireField(frame, "theme") };
    }
    case "kind": {
      const k = requireField(frame, "kind");
      if (typeof k.kind !== "string") throw new Error("kind frame is missing kind.kind (the slug)");
      return { ...state, customKinds: { ...state.customKinds, [k.kind]: k } };
    }
    case "kind-removed": {
      const slug = requireField(frame, "kind");
      const next = { ...state.customKinds };
      delete next[slug];
      return { ...state, customKinds: next };
    }
    case "asset": {
      const a = requireField(frame, "asset");
      return { ...state, assets: [...state.assets.filter((x) => x.id !== a.id), a] };
    }
    case "asset-removed": {
      const id = requireField(frame, "id");
      return { ...state, assets: state.assets.filter((x) => x.id !== id) };
    }
    case "designer": {
      if (!("id" in frame)) throw new Error('frame designer is missing "id"');
      return { ...state, designer: frame.id };
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
  if (pose === "sip" || pose === "coffee") {
    // a slow lift to the lips every few seconds, then hold the mug at chest height
    const lift = Math.max(0, Math.sin(s * 0.9)) ** 3;
    a.armR = (-55 - 70 * lift) * D2R; a.armRz = 14 * D2R;
    a.armL = Math.sin(s * 1.1) * 3 * D2R;
    a.headTilt = (-14 * lift + 3) * D2R;
    a.head = Math.sin(s * 0.3) * 12 * D2R * (1 - lift);
    a.bob = Math.sin(s * 2) * 0.008;
    return a;
  }
  if (pose === "snack") {
    const bite = Math.max(0, Math.sin(s * 2.2)) ** 2;
    a.armL = (-60 - 60 * bite) * D2R; a.armLz = 16 * D2R;
    a.headTilt = (-4 + 6 * bite) * D2R;
    a.bob = Math.sin(s * 4.4) * 0.006 * bite;
    return a;
  }
  if (pose === "read") {
    a.armL = a.armR = -62 * D2R;
    a.armLz = a.armRz = 12 * D2R;
    a.headTilt = 22 * D2R;
    // a page turn now and then: right hand sweeps across
    const turn = Math.max(0, Math.sin(s * 0.55) - 0.9) * 10;
    a.armRz = (12 + 30 * turn) * D2R;
    a.head = Math.sin(s * 0.7) * 4 * D2R;
    a.bob = Math.sin(s * 1.6) * 0.006;
    return a;
  }
  if (pose === "play") {
    // arcade: both hands on the controls, jittering, the whole body leaning in
    a.armL = -78 * D2R + Math.sin(s * 17) * 6 * D2R;
    a.armR = -80 * D2R + Math.sin(s * 23 + 1) * 9 * D2R;
    a.armLz = Math.sin(s * 5) * 8 * D2R;
    a.lean = (8 + Math.sin(s * 3) * 3) * D2R;
    a.head = Math.sin(s * 1.3) * 3 * D2R;
    a.headTilt = 4 * D2R;
    a.bob = Math.abs(Math.sin(s * 6)) * 0.02;
    return a;
  }
  if (pose === "water-plants") {
    // watering can held out, tipping in slow pours
    a.armR = (-70 + Math.sin(s * 1.2) * 14) * D2R; a.armRz = 6 * D2R;
    a.armL = Math.sin(s * 1.1) * 3 * D2R;
    a.lean = 10 * D2R;
    a.headTilt = 18 * D2R;
    a.bob = Math.sin(s * 2) * 0.008;
    return a;
  }
  if (pose === "whiteboard") {
    // writing: right arm up, scribbling across the board
    a.armR = (-128 + Math.sin(s * 7) * 6) * D2R;
    a.armRz = (Math.sin(s * 0.9) * 22) * D2R;
    a.armL = Math.sin(s * 0.8) * 4 * D2R;
    a.head = Math.sin(s * 0.9) * 10 * D2R;
    a.headTilt = -8 * D2R;
    a.bob = Math.sin(s * 2) * 0.006;
    return a;
  }
  if (pose === "chat") {
    // talking with the hands, nodding along
    const talk = Math.sin(s * 0.6) > 0;
    a.armL = (talk ? -35 + Math.sin(s * 4) * 18 : 0) * D2R; a.armLz = 10 * D2R;
    a.armR = (talk ? -25 + Math.sin(s * 3 + 1) * 14 : 0) * D2R;
    a.headTilt = (talk ? -3 : Math.sin(s * 5) * 6) * D2R;
    a.head = Math.sin(s * 0.4) * 8 * D2R;
    a.bob = Math.sin(s * 2) * 0.008;
    return a;
  }
  if (pose === "think") {
    // hand on chin, gaze drifting up, a slow weight shift
    a.armR = -128 * D2R; a.armRz = -30 * D2R;
    a.armL = -40 * D2R; a.armLz = -24 * D2R;
    a.headTilt = (-14 + Math.sin(s * 0.5) * 5) * D2R;
    a.head = Math.sin(s * 0.35) * 18 * D2R;
    a.lean = Math.sin(s * 0.4) * 2 * D2R;
    a.bob = Math.sin(s * 1.2) * 0.006;
    return a;
  }
  if (pose === "watch") {
    // standing in front of the TV, arms folded, the odd laugh
    const laugh = Math.max(0, Math.sin(s * 0.7) - 0.85) * 6;
    a.armL = a.armR = -70 * D2R;
    a.armLz = -38 * D2R; a.armRz = -38 * D2R;
    a.headTilt = (-4 - laugh * 8) * D2R;
    a.head = Math.sin(s * 0.25) * 6 * D2R;
    a.lean = -3 * D2R;
    a.bob = Math.sin(s * 2) * 0.006 + Math.abs(Math.sin(s * 14)) * 0.02 * laugh;
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
export function itemPoint(item, lx, lz, custom) {
  const f = footprint(item, custom);
  const cx = f.x + f.w / 2, cz = f.z + f.d / 2;
  const r = item.rot * D2R;
  return { x: cx + lx * Math.cos(r) + lz * Math.sin(r), z: cz - lx * Math.sin(r) + lz * Math.cos(r), yaw: r };
}

/**
 * Places an idle agent can go: every kind's seats (sit at `seatY`) and stations (stand, do the activity),
 * from the shared catalog / custom kinds. {id, itemId, x, z, yaw, pose, seatY?, activity?, duration}.
 */
export function idleSpots(items, custom) {
  const { seats, stations } = allSpots(items, custom);
  return [
    ...seats.map((s) => ({ id: s.id, itemId: s.item, x: s.x, z: s.z, yaw: s.yaw, pose: "sit", seatY: s.height, activity: null, duration: SEAT_SECONDS })),
    ...stations.map((s) => ({ id: s.id, itemId: s.item, x: s.x, z: s.z, yaw: s.yaw, pose: s.activity, activity: s.activity, duration: s.duration })),
  ];
}
/**
 * Drop spots nobody can reach: outside the floor (a station in front of a plant against the front wall),
 * or a station whose cell is covered by furniture. Seats sit on their own item, so only the floor bounds apply.
 */
export function usableSpots(spots, blocked, grid) {
  return spots.filter((s) => spotReachable(s, s.pose === "sit", blocked, grid));
}

/** How long an idle agent stays on a seat before it fancies something else. */
export const SEAT_SECONDS = 50;

/** Deterministic spot choice: hash order, skipping spots already taken (and `avoid`). null if all are taken. */
export function pickSpot(agentId, spots, taken, salt = 0, avoid = null) {
  if (!spots.length) return null;
  const start = hashStr(`${agentId}:${salt}`) % spots.length;
  for (let i = 0; i < spots.length; i++) {
    const s = spots[(start + i) % spots.length];
    if (!taken.has(s.id) && s.id !== avoid) return s;
  }
  return null;
}

/**
 * Who goes where, one agent per seat/station, stable: agents already on a spot keep it until they're
 * restless (their time there is up); then the rest pick in join order. A free "chat" station next to
 * someone already chatting is preferred now and then, so huddles fill in pairs.
 * wanters: [{id, joinedAt, salt, current: spotId | null, restless: bool}] → Map(id → spot).
 */
export function assignSpots(wanters, spots) {
  const byId = new Map(spots.map((s) => [s.id, s]));
  const taken = new Set();
  const out = new Map();
  const order = [...wanters].sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1));
  for (const w of order) {
    const cur = w.current ? byId.get(w.current) : null;
    if (cur && !w.restless && !taken.has(cur.id)) { taken.add(cur.id); out.set(w.id, cur); }
  }
  for (const w of order) {
    if (out.has(w.id)) continue;
    const avoid = w.restless ? w.current : null;
    let spot = null;
    if (hashStr(`${w.id}:chat:${w.salt}`) % 3 === 0) {
      const busy = new Set(spots.filter((s) => s.activity === "chat" && taken.has(s.id)).map((s) => s.itemId));
      spot = spots.find((s) => s.activity === "chat" && busy.has(s.itemId) && !taken.has(s.id) && s.id !== avoid) ?? null;
    }
    spot ??= pickSpot(w.id, spots, taken, w.salt, avoid);
    if (!spot) continue;
    taken.add(spot.id);
    out.set(w.id, spot);
  }
  return out;
}

/* ── grid routes ────────────────────────────────────────────────────────────────────────────── */

export { blockedCells };

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
export function wallOf(item, custom) {
  if (kindOf(item.kind, custom)?.layer !== "wall") return null;
  if (item.rot === 0 && item.z === 0) return "back";
  if (item.rot === 90 && item.x === 0) return "left";
  throw new Error(`item ${item.id}: ${item.kind} is not on a wall (rot ${item.rot}, x ${item.x}, z ${item.z})`);
}

/** Items → instance batches keyed "kind" (floor/object) or "kind@back"/"kind@left" (wall items), each
 *  instance {id, x, z (footprint centre), yaw, color}. Textable items also go in `texts`. */
export function layoutBatches(items, custom) {
  const batches = new Map();
  const texts = [];
  for (const it of items) {
    const kind = kindOf(it.kind, custom);
    if (!kind) throw new Error(`item ${it.id}: unknown kind "${it.kind}"`);
    const wall = wallOf(it, custom);
    const key = wall ? `${it.kind}@${wall}` : it.kind;
    const f = footprint(it, custom);
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

/* ── custom voxel kinds ─────────────────────────────────────────────────────────────────────── */

/** Greedy-merge boxes that share a full face and look the same (same colour, material, emissive). */
export function mergeBoxes(boxes) {
  let list = boxes.map((b) => ({ ...b }));
  const same = (a, b) => a.color.toLowerCase() === b.color.toLowerCase() && (a.material ?? "matte") === (b.material ?? "matte") && !!a.emissive === !!b.emissive;
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (!same(a, b)) continue;
        let m = null;
        if (a.y === b.y && a.h === b.h && a.z === b.z && a.d === b.d && (a.x + a.w === b.x || b.x + b.w === a.x)) m = { ...a, x: Math.min(a.x, b.x), w: a.w + b.w };
        else if (a.x === b.x && a.w === b.w && a.z === b.z && a.d === b.d && (a.y + a.h === b.y || b.y + b.h === a.y)) m = { ...a, y: Math.min(a.y, b.y), h: a.h + b.h };
        else if (a.x === b.x && a.w === b.w && a.y === b.y && a.h === b.h && (a.z + a.d === b.z || b.z + b.d === a.z)) m = { ...a, z: Math.min(a.z, b.z), d: a.d + b.d };
        if (m) { list[i] = m; list.splice(j, 1); changed = true; break outer; }
      }
    }
  }
  return list;
}

/**
 * A custom kind's boxes (normalised by kinds.js validateKindDef: 16 units per cell, min corner, origin at the
 * footprint's min corner) →
 * geometry buckets in the item frame used by built-ins (1 unit = 1 cell, origin at the footprint centre,
 * y up): {matte, glossy, glass, screen, emissive}, each a list of {cx, y0, cz, w, h, d, color}.
 * Emissive boxes glow at night whatever their material; screen boxes show the office logo.
 */
export function kindGeometryPlan(def) {
  if (!def || !Number.isInteger(def.w) || !Number.isInteger(def.d) || !Array.isArray(def.boxes)) throw new Error(`custom kind ${JSON.stringify(def?.kind)} has no w/d/boxes`);
  const U = UNITS;
  const fw = def.w, fd = def.d;
  const merged = mergeBoxes(def.boxes);
  const plan = { matte: [], glossy: [], glass: [], screen: [], emissive: [], input: def.boxes.length, merged: merged.length };
  for (const b of merged) {
    const mat = b.material ?? "matte";
    if (!BOX_MATERIALS.includes(mat)) throw new Error(`custom kind ${def.kind}: unknown box material ${JSON.stringify(mat)}`);
    const out = { cx: (b.x + b.w / 2) / U - fw / 2, y0: b.y / U, cz: (b.z + b.d / 2) / U - fd / 2, w: b.w / U, h: b.h / U, d: b.d / U, color: b.color };
    const bucket = mat === "screen" ? "screen" : b.emissive ? "emissive" : mat;
    plan[bucket].push(out);
  }
  return plan;
}

/* ── theme → look ───────────────────────────────────────────────────────────────────────────── */

/** Light rigs per lighting mood: day sun/hemisphere tints and the colour lamps glow at night. */
export const MOODS = Object.freeze({
  warm: { sun: "#ffe4bd", sky: "#d7ecff", ground: "#e3c39d", lamp: "#ffc27a", fill: "#ffd9a8", nightSky: "#41508f" },
  neutral: { sun: "#fff3e4", sky: "#e2ecf8", ground: "#d6cfc6", lamp: "#ffe0b8", fill: "#ffe9cf", nightSky: "#45507f" },
  cool: { sun: "#eef3ff", sky: "#d2e4ff", ground: "#c4cfd9", lamp: "#d6e6ff", fill: "#dfe9ff", nightSky: "#3f5a96" },
});

/** Floor roughness per material: polished concrete and tile catch a little light, carpet none. */
const FLOOR_ROUGH = { wood: 0.78, tile: 0.5, concrete: 0.62, carpet: 1 };

/** Built-in model colours, used verbatim by the default theme so the classic office looks as it always did. */
export const CLASSIC_COLORS = Object.freeze({ desk: "#6aa6c9", chair: "#e39a5b", sofa: "#6f9fc0", beanbag: "#f2a65a", rug: "#d98f6f", sign: "#3a4a3f", lamp: "#2e313a", poster: "#f2c879" });

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Pure: a complete theme → every colour and material the scene paints with.
 * {floor: {material, color, roughness}, walls: {color, trim, baseboard, accent}, desk: {wood, rail},
 *  kindColors: {kind → default accent colour}, mood: MOODS[lighting], nightWindow, signBg, signFg, screenBg}
 */
export function themeLook(theme) {
  const t = validateTheme(theme);
  const classic = sameList(t.accents, DEFAULT_THEME.accents);
  const a = (i) => t.accents[i % t.accents.length];
  // a soft version of an accent for big surfaces (sofa, rugs): keep the hue, ease the saturation/lightness
  const soft = (hex, l = 0.62) => { const [h, s] = hexToHsl(hex); return hslToHex([h, Math.min(s, 0.55), l]); };
  // the darkest accent (or a deepened primary) anchors signage and screens
  const darkest = [...t.accents].sort((x, y) => luminance(x) - luminance(y))[0];
  const ink = luminance(darkest) < 0.06 ? darkest : hslToHex([hexToHsl(a(0))[0], 0.25, 0.1]);
  const kindColors = classic ? { ...CLASSIC_COLORS } : {
    desk: a(0),
    chair: a(0),
    sofa: soft(a(0), 0.5),
    beanbag: a(1),
    rug: soft(a(1), 0.66),
    sign: ink,
    lamp: ink,
    poster: soft(a(1), 0.8),
  };
  return {
    floor: { material: t.floor.material, color: t.floor.color, roughness: FLOOR_ROUGH[t.floor.material] },
    walls: { color: t.walls.color, trim: t.walls.trim, baseboard: mixHex(t.walls.color, t.walls.trim, 0.25), accent: t.walls.accent },
    desk: { wood: t.desk.wood, rail: t.desk.rail },
    kindColors,
    mood: MOODS[t.lighting],
    nightWindow: t.nightWindow,
    signBg: classic ? "#34433a" : ink,
    signFg: classic ? "#f6f1e3" : mixHex("#ffffff", a(1), 0.12),
    screenBg: classic ? "#18233a" : ink,
    logo: t.logo,
    logoOnSigns: t.logoOnSigns,
  };
}
