// W3 (spec-v2 §5): structure classes. structureKind() classifies an OSM building; applyStructures() restyles the
// columns W2 already stamped for it (build-sf calls it after stampBuildings, before finishDecks). Ballpark and
// arena geometry generators live here too; the landmark recipes (lib/landmarks.mjs) use them for Oracle Park and
// Chase Center.
import { BLOCK_M, CAP, FACADE, PALETTE_INDEX, STRUCTURE_KINDS, SURFACE } from "../../../public/shared/city.js";
import { pointInPolygon, scanPolygon } from "./geo.mjs";
import { landmarkKeys, loadLandmarks } from "./landmarks.mjs";
import { rasterIndex } from "./raster.mjs";

/** Entry ids applyStructures adds: STRUCTURE_ID_BASE + n. W2's own ids must stay below it. */
export const STRUCTURE_ID_BASE = 3_000_000_000;

const TRANSIT = new Set(["transportation", "train_station"]);
const TERMINAL = new Set(["terminal", "train_station", "transportation"]);
const PIER_NAME = /^pier \d+[a-z½]?$/i;
const SHED_BUILDINGS = new Set(["yes", "warehouse", "industrial", "commercial", "retail", "transportation", "office", "shed", "hangar"]);
const CHURCH_BUILDINGS = new Set(["church", "cathedral", "chapel"]);
/** Classes whose recipe is a landmark entry (landmarks.json), never a generic restyle. */
export const LANDMARK_ONLY_KINDS = Object.freeze(["ballpark", "terminal_tower"]);
/** Classes that must never keep facade 0 (window atlas). */
export const NO_WINDOW_KINDS = Object.freeze(["ballpark", "arena", "conference"]);

/**
 * OSM tags (+ the DataSF record under the footprint, or null) → one of STRUCTURE_KINDS, or null for an ordinary
 * building. W2 calls it per OSM record while loading (ctx.osm[].structure).
 * @param {Record<string, string>} tags
 * @param {import("./ctx.mjs").DatasfBuilding | null} ds
 * @returns {string | null}
 */
export function structureKind(tags, ds) {
  if (!tags || typeof tags !== "object") throw new Error("structureKind: tags must be an object");
  if (ds !== null && (typeof ds !== "object" || !Number.isFinite(ds.maxM) || !Number.isFinite(ds.heightM))) {
    throw new Error("structureKind: ds must be a DataSF record (maxM, heightM) or null");
  }
  const b = tags.building ?? tags["building:part"] ?? "";
  const { leisure = "", amenity = "", sport = "", name = "" } = tags;
  const stadium = b === "stadium" || leisure === "stadium";
  if (b === "roof") return "canopy";
  if (stadium && /(^|;)baseball(;|$)/.test(sport)) return "ballpark";
  if (stadium || b === "arena" || (leisure === "sports_centre" && b === "arena")) return "arena";
  if (amenity === "conference_centre" || b === "conference_centre") return "conference";
  if (TRANSIT.has(b) && (tags["roof:garden"] === "yes" || /transit cent(er|re)/i.test(name))) return "transit_roofpark";
  if ((TERMINAL.has(b) || amenity === "ferry_terminal") && ds && ds.maxM - ds.heightM > 30) return "terminal_tower";
  if (tags.man_made === "pier" || (PIER_NAME.test(name.trim()) && SHED_BUILDINGS.has(b))) return "pier_shed";
  if (CHURCH_BUILDINGS.has(b) || amenity === "place_of_worship") return "church";
  if (b === "parking" || (amenity === "parking" && /^multi[-_]?storey$/.test(tags.parking ?? ""))) return "parking_garage";
  return null;
}

// ---------- geometry helpers (block space) ----------

export const columnKey = (x, z) => `${x},${z}`;

/** Columns (centre inside) of a polygon list. → [x, z][] */
export function polygonColumns(polygons) {
  const out = [];
  const seen = new Set();
  for (const poly of polygons) {
    scanPolygon(poly, (x, z) => {
      const k = columnKey(x, z);
      if (!seen.has(k)) { seen.add(k); out.push([x, z]); }
    });
  }
  return out;
}

/** Principal (long) axis of a set of columns: unit [ux, uz] and the extents along it and across it. */
export function principalAxis(cols) {
  if (cols.length === 0) throw new Error("principalAxis: no columns");
  let mx = 0, mz = 0;
  for (const [x, z] of cols) { mx += x + 0.5; mz += z + 0.5; }
  mx /= cols.length; mz /= cols.length;
  let sxx = 0, szz = 0, sxz = 0;
  for (const [x, z] of cols) {
    const dx = x + 0.5 - mx, dz = z + 0.5 - mz;
    sxx += dx * dx; szz += dz * dz; sxz += dx * dz;
  }
  const a = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const ux = Math.cos(a), uz = Math.sin(a);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [x, z] of cols) {
    const dx = x + 0.5 - mx, dz = z + 0.5 - mz;
    const u = dx * ux + dz * uz, v = -dx * uz + dz * ux;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  return { cx: mx, cz: mz, ux, uz, u0, u1, v0, v1 };
}

function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz;
  const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2));
  return Math.hypot(px - ax - t * dx, pz - az - t * dz);
}
/** Distance from a point to a ring's edges. */
export function ringDistance(px, pz, ring) {
  let d = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) d = Math.min(d, segDist(px, pz, ring[j][0], ring[j][1], ring[i][0], ring[i][1]));
  return d;
}
function ringCentroid(ring) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f; cx += (ring[j][0] + ring[i][0]) * f; cz += (ring[j][1] + ring[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) throw new Error("ringCentroid: degenerate ring");
  return [cx / (3 * a), cz / (3 * a)];
}

// ---------- arena ----------

/** Chase Center drum (spec-v2 §5 row 19): column top above base at distance r from the centre of a drum of radius R. */
export function arenaTop(r, R, wall, rise) {
  if (!(R > 0)) throw new Error(`arenaTop: R must be > 0, got ${R}`);
  const t = Math.min(1, r / R);
  return wall + Math.round(rise * (1 - t * t));
}

// ---------- ballpark ----------

/**
 * Ballpark geometry (spec-v2 §5, Oracle Park). Polygons are block-space rings (outline = whole stadium,
 * field = playing field, infield = dirt infield). → {home: [hx, hz] unit vector, field: Map key→surface,
 * stands: Map key→top (relative), scoreboard: Map key→top, lights: [x, z][], outline: [x, z][]}
 */
export function ballparkLayout({ outline, field, infield }, { hmax, outfieldMin, lights, scoreboard }) {
  for (const [k, v] of Object.entries({ hmax, outfieldMin })) if (!Number.isInteger(v) || v < 1) throw new Error(`ballpark: ${k} must be an integer ≥ 1`);
  if (outfieldMin > hmax) throw new Error("ballpark: outfieldMin above hmax");
  const [fx, fz] = ringCentroid(field);
  const [ix, iz] = ringCentroid(infield);
  const hl = Math.hypot(ix - fx, iz - fz);
  if (hl < 1) throw new Error("ballpark: infield centroid coincides with the field centroid; cannot orient home plate");
  const hx = (ix - fx) / hl, hz = (iz - fz) / hl;
  const angleOf = (x, z) => {
    const dx = x - fx, dz = z - fz, L = Math.hypot(dx, dz) || 1;
    return (Math.acos(Math.max(-1, Math.min(1, (dx * hx + dz * hz) / L))) * 180) / Math.PI;
  };
  const hmaxAt = (ang) => (ang <= 110 ? hmax : Math.max(outfieldMin, Math.round(hmax - ((hmax - outfieldMin) * (ang - 110)) / 40)));
  const outlineCols = polygonColumns([[outline]]);
  const fieldMap = new Map();
  const stands = new Map();
  for (const [x, z] of outlineCols) {
    const px = x + 0.5, pz = z + 0.5;
    const k = columnKey(x, z);
    if (pointInPolygon(px, pz, [field])) {
      const track = ringDistance(px, pz, field) < 1.5;
      fieldMap.set(k, track || pointInPolygon(px, pz, [infield]) ? SURFACE.DIRT : SURFACE.GRASS);
    } else {
      const d = ringDistance(px, pz, field);
      stands.set(k, Math.min(hmaxAt(angleOf(px, pz)), 1 + Math.floor(0.6 * d)));
    }
  }
  const inOutline = (x, z) => pointInPolygon(x, z, [outline]);
  const march = (dx, dz, inside) => {
    let t = 0;
    while (inside(fx + dx * (t + 1), fz + dz * (t + 1))) {
      t++;
      if (t > 2000) throw new Error("ballpark: march did not leave the polygon");
    }
    return t;
  };
  // scoreboard: centre field, just behind the outfield fence
  const back = march(-hx, -hz, (x, z) => pointInPolygon(x, z, [field])) + 1 + scoreboard.d / 2;
  const sbx = fx - hx * back, sbz = fz - hz * back;
  const sb = new Map();
  for (const [x, z] of outlineCols) {
    const dx = x + 0.5 - sbx, dz = z + 0.5 - sbz;
    const along = dx * hx + dz * hz, across = -dx * hz + dz * hx;
    if (Math.abs(along) < scoreboard.d / 2 && Math.abs(across) < scoreboard.w / 2) sb.set(columnKey(x, z), scoreboard.y1);
  }
  if (sb.size === 0) throw new Error("ballpark: scoreboard falls outside the outline");
  for (const k of sb.keys()) stands.delete(k);
  // light towers on the outer stands ring, symmetric about the home direction
  const lightCols = [];
  for (const deg of lights.angles) {
    const a = (deg * Math.PI) / 180;
    const dx = hx * Math.cos(a) - hz * Math.sin(a), dz = hx * Math.sin(a) + hz * Math.cos(a);
    const t = march(dx, dz, inOutline) - 1;
    const x = Math.floor(fx + dx * t), z = Math.floor(fz + dz * t);
    if (!stands.has(columnKey(x, z))) throw new Error(`ballpark: light tower at ${deg}° (${x},${z}) is not on the stands`);
    lightCols.push([x, z]);
  }
  return { home: [hx, hz], centre: [fx, fz], field: fieldMap, stands, scoreboard: sb, lights: lightCols, outline: outlineCols };
}

// ---------- applyStructures ----------

const isWater = (s) => s === SURFACE.WATER || s === SURFACE.SHALLOW;

/** Columns W2 stamped for a record: inside its polygons and owned by a building. */
function stampedColumns(raster, rec) {
  const out = [];
  for (const [x, z] of polygonColumns(rec.polygons)) {
    const i = rasterIndex(raster, x, z);
    if (i >= 0 && raster.owner[i] >= 0) out.push([x, z, i]);
  }
  return out;
}

function datasfFor(ctx, rec) {
  const [cx, cz] = ringCentroid(rec.polygons[0][0]);
  const hits = ctx.datasf.filter((d) => d.polygons.some((p) => pointInPolygon(cx, cz, p)));
  return hits.length === 1 ? hits[0] : null;
}

/** Which end (+1 / −1 along u) of a footprint faces `want` (a predicate on the surface just past the end). */
function endScore(raster, axis, sign, want) {
  let n = 0;
  for (let s = 1; s <= 3; s++) {
    for (let v = Math.floor(axis.v0); v <= Math.ceil(axis.v1); v++) {
      const u = (sign > 0 ? axis.u1 : axis.u0) + sign * s;
      const x = Math.floor(axis.cx + u * axis.ux - v * axis.uz), z = Math.floor(axis.cz + u * axis.uz + v * axis.ux);
      const i = rasterIndex(raster, x, z);
      if (i >= 0 && want(raster.surface[i])) n++;
    }
  }
  return n;
}

function localUV(axis, x, z) {
  const dx = x + 0.5 - axis.cx, dz = z + 0.5 - axis.cz;
  return [dx * axis.ux + dz * axis.uz, -dx * axis.uz + dz * axis.ux];
}

/**
 * build-sf calls this after stampBuildings and before finishDecks. Writes through the raster API (setColumn,
 * clearBuilding, addEntry, addProp) and, for canopies, the raster's deck layer. Records whose key a landmark
 * covers (landmarks.json `covers` and site keys) are left to applyLandmarks. → the same raster
 * @param {object} raster
 * @param {object} ctx
 * @param {{skipKeys?: Set<string>}} [opts]
 */
export function applyStructures(raster, ctx, opts = {}) {
  const skip = opts.skipKeys ?? landmarkKeys(loadLandmarks());
  const report = ctx.report;
  const log = { restyled: {}, leftToLandmarks: [], notStamped: [], parents: {} };
  report.structures = log;
  report.parents ??= {};
  let nextId = STRUCTURE_ID_BASE;
  const take = () => {
    if (nextId >= STRUCTURE_ID_BASE + 900_000_000) throw new Error("applyStructures: structure id range exhausted");
    return nextId++;
  };
  for (const rec of ctx.osm) {
    const kind = rec.structure;
    if (kind === null) continue;
    if (!STRUCTURE_KINDS.includes(kind)) throw new Error(`applyStructures: ${rec.key} has unknown structure ${kind}`);
    if (skip.has(rec.key)) continue;
    if (LANDMARK_ONLY_KINDS.includes(kind)) {
      log.leftToLandmarks.push({ key: rec.key, kind });
      continue;
    }
    const cols = stampedColumns(raster, rec);
    if (cols.length === 0) {
      log.notStamped.push({ key: rec.key, kind });
      continue;
    }
    // a structure stamped over sloping ground (outline plus parts/parcels on different bases) restyles as one
    // entry on its lowest base; the higher columns keep their tops, so their ground under the building drops
    const base = Math.min(...cols.map(([, , i]) => raster.ground[i]));
    const maxBase = Math.max(...cols.map(([, , i]) => raster.ground[i]));
    if (maxBase !== base) (log.mixedBases ??= []).push({ key: rec.key, kind, base, maxBase });
    const tops = cols.map(([, , i]) => raster.top[i]);
    const top = Math.max(...tops);
    const H = top - base;
    const old = raster.entries[raster.owner[cols[0][2]]];
    const name = rec.tags.name ?? rec.key;
    const restyle = (style, colTop) => {
      const id = take();
      const ts = cols.map(([x, z]) => colTop(x, z));
      raster.addEntry({ id, base, top: base + Math.max(...ts), palette: style.palette ?? old.palette, accent: style.accent ?? style.palette ?? old.accent, cap: style.cap ?? CAP.FLAT, facade: style.facade ?? FACADE.WINDOWS, parent: style.parent ?? 0 });
      cols.forEach(([x, z], k) => raster.setColumn(x, z, { bldg: id, base, top: base + ts[k] }));
      return id;
    };
    const keep = (x, z) => raster.top[rasterIndex(raster, x, z)] - base;
    switch (kind) {
      case "arena": {
        const ax = principalAxis(cols);
        const R = Math.max(ax.u1 - ax.u0, ax.v1 - ax.v0) / 2;
        const rise = Math.max(1, Math.round(H * 0.23));
        restyle({ facade: FACADE.RIBBED, accent: PALETTE_INDEX.chase }, (x, z) => arenaTop(Math.hypot(x + 0.5 - ax.cx, z + 0.5 - ax.cz), R, Math.max(1, H - rise), rise));
        break;
      }
      case "conference": {
        const green = cols.filter(([, , i]) => raster.surface[i] === SURFACE.PARK || raster.surface[i] === SURFACE.GRASS);
        if (green.length > 0 && green.length < cols.length) {
          const parent = take();
          log.parents[parent] = name;
          report.parents[parent] = name;
          const greenSet = new Set(green.map(([x, z]) => columnKey(x, z)));
          const plain = cols.filter(([x, z]) => !greenSet.has(columnKey(x, z)));
          for (const [set, style] of [[plain, { facade: FACADE.CURTAIN, parent }], [green, { facade: FACADE.CURTAIN, cap: CAP.GREEN, accent: PALETTE_INDEX["pastel-green"], parent }]]) {
            const id = take();
            const t = Math.max(...set.map(([, , i]) => raster.top[i]));
            raster.addEntry({ id, base, top: t, palette: old.palette, accent: style.accent ?? old.accent, cap: style.cap ?? CAP.FLAT, facade: style.facade, parent });
            for (const [x, z, i] of set) raster.setColumn(x, z, { bldg: id, base, top: raster.top[i] });
          }
        } else {
          restyle({ facade: FACADE.CURTAIN, cap: green.length ? CAP.GREEN : CAP.FLAT }, keep);
        }
        break;
      }
      case "pier_shed": {
        const ax = principalAxis(cols);
        const half = (ax.v1 - ax.v0) / 2;
        const ridge = Math.max(1, Math.round(half / 3));
        const eave = Math.max(1, H - ridge);
        const landEnd = endScore(raster, ax, 1, (s) => !isWater(s)) >= endScore(raster, ax, -1, (s) => !isWater(s)) ? 1 : -1;
        restyle({ palette: PALETTE_INDEX["concrete-warm"], accent: PALETTE_INDEX["concrete-warm"], facade: FACADE.RIBBED }, (x, z) => {
          const [u, v] = localUV(ax, x, z);
          const vm = (ax.v0 + ax.v1) / 2;
          const gable = eave + Math.round(ridge * (1 - Math.min(1, Math.abs(v - vm) / Math.max(half, 0.5))));
          const bulkhead = landEnd * u > (landEnd > 0 ? ax.u1 : -ax.u0) - 3 ? 2 : 0;
          return gable + bulkhead;
        });
        break;
      }
      case "church": {
        const ds = datasfFor(ctx, rec);
        if (!ds) {
          log.notStamped.push({ key: rec.key, kind, why: "no single DataSF footprint under the centroid for the tower height" });
          restyle({ facade: FACADE.BLANK }, keep);
          break;
        }
        const towerH = Math.max(H + 2, Math.round(ds.maxM / BLOCK_M));
        const ax = principalAxis(cols);
        const street = (s) => s === SURFACE.ROAD || s === SURFACE.SIDEWALK;
        const end = endScore(raster, ax, 1, street) >= endScore(raster, ax, -1, street) ? 1 : -1;
        const wantU = end > 0 ? ax.u1 - 1 : ax.u0 + 1, wantV = (ax.v0 + ax.v1) / 2;
        const [tu, tv] = cols.map(([x, z]) => localUV(ax, x, z)).sort((a, b) => Math.hypot(a[0] - wantU, a[1] - wantV) - Math.hypot(b[0] - wantU, b[1] - wantV))[0];
        restyle({ facade: FACADE.BLANK, cap: CAP.SPIRE, accent: PALETTE_INDEX.metal }, (x, z) => {
          const [u, v] = localUV(ax, x, z);
          const d = Math.max(Math.abs(u - tu), Math.abs(v - tv));
          if (d < 0.5) return towerH;
          if (d < 1.5) return Math.max(keep(x, z), towerH - 3);
          return keep(x, z);
        });
        break;
      }
      case "parking_garage":
        restyle({ palette: PALETTE_INDEX.concrete, accent: PALETTE_INDEX.concrete, facade: FACADE.PARKING }, keep);
        break;
      case "transit_roofpark":
        restyle({ palette: PALETTE_INDEX["transit-white"], accent: PALETTE_INDEX["pastel-green"], facade: FACADE.RIBBED, cap: CAP.GREEN }, () => 7);
        break;
      case "canopy": {
        const ax = principalAxis(cols);
        const corners = new Set();
        for (const su of [-1, 1]) for (const sv of [-1, 1]) {
          let best = null, bd = Infinity;
          for (const [x, z] of cols) {
            const [u, v] = localUV(ax, x, z);
            const d = -(su * u + sv * v);
            if (d < bd) { bd = d; best = columnKey(x, z); }
          }
          corners.add(best);
        }
        for (const [x, z, i] of cols) {
          const deckTop = raster.top[i];
          raster.clearBuilding(x, z);
          if (deckTop <= raster.ground[i]) throw new Error(`applyStructures: canopy ${rec.key} deck ${deckTop} not above ground at ${x},${z}`);
          raster.setDeck(x, z, deckTop, { pillar: corners.has(columnKey(x, z)) });
        }
        break;
      }
      default:
        throw new Error(`applyStructures: no recipe for ${kind}`);
    }
    log.restyled[kind] = (log.restyled[kind] ?? 0) + 1;
  }
  return raster;
}

