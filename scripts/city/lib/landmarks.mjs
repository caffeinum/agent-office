// W3 (spec-v2 §5): landmark recipes from scripts/city/sf/landmarks.json, compiled against the build projection and
// stamped into the raster (build-sf calls applyLandmarks last, before encode). Heights are generated: every site
// names a skyline.src.json row (heightRef) or a sourced realHeightM, and checks assert the recipe top against it.
//
// Local frame per site: centre (cx, cz) in blocks, u = the axis pointing as close as possible to compass bearing
// `toward`, v = u turned toward bearing toward+90. For an OSM key the centre and the axis come from the OSM
// polygon's minimum-area rectangle (so the recipe follows the real footprint under any rotation); for an lm: key
// they come from lat/lon and `toward`. Recipe y values are blocks above the site base (max ground under it).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BLOCK_M, CAP, FACADE, PALETTE_INDEX, SURFACE, blockToLonLat, lonLatToBlock } from "../../../public/shared/city.js";
import { pointInPolygon } from "./geo.mjs";
import { rasterIndex } from "./raster.mjs";
import { arenaTop, ballparkLayout, columnKey } from "./structures.mjs";

const SF_DIR = join(dirname(fileURLToPath(import.meta.url)), "../sf");
export const LANDMARKS_PATH = join(SF_DIR, "landmarks.json");
export const SKYLINE_PATH = join(SF_DIR, "skyline.src.json");
/** Entry ids: landmark i gets parent LANDMARK_ID_BASE + i·256 (virtual, in manifest.parents) and parts parent+1…. */
export const LANDMARK_ID_BASE = 4_000_000_000;
const PARTS_PER_LANDMARK = 255;

const CAP_BY_NAME = Object.fromEntries(Object.entries(CAP).map(([k, v]) => [k.toLowerCase(), v]));
const FACADE_BY_NAME = Object.fromEntries(Object.entries(FACADE).map(([k, v]) => [k.toLowerCase(), v]));
const SURFACE_BY_NAME = Object.fromEntries(Object.entries(SURFACE).map(([k, v]) => [k.toLowerCase(), v]));

// ---------- loading and validation ----------

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v, what) => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${what} must be a finite number, got ${JSON.stringify(v)}`);
  return v;
};
const int = (v, what, min = -Infinity) => {
  if (!Number.isInteger(v) || v < min) throw new Error(`${what} must be an integer ≥ ${min}, got ${JSON.stringify(v)}`);
  return v;
};
const palette = (name, what) => {
  if (!(name in PALETTE_INDEX)) throw new Error(`${what}: unknown palette colour ${JSON.stringify(name)}`);
  return PALETTE_INDEX[name];
};
const URL_RE = /^https:\/\/\S+$/;

/** skyline.src.json → {source, rows, byKey}; throws on any malformed row. */
export function loadSkyline(path = SKYLINE_PATH) {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  if (!isObj(doc.source) || !URL_RE.test(doc.source.url) || !Number.isInteger(doc.source.revid) || !/^\d{4}-\d{2}-\d{2}$/.test(doc.source.accessed)) {
    throw new Error("skyline.src.json: source needs url, revid and accessed (YYYY-MM-DD)");
  }
  if (!Array.isArray(doc.rows) || doc.rows.length < 50) throw new Error("skyline.src.json: needs at least 50 rows");
  const byKey = new Map();
  doc.rows.forEach((r, i) => {
    const what = `skyline row ${i}`;
    if (r.rank !== i + 1) throw new Error(`${what}: rank ${r.rank}, expected ${i + 1}`);
    if (typeof r.key !== "string" || !/^[a-z0-9-]+$/.test(r.key)) throw new Error(`${what}: bad key ${r.key}`);
    if (byKey.has(r.key)) throw new Error(`${what}: duplicate key ${r.key}`);
    num(r.lat, `${what}.lat`);
    num(r.lon, `${what}.lon`);
    if (r.lat < 37.70 || r.lat > 37.85 || r.lon < -122.53 || r.lon > -122.35) throw new Error(`${what}: ${r.lat},${r.lon} is outside San Francisco`);
    if (num(r.heightM, `${what}.heightM`) <= 0) throw new Error(`${what}: heightM must be > 0`);
    byKey.set(r.key, r);
  });
  return { source: doc.source, rows: doc.rows, byKey };
}

const OP_KEYS = {
  rect: ["w", "d", "at", "y1"], rrect: ["w", "d", "r", "at", "y1"], circle: ["d", "at", "y1"], oct: ["d", "at", "y1"],
  poly: ["ll", "y1"], chamfer: ["size"], sawtooth: ["faces", "step", "depth"], tier: ["y1", "inset", "chamfer"],
  taper: ["to", "y0", "y1"], spire: ["w", "y1", "at"], rim: ["width", "y1", "inset"], slope: ["axis", "y0", "y1"],
  part: ["name", "cap", "facade", "palette", "accent", "accentFrom"], prop: ["at", "y0", "y1", "color", "emissive"],
  field: ["surface"], arena: ["wall", "rise"], arc: ["centre", "r", "width", "from", "to", "y1"],
  ballpark: ["outline", "field", "infield", "hmax", "outfieldMin", "lights", "scoreboard", "stands", "scoreboardPalette", "sources", "leftField"],
  site: ["key", "name", "lat", "lon", "toward", "heightRef", "realHeightM", "source", "covers"],
  mesh: ["kind", "y0", "y1", "every", "inset", "palette", "emissive"],
};
/** crown_lattice: fins on the ring at `inset`; clock_faces: one face per side, the cells just outside the shape. */
export const MESH_KINDS = Object.freeze(["crown_lattice", "clock_faces"]);
const LANDMARK_KEYS = ["key", "name", "address", "lat", "lon", "toward", "heightRef", "realHeightM", "source", "palette", "accent", "covers", "note", "recipe", "bridge"];

function validateSiteRef(o, skyline, what) {
  const hasRef = o.heightRef !== undefined, hasReal = o.realHeightM !== undefined;
  if (hasRef === hasReal) throw new Error(`${what}: needs exactly one of heightRef or realHeightM`);
  if (hasRef && !skyline.byKey.has(o.heightRef)) throw new Error(`${what}: heightRef ${JSON.stringify(o.heightRef)} is not a skyline.src.json row key`);
  if (hasReal) {
    if (num(o.realHeightM, `${what}.realHeightM`) <= 0) throw new Error(`${what}: realHeightM must be > 0`);
    if (typeof o.source !== "string" || !URL_RE.test(o.source)) throw new Error(`${what}: realHeightM needs a source URL`);
  }
  if (!/^(o:[wr][1-9]\d*|lm:[a-z0-9-]+)$/.test(o.key)) throw new Error(`${what}: key must be an OSM id (o:w…/o:r…) or lm:<slug>, got ${o.key}`);
  num(o.lat, `${what}.lat`);
  num(o.lon, `${what}.lon`);
  num(o.toward, `${what}.toward`);
  if (o.covers !== undefined && (!Array.isArray(o.covers) || o.covers.some((k) => !/^o:[wr][1-9]\d*$/.test(k)))) throw new Error(`${what}: covers must be a list of OSM keys`);
}

function validateOp(op, what) {
  if (!isObj(op) || typeof op.op !== "string" || !(op.op in OP_KEYS)) throw new Error(`${what}: unknown op ${JSON.stringify(op?.op)}`);
  for (const k of Object.keys(op)) if (k !== "op" && !OP_KEYS[op.op].includes(k)) throw new Error(`${what} (${op.op}): unknown field "${k}"`);
  if (op.at !== undefined && (!Array.isArray(op.at) || op.at.length !== 2)) throw new Error(`${what}: at must be [u, v]`);
  if (op.y1 !== undefined) int(op.y1, `${what}.y1`, 1);
  if (op.op === "part") {
    if (typeof op.name !== "string" || !op.name) throw new Error(`${what}: part needs a name`);
    if (op.cap !== undefined && !(op.cap in CAP_BY_NAME)) throw new Error(`${what}: unknown cap ${op.cap}`);
    if (op.facade !== undefined && !(op.facade in FACADE_BY_NAME)) throw new Error(`${what}: unknown facade ${op.facade}`);
    if (op.palette !== undefined) palette(op.palette, what);
    if (op.accent !== undefined) palette(op.accent, what);
    if (op.accentFrom !== undefined) int(op.accentFrom, `${what}.accentFrom`, 1);
  }
  if (op.op === "prop") palette(op.color, what);
  if (op.op === "field" && !(op.surface in SURFACE_BY_NAME)) throw new Error(`${what}: unknown surface ${op.surface}`);
  if (op.op === "mesh" && !MESH_KINDS.includes(op.kind)) throw new Error(`${what}: unknown mesh kind ${op.kind}`);
}

const BRIDGE_KEYS = ["palette", "points", "decks", "deckWidth", "towerLegs", "crossBeams", "cableSag", "suspenderEvery", "anchorSize"];
/** approach: where the deck lands on the shore; the deck descends from the anchor to the ground there. */
const POINT_KINDS = ["approach", "anchor", "tower", "end"];
function validateBridge(b, what) {
  if (!isObj(b)) throw new Error(`${what}: must be an object`);
  for (const k of Object.keys(b)) if (!BRIDGE_KEYS.includes(k)) throw new Error(`${what}: unknown field "${k}"`);
  for (const k of BRIDGE_KEYS) if (!(k in b)) throw new Error(`${what}: missing "${k}"`);
  palette(b.palette, what);
  if (!Array.isArray(b.points) || b.points.length < 2) throw new Error(`${what}.points: needs ≥ 2 points`);
  b.points.forEach((p, i) => {
    const pw = `${what}.points[${i}]`;
    for (const k of Object.keys(p)) if (!["ref", "source", "lat", "lon", "kind", "anchorTop"].includes(k)) throw new Error(`${pw}: unknown field "${k}"`);
    num(p.lat, `${pw}.lat`);
    num(p.lon, `${pw}.lon`);
    if (!POINT_KINDS.includes(p.kind)) throw new Error(`${pw}: kind must be one of ${POINT_KINDS.join(", ")}`);
    if (typeof p.source !== "string" || !URL_RE.test(p.source)) throw new Error(`${pw}: needs a source URL`);
    if (p.anchorTop !== undefined && (num(p.anchorTop.heightM, `${pw}.anchorTop.heightM`) <= 0 || !URL_RE.test(p.anchorTop.source ?? ""))) throw new Error(`${pw}.anchorTop needs heightM > 0 and a source URL`);
  });
  if (!b.points.some((p) => p.kind === "tower")) throw new Error(`${what}: no tower point`);
  if (!Array.isArray(b.decks) || b.decks.length === 0) throw new Error(`${what}.decks: needs ≥ 1 deck`);
  b.decks.forEach((d, i) => {
    if (num(d.clearanceM, `${what}.decks[${i}].clearanceM`) <= 0) throw new Error(`${what}.decks[${i}]: clearanceM must be > 0`);
    if (d.above !== undefined) int(d.above, `${what}.decks[${i}].above`, 0);
  });
  int(b.deckWidth, `${what}.deckWidth`, 2);
  int(b.towerLegs?.w, `${what}.towerLegs.w`, 1);
  int(b.towerLegs?.d, `${what}.towerLegs.d`, 1);
  if (!Array.isArray(b.crossBeams) || b.crossBeams.some((f) => !(f > 0 && f < 1))) throw new Error(`${what}.crossBeams: fractions in (0, 1)`);
  int(b.cableSag, `${what}.cableSag`, 1);
  int(b.suspenderEvery, `${what}.suspenderEvery`, 1);
  int(b.anchorSize, `${what}.anchorSize`, 1);
}

/** landmarks.json → validated list (with skyline rows resolved). */
export function loadLandmarks(path = LANDMARKS_PATH, skyline = loadSkyline()) {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(doc.landmarks)) throw new Error("landmarks.json: landmarks must be an array");
  const keys = new Set();
  doc.landmarks.forEach((lm, i) => {
    const what = `landmark[${i}] ${lm?.name}`;
    if (!isObj(lm)) throw new Error(`${what}: not an object`);
    for (const k of Object.keys(lm)) if (!LANDMARK_KEYS.includes(k)) throw new Error(`${what}: unknown field "${k}"`);
    if (typeof lm.name !== "string" || typeof lm.address !== "string") throw new Error(`${what}: needs name and address`);
    validateSiteRef(lm, skyline, what);
    palette(lm.palette, `${what}.palette`);
    palette(lm.accent, `${what}.accent`);
    if (lm.bridge !== undefined) {
      if (lm.recipe !== undefined) throw new Error(`${what}: a bridge has no chunk recipe`);
      validateBridge(lm.bridge, `${what}.bridge`);
    } else {
      if (!Array.isArray(lm.recipe) || lm.recipe.length === 0) throw new Error(`${what}: recipe must be a non-empty op list`);
      lm.recipe.forEach((op, k) => {
        validateOp(op, `${what} op ${k}`);
        if (op.op === "site") validateSiteRef(op, skyline, `${what} op ${k}`);
      });
    }
    for (const k of [lm.key, ...(lm.recipe ?? []).filter((o) => o.op === "site").map((o) => o.key)]) {
      if (keys.has(k)) throw new Error(`${what}: key ${k} used twice`);
      keys.add(k);
    }
  });
  return doc.landmarks;
}

/** Reference height (m) of a site: the skyline row's heightM or the sourced realHeightM. */
export function siteHeightM(site, skyline) {
  return site.heightRef !== undefined ? skyline.byKey.get(site.heightRef).heightM : site.realHeightM;
}

/** Every OSM key a landmark owns (site keys and covers): applyStructures leaves these alone. */
export function landmarkKeys(landmarks) {
  const out = new Set();
  for (const lm of landmarks) {
    for (const s of [lm, ...(lm.recipe ?? []).filter((o) => o.op === "site")]) {
      if (s.key.startsWith("o:")) out.add(s.key);
      for (const k of s.covers ?? []) out.add(k);
    }
  }
  return out;
}

// ---------- frames ----------

const unit = (x, z) => {
  const L = Math.hypot(x, z);
  if (L < 1e-9) throw new Error("zero-length direction");
  return [x / L, z / L];
};

/** Block-space unit vector of compass bearing `deg` at lon/lat. */
export function bearingVector(proj, lon, lat, deg) {
  const r = (deg * Math.PI) / 180, m = 30;
  const p0 = lonLatToBlock(lon, lat, proj);
  const p1 = lonLatToBlock(lon + (Math.sin(r) * m) / proj.mPerDegLon, lat + (Math.cos(r) * m) / proj.mPerDegLat, proj);
  return unit(p1.x - p0.x, p1.z - p0.z);
}

/** Compass bearing (0..360) of block-space direction [dx, dz] at block (x, z). */
export function vectorBearing(proj, x, z, [dx, dz]) {
  const a = blockToLonLat(x, z, proj), b = blockToLonLat(x + dx * 10, z + dz * 10, proj);
  const e = (b.lon - a.lon) * proj.mPerDegLon, n = (b.lat - a.lat) * proj.mPerDegLat;
  return ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360;
}

function hull(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** Minimum-area bounding rectangle of polygons' outer rings → {cx, cz, ux, uz, a (extent along u), b}. */
export function minAreaRect(polygons) {
  const h = hull(polygons.flatMap((p) => p[0]));
  if (h.length < 3) throw new Error("minAreaRect: degenerate polygon");
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const [ax, az] = h[i], [bx, bz] = h[(i + 1) % h.length];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-9) continue;
    const ux = (bx - ax) / L, uz = (bz - az) / L;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, z] of h) {
      const u = x * ux + z * uz, v = -x * uz + z * ux;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area - 1e-9) {
      const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
      best = { area, ux, uz, a: u1 - u0, b: v1 - v0, cx: cu * ux - cv * uz, cz: cu * uz + cv * ux };
    }
  }
  return best;
}

const angDiff = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

/**
 * Frame of a site. OSM key: the record in ctx.osm (throws when missing); the axis is the min-rect direction
 * (of four) whose bearing is closest to `toward`. lm: key: lat/lon and `toward`.
 * → {cx, cz, u: [ux, uz], v: [vx, vz], rect?: {a, b} (OSM extents along u and v)}
 */
export function siteFrame(site, ctx) {
  const { proj } = ctx;
  if (site.key.startsWith("lm:")) {
    const c = lonLatToBlock(site.lon, site.lat, proj);
    return { cx: c.x, cz: c.z, u: bearingVector(proj, site.lon, site.lat, site.toward), v: bearingVector(proj, site.lon, site.lat, site.toward + 90) };
  }
  const rec = ctx.osm.find((r) => r.key === site.key);
  if (!rec) throw new Error(`landmark ${site.name ?? site.key}: OSM record ${site.key} is not in ctx.osm`);
  const m = minAreaRect(rec.polygons);
  const cands = [[m.ux, m.uz, m.a, m.b], [-m.ux, -m.uz, m.a, m.b], [-m.uz, m.ux, m.b, m.a], [m.uz, -m.ux, m.b, m.a]];
  const scored = cands.map((c) => ({ c, d: angDiff(vectorBearing(proj, m.cx, m.cz, [c[0], c[1]]), site.toward) })).sort((a, b) => a.d - b.d);
  const [ux, uz, a, b] = scored[0].c;
  const vA = [-uz, ux], vB = [uz, -ux];
  const v = angDiff(vectorBearing(proj, m.cx, m.cz, vA), site.toward + 90) <= angDiff(vectorBearing(proj, m.cx, m.cz, vB), site.toward + 90) ? vA : vB;
  return { cx: m.cx, cz: m.cz, u: [ux, uz], v, rect: { a, b } };
}

// ---------- shapes ----------

/** A footprint: contains(col, inset) on a column {x, z, u, v}; bbox in block space. */
function makeShape(op, frame, proj) {
  const [u0, v0] = op.at ?? [0, 0];
  const toAbs = (u, v) => [frame.cx + u * frame.u[0] + v * frame.v[0], frame.cz + u * frame.u[1] + v * frame.v[1]];
  const localBox = (hu, hv) => {
    const pts = [[-hu, -hv], [hu, -hv], [hu, hv], [-hu, hv]].map(([a, b]) => toAbs(u0 + a, v0 + b));
    return { minX: Math.min(...pts.map((p) => p[0])), maxX: Math.max(...pts.map((p) => p[0])), minZ: Math.min(...pts.map((p) => p[1])), maxZ: Math.max(...pts.map((p) => p[1])) };
  };
  switch (op.op) {
    case "rect":
    case "rrect":
    case "spire": {
      const w = num(op.w, "rect.w"), d = op.op === "spire" ? op.w : num(op.d, "rect.d");
      const r = op.op === "rrect" ? num(op.r, "rrect.r") : 0;
      return {
        kind: "rect", w, d, u0, v0, bbox: localBox(w / 2, d / 2),
        contains(c, inset = 0) {
          const hu = w / 2 - inset, hv = d / 2 - inset;
          const du = Math.abs(c.u - u0), dv = Math.abs(c.v - v0);
          if (du >= hu || dv >= hv) return false;
          const rr = Math.max(0, r - inset);
          if (rr > 0 && du > hu - rr && dv > hv - rr) return Math.hypot(du - (hu - rr), dv - (hv - rr)) < rr;
          return true;
        },
      };
    }
    case "circle":
    case "oct": {
      const R = num(op.d, `${op.op}.d`) / 2;
      return {
        kind: op.op, w: 2 * R, d: 2 * R, u0, v0, bbox: localBox(R, R),
        contains(c, inset = 0) {
          const a = R - inset, du = Math.abs(c.u - u0), dv = Math.abs(c.v - v0);
          if (op.op === "circle") return Math.hypot(du, dv) < a;
          return du < a && dv < a && du + dv < a * Math.SQRT2;
        },
      };
    }
    case "arc": {
      const [cu, cv] = op.centre, r = num(op.r, "arc.r"), hw = num(op.width, "arc.width") / 2;
      const from = num(op.from, "arc.from"), to = num(op.to, "arc.to");
      return {
        kind: "arc", u0: cu, v0: cv, bbox: (() => { const b = localBox(r + hw, r + hw); const [ax, az] = toAbs(cu, cv); const [bx, bz] = toAbs(0, 0); return { minX: b.minX + ax - bx, maxX: b.maxX + ax - bx, minZ: b.minZ + az - bz, maxZ: b.maxZ + az - bz }; })(),
        contains(c) {
          const du = c.u - cu, dv = c.v - cv;
          if (Math.abs(Math.hypot(du, dv) - r) >= hw) return false;
          const a = ((Math.atan2(dv, du) * 180) / Math.PI + 360) % 360;
          return from <= to ? a >= from && a <= to : a >= from || a <= to;
        },
      };
    }
    case "poly": {
      if (!Array.isArray(op.ll) || op.ll.length < 3) throw new Error("poly.ll must list ≥ 3 [lat, lon] points");
      const ring = op.ll.map(([lat, lon]) => { const b = lonLatToBlock(lon, lat, proj); return [b.x, b.z]; });
      const xs = ring.map((p) => p[0]), zs = ring.map((p) => p[1]);
      return {
        kind: "poly", ring, bbox: { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) },
        contains(c, inset = 0) {
          if (inset !== 0) throw new Error("poly footprints take no inset");
          return pointInPolygon(c.x + 0.5, c.z + 0.5, [ring]);
        },
      };
    }
    default:
      throw new Error(`makeShape: ${op.op} is not a footprint`);
  }
}

/** Wrap a rect-like shape with a chamfer or sawtooth modifier (applies to every later write). */
function modify(shape, op) {
  if (shape.kind !== "rect") throw new Error(`${op.op} needs a rect/rrect footprint, have ${shape.kind}`);
  const base = shape.contains;
  if (op.op === "chamfer") {
    const size = num(op.size, "chamfer.size");
    return { ...shape, contains: (c, inset = 0) => base(c, inset) && chamferOk(shape, c, inset, size) };
  }
  const step = int(op.step, "sawtooth.step", 1), depth = int(op.depth, "sawtooth.depth", 1);
  const longAlongU = shape.w >= shape.d;
  const faces = op.faces;
  if (!["long", "short", "all"].includes(faces)) throw new Error(`sawtooth.faces must be long, short or all, got ${faces}`);
  return {
    ...shape,
    contains(c, inset = 0) {
      if (!base(c, inset)) return false;
      const du = Math.abs(c.u - shape.u0), dv = Math.abs(c.v - shape.v0);
      const hu = shape.w / 2 - inset, hv = shape.d / 2 - inset;
      const cut = (alongFaceCoord, distToFace) => distToFace < depth && Math.floor((alongFaceCoord + 1000) / step) % 2 === 1;
      const onU = faces === "all" || (faces === "long") === longAlongU; // faces normal to v (running along u)
      const onV = faces === "all" || (faces === "long") !== longAlongU;
      if (onU && cut(c.u - shape.u0, hv - dv)) return false;
      if (onV && cut(c.v - shape.v0, hu - du)) return false;
      return true;
    },
  };
}
function chamferOk(shape, c, inset, size) {
  const du = Math.abs(c.u - shape.u0), dv = Math.abs(c.v - shape.v0);
  return shape.w / 2 - inset - du + (shape.d / 2 - inset - dv) >= size;
}

// ---------- compile ----------

/**
 * The Coke bottle and the glove on the left-centre stands: a 2×2 red bottle (neck 1×1) and a 3×2 brown glove,
 * `angle` degrees left of straight-away centre field, on the stands just past the field. → props (y relative)
 */
function leftFieldProps(lay, { angle }) {
  num(angle, "ballpark.leftField.angle");
  const [hx, hz] = lay.home, [fx, fz] = lay.centre;
  const dx = -hx, dz = -hz, lx = dz, lz = -dx;
  const a = (angle * Math.PI) / 180;
  const ux = dx * Math.cos(a) + lx * Math.sin(a), uz = dz * Math.cos(a) + lz * Math.sin(a);
  const standAt = (t) => lay.stands.get(columnKey(Math.floor(fx + ux * t), Math.floor(fz + uz * t)));
  let t = 1;
  while (standAt(t) === undefined) { if (++t > 400) throw new Error("ballpark.leftField: no stands along the left-centre ray"); }
  t += 3;
  const top = (x, z) => {
    const h = lay.stands.get(columnKey(x, z));
    if (h === undefined) throw new Error(`ballpark.leftField: prop column ${x},${z} is not on the stands`);
    return h;
  };
  const out = [];
  const bx = Math.floor(fx + ux * t), bz = Math.floor(fz + uz * t);
  const base = Math.max(...[[0, 0], [1, 0], [0, 1], [1, 1]].map(([i, j]) => top(bx + i, bz + j)));
  for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]]) out.push({ x: bx + i, z: bz + j, y0: null, y1: base + 5, color: PALETTE_INDEX.coke, flags: 0 });
  out.push({ x: bx, z: bz, y0: base + 5, y1: base + 8, color: PALETTE_INDEX.coke, flags: 0 });
  // the glove: 5 blocks further along the stands to the left
  const gx = bx + 0.5 + lx * 5, gz = bz + 0.5 + lz * 5;
  const gcells = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
    const k = [Math.floor(gx + lx * i + ux * j), Math.floor(gz + lz * i + uz * j)];
    if (!gcells.some(([x, z]) => x === k[0] && z === k[1])) gcells.push(k);
  }
  const gbase = Math.max(...gcells.map(([x, z]) => top(x, z)));
  for (const [x, z] of gcells) out.push({ x, z, y0: null, y1: gbase + 3, color: PALETTE_INDEX.glove, flags: 0 });
  return out;
}

/**
 * Compile one landmark against ctx (proj, osm). Pure: no raster writes.
 * → {key, name, sites: [{site, frame, refTop, parts: [{name, cap, facade, palette, accent, accentFrom}],
 *    cols: Map key→{x, z, part, top}, field: Map key→surface, outline: Set key, props: [{x, z, y0|null, y1, color, flags}],
 *    mesh: [op]}]}
 */
export function compileLandmark(lm, ctx, skyline) {
  if (lm.bridge !== undefined) return { key: lm.key, name: lm.name, bridge: lm.bridge, sites: [] };
  const sites = [];
  let S = null;
  let shape = null;
  let part = -1;
  const openSite = (src) => {
    const frame = siteFrame({ ...src, name: src.name ?? lm.name }, ctx);
    S = { site: src, frame, refTop: Math.round(siteHeightM(src, skyline) / BLOCK_M), parts: [], cols: new Map(), field: new Map(), outline: new Set(), props: [], mesh: [] };
    sites.push(S);
    shape = null;
    part = -1;
  };
  const ensurePart = () => {
    if (part < 0) {
      S.parts.push({ name: "body", cap: CAP.FLAT, facade: FACADE.WINDOWS, palette: palette(lm.palette, lm.name), accent: palette(lm.accent, lm.name), accentFrom: null });
      part = S.parts.length - 1;
    }
  };
  const columnsOf = (sh) => {
    const out = [];
    const { minX, maxX, minZ, maxZ } = sh.bbox;
    for (let z = Math.floor(minZ) - 1; z <= Math.ceil(maxZ) + 1; z++) {
      for (let x = Math.floor(minX) - 1; x <= Math.ceil(maxX) + 1; x++) {
        const dx = x + 0.5 - S.frame.cx, dz = z + 0.5 - S.frame.cz;
        out.push({ x, z, u: dx * S.frame.u[0] + dz * S.frame.u[1], v: dx * S.frame.v[0] + dz * S.frame.v[1] });
      }
    }
    return out;
  };
  /** The cells just outside a shape at the middle of each of its four sides (frame u/v), up to 3 per side. */
  const faceCells = (sh) => {
    const all = columnsOf(sh);
    const inside = all.filter((c) => sh.contains(c, 0));
    if (!inside.length) return [];
    const mu = inside.reduce((s, c) => s + c.u, 0) / inside.length, mv = inside.reduce((s, c) => s + c.v, 0) / inside.length;
    const key = (c) => `${c.x},${c.z}`;
    const inSet = new Set(inside.map(key));
    const touches = (c) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => inSet.has(`${c.x + dx},${c.z + dz}`));
    return all.filter((c) => !inSet.has(key(c)) && touches(c)).filter((c) => Math.min(Math.abs(c.u - mu), Math.abs(c.v - mv)) <= 1.2).map((c) => [c.x, c.z]);
  };
  const write = (c, top) => {
    ensurePart();
    const k = columnKey(c.x, c.z);
    const cur = S.cols.get(k);
    if (!cur || cur.part !== part) S.cols.set(k, { x: c.x, z: c.z, part, top });
    else cur.top = Math.max(cur.top, top);
    S.field.delete(k);
  };
  const need = () => {
    if (!shape) throw new Error(`${lm.name}: op needs a footprint first`);
    return shape;
  };
  openSite(lm);
  for (const op of lm.recipe) {
    switch (op.op) {
      case "site":
        openSite(op);
        break;
      case "rect": case "rrect": case "circle": case "oct": case "poly": case "arc": {
        shape = makeShape(op, S.frame, ctx.proj);
        for (const c of columnsOf(shape)) if (shape.contains(c)) S.outline.add(columnKey(c.x, c.z));
        if (op.y1 !== undefined) for (const c of columnsOf(shape)) if (shape.contains(c)) write(c, op.y1);
        break;
      }
      case "chamfer": case "sawtooth":
        shape = modify(need(), op);
        break;
      case "tier": {
        const sh = need();
        const inset = op.inset ?? 0;
        for (const c of columnsOf(sh)) {
          if (!sh.contains(c, inset)) continue;
          if (op.chamfer !== undefined && !chamferOk(sh, c, inset, op.chamfer)) continue;
          write(c, op.y1);
        }
        break;
      }
      case "taper": {
        const sh = need();
        if (sh.kind !== "rect") throw new Error(`${lm.name}: taper needs a rect footprint`);
        const [w1, d1] = op.to;
        const y0 = int(op.y0, "taper.y0", 0), y1 = op.y1;
        for (const c of columnsOf(sh)) {
          if (!sh.contains(c)) continue;
          const du = 2 * Math.abs(c.u - sh.u0), dv = 2 * Math.abs(c.v - sh.v0);
          const tu = du < w1 ? 1 : (sh.w - du) / (sh.w - w1);
          const tv = dv < d1 ? 1 : (sh.d - dv) / (sh.d - d1);
          const t = Math.max(0, Math.min(1, tu, tv));
          const top = y0 + Math.floor(t * (y1 - y0) + 1e-9);
          if (top >= 1) write(c, top);
        }
        break;
      }
      case "spire": {
        const sh = makeShape(op, S.frame, ctx.proj);
        let n = 0;
        for (const c of columnsOf(sh)) if (sh.contains(c)) { write(c, op.y1); n++; }
        if (n === 0) {
          // a 1-wide spire between column centres: take the column nearest the spire axis
          const [u0, v0] = op.at ?? [0, 0];
          const best = columnsOf(sh).sort((a, b) => Math.hypot(a.u - u0, a.v - v0) - Math.hypot(b.u - u0, b.v - v0))[0];
          write(best, op.y1);
        }
        break;
      }
      case "rim": {
        const sh = need();
        const inset = op.inset ?? 0;
        for (const c of columnsOf(sh)) if (sh.contains(c, inset) && !sh.contains(c, inset + op.width)) write(c, op.y1);
        break;
      }
      case "slope": {
        const sh = need();
        if (sh.kind !== "rect") throw new Error(`${lm.name}: slope needs a rect footprint`);
        const half = op.axis === "u" ? sh.w / 2 : sh.d / 2;
        for (const c of columnsOf(sh)) {
          if (!sh.contains(c)) continue;
          const s = op.axis === "u" ? c.u - sh.u0 : c.v - sh.v0;
          const t = Math.max(0, Math.min(1, (s + half) / (2 * half)));
          write(c, op.y0 + Math.round(t * (op.y1 - op.y0)));
        }
        break;
      }
      case "part":
        S.parts.push({
          name: op.name, cap: CAP_BY_NAME[op.cap ?? "flat"], facade: FACADE_BY_NAME[op.facade ?? "windows"],
          palette: palette(op.palette ?? lm.palette, lm.name), accent: palette(op.accent ?? op.palette ?? lm.accent, lm.name), accentFrom: op.accentFrom ?? null,
        });
        part = S.parts.length - 1;
        break;
      case "prop": {
        const [u, v] = op.at;
        const x = Math.floor(S.frame.cx + u * S.frame.u[0] + v * S.frame.v[0]), z = Math.floor(S.frame.cz + u * S.frame.u[1] + v * S.frame.v[1]);
        S.props.push({ x, z, y0: op.y0 ?? null, y1: op.y1, color: palette(op.color, lm.name), flags: op.emissive ? 1 : 0 });
        break;
      }
      case "field": {
        const sh = need();
        for (const c of columnsOf(sh)) {
          if (!sh.contains(c)) continue;
          const k = columnKey(c.x, c.z);
          S.cols.delete(k);
          S.field.set(k, SURFACE_BY_NAME[op.surface]);
        }
        break;
      }
      case "arena": {
        const sh = need();
        if (sh.kind !== "circle") throw new Error(`${lm.name}: arena needs a circle footprint`);
        const R = sh.w / 2;
        for (const c of columnsOf(sh)) if (sh.contains(c)) write(c, arenaTop(Math.hypot(c.u - sh.u0, c.v - sh.v0), R, op.wall, op.rise));
        break;
      }
      case "ballpark": {
        const ring = (ll) => ll.map(([lat, lon]) => { const b = lonLatToBlock(lon, lat, ctx.proj); return [b.x, b.z]; });
        const lay = ballparkLayout(
          { outline: ring(op.outline), field: ring(op.field), infield: ring(op.infield) },
          { hmax: op.hmax, outfieldMin: op.outfieldMin, lights: op.lights, scoreboard: op.scoreboard },
        );
        for (const [x, z] of lay.outline) S.outline.add(columnKey(x, z));
        for (const [k, s] of lay.field) S.field.set(k, s);
        const addPart = (name, spec) => {
          S.parts.push({ name, cap: CAP_BY_NAME[spec.cap ?? "flat"], facade: FACADE_BY_NAME[spec.facade], palette: palette(spec.palette, lm.name), accent: palette(spec.accent ?? spec.palette, lm.name), accentFrom: null });
          return S.parts.length - 1;
        };
        const stands = addPart("stands", op.stands);
        for (const [k, t] of lay.stands) { const [x, z] = k.split(",").map(Number); S.cols.set(k, { x, z, part: stands, top: t }); }
        const sb = addPart("scoreboard", op.scoreboardPalette);
        for (const [k, t] of lay.scoreboard) { const [x, z] = k.split(",").map(Number); S.cols.set(k, { x, z, part: sb, top: t }); }
        // light towers: a dark steel mast with an emissive head
        for (const [x, z] of lay.lights) {
          S.props.push({ x, z, y0: null, y1: op.lights.y1 - 2, color: PALETTE_INDEX["steel-dark"], flags: 0 });
          S.props.push({ x, z, y0: op.lights.y1 - 2, y1: op.lights.y1, color: PALETTE_INDEX.light, flags: 1 });
        }
        if (op.leftField) for (const p of leftFieldProps(lay, op.leftField)) S.props.push(p);
        part = stands;
        S.ballpark = { home: lay.home, centre: lay.centre, standsPart: stands, hmax: op.hmax, outfieldMin: op.outfieldMin };
        break;
      }
      case "mesh": {
        const sh = need();
        const inset = op.inset ?? 0;
        const cells = op.kind === "clock_faces" ? faceCells(sh) : columnsOf(sh).filter((c) => sh.contains(c, inset) && !sh.contains(c, inset + 1)).map((c) => [c.x, c.z]);
        if (cells.length === 0) throw new Error(`${lm.name}: mesh ring is empty`);
        S.mesh.push({ ...op, cells, palette: palette(op.palette ?? lm.accent, lm.name) });
        break;
      }
      default:
        throw new Error(`${lm.name}: unhandled op ${op.op}`);
    }
  }
  for (const s of sites) {
    if (s.cols.size === 0 && s.field.size === 0) throw new Error(`${lm.name} (${s.site.key}): recipe writes no columns`);
    if (s.parts.length > PARTS_PER_LANDMARK) throw new Error(`${lm.name}: too many parts`);
  }
  return { key: lm.key, name: lm.name, sites };
}

/** Highest relative y a compiled site reaches: columns, props and mesh ops. */
export function siteTop(S) {
  let t = 0;
  for (const c of S.cols.values()) t = Math.max(t, c.top);
  for (const p of S.props) t = Math.max(t, p.y1);
  for (const m of S.mesh) t = Math.max(t, m.y1);
  return t;
}

// ---------- apply ----------

const isWater = (s) => s === SURFACE.WATER || s === SURFACE.SHALLOW;

/** Site base: the max ground (ctx.groundAt) under its outline and columns, at least 1. */
export function siteBase(S, ctx) {
  let g = 1;
  for (const k of new Set([...S.outline, ...S.cols.keys()])) {
    const [x, z] = k.split(",").map(Number);
    g = Math.max(g, ctx.groundAt(x, z));
  }
  return g;
}

/** {parentId: name} for every chunk-writing landmark (merge into manifest.parents). */
export function landmarkParents(landmarks = loadLandmarks()) {
  const out = {};
  landmarks.forEach((lm, i) => {
    if (lm.bridge === undefined) out[LANDMARK_ID_BASE + i * 256] = lm.name;
  });
  return out;
}

/**
 * build-sf calls this last, before encode. Every column a landmark's outline covers is cleared first, so the
 * landmark wins. Writes through the raster API only. Adds the landmark parents to ctx.report.parents (W2 merges
 * them into manifest.parents) and a summary to ctx.report.landmarks. → the same raster
 */
export function applyLandmarks(raster, ctx, landmarks = loadLandmarks(), skyline = loadSkyline()) {
  ctx.report.parents ??= {};
  const summary = [];
  landmarks.forEach((lm, i) => {
    if (lm.bridge !== undefined) return;
    const parent = LANDMARK_ID_BASE + i * 256;
    ctx.report.parents[parent] = lm.name;
    const compiled = compileLandmark(lm, ctx, skyline);
    let nextPart = parent + 1;
    for (const S of compiled.sites) {
      const base = siteBase(S, ctx);
      const at = (k) => {
        const [x, z] = k.split(",").map(Number);
        const idx = rasterIndex(raster, x, z);
        if (idx < 0) throw new Error(`${lm.name}: column ${x},${z} is outside the raster`);
        return [x, z, idx];
      };
      for (const k of S.outline) { const [x, z] = at(k); raster.clearBuilding(x, z); }
      const ids = S.parts.map(() => nextPart++);
      const partTop = S.parts.map(() => 0);
      for (const c of S.cols.values()) partTop[c.part] = Math.max(partTop[c.part], c.top);
      S.parts.forEach((p, k) => {
        if (partTop[k] === 0) return;
        raster.addEntry({
          id: ids[k], parent, base, top: base + partTop[k], palette: p.palette, accent: p.accent, cap: p.cap, facade: p.facade,
          ...(p.accentFrom !== null ? { accentFrom: base + p.accentFrom } : {}),
        });
      });
      let waterCols = 0;
      for (const [k, c] of S.cols) {
        const [x, z, idx] = at(k);
        if (isWater(raster.surface[idx])) { raster.setSurface(x, z, SURFACE.PIER); waterCols++; }
        raster.setColumn(x, z, { bldg: ids[c.part], base, top: base + c.top });
      }
      for (const [k, s] of S.field) {
        const [x, z, idx] = at(k);
        if (raster.ground[idx] < 1) throw new Error(`${lm.name}: field column ${x},${z} is on water (ground ${raster.ground[idx]})`);
        raster.setSurface(x, z, s);
      }
      for (const p of S.props) {
        const k = columnKey(p.x, p.z);
        const col = S.cols.get(k);
        const y0 = base + (p.y0 ?? col?.top ?? 0);
        raster.addProp(p.x, p.z, { y0, y1: base + p.y1, color: p.color, flags: p.flags });
      }
      summary.push({ key: S.site.key, name: S.site.name ?? lm.name, parent, base, top: base + siteTop(S), refTop: S.refTop, columns: S.cols.size, waterColumns: waterCols });
    }
  });
  ctx.report.landmarks = summary;
  return raster;
}
