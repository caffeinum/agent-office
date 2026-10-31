// Builds public/city/sf/companies.json from scripts/city/sf/companies.src.json (spec section 4).
// Every rule fails the run loudly. `--geocode-only` resolves the EAS points without a built city.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import {
  BLOCK_M, CHUNK, CITY_VERSION, COMPANY_STATUSES, SOURCE_KINDS, SURFACE,
  assertGzip, chunkKey, chunkOf, decodeChunk, lonLatToBlock, validateCompanies, validateManifest,
} from "../../public/shared/city.js";
import { resolveEas } from "./lib/eas.mjs";
import { BUDGET, BUILD_DIR, RAW_DIR } from "./sf/config.mjs";

const SRC_REQUIRED = ["id", "companyId", "name", "primary", "address", "status", "category", "color", "sources", "verifiedAt", "hint", "ship"];
const SRC_OPTIONAL = ["easId", "note"];
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Nearest building column searched within this many blocks of the EAS column (rule 4). */
export const PLACE_RADIUS = 15;
/** Anchor searched within this many blocks of the EAS column (rule 5). */
export const ANCHOR_RADIUS = 12;
export const ANCHOR_PREFERENCE = Object.freeze([SURFACE.SIDEWALK, SURFACE.PLAZA, SURFACE.ROAD]);

const fail = (msg) => {
  throw new Error(`companies: ${msg}`);
};

function checkKeys(obj, what) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) fail(`${what} must be an object`);
  for (const k of SRC_REQUIRED) if (!(k in obj)) fail(`${what}: missing ${k}`);
  for (const k of Object.keys(obj)) if (!SRC_REQUIRED.includes(k) && !SRC_OPTIONAL.includes(k)) fail(`${what}: unknown field ${k}`);
}

const newestOccupancy = (e) => e.sources.filter((s) => s.kind === "occupancy" && s.date).map((s) => s.date).sort().at(-1) ?? null;

/**
 * Shape checks for every source entry, rule 1 for shipped ones, rules 7 and 8 per company.
 * → {shipped, skipped: [{id, reason}]}
 */
export function checkSource(entries) {
  if (!Array.isArray(entries)) fail("source must be an array");
  const ids = new Set();
  const shipped = [];
  const skipped = [];
  entries.forEach((e, i) => {
    const what = `src[${i}]${e && typeof e.id === "string" ? ` (${e.id})` : ""}`;
    checkKeys(e, what);
    if (!ID_RE.test(e.id)) fail(`${what}: bad id`);
    if (ids.has(e.id)) fail(`${what}: duplicate id`);
    ids.add(e.id);
    if (!ID_RE.test(e.companyId)) fail(`${what}: bad companyId`);
    for (const k of ["name", "address", "category"]) if (typeof e[k] !== "string" || !e[k].trim()) fail(`${what}: ${k} must be a non-empty string`);
    if (typeof e.primary !== "boolean" || typeof e.ship !== "boolean") fail(`${what}: primary and ship must be booleans`);
    if (!COMPANY_STATUSES.includes(e.status)) fail(`${what}: status ${e.status} not in ${COMPANY_STATUSES.join("|")}`);
    if (!/^#[0-9a-f]{6}$/i.test(e.color)) fail(`${what}: color must be #rrggbb`);
    if ("easId" in e && (!Number.isInteger(e.easId) || e.easId < 1)) fail(`${what}: easId must be a positive integer`);
    if ("note" in e && (typeof e.note !== "string" || !e.note.trim())) fail(`${what}: note must be a non-empty string`);
    const h = e.hint;
    if (!h || typeof h !== "object" || !Number.isFinite(h.lat) || !Number.isFinite(h.lon) || typeof h.from !== "string" || !h.from) {
      fail(`${what}: hint must be {lat, lon, from}`);
    }
    if (h.from !== "scout" && !/^https:\/\//.test(h.from)) fail(`${what}: hint.from must be a https URL or "scout"`);
    if (!Array.isArray(e.sources)) fail(`${what}: sources must be an array`);
    e.sources.forEach((s, j) => {
      if (!s || typeof s.url !== "string" || !/^https:\/\//.test(s.url)) fail(`${what}.sources[${j}]: url must be https`);
      if (!SOURCE_KINDS.includes(s.kind)) fail(`${what}.sources[${j}]: kind ${s.kind} not in ${SOURCE_KINDS.join("|")}`);
      if ("date" in s && !DATE_RE.test(s.date)) fail(`${what}.sources[${j}]: date must be YYYY-MM-DD`);
      for (const k of Object.keys(s)) if (!["url", "kind", "date"].includes(k)) fail(`${what}.sources[${j}]: unknown field ${k}`);
    });
    if (!DATE_RE.test(e.verifiedAt)) fail(`${what}: verifiedAt must be YYYY-MM-DD`);
    if (!e.ship) {
      if (!e.note) fail(`${what}: an unshipped entry needs a note saying why`);
      skipped.push({ id: e.id, reason: e.note });
      return;
    }
    // rule 1
    if (e.sources.length === 0) fail(`${what}: rule 1: a shipped site needs at least one source`);
    if ((e.status === "hq" || e.status === "office") && !e.sources.some((s) => s.kind === "occupancy")) {
      fail(`${what}: rule 1: status ${e.status} needs an occupancy source (registry alone is not enough)`);
    }
    if (e.status === "former" && !e.sources.some((s) => (s.kind === "news" || s.kind === "company") && s.date)) {
      fail(`${what}: rule 1: status former needs a dated news or company source`);
    }
    shipped.push(e);
  });
  const byCompany = new Map();
  for (const e of shipped) byCompany.set(e.companyId, [...(byCompany.get(e.companyId) ?? []), e]);
  for (const [companyId, sites] of byCompany) {
    const primaries = sites.filter((s) => s.primary);
    if (primaries.length !== 1) fail(`${companyId}: rule 7: ${primaries.length} primary sites, expected exactly 1`);
    for (const s of sites) if (s.name !== sites[0].name) fail(`${companyId}: sites disagree on name (${s.name} vs ${sites[0].name})`);
    const [primary] = primaries;
    const occupied = sites.filter((s) => s.status === "hq" || s.status === "office");
    if (occupied.length > 1) {
      if (primary.status !== "hq") fail(`${companyId}: rule 8: primary ${primary.id} must have status hq`);
      for (const s of occupied) if (s !== primary && s.status !== "office") fail(`${companyId}: rule 8: non-primary ${s.id} must be office, got ${s.status}`);
      const best = newestOccupancy(primary);
      if (!best) fail(`${companyId}: rule 8: primary ${primary.id} needs a dated occupancy source`);
      for (const s of occupied) {
        const d = newestOccupancy(s);
        if (d && d > best) fail(`${companyId}: rule 8: ${s.id} has a newer occupancy source (${d}) than primary ${primary.id} (${best})`);
      }
    }
  }
  return { shipped, skipped };
}

/** manifest + directory of {cx}_{cz}.bin → column lookup. A listed chunk that fails to load throws; an unlisted one inside the range is open water. */
export function createColumnReader(manifest, chunksDir) {
  const listed = new Set(manifest.chunks.list.map(([cx, cz]) => chunkKey(cx, cz)));
  const { min, max } = manifest.chunks;
  const cache = new Map();
  const load = (cx, cz) => {
    const key = chunkKey(cx, cz);
    if (!cache.has(key)) {
      if (!listed.has(key)) {
        cache.set(key, null);
      } else {
        const file = join(chunksDir, `${key}.bin`);
        const gz = readFileSync(file);
        assertGzip(gz, file);
        const chunk = decodeChunk(gunzipSync(gz));
        if (chunk.cx !== cx || chunk.cz !== cz) fail(`${file} holds chunk ${chunk.cx},${chunk.cz}`);
        cache.set(key, chunk);
      }
    }
    return cache.get(key);
  };
  /** → {ground, surface, building: {id, base, top}|null} for the column, or null outside the manifest range. */
  return function columnAt(x, z) {
    const [cx, cz] = chunkOf(x, z);
    if (cx < min[0] || cx > max[0] || cz < min[1] || cz > max[1]) return null;
    const chunk = load(cx, cz);
    if (!chunk) return { ground: 0, surface: SURFACE.WATER, building: null };
    const i = (z - cz * CHUNK) * CHUNK + (x - cx * CHUNK);
    const b = chunk.bldg[i];
    return { ground: chunk.ground[i], surface: chunk.surface[i], building: b ? chunk.buildings[b - 1] : null };
  };
}

const isWater = (col) => col.surface === SURFACE.WATER || col.surface === SURFACE.SHALLOW;

/** Scan the disc of `radius` around (bx, bz), z-major then x, keeping the strictly nearest column that passes `ok`. */
function nearest(columnAt, bx, bz, radius, ok) {
  let best = null;
  let bestD = Infinity;
  for (let z = bz - radius; z <= bz + radius; z++) {
    for (let x = bx - radius; x <= bx + radius; x++) {
      const d = Math.hypot(x - bx, z - bz);
      if (d > radius || d >= bestD) continue;
      const col = columnAt(x, z);
      if (col && ok(col)) {
        best = { x, z, col };
        bestD = d;
      }
    }
  }
  return best && { ...best, d: bestD };
}

/** Rules 4 and 5 on the chunk grid. block = the EAS column. → {building, placement, placementDistM, anchor} */
export function placeOnGrid(columnAt, block, what = "site") {
  const here = columnAt(block.x, block.z);
  if (!here) fail(`${what}: column ${block.x},${block.z} is outside the built city`);
  let building;
  let placement;
  let placementDistM;
  if (here.building) {
    building = here.building;
    placement = "contains";
    placementDistM = 0;
  } else {
    const hit = nearest(columnAt, block.x, block.z, PLACE_RADIUS, (c) => c.building !== null);
    if (!hit) fail(`${what}: rule 4: no building column within ${PLACE_RADIUS} blocks of ${block.x},${block.z}`);
    building = hit.col.building;
    placement = "nearest";
    placementDistM = Math.round(hit.d * BLOCK_M * 10) / 10;
  }
  let a = null;
  for (const want of ANCHOR_PREFERENCE) {
    a = nearest(columnAt, block.x, block.z, ANCHOR_RADIUS, (c) => !c.building && c.surface === want);
    if (a) break;
  }
  a ??= nearest(columnAt, block.x, block.z, ANCHOR_RADIUS, (c) => !c.building && !isWater(c));
  if (!a) fail(`${what}: rule 5: no non-building, non-water column within ${ANCHOR_RADIUS} blocks of ${block.x},${block.z}`);
  if (a.col.ground < 1) fail(`${what}: rule 5: anchor ${a.x},${a.z} has ground ${a.col.ground}`);
  return { building, placement, placementDistM, anchor: { x: a.x, y: a.col.ground, z: a.z } };
}

const round7 = (v) => Number(v.toFixed(7));

function siteFor(e, eas, place, block) {
  const notes = [e.note, eas.range ? `Address range ${eas.range}; EAS queried the first number.` : null].filter(Boolean);
  const { building } = place;
  return {
    id: e.id, companyId: e.companyId, name: e.name, primary: e.primary, address: e.address, status: e.status,
    category: e.category, color: e.color, sources: e.sources, verifiedAt: e.verifiedAt,
    ...(notes.length ? { note: notes.join(" ") } : {}),
    lat: eas.lat, lon: eas.lon, eas: { id: eas.id, parcel: eas.parcel }, hintFrom: e.hint.from,
    buildingId: building.id, block, chunk: chunkOf(block.x, block.z), anchor: place.anchor,
    roofY: building.top, heightM: (building.top - building.base) * BLOCK_M,
    placement: place.placement, placementDistM: place.placementDistM,
  };
}

/** Rule 2 for every shipped entry. → Map<id, {id, parcel, lat, lon, distM, range}> */
export async function geocodeAll(shipped, { resolve, rawDir }) {
  const out = new Map();
  for (const e of shipped) {
    const r = await resolve(e, { rawDir });
    out.set(e.id, { ...r, lat: round7(r.lat), lon: round7(r.lon) });
  }
  return out;
}

/**
 * Apply rules 1-8, geocode via EAS, place on the bldg grid, validateCompanies, write.
 * `src` (array) overrides `srcPath`; `resolve` overrides the EAS geocoder (tests); `write:false` returns without writing.
 * → Promise<{doc, report}>
 */
export async function buildCompanies({
  srcPath = "scripts/city/sf/companies.src.json",
  manifestPath = "public/city/sf/manifest.json",
  outPath = "public/city/sf/companies.json",
  reportPath = join(BUILD_DIR, "companies-report.json"),
  rawDir = RAW_DIR,
  src,
  resolve = resolveEas,
  write = true,
} = {}) {
  const entries = src ?? JSON.parse(readFileSync(srcPath, "utf8"));
  const { shipped, skipped } = checkSource(entries);
  if (!existsSync(manifestPath)) fail(`no manifest at ${manifestPath}; run the map build (W2) first`);
  const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  const columnAt = createColumnReader(manifest, join(dirname(manifestPath), "chunks"));
  const points = await geocodeAll(shipped, { resolve, rawDir });
  const sites = [];
  const outside = [];
  const { min, max } = manifest.chunks;
  for (const e of shipped) {
    const eas = points.get(e.id);
    const p = lonLatToBlock(eas.lon, eas.lat, manifest.proj);
    const block = { x: Math.floor(p.x), z: Math.floor(p.z) };
    const [cx, cz] = chunkOf(block.x, block.z);
    if (cx < min[0] || cx > max[0] || cz < min[1] || cz > max[1]) {
      outside.push({ id: e.id, chunk: [cx, cz] });
      continue;
    }
    sites.push(siteFor(e, eas, placeOnGrid(columnAt, block, `${e.id} (${e.address})`), block));
  }
  for (const o of outside) {
    const e = shipped.find((x) => x.id === o.id);
    if (e.primary && sites.some((s) => s.companyId === e.companyId)) fail(`${e.id}: rule 3: primary is outside the bbox but other ${e.companyId} sites are inside`);
  }
  const doc = validateCompanies({ version: CITY_VERSION, city: manifest.city, builtAt: manifest.builtAt, sites }, manifest);
  const json = JSON.stringify(doc, null, 1) + "\n";
  if (Buffer.byteLength(json) > BUDGET.companiesBytes) fail(`companies.json is ${Buffer.byteLength(json)} bytes, budget ${BUDGET.companiesBytes}`);
  const report = {
    shipped: sites.length,
    companies: new Set(sites.map((s) => s.companyId)).size,
    skipped,
    outsideBbox: outside,
    scoutHints: shipped.filter((e) => e.hint.from === "scout").map((e) => e.id),
    nearest: sites.filter((s) => s.placement === "nearest").map((s) => ({ id: s.id, placementDistM: s.placementDistM })),
    hintDistM: Object.fromEntries([...points].map(([id, r]) => [id, Math.round(r.distM * 10) / 10])),
    bytes: Buffer.byteLength(json),
  };
  if (write) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, json);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 1) + "\n");
  }
  return { doc, report };
}

async function main() {
  if (process.argv.includes("--geocode-only")) {
    const { shipped, skipped } = checkSource(JSON.parse(readFileSync("scripts/city/sf/companies.src.json", "utf8")));
    const points = await geocodeAll(shipped, { resolve: resolveEas, rawDir: RAW_DIR });
    for (const e of shipped) {
      const r = points.get(e.id);
      const p = lonLatToBlock(r.lon, r.lat);
      console.log(`${e.id.padEnd(32)} eas ${String(r.id).padEnd(7)} parcel ${r.parcel.padEnd(9)} ${r.distM.toFixed(1).padStart(5)} m from hint  block ${Math.floor(p.x)},${Math.floor(p.z)}  chunk ${chunkOf(p.x, p.z)}`);
    }
    console.log(`${shipped.length} shipped sites geocoded, ${skipped.length} leads not shipped`);
    return;
  }
  const { report } = await buildCompanies();
  console.log(`companies: ${report.shipped} sites (${report.companies} companies), ${report.skipped.length} not shipped, ${report.outsideBbox.length} outside the bbox, ${report.bytes} bytes`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
