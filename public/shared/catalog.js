// The office floor plan as data: furniture kinds, the grid, the default office, and the pure
// validateItem / applyOp pair. Shared by the Worker (imports this file) and the browser viewer
// (served as /shared/catalog.js). Plain ESM, no DOM, no node APIs, no dependencies.
//
// Grid: integer cells, 1 cell = 1 world unit. Origin = the corner where the back wall (z = 0) meets the
// left wall (x = 0). An item's (x, z) is the min corner of its footprint; at rot 90/270 the footprint's
// w and d swap. rot is the y-rotation in degrees; every model's FRONT faces +z at rot 0.
// A desk's footprint includes its seat: desk top on the low-z row, seat on the +z row, sitter faces -z.
//
// Layers: footprints collide only within one layer, so a rug lies under desks and a window hangs above
// a fridge. Wall items hang on the back wall (rot 0, z 0) or the left wall (rot 90, x 0).

export const GRID = Object.freeze({ w: 24, d: 16 });
export const GRID_MIN = 8;
export const GRID_MAX = 48;
export const ROTS = Object.freeze([0, 90, 180, 270]);
export const TEXT_MAX = 280;
export const NAME_MAX = 32;
export const ACTIVITY_MAX = 120;
export const MAX_ITEMS = 400;
export const MAX_AGENTS = 64;
export const LAYERS = Object.freeze(["floor", "object", "wall"]);

const k = (w, d, label, layer, extra = {}) => Object.freeze({ w, d, label, layer, ...extra });

/** kind → footprint in cells at rot 0, label, layer, textable. */
export const KINDS = Object.freeze({
  desk: k(2, 2, "desk", "object", { seat: true }),
  chair: k(1, 1, "chair", "object"),
  plant: k(1, 1, "plant", "object"),
  sofa: k(3, 1, "sofa", "object"),
  lamp: k(1, 1, "floor lamp", "object"),
  bookshelf: k(2, 1, "bookshelf", "object"),
  rug: k(4, 6, "rug", "floor"),
  whiteboard: k(2, 1, "whiteboard", "wall", { textable: true }),
  sign: k(1, 1, "sign", "object", { textable: true }),
  fridge: k(1, 1, "fridge", "object"),
  "coffee-machine": k(1, 1, "coffee machine", "object"),
  table: k(2, 2, "table", "object"),
  tv: k(2, 1, "tv", "object"),
  window: k(2, 1, "window", "wall"),
  poster: k(1, 1, "poster", "wall", { textable: true }),
  "server-rack": k(1, 1, "server rack", "object"),
  beanbag: k(1, 1, "beanbag", "object"),
});

export const KIND_NAMES = Object.freeze(Object.keys(KINDS));

const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export class OfficeError extends Error {
  constructor(message) {
    super(message);
    this.name = "OfficeError";
  }
}

const fail = (msg) => { throw new OfficeError(msg); };

/** The kind's definition, or undefined — own keys only, so "constructor" or "__proto__" are never kinds. */
export function kindOf(kind) {
  return typeof kind === "string" && Object.hasOwn(KINDS, kind) ? KINDS[kind] : undefined;
}

/** The cells an item covers: {x, z, w, d}, w/d swapped at 90/270. */
export function footprint(item) {
  const kind = kindOf(item.kind);
  if (!kind) fail(`unknown kind ${JSON.stringify(item.kind)} (kinds: ${KIND_NAMES.join(", ")})`);
  const turned = item.rot === 90 || item.rot === 270;
  return { x: item.x, z: item.z, w: turned ? kind.d : kind.w, d: turned ? kind.w : kind.d };
}

export function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.z < b.z + b.d && a.z + a.d > b.z;
}

/** Throws OfficeError if `item` can't stand in an office of `grid` next to `others` (items without it). */
export function validateItem(item, others, grid = GRID) {
  if (!item || typeof item !== "object" || Array.isArray(item)) fail("item is not an object");
  if (typeof item.id !== "string" || !ID_RE.test(item.id)) fail(`bad item id ${JSON.stringify(item.id)} (lowercase a-z0-9-, starts with a letter, ≤40)`);
  const kind = kindOf(item.kind);
  if (!kind) fail(`unknown kind ${JSON.stringify(item.kind)} (kinds: ${KIND_NAMES.join(", ")})`);
  if (!Number.isInteger(item.x)) fail(`x must be an integer cell, got ${JSON.stringify(item.x)}`);
  if (!Number.isInteger(item.z)) fail(`z must be an integer cell, got ${JSON.stringify(item.z)}`);
  if (!ROTS.includes(item.rot)) fail(`bad rot ${JSON.stringify(item.rot)} (0, 90, 180 or 270)`);
  if (item.text !== undefined) {
    if (!kind.textable) fail(`${item.kind} has no text (textable kinds: ${textableKinds().join(", ")})`);
    if (typeof item.text !== "string") fail("text must be a string");
    if (item.text.length > TEXT_MAX) fail(`text is ${item.text.length} chars, max ${TEXT_MAX}`);
  }
  if (item.color !== undefined && (typeof item.color !== "string" || !COLOR_RE.test(item.color))) {
    fail(`bad color ${JSON.stringify(item.color)} (#rrggbb)`);
  }
  const f = footprint(item);
  if (f.x < 0 || f.z < 0 || f.x + f.w > grid.w || f.z + f.d > grid.d) {
    fail(`${item.kind} at x ${f.x}, z ${f.z} (${f.w}×${f.d}) is out of bounds; the floor is x 0..${grid.w - 1}, z 0..${grid.d - 1}`);
  }
  if (kind.layer === "wall") {
    const onBack = item.rot === 0 && item.z === 0;
    const onLeft = item.rot === 90 && item.x === 0;
    if (!onBack && !onLeft) fail(`${item.kind} hangs on a wall: rot 0 with z 0 (back wall) or rot 90 with x 0 (left wall)`);
  }
  for (const o of others) {
    if (o.id === item.id) fail(`duplicate item id "${item.id}"`);
    if (kindOf(o.kind)?.layer !== kind.layer) continue;
    if (overlaps(footprint(o), f)) fail(`${item.kind} at x ${f.x}, z ${f.z} overlaps ${o.kind} "${o.id}"`);
  }
  return item;
}

function textableKinds() {
  return KIND_NAMES.filter((n) => KINDS[n].textable);
}

export function nextId(items, kind) {
  const prefix = `${kind}-`;
  let max = 0;
  for (const it of items) {
    if (!it.id.startsWith(prefix)) continue;
    const n = Number(it.id.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${max + 1}`;
}

const OP_FIELDS = {
  add: ["kind", "x", "z", "rot", "text", "color"],
  remove: ["id"],
  move: ["id", "x", "z"],
  rotate: ["id", "rot"],
  text: ["id", "text"],
};
export const OPS = Object.freeze(Object.keys(OP_FIELDS));

function findItem(items, id) {
  if (typeof id !== "string" || !id) fail(`op needs an item id, got ${JSON.stringify(id)}`);
  const item = items.find((it) => it.id === id);
  if (!item) fail(`no item "${id}" (office_look lists items)`);
  return item;
}

/**
 * Pure: (items, op) → { items, item } (the added/changed item) or { items, removed } (the removed id).
 * op: {op:"add", kind, x, z, rot?, text?, color?} | {op:"remove", id} | {op:"move", id, x, z} |
 *     {op:"rotate", id, rot} | {op:"text", id, text}. Throws OfficeError with a clear message.
 */
export function applyOp(items, op, by, { grid = GRID, now = Date.now() } = {}) {
  if (typeof by !== "string" || !by) fail(`applyOp needs who made the change, got ${JSON.stringify(by)}`);
  if (!op || typeof op !== "object" || Array.isArray(op)) fail("op is not an object");
  const allowed = typeof op.op === "string" && Object.hasOwn(OP_FIELDS, op.op) ? OP_FIELDS[op.op] : undefined;
  if (!allowed) fail(`unknown op ${JSON.stringify(op.op)} (${OPS.join(", ")})`);
  for (const key of Object.keys(op)) if (key !== "op" && !allowed.includes(key)) fail(`op ${op.op} has unknown field "${key}"`);
  const stamp = { by, at: now };
  if (op.op === "add") {
    if (!kindOf(op.kind)) fail(`unknown kind ${JSON.stringify(op.kind)} (kinds: ${KIND_NAMES.join(", ")})`);
    if (items.length >= MAX_ITEMS) fail(`the office is full (${MAX_ITEMS} items); remove something first`);
    const item = { id: nextId(items, op.kind), kind: op.kind, x: op.x, z: op.z, rot: op.rot ?? 0 };
    if (op.text !== undefined) item.text = op.text;
    if (op.color !== undefined) item.color = op.color;
    Object.assign(item, stamp);
    validateItem(item, items, grid);
    return { items: [...items, item], item };
  }
  const cur = findItem(items, op.id);
  if (op.op === "remove") return { items: items.filter((it) => it.id !== op.id), removed: op.id };
  let next;
  if (op.op === "move") next = { ...cur, x: op.x, z: op.z, ...stamp };
  else if (op.op === "rotate") next = { ...cur, rot: op.rot, ...stamp };
  else next = { ...cur, text: op.text, ...stamp };
  validateItem(next, items.filter((it) => it.id !== cur.id), grid);
  return { items: items.map((it) => (it.id === cur.id ? next : it)), item: next };
}

/** Where a desk's sitter sits (world units, cell centres) and which way they face (yaw radians, 0 = +z). */
export function seatOf(desk) {
  const f = footprint(desk);
  const cx = f.x + f.w / 2, cz = f.z + f.d / 2;
  const r = (desk.rot * Math.PI) / 180;
  // local seat at (0, +0.5) from the footprint centre, sitter facing -z (towards the desk top)
  const lx = 0, lz = 0.5;
  return {
    x: cx + lx * Math.cos(r) + lz * Math.sin(r),
    z: cz - lx * Math.sin(r) + lz * Math.cos(r),
    yaw: r + Math.PI,
  };
}

/** A cosy starting office: kitchen, lounge, two facing rows of 4 desks on rugs, plants, shelves. */
export function defaultLayout(now = 0) {
  const items = [];
  const put = (kind, x, z, rot = 0, extra = {}) => {
    items.push({ id: nextId(items, kind), kind, x, z, rot, ...extra, by: "default", at: now });
  };
  put("window", 4, 0);
  put("window", 9, 0);
  put("window", 14, 0);
  put("poster", 19, 0, 0, { text: "ship small, ship often" });
  put("window", 0, 3, 90);
  put("whiteboard", 0, 9, 90, { text: "today:\n- be helpful\n- be kind" });
  put("poster", 0, 13, 90, { text: "be a polite office-mate" });

  put("fridge", 0, 0);
  put("coffee-machine", 1, 0);
  put("plant", 2, 0);
  put("table", 1, 2);
  put("chair", 3, 2, 90);
  put("chair", 3, 3, 90);

  put("rug", 6, 4);
  put("rug", 10, 4);
  for (const x of [6, 8, 10, 12]) {
    put("desk", x, 5, 180);
    put("desk", x, 7, 0);
  }

  put("rug", 17, 2, 90);
  put("sofa", 18, 2);
  put("table", 19, 3);
  put("beanbag", 22, 4);
  put("tv", 19, 6, 180);
  put("lamp", 17, 2);
  put("plant", 23, 0);

  put("bookshelf", 0, 6, 90);
  put("lamp", 4, 12);
  put("beanbag", 16, 12);
  put("server-rack", 22, 13);
  put("server-rack", 23, 13);
  put("sign", 11, 14, 0, { text: "agent office" });
  put("plant", 0, 15);
  put("plant", 23, 15);
  put("plant", 15, 9);

  const placed = [];
  for (const it of items) { validateItem(it, placed); placed.push(it); }
  return items;
}
