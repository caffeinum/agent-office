// DataSF + OSM building merge with the spec-v2 §3.4 height priority, and the base/top rule.
// Building items are in block coordinates: {key, polygons: Polygon[], heightM, ...}.
//
// Priority, highest wins (landmark recipes and building:part are applied later, on the raster):
//   3. an OSM outline with an explicit height > 60 m, start_date after 2010, a structure kind, or a matched DataSF
//      parcel whose max − median gap is > 40 m: the OSM polygon is used and every DataSF parcel whose centroid lies
//      inside it is deleted (report.deletedParcels). Replaces v1's 1.5× area rule.
//   4. DataSF hgt_median_m. An explicit OSM `height` more than 6 m above it raises it, but never onto a parcel more
//      than 1.2× the OSM outline's area or whose centroid lies outside the outline.
//   5. OSM levels × 3.5 m (4 m per level for office buildings with ≥ 10 levels), for OSM-only buildings.
//   6. 9 m.
import { pointInPolygon, polygonArea, polygonBounds, ringCentroid } from "./geo.mjs";

export const OSM_DEFAULT_HEIGHT_M = 9;
const HEIGHT_MARGIN_M = 6;
export const TOWER_M = 60;
export const TOWER_GAP_M = 40;
export const NEW_AFTER_YEAR = 2010;
export const MAX_COPY_AREA_RATIO = 1.2;
const GRID = 64;

const areaOf = (b) => b.polygons.reduce((s, p) => s + polygonArea(p), 0);
const largest = (b) => b.polygons.reduce((best, p) => (polygonArea(p) > polygonArea(best) ? p : best), b.polygons[0]);
export const centroidOf = (b) => ringCentroid(largest(b)[0]);
const contains = (b, [x, z]) => b.polygons.some((p) => pointInPolygon(x, z, p));
export function boundsOf(b) {
  const bs = b.polygons.map(polygonBounds);
  return {
    minX: Math.min(...bs.map((q) => q.minX)), minZ: Math.min(...bs.map((q) => q.minZ)),
    maxX: Math.max(...bs.map((q) => q.maxX)), maxZ: Math.max(...bs.map((q) => q.maxZ)),
  };
}

/** Spatial index over items with polygons. → (bounds) → Set of item indices whose bounds share a 64-block cell */
export function gridIndex(items) {
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

/** First four-digit year of an OSM start_date ("2016", "2016-05", "~1925", "C19" → null). */
export function startYear(tags) {
  const m = /(\d{4})/.exec(String(tags?.start_date ?? ""));
  return m ? Number(m[1]) : null;
}

/** Why an OSM outline outranks the DataSF parcels it matches (rank 3), or null. */
export function osmWinsReason(o, matched) {
  if (o.explicitHeightM !== null && o.explicitHeightM > TOWER_M) return "height>60m";
  const y = startYear(o.tags);
  if (y !== null && y > NEW_AFTER_YEAR) return "start_date>2010";
  if (o.structure) return `structure:${o.structure}`;
  if (matched.some((d) => d.maxM - d.heightM > TOWER_GAP_M)) return "datasf-gap>40m";
  return null;
}

/**
 * datasf = [{key:"d:<area_id>", polygons, heightM, maxM, peakM?}],
 * osm = [{key, polygons, heightM|null (rank-5 height), explicitHeightM|null (parsed `height`), tags, structure|null}],
 * overrides = {key: {heightM?, palette?, deckY?}}. Ids are assigned sequentially after sorting by key.
 * → {buildings: [{id, key, polygons, heightM, source, tags, structure, maxM, medianM, palette?, peakM?}], report}
 */
export function mergeBuildings({ datasf, osm, overrides }) {
  checkOverrides(overrides);
  const ds = datasf.map((d) => ({ ...d, source: "datasf", area: areaOf(d), centroid: centroidOf(d), removed: false, tags: null, structure: null, medianM: d.heightM, maxM: d.maxM ?? null }));
  const candidates = gridIndex(ds);
  const added = [];
  const report = {
    datasf: ds.length, osm: osm.length, heightRaised: 0, heightCopyBlocked: [], deletedParcels: [], osmWins: {},
    osmAdded: 0, osmAddedDefaultHeight: 0, osmMatched: 0,
  };
  const osmMatches = new Map();
  for (const o of osm) {
    const oc = centroidOf(o);
    const oArea = areaOf(o);
    const matched = [...candidates(boundsOf(o))].filter((i) => !ds[i].removed && (contains(o, ds[i].centroid) || contains(ds[i], oc)));
    if (matched.length === 0) {
      added.push({ key: o.key, polygons: o.polygons, heightM: o.heightM ?? OSM_DEFAULT_HEIGHT_M, source: "osm", tags: o.tags, structure: o.structure, maxM: null, medianM: null });
      report.osmAdded++;
      if (o.heightM === null) report.osmAddedDefaultHeight++;
      continue;
    }
    report.osmMatched++;
    osmMatches.set(o.key, matched);
    const why = osmWinsReason(o, matched.map((i) => ds[i]));
    if (why) {
      const inside = matched.filter((i) => contains(o, ds[i].centroid));
      for (const i of inside) ds[i].removed = true;
      const parcels = inside.map((i) => ds[i]);
      const heightM = o.heightM ?? (parcels.length ? Math.max(...parcels.map((d) => d.heightM)) : OSM_DEFAULT_HEIGHT_M);
      const maxM = parcels.length ? Math.max(...parcels.map((d) => d.maxM)) : null;
      const medianM = parcels.length ? Math.max(...parcels.map((d) => d.heightM)) : null;
      added.push({ key: o.key, polygons: o.polygons, heightM, source: "osm", tags: o.tags, structure: o.structure, maxM, medianM });
      report.deletedParcels.push({ key: o.key, reason: why, heightM, parcels: parcels.map((d) => d.key) });
      report.osmWins[why] = (report.osmWins[why] ?? 0) + 1;
      osmMatches.set(o.key, inside);
      continue;
    }
    if (o.explicitHeightM === null) continue;
    for (const i of matched) {
      if (!(o.explicitHeightM > ds[i].heightM + HEIGHT_MARGIN_M)) continue;
      if (ds[i].area > MAX_COPY_AREA_RATIO * oArea || !contains(o, ds[i].centroid)) {
        report.heightCopyBlocked.push({ osm: o.key, parcel: ds[i].key, osmHeightM: o.explicitHeightM, parcelHeightM: ds[i].heightM });
        continue;
      }
      ds[i].heightM = o.explicitHeightM;
      ds[i].heightFrom = o.key;
      ds[i].tags ??= o.tags;
      report.heightRaised++;
    }
  }
  const final = [...ds.filter((d) => !d.removed), ...added];
  const byKey = new Map(final.map((b) => [b.key, b]));
  const used = new Set();
  for (const [key, o] of Object.entries(overrides)) {
    if (!("heightM" in o) && !("palette" in o)) continue;
    const targets = byKey.has(key) ? [byKey.get(key)] : (osmMatches.get(key) ?? []).map((i) => ds[i]).filter((d) => !d.removed);
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
    tags: b.tags ?? null,
    structure: b.structure ?? null,
    maxM: b.maxM ?? null,
    medianM: b.medianM ?? null,
    ...(b.palette !== undefined ? { palette: b.palette } : {}),
    ...(b.peakM !== undefined && b.peakM !== null ? { peakM: b.peakM } : {}),
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
