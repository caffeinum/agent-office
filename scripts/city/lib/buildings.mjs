// DataSF + OSM building merge (spec section 2, building rules 1-4) and the base/top rule.
// Building items are in block coordinates: {key, polygons: Polygon[], heightM, ...}.
import { pointInPolygon, polygonArea, polygonBounds, ringCentroid } from "./geo.mjs";

export const OSM_DEFAULT_HEIGHT_M = 9;
const HEIGHT_MARGIN_M = 6;
const FOOTPRINT_RATIO = 1.5;
const TOWER_M = 60;
const GRID = 64;

const areaOf = (b) => b.polygons.reduce((s, p) => s + polygonArea(p), 0);
const largest = (b) => b.polygons.reduce((best, p) => (polygonArea(p) > polygonArea(best) ? p : best), b.polygons[0]);
const centroidOf = (b) => ringCentroid(largest(b)[0]);
const contains = (b, [x, z]) => b.polygons.some((p) => pointInPolygon(x, z, p));
function boundsOf(b) {
  const bs = b.polygons.map(polygonBounds);
  return {
    minX: Math.min(...bs.map((q) => q.minX)), minZ: Math.min(...bs.map((q) => q.minZ)),
    maxX: Math.max(...bs.map((q) => q.maxX)), maxZ: Math.max(...bs.map((q) => q.maxZ)),
  };
}

function gridIndex(items) {
  const cells = new Map();
  items.forEach((it, i) => {
    const bb = boundsOf(it);
    for (let gz = Math.floor(bb.minZ / GRID); gz <= Math.floor(bb.maxZ / GRID); gz++) {
      for (let gx = Math.floor(bb.minX / GRID); gx <= Math.floor(bb.maxX / GRID); gx++) {
        const k = `${gx},${gz}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(i);
      }
    }
  });
  return (bb) => {
    const out = new Set();
    for (let gz = Math.floor(bb.minZ / GRID); gz <= Math.floor(bb.maxZ / GRID); gz++) {
      for (let gx = Math.floor(bb.minX / GRID); gx <= Math.floor(bb.maxX / GRID); gx++) {
        for (const i of cells.get(`${gx},${gz}`) ?? []) out.add(i);
      }
    }
    return out;
  };
}

const OVERRIDE_FIELDS = new Set(["heightM", "palette", "deckY"]);
function checkOverrides(overrides) {
  for (const [key, o] of Object.entries(overrides)) {
    if (!/^(d:\d+|o:[wr]\d+)$/.test(key)) throw new Error(`overrides.json: bad key ${key} (d:<area_id> | o:w<id> | o:r<id>)`);
    for (const f of Object.keys(o)) if (!OVERRIDE_FIELDS.has(f)) throw new Error(`overrides.json ${key}: unknown field ${f}`);
    if ("heightM" in o && !(o.heightM > 0)) throw new Error(`overrides.json ${key}: heightM must be > 0`);
    if ("palette" in o && !Number.isInteger(o.palette)) throw new Error(`overrides.json ${key}: palette must be an integer index`);
  }
}

/**
 * datasf = [{key:"d:<area_id>", polygons, heightM, peakM}], osm = [{key:"o:w<id>"|"o:r<id>", polygons, heightM|null}],
 * overrides = {key: {heightM?, palette?, deckY?}}. Ids are assigned sequentially after sorting by key.
 * → {buildings: [{id, key, polygons, heightM, palette?, peakM?, source}], report}
 */
export function mergeBuildings({ datasf, osm, overrides }) {
  checkOverrides(overrides);
  const ds = datasf.map((d) => ({ ...d, source: "datasf", area: areaOf(d), centroid: centroidOf(d), removed: false }));
  const candidates = gridIndex(ds);
  const added = [];
  const report = { datasf: ds.length, osm: osm.length, heightRaised: 0, footprintReplaced: [], osmAdded: 0, osmAddedDefaultHeight: 0, osmMatched: 0 };
  const osmMatches = new Map();
  for (const o of osm) {
    const oc = centroidOf(o);
    const matched = [...candidates(boundsOf(o))].filter((i) => !ds[i].removed && (contains(o, ds[i].centroid) || contains(ds[i], oc)));
    if (matched.length === 0) {
      added.push({ key: o.key, polygons: o.polygons, heightM: o.heightM ?? OSM_DEFAULT_HEIGHT_M, source: "osm" });
      report.osmAdded++;
      if (o.heightM === null) report.osmAddedDefaultHeight++;
      continue;
    }
    report.osmMatched++;
    osmMatches.set(o.key, matched);
    if (o.heightM === null) continue;
    const matchedArea = matched.reduce((s, i) => s + ds[i].area, 0);
    if (areaOf(o) > FOOTPRINT_RATIO * matchedArea && (o.heightM > TOWER_M || overrides[o.key])) {
      for (const i of matched) ds[i].removed = true;
      added.push({ key: o.key, polygons: o.polygons, heightM: o.heightM, source: "osm", replaced: matched.map((i) => ds[i].key) });
      report.footprintReplaced.push({ key: o.key, heightM: o.heightM, replaced: matched.map((i) => ds[i].key) });
      osmMatches.delete(o.key);
      continue;
    }
    for (const i of matched) {
      if (o.heightM > ds[i].heightM + HEIGHT_MARGIN_M) {
        ds[i].heightM = o.heightM;
        ds[i].heightFrom = o.key;
        report.heightRaised++;
      }
    }
  }
  const final = [...ds.filter((d) => !d.removed), ...added];
  const byKey = new Map(final.map((b) => [b.key, b]));
  const used = new Set();
  for (const [key, o] of Object.entries(overrides)) {
    if (!("heightM" in o) && !("palette" in o)) continue;
    const targets = byKey.has(key) ? [byKey.get(key)] : (osmMatches.get(key) ?? []).map((i) => ds[i]);
    if (targets.length === 0) throw new Error(`overrides.json ${key}: matches no building in this build`);
    for (const t of targets) {
      if ("heightM" in o) t.heightM = o.heightM;
      if ("palette" in o) t.palette = o.palette;
    }
    used.add(key);
  }
  report.overridesApplied = [...used].sort();
  final.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const buildings = final.map((b, i) => ({
    id: i + 1,
    key: b.key,
    polygons: b.polygons,
    heightM: b.heightM,
    source: b.source,
    ...(b.palette !== undefined ? { palette: b.palette } : {}),
    ...(b.peakM !== undefined ? { peakM: b.peakM } : {}),
  }));
  report.total = buildings.length;
  return { buildings, report };
}

/** base = min ground, top = max ground + max(1, round(h/3)). → {base, top} */
export function baseTop(groundsUnderFootprint, heightM) {
  let min = Infinity, max = -Infinity;
  for (const g of groundsUnderFootprint) {
    if (g < min) min = g;
    if (g > max) max = g;
  }
  if (!Number.isFinite(min)) throw new Error("baseTop: no ground under the footprint");
  if (!(heightM >= 0)) throw new Error(`baseTop: height must be a number ≥ 0, got ${heightM}`);
  return { base: min, top: max + Math.max(1, Math.round(heightM / 3)) };
}
