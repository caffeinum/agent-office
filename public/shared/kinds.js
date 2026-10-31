// Custom voxel furniture kinds, seats & stations, and the office design summary. Shared by the Worker and
// the viewer (served as /shared/kinds.js). Plain ESM, no DOM, no dependencies beyond the catalog.
//
// Local model space: 16 units per grid cell. Origin = the footprint's min corner at rot 0, x along the
// footprint's w, z along its d, y up from the floor. A model's FRONT faces +z (like every built-in).
// Seats and stations use the same space; they may sit up to one cell outside the footprint (a station
// is usually where you stand IN FRONT of the thing).

import { footprint, GRID, KINDS, KIND_NAMES, kindOf, OfficeError, SPOOF_LINE_RE } from "./catalog.js";
import { describeTheme } from "./theme.js";

export const UNITS = 16;
export const CUSTOM_KINDS_MAX = 64;
export const BOXES_MAX = 512;
export const HEIGHT_MAX = 64;
export const FOOTPRINT_MAX = 8;
export const SEATS_MAX = 16;
export const STATIONS_MAX = 16;
export const LABEL_MAX = 40;
export const BOX_MATERIALS = Object.freeze(["matte", "glossy", "glass", "screen"]);
export const ACTIVITIES = Object.freeze(["coffee", "snack", "read", "play", "water-plants", "whiteboard", "chat", "think", "watch"]);
/** Seconds an agent spends at a station when the station doesn't say. */
export const ACTIVITY_DURATION = Object.freeze({ coffee: 25, snack: 20, read: 60, play: 45, "water-plants": 15, whiteboard: 40, chat: 45, think: 30, watch: 50 });
export const DURATION_MIN = 3;
export const DURATION_MAX = 600;
export const KIND_SLUG_RE = /^[a-z][a-z0-9-]{1,29}$/;
export const CUSTOM_LAYERS = Object.freeze(["object", "floor", "wall"]);
const ROTS = [0, 90, 180, 270];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const fail = (msg) => { throw new OfficeError(msg); };
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

function onlyKeys(obj, allowed, where) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(`${where} has unknown field "${k}" (allowed: ${allowed.join(", ")})`);
}

function int(v, min, max, where) {
  if (!Number.isInteger(v) || v < min || v > max) fail(`${where} must be an integer ${min}..${max}, got ${JSON.stringify(v)}`);
  return v;
}

function num(v, min, max, where) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) fail(`${where} must be a number ${min}..${max}, got ${JSON.stringify(v)}`);
  return v;
}

/** Validates one seat {x, z, rot, height} for a w×d footprint. Returns a normalised copy. */
export function validateSeat(s, w, d, where = "seat") {
  if (!isObj(s)) fail(`${where} must be {x, z, rot, height}`);
  onlyKeys(s, ["x", "z", "rot", "height"], where);
  if (!ROTS.includes(s.rot ?? 0)) fail(`${where}.rot must be 0, 90, 180 or 270 (the way the sitter faces at item rot 0; 0 = +z, the model's front)`);
  return {
    x: num(s.x, -UNITS, w * UNITS + UNITS, `${where}.x`),
    z: num(s.z, -UNITS, d * UNITS + UNITS, `${where}.z`),
    rot: s.rot ?? 0,
    height: num(s.height ?? 7, 0, HEIGHT_MAX, `${where}.height`),
  };
}

/** Validates one station {x, z, rot, activity, duration?}. Returns a normalised copy. */
export function validateStation(s, w, d, where = "station") {
  if (!isObj(s)) fail(`${where} must be {x, z, rot, activity, duration?}`);
  onlyKeys(s, ["x", "z", "rot", "activity", "duration"], where);
  if (!ROTS.includes(s.rot ?? 0)) fail(`${where}.rot must be 0, 90, 180 or 270 (the way the agent faces at item rot 0)`);
  if (!ACTIVITIES.includes(s.activity)) fail(`${where}.activity must be one of ${ACTIVITIES.join(", ")}, got ${JSON.stringify(s.activity)}`);
  const out = {
    x: num(s.x, -UNITS, w * UNITS + UNITS, `${where}.x`),
    z: num(s.z, -UNITS, d * UNITS + UNITS, `${where}.z`),
    rot: s.rot ?? 0,
    activity: s.activity,
  };
  if (s.duration !== undefined) out.duration = int(s.duration, DURATION_MIN, DURATION_MAX, `${where}.duration`);
  return out;
}

function validateBox(b, w, d, where) {
  if (!isObj(b)) fail(`${where} must be {x, y, z, w, h, d, color, emissive?, material?}`);
  onlyKeys(b, ["x", "y", "z", "w", "h", "d", "color", "emissive", "material"], where);
  const box = {
    x: int(b.x, 0, w * UNITS - 1, `${where}.x`),
    y: int(b.y, 0, HEIGHT_MAX - 1, `${where}.y`),
    z: int(b.z, 0, d * UNITS - 1, `${where}.z`),
    w: int(b.w, 1, w * UNITS, `${where}.w`),
    h: int(b.h, 1, HEIGHT_MAX, `${where}.h`),
    d: int(b.d, 1, d * UNITS, `${where}.d`),
    color: "",
  };
  if (box.x + box.w > w * UNITS) fail(`${where} sticks out of the footprint along x: x ${box.x} + w ${box.w} > ${w * UNITS} (${w} cells × ${UNITS})`);
  if (box.z + box.d > d * UNITS) fail(`${where} sticks out of the footprint along z: z ${box.z} + d ${box.d} > ${d * UNITS} (${d} cells × ${UNITS})`);
  if (box.y + box.h > HEIGHT_MAX) fail(`${where} is too tall: y ${box.y} + h ${box.h} > ${HEIGHT_MAX}`);
  if (typeof b.color !== "string" || !COLOR_RE.test(b.color)) fail(`${where}.color must be #rrggbb, got ${JSON.stringify(b.color)}`);
  box.color = b.color.toLowerCase();
  if (b.emissive !== undefined) {
    if (typeof b.emissive !== "boolean") fail(`${where}.emissive must be true or false`);
    if (b.emissive) box.emissive = true;
  }
  if (b.material !== undefined) {
    if (!BOX_MATERIALS.includes(b.material)) fail(`${where}.material must be one of ${BOX_MATERIALS.join(", ")}, got ${JSON.stringify(b.material)}`);
    if (b.material !== "matte") box.material = b.material;
  }
  return box;
}

/**
 * Validates a custom kind definition strictly and returns the normalised kind:
 * {kind, label, w, d, layer, boxes, seats, stations, textable, screen, custom: true}.
 * Input: {kind, label, footprint: {w, d}, boxes, layer?, seats?, stations?, textable?, screen?}.
 */
export function validateKindDef(def) {
  if (!isObj(def)) fail("kind definition is not an object");
  onlyKeys(def, ["kind", "label", "footprint", "layer", "boxes", "seats", "stations", "textable", "screen"], "kind definition");
  if (typeof def.kind !== "string" || !KIND_SLUG_RE.test(def.kind)) fail(`kind must be a slug: lowercase a-z0-9-, starts with a letter, 2-30 chars; got ${JSON.stringify(def.kind)}`);
  if (Object.hasOwn(KINDS, def.kind)) fail(`"${def.kind}" is a built-in kind and can't be redefined — pick another name (built-ins: ${KIND_NAMES.join(", ")})`);
  if (typeof def.label !== "string" || !def.label.trim() || def.label.length > LABEL_MAX) fail(`label must be a non-empty string ≤${LABEL_MAX} chars`);
  if (SPOOF_LINE_RE.test(def.label)) fail("label has control or bidi-override characters");
  if (!isObj(def.footprint)) fail("footprint must be {w, d} in grid cells");
  onlyKeys(def.footprint, ["w", "d"], "footprint");
  const w = int(def.footprint.w, 1, FOOTPRINT_MAX, "footprint.w");
  const d = int(def.footprint.d, 1, FOOTPRINT_MAX, "footprint.d");
  const layer = def.layer ?? "object";
  if (!CUSTOM_LAYERS.includes(layer)) fail(`layer must be one of ${CUSTOM_LAYERS.join(", ")}`);
  if (!Array.isArray(def.boxes) || def.boxes.length < 1) fail("boxes must be a non-empty array");
  if (def.boxes.length > BOXES_MAX) fail(`too many boxes: ${def.boxes.length}, max ${BOXES_MAX} per kind`);
  const boxes = def.boxes.map((b, i) => validateBox(b, w, d, `boxes[${i}]`));
  const seats = def.seats ?? [];
  const stations = def.stations ?? [];
  if (!Array.isArray(seats) || seats.length > SEATS_MAX) fail(`seats must be an array of ≤${SEATS_MAX}`);
  if (!Array.isArray(stations) || stations.length > STATIONS_MAX) fail(`stations must be an array of ≤${STATIONS_MAX}`);
  for (const key of ["textable", "screen"]) if (def[key] !== undefined && typeof def[key] !== "boolean") fail(`${key} must be true or false`);
  return {
    kind: def.kind,
    label: def.label.trim(),
    w,
    d,
    layer,
    boxes,
    seats: seats.map((s, i) => validateSeat(s, w, d, `seats[${i}]`)),
    stations: stations.map((s, i) => validateStation(s, w, d, `stations[${i}]`)),
    textable: def.textable === true,
    screen: def.screen === true,
    custom: true,
  };
}

/** Compact description of a kind for office_kinds: no boxes, just their count, height and main colours. */
export function summarizeKind(k) {
  const out = { label: k.label, w: k.w, d: k.d, layer: k.layer };
  if (k.custom) {
    const area = new Map();
    let height = 0;
    for (const b of k.boxes) {
      area.set(b.color, (area.get(b.color) ?? 0) + b.w * b.d + b.w * b.h + b.d * b.h);
      height = Math.max(height, b.y + b.h);
    }
    Object.assign(out, {
      custom: true,
      boxes: k.boxes.length,
      height,
      colors: [...area.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c]) => c),
    });
    if (k.by) out.by = k.by;
  }
  if (k.textable) out.textable = true;
  if (k.screen) out.screen = true;
  if (k.seat) out.seat = true;
  if (k.seats?.length) out.seats = k.seats;
  if (k.stations?.length) out.stations = k.stations;
  return out;
}

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * World positions of an item's seats and stations (cell units, like seatOf), yaw in radians (0 = facing +z).
 * Ids are stable: "<itemId>:s<i>" for seats, "<itemId>:t<i>" for stations.
 */
export function spotsOf(item, custom) {
  const kind = kindOf(item.kind, custom);
  if (!kind) fail(`unknown kind ${JSON.stringify(item.kind)}`);
  const f = footprint(item, custom);
  const cx = f.x + f.w / 2, cz = f.z + f.d / 2;
  const r = (item.rot * Math.PI) / 180;
  const place = (s) => {
    const ox = s.x / UNITS - kind.w / 2, oz = s.z / UNITS - kind.d / 2;
    return {
      x: round2(cx + ox * Math.cos(r) + oz * Math.sin(r)),
      z: round2(cz - ox * Math.sin(r) + oz * Math.cos(r)),
      yaw: round2(((item.rot + s.rot) % 360) * Math.PI / 180),
    };
  };
  return {
    seats: (kind.seats ?? []).map((s, i) => ({ id: `${item.id}:s${i}`, item: item.id, ...place(s), height: s.height / UNITS })),
    stations: (kind.stations ?? []).map((s, i) => ({
      id: `${item.id}:t${i}`,
      item: item.id,
      ...place(s),
      activity: s.activity,
      duration: s.duration ?? ACTIVITY_DURATION[s.activity],
    })),
  };
}

/** Cells blocked by object-layer furniture (floor rugs and wall items don't block walking). */
export function blockedCells(items, grid, custom) {
  const b = new Uint8Array(grid.w * grid.d);
  for (const it of items) {
    if (kindOf(it.kind, custom)?.layer !== "object") continue;
    const f = footprint(it, custom);
    for (let x = f.x; x < f.x + f.w; x++) for (let z = f.z; z < f.z + f.d; z++) {
      if (x >= 0 && z >= 0 && x < grid.w && z < grid.d) b[z * grid.w + x] = 1;
    }
  }
  return b;
}

/**
 * Can an agent use this spot? Off the floor never; a station also needs its cell free of furniture.
 * Seats sit on their own item, so only the floor bounds apply to them.
 */
export function spotReachable(spot, isSeat, blocked, grid) {
  if (spot.x < 0 || spot.z < 0 || spot.x >= grid.w || spot.z >= grid.d) return false;
  if (isSeat) return true;
  return !blocked[Math.floor(spot.z) * grid.w + Math.floor(spot.x)];
}

/** Every seat and station in the office. */
export function allSpots(items, custom) {
  const seats = [], stations = [];
  for (const it of items) {
    if (!kindOf(it.kind, custom)) continue;
    const s = spotsOf(it, custom);
    seats.push(...s.seats);
    stations.push(...s.stations);
  }
  return { seats, stations };
}

// ---------- design summary ----------

const ZONE_PRIORITY = ["work", "kitchen", "arcade", "lounge", "meeting", "library", "servers"];
const BUILTIN_TAG = { desk: "work", "coffee-machine": "kitchen", fridge: "kitchen", sofa: "lounge", beanbag: "lounge", tv: "lounge", table: "meeting", bookshelf: "library", "server-rack": "servers" };
const ACTIVITY_TAG = { coffee: "kitchen", snack: "kitchen", play: "arcade", read: "library", whiteboard: "meeting", chat: "meeting", think: "lounge", watch: "lounge", "water-plants": "decor" };

function tagOf(kindName, kind) {
  if (BUILTIN_TAG[kindName]) return BUILTIN_TAG[kindName];
  if (kind.custom) {
    const acts = (kind.stations ?? []).map((s) => ACTIVITY_TAG[s.activity]).filter(Boolean);
    if (acts.length) return acts.sort((a, b) => ZONE_PRIORITY.indexOf(a) - ZONE_PRIORITY.indexOf(b))[0];
    if (kind.seats?.length) return "lounge";
  }
  if (kind.seats?.length) return "seating";
  return "decor";
}

/** Functional tags of a cluster, most items first (ties by ZONE_PRIORITY); seating/decor only when nothing else. */
function rankTags(tagCounts) {
  const rank = (t) => (ZONE_PRIORITY.includes(t) ? ZONE_PRIORITY.indexOf(t) : ZONE_PRIORITY.length);
  const all = Object.entries(tagCounts).sort((a, b) => b[1] - a[1] || rank(a[0]) - rank(b[0])).map(([t]) => t);
  const functional = all.filter((t) => t !== "decor" && t !== "seating");
  return functional.length ? functional : all;
}

/** Largest axis-aligned free rectangle in a w×d occupancy grid (1 = blocked). */
function largestFree(blocked, w, d) {
  const heights = new Array(w).fill(0);
  let best = { x: 0, z: 0, w: 0, d: 0 };
  for (let z = 0; z < d; z++) {
    for (let x = 0; x < w; x++) heights[x] = blocked[z * w + x] ? 0 : heights[x] + 1;
    const stack = [];
    for (let x = 0; x <= w; x++) {
      const h = x < w ? heights[x] : 0;
      let start = x;
      while (stack.length && stack.at(-1)[1] >= h) {
        const [sx, sh] = stack.pop();
        if (sh * (x - sx) > best.w * best.d) best = { x: sx, z: z - sh + 1, w: x - sx, d: sh };
        start = sx;
      }
      stack.push([start, h]);
    }
  }
  return best;
}

/**
 * A compact, screenshot-free picture of the office for a designer agent: theme in one line, zones (clusters
 * of ≥2 object-layer pieces at most one empty cell apart, named by their dominant tag, with every tag in
 * `tags`), lone pieces under `scattered`, free floor (incl. the largest open rectangle), usable seat /
 * station counts, and the ids of spots nobody can reach (off the floor or under furniture) in `unreachable`.
 */
export function designSummary({ grid = GRID, items, theme, custom }) {
  const objects = [];
  for (const it of items) {
    const kind = kindOf(it.kind, custom);
    if (!kind || kind.layer !== "object") continue;
    objects.push({ it, kind, f: footprint(it, custom) });
  }
  const parent = objects.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  // same zone when at most one empty cell (a walkway) separates two pieces
  const near = (a, b) => a.x - 2 < b.x + b.w && a.x + a.w + 2 > b.x && a.z - 2 < b.z + b.d && a.z + a.d + 2 > b.z;
  for (let i = 0; i < objects.length; i++) for (let j = i + 1; j < objects.length; j++) {
    if (near(objects[i].f, objects[j].f)) parent[find(i)] = find(j);
  }
  const groups = new Map();
  objects.forEach((o, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(o);
  });

  const blocked = blockedCells(items, grid, custom);
  const zones = [];
  const scattered = {};
  for (const members of groups.values()) {
    if (members.length === 1) {
      const k = members[0].it.kind;
      scattered[k] = (scattered[k] ?? 0) + 1;
      continue;
    }
    const counts = {};
    let seats = 0, stations = 0;
    const tagCounts = {};
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const { it, kind, f } of members) {
      counts[it.kind] = (counts[it.kind] ?? 0) + 1;
      const s = spotsOf(it, custom);
      seats += s.seats.filter((p) => spotReachable(p, true, blocked, grid)).length;
      stations += s.stations.filter((p) => spotReachable(p, false, blocked, grid)).length;
      const tag = tagOf(it.kind, kind);
      tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
      x0 = Math.min(x0, f.x); z0 = Math.min(z0, f.z); x1 = Math.max(x1, f.x + f.w); z1 = Math.max(z1, f.z + f.d);
    }
    const tags = rankTags(tagCounts);
    zones.push({
      name: tags[0],
      tags,
      x: x0, z: z0, w: x1 - x0, d: z1 - z0,
      items: members.length,
      kinds: Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => (n > 1 ? `${k}×${n}` : k)).join(" "),
      seats,
      stations,
    });
  }
  zones.sort((a, b) => b.items - a.items || a.z - b.z || a.x - b.x);
  const seen = {};
  for (const z of zones) {
    seen[z.name] = (seen[z.name] ?? 0) + 1;
    if (seen[z.name] > 1) z.name = `${z.name}-${seen[z.name]}`;
  }

  const freeCells = blocked.reduce((n, b) => n + (b ? 0 : 1), 0);
  const spots = allSpots(items, custom);
  const seats = spots.seats.filter((p) => spotReachable(p, true, blocked, grid));
  const stations = spots.stations.filter((p) => spotReachable(p, false, blocked, grid));
  const unreachable = [
    ...spots.seats.filter((p) => !spotReachable(p, true, blocked, grid)),
    ...spots.stations.filter((p) => !spotReachable(p, false, blocked, grid)),
  ].map((p) => p.id);
  const byActivity = {};
  for (const s of stations) byActivity[s.activity] = (byActivity[s.activity] ?? 0) + 1;
  return {
    theme: theme ? describeTheme(theme) : undefined,
    grid: { w: grid.w, d: grid.d },
    zones,
    scattered: Object.entries(scattered).sort((a, b) => b[1] - a[1]).map(([k, n]) => (n > 1 ? `${k}×${n}` : k)).join(" "),
    freeFloor: { cells: freeCells, pct: Math.round((freeCells / (grid.w * grid.d)) * 100), largestOpen: largestFree(blocked, grid.w, grid.d) },
    seats: seats.length,
    stations: stations.length,
    stationsByActivity: byActivity,
    unreachable,
    wallItems: items.filter((it) => kindOf(it.kind, custom)?.layer === "wall").length,
    customKinds: custom ? Object.keys(custom).length : 0,
  };
}
