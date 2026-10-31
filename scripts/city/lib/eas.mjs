// DataSF Enterprise Addressing System (EAS, dataset 3mea-di5p, PDDL): address normalisation and
// geocoding for the company sites (spec section 4, rule 2). Responses are cached in raw/eas/<site id>.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const EAS_DATASET = "3mea-di5p";
export const EAS_ENDPOINT = `https://data.sf.gov/resource/${EAS_DATASET}.json`;
export const EAS_LICENSE = "PDDL";
const USER_AGENT = "agent-office-city-build/0.1 (+https://github.com/caffeinum/agent-office)";

/** Column names pinned from the dataset's X-SODA2-Fields header (fetched 2026-10-31). */
export const EAS_COLUMNS = Object.freeze({
  id: "eas_baseid",
  number: "address_number",
  suffix: "address_number_suffix",
  street: "street_name",
  type: "street_type",
  parcel: "parcel_number",
  lat: "latitude",
  lon: "longitude",
});

/** All hits within this many metres of each other count as one place (rule 2). */
export const SAME_PLACE_M = 10;
/** The EAS point must lie within this many metres of the entry's hint (rule 2). */
export const MAX_HINT_M = 60;

const ORDINAL_WORDS = {
  FIRST: "1ST", SECOND: "2ND", THIRD: "3RD", FOURTH: "4TH", FIFTH: "5TH", SIXTH: "6TH", SEVENTH: "7TH",
  EIGHTH: "8TH", NINTH: "9TH", TENTH: "10TH", ELEVENTH: "11TH", TWELFTH: "12TH", THIRTEENTH: "13TH",
  FOURTEENTH: "14TH", FIFTEENTH: "15TH", SIXTEENTH: "16TH", SEVENTEENTH: "17TH", EIGHTEENTH: "18TH",
  NINETEENTH: "19TH", TWENTIETH: "20TH",
};

const STREET_TYPES = {
  STREET: "ST", ST: "ST",
  AVENUE: "AVE", AVE: "AVE", AV: "AVE",
  BOULEVARD: "BLVD", BLVD: "BLVD",
  PLACE: "PL", PL: "PL",
  CROSSING: "XING", XING: "XING",
  WAY: "WAY",
  DRIVE: "DR", DR: "DR",
  LANE: "LN", LN: "LN",
  TERRACE: "TER", TER: "TER",
  COURT: "CT", CT: "CT",
  ROAD: "RD", RD: "RD",
  ALLEY: "ALY", ALY: "ALY",
  PLAZA: "PLZ", PLZ: "PLZ",
};

const SUITE_RE = /\b(SUITE|STE|UNIT|FLOOR|FL|FLR|ROOM|RM|APT)\b\.?\s*[A-Z0-9-]*/g;
const FLOOR_RE = /\b\d+(ST|ND|RD|TH)\s+(FLOOR|FL|FLR)\b\.?/g;

/**
 * Uppercase; drop everything after the first comma (city/state/zip, or a suite written as ", Suite 5");
 * strip suite/unit/floor/#…; collapse whitespace; spelled ordinals → numeric (THIRD → 3RD); abbreviate the
 * street type; a number range "1455-1515" keeps the first number and returns the range.
 * → {number, street, type: string|null, range: string|null}
 */
export function normalizeAddress(address) {
  if (typeof address !== "string" || !address.trim()) throw new Error(`normalizeAddress: address must be a non-empty string, got ${JSON.stringify(address)}`);
  let s = address.toUpperCase().split(",")[0];
  s = s.replace(/#\s*[A-Z0-9-]+/g, " ").replace(FLOOR_RE, " ").replace(SUITE_RE, " ").replace(/[.]/g, " ").replace(/\s+/g, " ").trim();
  const m = /^(\d+)(?:\s*-\s*(\d+))?\s+(.+)$/.exec(s);
  if (!m) throw new Error(`normalizeAddress: no street number in ${JSON.stringify(address)}`);
  const words = m[3].split(" ").map((w) => ORDINAL_WORDS[w] ?? w.replace(/^0+(?=\d)/, ""));
  let type = null;
  if (words.length > 1 && STREET_TYPES[words[words.length - 1]]) type = STREET_TYPES[words.pop()];
  const street = words.join(" ");
  if (!street) throw new Error(`normalizeAddress: no street name in ${JSON.stringify(address)}`);
  return { number: Number(m[1]), street, type, range: m[2] ? `${m[1]}-${m[2]}` : null };
}

/** EAS writes single-digit numbered streets zero-padded ("03RD"). */
const easStreetName = (street) => street.replace(/^(\d)(ST|ND|RD|TH)\b/, "0$1$2");
const sqlString = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** → data.sf.gov SODA URL selecting the EAS base addresses for the normalised address. */
export function easQueryUrl(norm) {
  if (!norm || !Number.isInteger(norm.number) || typeof norm.street !== "string") throw new Error(`easQueryUrl: bad normalised address ${JSON.stringify(norm)}`);
  const c = EAS_COLUMNS;
  const where = [
    `${c.number}=${norm.number}`,
    `${c.suffix} IS NULL`,
    `${c.street}=${sqlString(easStreetName(norm.street))}`,
    ...(norm.type ? [`${c.type}=${sqlString(norm.type)}`] : []),
  ].join(" AND ");
  const u = new URL(EAS_ENDPOINT);
  u.searchParams.set("$select", Object.values(c).join(","));
  u.searchParams.set("$where", where);
  u.searchParams.set("$order", `${c.id} ASC`);
  u.searchParams.set("$limit", "50");
  return u.href;
}

/** Great-circle distance in metres (haversine). */
export function distanceM(a, b) {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** A raw SODA row → {id, parcel: string|null, lat, lon, number, street, type}. Throws on a malformed row. */
export function parseEasRow(row) {
  const c = EAS_COLUMNS;
  const id = Number(row[c.id]);
  const lat = Number(row[c.lat]);
  const lon = Number(row[c.lon]);
  if (!Number.isInteger(id) || id < 1) throw new Error(`EAS row without a valid ${c.id}: ${JSON.stringify(row)}`);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error(`EAS row ${id} without a point: ${JSON.stringify(row)}`);
  return {
    id,
    parcel: typeof row[c.parcel] === "string" && row[c.parcel] ? row[c.parcel] : null,
    lat,
    lon,
    number: Number(row[c.number]),
    street: String(row[c.street] ?? "").replace(/^0+(?=\d)/, ""),
    type: row[c.type] ?? null,
  };
}

/** hits = parsed rows. All within SAME_PLACE_M → lowest id; otherwise `easId` must name one; else throw. → hit */
export function pickEasHit(hits, { easId } = {}) {
  if (!Array.isArray(hits) || hits.length === 0) throw new Error("pickEasHit: no EAS match");
  if (easId !== undefined) {
    const hit = hits.find((h) => h.id === easId);
    if (!hit) throw new Error(`pickEasHit: easId ${easId} is not among the hits (${hits.map((h) => h.id).join(", ")})`);
    return hit;
  }
  let spread = 0;
  for (const a of hits) for (const b of hits) spread = Math.max(spread, distanceM(a, b));
  if (spread > SAME_PLACE_M) {
    throw new Error(`pickEasHit: ${hits.length} EAS hits up to ${spread.toFixed(1)} m apart (${hits.map((h) => h.id).join(", ")}); set easId to pick one`);
  }
  return hits.reduce((lo, h) => (h.id < lo.id ? h : lo));
}

async function fetchEasJson(url, { retries = 5 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
      const body = Buffer.from(await res.arrayBuffer());
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.subarray(0, 200).toString()}`);
      if (!/^application\/(json|[a-z.+-]+\+json)\b/.test(type)) {
        const e = new Error(`EAS: expected JSON from ${url}, got ${type || "no content-type"}: ${body.subarray(0, 200).toString()}`);
        e.fatal = true;
        throw e;
      }
      const rows = JSON.parse(body.toString("utf8"));
      if (!Array.isArray(rows)) throw new Error(`EAS: expected an array from ${url}`);
      return rows;
    } catch (e) {
      if (e.fatal) throw e;
      lastError = e;
    }
  }
  throw new Error(`EAS: ${url} failed after ${retries + 1} attempts: ${lastError.message}`);
}

/**
 * entry = a companies.src.json entry. Query EAS (cached in rawDir/eas/<entry.id>.json), keep rows whose
 * normalised fields equal the entry's, pick one, and check it is within MAX_HINT_M of entry.hint.
 * → Promise<{id, parcel, lat, lon, distM, range}>
 */
export async function resolveEas(entry, { rawDir, fetchRows = fetchEasJson } = {}) {
  if (!rawDir) throw new Error("resolveEas: rawDir is required");
  const what = `${entry.id} (${entry.address})`;
  const norm = normalizeAddress(entry.address);
  const url = easQueryUrl(norm);
  const dir = join(rawDir, "eas");
  const file = join(dir, `${entry.id}.json`);
  let cached = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  if (!cached || cached.url !== url) {
    const rows = await fetchRows(url);
    cached = { url, fetchedAt: new Date().toISOString(), license: EAS_LICENSE, rows };
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(cached, null, 1) + "\n");
  }
  const hits = cached.rows.map(parseEasRow).filter(
    (h) => h.number === norm.number && h.street === norm.street && (norm.type === null || h.type === norm.type),
  );
  if (hits.length === 0) throw new Error(`EAS: no match for ${what}; query ${url}`);
  let hit;
  try {
    hit = pickEasHit(hits, { easId: entry.easId });
  } catch (e) {
    throw new Error(`EAS: ${what}: ${e.message}`);
  }
  if (!hit.parcel) throw new Error(`EAS: ${what}: record ${hit.id} has no ${EAS_COLUMNS.parcel}`);
  const distM = distanceM(hit, entry.hint);
  if (distM > MAX_HINT_M) {
    throw new Error(`EAS: ${what}: EAS point ${hit.id} (${hit.lat}, ${hit.lon}) is ${distM.toFixed(0)} m from the hint (${entry.hint.lat}, ${entry.hint.lon}) from ${entry.hint.from}; limit ${MAX_HINT_M} m`);
  }
  return { id: hit.id, parcel: hit.parcel, lat: hit.lat, lon: hit.lon, distM, range: norm.range };
}
