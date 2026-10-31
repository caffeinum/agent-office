// The build context handed to the W3 hooks (spec-v2 §3.10) and the frozen record shapes in it (§3.3).
// build-sf.mjs creates it once, after loadBuildings, with createBuildCtx; the hooks only read it (report aside).
//
// ctx = {proj, groundAt(x, z), osm: OsmBuilding[], datasf: DatasfBuilding[], report}
//
// OsmBuilding (one per OSM building or building:part way/relation, inside the raster; nothing dropped silently):
//   key        "o:w<id>" | "o:r<id>"
//   osmType    "way" | "relation"
//   osmId      positive integer
//   tags       every OSM tag, verbatim (string → string)
//   polygons   Polygon[] in block coordinates: Polygon = Ring[] (outer first), Ring = [x, z][] closed
//   isPart     true for building:part (tags["building:part"] present and not "no")
//   heightM    parsed `height` (or levels × 3.5 / 4 m rule, spec-v2 §3.4 rule 5), or null when untagged
//   minHeightM parsed `min_height` (or building:min_level × 3.5), or null
//   structure  structureKind(tags, ds) result: one of STRUCTURE_KINDS, or null
//
// DatasfBuilding (one per DataSF footprint ynuv-fyni inside the raster):
//   key        "d:<area_id>"
//   areaId     the DataSF area_id string
//   polygons   Polygon[] in block coordinates
//   heightM    hgt_median_m
//   maxM       hgt_maxcm / 100
//   gndMinM    gnd_min_m
//   peakM      peak_1st_m, or null when DataSF has none
import { STRUCTURE_KINDS, validateProj } from "../../../public/shared/city.js";

export const OSM_RECORD_KEYS = Object.freeze(["key", "osmType", "osmId", "tags", "polygons", "isPart", "heightM", "minHeightM", "structure"]);
export const DATASF_RECORD_KEYS = Object.freeze(["key", "areaId", "polygons", "heightM", "maxM", "gndMinM", "peakM"]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function exactKeys(o, keys, what) {
  if (!isObj(o)) throw new Error(`${what}: must be an object`);
  for (const k of keys) if (!(k in o)) throw new Error(`${what}: missing "${k}"`);
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Error(`${what}: unknown field "${k}"`);
}
const finiteOrNull = (v, what) => {
  if (v !== null && (typeof v !== "number" || !Number.isFinite(v))) throw new Error(`${what} must be a finite number or null, got ${v}`);
};
const finite = (v, what) => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${what} must be a finite number, got ${v}`);
};

function validatePolygons(polys, what) {
  if (!Array.isArray(polys) || polys.length === 0) throw new Error(`${what}.polygons must be a non-empty array`);
  polys.forEach((poly, i) => {
    if (!Array.isArray(poly) || poly.length === 0) throw new Error(`${what}.polygons[${i}] must be a non-empty ring list`);
    poly.forEach((ring, r) => {
      if (!Array.isArray(ring) || ring.length < 4) throw new Error(`${what}.polygons[${i}][${r}] must be a closed ring of ≥ 4 points`);
      const [a, b] = [ring[0], ring[ring.length - 1]];
      if (a[0] !== b[0] || a[1] !== b[1]) throw new Error(`${what}.polygons[${i}][${r}] is not closed`);
      for (const p of ring) {
        if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new Error(`${what}.polygons[${i}][${r}]: bad point ${JSON.stringify(p)}`);
      }
    });
  });
}

export function validateOsmRecord(r, what = "osm record") {
  exactKeys(r, OSM_RECORD_KEYS, what);
  if (!/^o:[wr][1-9]\d*$/.test(r.key)) throw new Error(`${what}.key: bad key ${JSON.stringify(r.key)}`);
  if (r.osmType !== (r.key[2] === "w" ? "way" : "relation")) throw new Error(`${what}.osmType ${r.osmType} does not match key ${r.key}`);
  if (!Number.isInteger(r.osmId) || `o:${r.key[2]}${r.osmId}` !== r.key) throw new Error(`${what}.osmId ${r.osmId} does not match key ${r.key}`);
  if (!isObj(r.tags)) throw new Error(`${what}.tags must be an object`);
  for (const [k, v] of Object.entries(r.tags)) if (typeof v !== "string") throw new Error(`${what}.tags.${k} must be a string`);
  validatePolygons(r.polygons, what);
  if (typeof r.isPart !== "boolean") throw new Error(`${what}.isPart must be boolean`);
  finiteOrNull(r.heightM, `${what}.heightM`);
  finiteOrNull(r.minHeightM, `${what}.minHeightM`);
  if (r.structure !== null && !STRUCTURE_KINDS.includes(r.structure)) throw new Error(`${what}.structure ${r.structure} is not a STRUCTURE_KINDS value`);
  return r;
}

export function validateDatasfRecord(r, what = "datasf record") {
  exactKeys(r, DATASF_RECORD_KEYS, what);
  if (!/^d:.+$/.test(r.key) || r.key !== `d:${r.areaId}`) throw new Error(`${what}.key ${r.key} does not match areaId ${r.areaId}`);
  validatePolygons(r.polygons, what);
  finite(r.heightM, `${what}.heightM`);
  finite(r.maxM, `${what}.maxM`);
  finite(r.gndMinM, `${what}.gndMinM`);
  finiteOrNull(r.peakM, `${what}.peakM`);
  return r;
}

/** Validate every record and freeze the context the hooks get. → ctx */
export function createBuildCtx({ proj, groundAt, osm, datasf, report, ...rest }) {
  const extra = Object.keys(rest);
  if (extra.length) throw new Error(`createBuildCtx: unknown field(s) ${extra.join(", ")}`);
  validateProj(proj, "ctx.proj");
  if (typeof groundAt !== "function") throw new Error("ctx.groundAt must be a function (x, z) → ground y");
  if (!Array.isArray(osm)) throw new Error("ctx.osm must be an array");
  if (!Array.isArray(datasf)) throw new Error("ctx.datasf must be an array");
  if (!isObj(report)) throw new Error("ctx.report must be an object");
  osm.forEach((r, i) => validateOsmRecord(r, `ctx.osm[${i}]`));
  datasf.forEach((r, i) => validateDatasfRecord(r, `ctx.datasf[${i}]`));
  return Object.freeze({ proj, groundAt, osm, datasf, report });
}
