// Live city feed (spec-v2 §7.5): the view-only WS client of the City DO, the walker state it feeds, and path
// interpolation. Positions are f(path, serverNow − t0) with the clock offset taken from the snapshot `now`;
// y comes from the path (the walk graph, §7.6), never from groundAt; walkers keep to the right-hand sidewalk,
// offset by the street's halfWidth from walk.bin.
//
// Wire format (City DO src/city/do.ts → viewer), one JSON frame or a JSON array of frames per message;
// createWireAdapter() turns it into the internal frames below:
//   {type:"snapshot", now, builtAt, sites:[Site], walkers:[WireWalker], chatTail:[WireChat]}
//   {type:"walk"|"arrive", walker: WireWalker}  {type:"presence", site: Site}  {type:"left", id, inside?}
//   {type:"say", id, text, ts}  {type:"chat", msg: WireChat}
//   WireWalker = {id, name, hue, status, site, path:[[x,z,y],…], t0 (server ms), speed (blocks/s, 0 = standing), mode}
//   Site       = {siteId, companyId, agentCount, agents:[{name, hue, status}], inside}   (inside = walkers gone in)
//   WireChat   = {seq, ts, from:{id, name}, scope:"near"|"city", say?, text, x, z}
// Internal frames (createLiveState.apply):
//   {type:"snapshot", now, walkers:[Walker], presence:[Presence], chatTail:[Chat]}
//   {type:"walk"|"arrive", walker}  {type:"presence", presence:[Presence]}  {type:"say", id, text, ts}
//   {type:"left", id}  {type:"chat", chat}
//   Walker   = {id, name, hue, status, path, t0, speed, mode, inside, siteId|null}
//   Presence = {companyId, agentCount, agents:[{name, hue, status}], inside}   (summed over the company's sites)
//   Chat     = {seq, ts, from (walker id), name, scope:"near"|"city", text, x, z}

import { WALK_EDGE_INTS, WALK_NODE_INTS, edgeHalfWidth10 } from "../../shared/city.js";

export const MODES = Object.freeze(["walk", "ride"]);
export const CHAT_SCOPES = Object.freeze(["near", "city"]);
export const SAY_MS = 6000;
export const CHAT_KEEP = 50;
/** halfWidth is the carriageway's half width: on a street the sidewalk centre lies this far beyond its edge. */
export const SIDEWALK_OUT = 0.5;
/** At or below this halfWidth the edge is a footway with no sidewalk: walkers keep to its right half. */
export const PATH_MAX_HALF = 1.5;

/** Pure. Right-hand offset (blocks from the centreline) for an edge of halfWidth hw; 0 off the graph (hw null). */
export function sidewalkOffset(hw) {
  if (hw === null) return 0;
  if (!(hw > 0)) throw new Error(`sidewalkOffset: halfWidth must be > 0, got ${hw}`);
  return hw > PATH_MAX_HALF ? hw + SIDEWALK_OUT : hw / 2;
}
export const RECONNECT_MS = Object.freeze({ min: 1000, max: 30000 });

const WALKER_KEYS = ["id", "name", "hue", "status", "path", "t0", "speed", "mode", "inside", "siteId"];
const PRESENCE_KEYS = ["companyId", "agentCount", "agents", "inside"];
const CHAT_KEYS = ["seq", "ts", "from", "name", "scope", "text", "x", "z"];

function exactKeys(o, keys, what) {
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error(`${what} must be an object, got ${JSON.stringify(o)}`);
  for (const k of keys) if (!(k in o)) throw new Error(`${what} is missing "${k}"`);
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Error(`${what} has unknown field "${k}"`);
}
const str = (v, what) => { if (typeof v !== "string" || !v) throw new Error(`${what} must be a non-empty string, got ${JSON.stringify(v)}`); return v; };
const num = (v, what) => { if (!Number.isFinite(v)) throw new Error(`${what} must be a finite number, got ${JSON.stringify(v)}`); return v; };

/** Throws unless every path point is [x, z, y] with finite numbers; a point without y is a server bug. */
export function validatePath(path, what = "path") {
  if (!Array.isArray(path) || path.length < 1) throw new Error(`${what} must be a non-empty array of [x, z, y]`);
  path.forEach((p, i) => {
    if (!Array.isArray(p)) throw new Error(`${what}[${i}] must be [x, z, y], got ${JSON.stringify(p)}`);
    if (p.length === 2) throw new Error(`${what}[${i}] has no y (${JSON.stringify(p)}); walker y comes from the walk graph, never from the ground`);
    if (p.length !== 3 || !p.every(Number.isFinite)) throw new Error(`${what}[${i}] must be three finite numbers [x, z, y], got ${JSON.stringify(p)}`);
  });
  return path;
}

export function validateWalker(w) {
  exactKeys(w, WALKER_KEYS, `walker ${JSON.stringify(w?.id)}`);
  const what = `walker ${w.id}`;
  str(w.id, `${what}.id`); str(w.name, `${what}.name`); str(w.status, `${what}.status`);
  num(w.hue, `${what}.hue`); num(w.t0, `${what}.t0`);
  if (!(w.speed >= 0)) throw new Error(`${what}.speed must be ≥ 0 blocks/s, got ${JSON.stringify(w.speed)}`);
  if (!MODES.includes(w.mode)) throw new Error(`${what}.mode must be ${MODES.join("|")}, got ${JSON.stringify(w.mode)}`);
  if (typeof w.inside !== "boolean") throw new Error(`${what}.inside must be a boolean`);
  if (w.siteId !== null) str(w.siteId, `${what}.siteId`);
  validatePath(w.path, `${what}.path`);
  return w;
}

export function validatePresence(list) {
  if (!Array.isArray(list)) throw new Error("presence must be an array");
  for (const p of list) {
    exactKeys(p, PRESENCE_KEYS, `presence ${JSON.stringify(p?.companyId)}`);
    str(p.companyId, "presence.companyId");
    if (!Array.isArray(p.agents)) throw new Error(`presence ${p.companyId}.agents must be an array`);
    if (p.agentCount !== p.agents.length) throw new Error(`presence ${p.companyId}: agentCount ${p.agentCount} != ${p.agents.length} agents`);
    if (!Number.isInteger(p.inside) || p.inside < 0) throw new Error(`presence ${p.companyId}.inside must be an integer ≥ 0, got ${JSON.stringify(p.inside)}`);
    p.agents.forEach((a, i) => {
      exactKeys(a, ["name", "hue", "status"], `presence ${p.companyId}.agents[${i}]`);
      str(a.name, `presence ${p.companyId}.agents[${i}].name`); num(a.hue, `presence ${p.companyId}.agents[${i}].hue`); str(a.status, `presence ${p.companyId}.agents[${i}].status`);
    });
  }
  return list;
}

export function validateChat(c) {
  exactKeys(c, CHAT_KEYS, `chat ${JSON.stringify(c?.seq)}`);
  if (!Number.isSafeInteger(c.seq)) throw new Error(`chat.seq must be an integer, got ${JSON.stringify(c.seq)}`);
  num(c.ts, "chat.ts"); str(c.from, "chat.from"); str(c.name, "chat.name");
  if (!CHAT_SCOPES.includes(c.scope)) throw new Error(`chat ${c.seq}: scope ${JSON.stringify(c.scope)} is not ${CHAT_SCOPES.join("|")} (DMs never reach viewers)`);
  if (typeof c.text !== "string") throw new Error(`chat ${c.seq}: text must be a string`);
  num(c.x, "chat.x"); num(c.z, "chat.z");
  return c;
}

/** Pure. Server clock minus local clock, from the snapshot's `now` and the local time it arrived. */
export function clockOffset(serverNow, localNow) {
  num(serverNow, "snapshot.now"); num(localNow, "local now");
  return serverNow - localNow;
}

/* ── graph lookup: halfWidth per path segment ─────────────────────────────────────────────────── */

/** Pure. → {nodeAt(x, z) → index|-1, edgeWidth(a, b) → halfWidth blocks|null, outgoing(a) → [{b, w}]} over a WalkGraph. */
export function graphIndex(graph) {
  if (!graph || !(graph.nodes instanceof Int32Array) || !(graph.edges instanceof Int32Array)) throw new Error("graphIndex: expected a decoded walk graph");
  const nodes = new Map();
  const n = graph.nodes.length / WALK_NODE_INTS;
  for (let i = 0; i < n; i++) nodes.set(`${graph.nodes[i * 3]},${graph.nodes[i * 3 + 1]}`, i);
  const out = new Map();
  const ne = graph.edges.length / WALK_EDGE_INTS;
  for (let e = 0; e < ne; e++) {
    const a = graph.edges[e * WALK_EDGE_INTS], b = graph.edges[e * WALK_EDGE_INTS + 1];
    if (!out.has(a)) out.set(a, []);
    out.get(a).push({ b, w: edgeHalfWidth10(graph.edges, e) / 10 });
  }
  const pos = (i) => [graph.nodes[i * 3] / 10, graph.nodes[i * 3 + 1] / 10];
  return {
    nodeAt: (x, z) => nodes.get(`${Math.round(x * 10)},${Math.round(z * 10)}`) ?? -1,
    edgeWidth: (a, b) => out.get(a)?.find((o) => o.b === b)?.w ?? null,
    outgoing: (a) => out.get(a) ?? [],
    pos,
  };
}

/**
 * Pure. halfWidth (blocks) of each path segment: the graph edge joining its two ends, or (for a simplified path)
 * the edge leaving its start node in the segment's direction (cos ≥ 0.98). null where the segment is off the graph
 * (it then walks its centreline).
 */
export function segmentWidths(path, index) {
  const widths = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const [x0, z0] = path[i], [x1, z1] = path[i + 1];
    const a = index.nodeAt(x0, z0), b = index.nodeAt(x1, z1);
    let w = a >= 0 && b >= 0 ? index.edgeWidth(a, b) : null;
    if (w === null && a >= 0) {
      const L = Math.hypot(x1 - x0, z1 - z0);
      let best = 0.98;
      for (const o of index.outgoing(a)) {
        const [bx, bz] = index.pos(o.b);
        const l = Math.hypot(bx - x0, bz - z0);
        if (!L || !l) continue;
        const cos = ((bx - x0) * (x1 - x0) + (bz - z0) * (z1 - z0)) / (l * L);
        if (cos >= best) { best = cos; w = o.w; }
      }
    }
    widths.push(w);
  }
  return widths;
}

/** Right-hand normal of a horizontal direction (y up, x east, z south): right = (−dz, dx). */
const rightOf = (dx, dz) => { const l = Math.hypot(dx, dz) || 1; return [-dz / l, dx / l]; };

/**
 * Pure. Per-vertex right-hand sidewalk offsets [ox, oz]: each segment moves sidewalkOffset(halfWidth) to its right;
 * interior vertices take the miter of their two segments (clamped), so the offset path stays continuous.
 */
export function sidewalkOffsets(path, widths) {
  const n = path.length;
  if (widths.length !== Math.max(0, n - 1)) throw new Error(`sidewalkOffsets: ${widths.length} widths for ${n} points`);
  const segs = widths.map((w, i) => {
    const [x0, z0] = path[i], [x1, z1] = path[i + 1];
    const zero = x0 === x1 && z0 === z1;
    return { n: zero ? null : rightOf(x1 - x0, z1 - z0), o: sidewalkOffset(w) };
  });
  const out = [];
  for (let k = 0; k < n; k++) {
    let prev = null, next = null;
    for (let i = k - 1; i >= 0 && !prev; i--) if (segs[i].n) prev = segs[i];
    for (let i = k; i < segs.length && !next; i++) if (segs[i].n) next = segs[i];
    if (!prev && !next) { out.push([0, 0]); continue; }
    if (!prev || !next) { const s = prev ?? next; out.push([s.n[0] * s.o, s.n[1] * s.o]); continue; }
    const mx = prev.n[0] + next.n[0], mz = prev.n[1] + next.n[1];
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { out.push([next.n[0] * next.o, next.n[1] * next.o]); continue; }
    const m = [mx / ml, mz / ml];
    const o = Math.max(prev.o, next.o) / Math.max(0.5, m[0] * next.n[0] + m[1] * next.n[1]);
    out.push([m[0] * o, m[1] * o]);
  }
  return out;
}

/** Pure. A walker's path prepared for interpolation: cumulative 3-D lengths (the walk graph's len10 is 3-D) and offsets. */
export function makeTrack(walker, index) {
  validateWalker(walker);
  const { path } = walker;
  const cum = [0];
  for (let i = 1; i < path.length; i++) {
    const [ax, az, ay] = path[i - 1], [bx, bz, by] = path[i];
    cum.push(cum[i - 1] + Math.hypot(bx - ax, bz - az, by - ay));
  }
  const offsets = index ? sidewalkOffsets(path, segmentWidths(path, index)) : path.map(() => [0, 0]);
  return { walker, cum, total: cum[cum.length - 1], offsets };
}

/** Pure. Point at distance d along a track → {x, y, z, heading, d}; d is clamped to [0, total]. */
export function pointAt(track, d) {
  const { walker: { path }, cum, total, offsets } = track;
  const dd = Math.max(0, Math.min(total, d));
  let lo = 0, hi = path.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= dd) lo = mid; else hi = mid; }
  const a = path[lo], b = path[Math.min(hi, path.length - 1)];
  const len = cum[hi] - cum[lo];
  const f = hi === lo || len <= 0 ? 0 : (dd - cum[lo]) / len;
  const oa = offsets[lo], ob = offsets[Math.min(hi, path.length - 1)];
  let hx = b[0] - a[0], hz = b[1] - a[1];
  if (!hx && !hz && path.length > 1) { const p = path[path.length - 2], q = path[path.length - 1]; hx = q[0] - p[0]; hz = q[1] - p[1]; }
  return {
    x: a[0] + (b[0] - a[0]) * f + oa[0] + (ob[0] - oa[0]) * f,
    z: a[1] + (b[1] - a[1]) * f + oa[1] + (ob[1] - oa[1]) * f,
    y: a[2] + (b[2] - a[2]) * f,
    heading: Math.atan2(hx, hz),
    d: dd,
  };
}

/** Pure. Where a walker is at server time `serverNow` → {x, y, z, heading, d, moving, mode}. */
export function walkerPosition(track, serverNow) {
  const { walker } = track;
  const d = (walker.speed * (serverNow - walker.t0)) / 1000;
  const p = pointAt(track, d);
  return { ...p, moving: d > 0 && d < track.total, mode: walker.mode };
}

/* ── state ────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The live city state: walkers (tracks), presence, chat tail and say bubbles. apply(frame, localNow) mutates it;
 * every frame before the snapshot throws. → {apply, serverNow, position, walkers, presence, chat, sayOf, onChange}
 */
export function createLiveState({ graph = null } = {}) {
  const index = graph ? graphIndex(graph) : null;
  const tracks = new Map();
  const says = new Map();
  let presence = [];
  let chat = [];
  let offset = null;
  const listeners = [];

  const emit = (kind) => { for (const fn of listeners) fn(kind); };
  const need = (f) => { if (offset === null) throw new Error(`live: "${f.type}" frame before the snapshot`); };
  const putChat = (c) => {
    validateChat(c);
    if (chat.some((x) => x.seq === c.seq)) return;
    chat = [...chat, c].sort((a, b) => a.seq - b.seq).slice(-CHAT_KEEP);
  };

  function apply(frame, localNow = Date.now()) {
    if (Array.isArray(frame)) { for (const f of frame) apply(f, localNow); return; }
    if (!frame || typeof frame.type !== "string") throw new Error(`live: bad frame ${JSON.stringify(frame)?.slice(0, 120)}`);
    switch (frame.type) {
      case "snapshot": {
        exactKeys(frame, ["type", "now", "walkers", "presence", "chatTail"], "snapshot");
        if (!Array.isArray(frame.walkers) || !Array.isArray(frame.chatTail)) throw new Error("snapshot.walkers and snapshot.chatTail must be arrays");
        const next = new Map();
        for (const w of frame.walkers) {
          if (next.has(w?.id)) throw new Error(`snapshot: duplicate walker ${w.id}`);
          next.set(w.id, makeTrack(w, index));
        }
        presence = validatePresence(frame.presence);
        offset = clockOffset(frame.now, localNow);
        tracks.clear();
        for (const [k, v] of next) tracks.set(k, v);
        says.clear();
        chat = [];
        for (const c of frame.chatTail) putChat(c);
        emit("snapshot");
        return;
      }
      case "walk":
      case "arrive":
        need(frame);
        exactKeys(frame, ["type", "walker"], `${frame.type} frame`);
        tracks.set(frame.walker.id, makeTrack(frame.walker, index));
        emit(frame.type);
        return;
      case "presence":
        need(frame);
        exactKeys(frame, ["type", "presence"], "presence frame");
        presence = validatePresence(frame.presence);
        emit("presence");
        return;
      case "say":
        need(frame);
        exactKeys(frame, ["type", "id", "text", "ts"], "say frame");
        if (!tracks.has(frame.id)) throw new Error(`live: say from unknown walker ${frame.id}`);
        if (typeof frame.text !== "string") throw new Error("say.text must be a string");
        num(frame.ts, "say.ts");
        says.set(frame.id, { text: frame.text, until: frame.ts + SAY_MS });
        emit("say");
        return;
      case "left":
        need(frame);
        exactKeys(frame, ["type", "id"], "left frame");
        tracks.delete(frame.id);
        says.delete(frame.id);
        emit("left");
        return;
      case "chat":
        need(frame);
        exactKeys(frame, ["type", "chat"], "chat frame");
        putChat(frame.chat);
        emit("chat");
        return;
      default:
        throw new Error(`live: unknown frame type ${JSON.stringify(frame.type)}`);
    }
  }

  const serverNow = (localNow = Date.now()) => {
    if (offset === null) throw new Error("live: no snapshot yet, server clock unknown");
    return localNow + offset;
  };

  return {
    apply,
    serverNow,
    get ready() { return offset !== null; },
    /** Interpolated position of walker `id` at local time `localNow`, or null if it is gone. */
    position(id, localNow = Date.now()) {
      const t = tracks.get(id);
      return t ? walkerPosition(t, serverNow(localNow)) : null;
    },
    walker: (id) => tracks.get(id)?.walker ?? null,
    track: (id) => tracks.get(id) ?? null,
    walkers: () => [...tracks.values()].map((t) => t.walker),
    tracks: () => [...tracks.values()],
    presence: () => presence,
    chat: () => chat,
    /** Current speech bubble text of a walker, or null once SAY_MS has passed (server time). */
    sayOf(id, localNow = Date.now()) {
      const s = says.get(id);
      return s && serverNow(localNow) < s.until ? s.text : null;
    },
    onChange(fn) { listeners.push(fn); },
  };
}

/** Pure. "N here / M inside" (either half alone when the other is 0; "" when both are). */
export function badgeText(here, inside) {
  for (const [v, k] of [[here, "here"], [inside, "inside"]]) if (!Number.isInteger(v) || v < 0) throw new Error(`badgeText: ${k} must be an integer ≥ 0, got ${v}`);
  return [here ? `${here} here` : "", inside ? `${inside} inside` : ""].filter(Boolean).join(" / ");
}

/** Pure. Walkers gone inside, per company, from the live presence (the City DO counts them per site) → Map<companyId, n>. */
export function insideCounts(presence) {
  const m = new Map();
  for (const p of presence) if (p.inside) m.set(p.companyId, (m.get(p.companyId) ?? 0) + p.inside);
  return m;
}

const WIRE_WALKER_KEYS = ["id", "name", "hue", "status", "site", "path", "t0", "speed", "mode"];
const SITE_KEYS = ["siteId", "companyId", "agentCount", "agents", "inside"];

/**
 * City DO wire frames → internal frames. Stateful: it keeps the per-site presence the server sends as deltas and
 * hands createLiveState the per-company list. One adapter per socket (a snapshot resets it). → (msg) → frame | frame[]
 */
export function createWireAdapter() {
  const sites = new Map();
  const site = (s) => {
    exactKeys(s, SITE_KEYS, `site ${JSON.stringify(s?.siteId)}`);
    str(s.siteId, "site.siteId"); str(s.companyId, `site ${s.siteId}.companyId`);
    return s;
  };
  const presence = () => {
    const by = new Map();
    for (const s of sites.values()) {
      if (!s.agentCount && !s.inside) continue;
      const p = by.get(s.companyId) ?? { companyId: s.companyId, agentCount: 0, agents: [], inside: 0 };
      p.agentCount += s.agentCount;
      p.agents.push(...s.agents);
      p.inside += s.inside;
      by.set(s.companyId, p);
    }
    return [...by.values()];
  };
  const walker = (w) => {
    exactKeys(w, WIRE_WALKER_KEYS, `walker ${JSON.stringify(w?.id)}`);
    const { site: siteId, ...rest } = w;
    return { ...rest, inside: false, siteId };
  };
  const chat = (c) => {
    const keys = ["seq", "ts", "from", "scope", "text", "x", "z"];
    exactKeys(c, "say" in (c ?? {}) ? [...keys, "say"] : keys, `chat ${JSON.stringify(c?.seq)}`);
    exactKeys(c.from, ["id", "name"], `chat ${c.seq}.from`);
    return { seq: c.seq, ts: c.ts, from: c.from.id, name: c.from.name, scope: c.scope, text: c.text, x: c.x, z: c.z };
  };
  const one = (f) => {
    if (!f || typeof f.type !== "string") throw new Error(`live: bad frame ${JSON.stringify(f)?.slice(0, 120)}`);
    switch (f.type) {
      case "snapshot":
        exactKeys(f, ["type", "now", "builtAt", "sites", "walkers", "chatTail"], "snapshot");
        if (!Array.isArray(f.sites) || !Array.isArray(f.walkers) || !Array.isArray(f.chatTail)) throw new Error("snapshot.sites, walkers and chatTail must be arrays");
        sites.clear();
        for (const s of f.sites) sites.set(site(s).siteId, s);
        return { type: "snapshot", now: f.now, walkers: f.walkers.map(walker), presence: presence(), chatTail: f.chatTail.map(chat) };
      case "walk":
      case "arrive":
        exactKeys(f, ["type", "walker"], `${f.type} frame`);
        return { type: f.type, walker: walker(f.walker) };
      case "presence":
        exactKeys(f, ["type", "site"], "presence frame");
        sites.set(site(f.site).siteId, f.site);
        return { type: "presence", presence: presence() };
      case "left":
        exactKeys(f, "inside" in f ? ["type", "id", "inside"] : ["type", "id"], "left frame");
        return { type: "left", id: f.id };
      case "say":
        return f;
      case "chat":
        exactKeys(f, ["type", "msg"], "chat frame");
        return { type: "chat", chat: chat(f.msg) };
      case "error":
        throw new Error(`city socket: ${JSON.stringify(f.error)}`);
      default:
        throw new Error(`live: unknown frame type ${JSON.stringify(f.type)}`);
    }
  };
  return (msg) => (Array.isArray(msg) ? msg.map(one) : one(msg));
}

/** Pure. Live presence → the pins.setPresence shape [{companyId, agents:[{id, name, hue, status}]}]. */
export function presenceForPins(presence) {
  return presence.map((p) => ({ companyId: p.companyId, agents: p.agents.map((a) => ({ id: `${p.companyId}:${a.name}`, name: a.name, hue: a.hue, status: a.status })) }));
}

/**
 * Opens the view-only socket and feeds `state`; reconnects with backoff (a fresh snapshot replaces everything).
 * onStatus(status, detail) gets "connecting" | "live" | "offline". A malformed frame is a server bug: it goes to
 * onError (the red banner) and the socket is closed. → {close()}
 */
export function connectLive(url, state, { onStatus = () => {}, onError = (e) => { throw e; }, WebSocketImpl = globalThis.WebSocket } = {}) {
  if (!WebSocketImpl) throw new Error("connectLive: no WebSocket in this environment");
  let ws = null, closed = false, delay = RECONNECT_MS.min, timer = null;
  function open() {
    onStatus("connecting");
    ws = new WebSocketImpl(url);
    let synced = false;
    const fromWire = createWireAdapter();
    ws.onopen = () => { delay = RECONNECT_MS.min; };
    ws.onmessage = (ev) => {
      try {
        if (typeof ev.data !== "string") throw new Error("live: expected a text frame");
        const msg = JSON.parse(ev.data);
        const first = Array.isArray(msg) ? msg[0] : msg;
        if (!synced && first?.type !== "snapshot") throw new Error(`live: the socket must open with a snapshot, got ${JSON.stringify(first?.type)}`);
        state.apply(fromWire(msg));
        if (!synced) { synced = true; onStatus("live"); }
      } catch (e) {
        onError(e instanceof Error ? e : new Error(String(e)));
        ws.close();
      }
    };
    ws.onclose = () => {
      if (closed) return;
      const wait = delay;
      delay = Math.min(RECONNECT_MS.max, delay * 2);
      onStatus("offline", { retryMs: wait });
      timer = setTimeout(open, wait);
    };
  }
  open();
  return { close() { closed = true; clearTimeout(timer); ws?.close(); } };
}
