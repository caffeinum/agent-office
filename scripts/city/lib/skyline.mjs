// Skyline calibration (spec-v2 §3.4 rank 1 extended to the top-50 snapshot rows, §5 "heights are generated, not
// typed"). Runs after applyLandmarks. For each of the first 50 rows of skyline.src.json that no landmark recipe
// covers, the OSM outline under the row's coordinate is brought to round(heightM / 3) blocks:
//   - columns above the target are clamped to it (OSM/DataSF heights that include rooftop mechanicals);
//   - when the outline's top tier is within RAISE_SLACK below it, that tier is raised to it (measurement noise);
//   - when the top tier is further below, the snapshot height counts architectural tops (spires, masts, crowns):
//     the massing stays at the data's roof and the rest is modelled as a thin spire prop (operator: "model spires");
//   - when the outline is unbuilt in the data (DataSF lidar older than the tower), the whole outline becomes one new
//     entry at the roof (floors × ROOF_FLOOR_M, capped by the snapshot height) plus a spire prop up to the snapshot
//     height, but only when the outline is verifiably that building (name, address or floor count); a match by
//     coordinate alone is dropped and logged.
// Every change is logged in report.skyline. The heights come from the snapshot (Wikipedia, revision pinned).
import { BLOCK_M, PALETTE_INDEX, paletteFor } from "../../../public/shared/city.js";
import { lonLatToBlock } from "../../../public/shared/city.js";
import { rasterIndex } from "./raster.mjs";
import { polygonColumns } from "./structures.mjs";
import { loadLandmarks, loadSkyline } from "./landmarks.mjs";

export const SKYLINE_ROWS = 50;
/** A top tier is the outline's columns within this many blocks of its tallest column. */
const TIER_SLACK = 2;
/** Below this share of built columns (or this share of the target height) an outline counts as unbuilt in the data. */
const UNBUILT_SHARE = 0.5;
/** A top tier up to this many blocks below the snapshot is raised to it; further below, the rest is a spire. */
export const RAISE_SLACK = 2;
/** Roof height per floor (metres) for a tower the data does not have yet. */
export const ROOF_FLOOR_M = 4;
/** An outline's building:levels within this share of the row's floors verifies a coordinate match. */
const FLOORS_SLACK = 0.3;

const norm = (s) => String(s ?? "").toLowerCase().replace(/\bstreet\b/g, "st").replace(/[^a-z0-9]+/g, " ").trim();
/** How the outline is known to be the row's building: "name", "address", "floors", or null (coordinate only). */
export function matchEvidence(rec, row) {
  const t = rec.tags ?? {};
  const name = norm(row.name);
  if ([t.name, t.old_name, t["alt_name"]].some((n) => n && norm(n) === name)) return "name";
  if (t["addr:housenumber"] && t["addr:street"] && norm(`${t["addr:housenumber"]} ${t["addr:street"]}`) === name) return "address";
  const levels = Number(t["building:levels"]);
  if (row.floors && Number.isFinite(levels) && Math.abs(levels - row.floors) <= row.floors * FLOORS_SLACK) return "floors";
  return null;
}

/** A thin metal spire prop from the outline's top-tier centre column (roof) up to `top` (both relative). */
function addSpire(raster, cols, top) {
  const tier = cols.filter((c) => c.h > 0 && c.h >= Math.max(...cols.map((d) => d.h)) - TIER_SLACK);
  const mx = tier.reduce((a, c) => a + c.x, 0) / tier.length, mz = tier.reduce((a, c) => a + c.z, 0) / tier.length;
  const c = tier.sort((a, b) => Math.hypot(a.x - mx, a.z - mz) - Math.hypot(b.x - mx, b.z - mz))[0];
  const g = raster.ground[c.i];
  const roof = raster.top[c.i];
  if (g + top <= roof) return null;
  raster.addProp(c.x, c.z, { y0: roof, y1: g + top, color: PALETTE_INDEX.metal, flags: 0 });
  return { x: c.x, z: c.z, fromBlocks: roof - g, toBlocks: top };
}

function pointInRing(x, z, ring) {
  let c = false;
  for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
    const [xi, zi] = ring[i], [xk, zk] = ring[k];
    if ((zi > z) !== (zk > z) && x < ((xk - xi) * (z - zi)) / (zk - zi) + xi) c = !c;
  }
  return c;
}
const contains = (rec, x, z) => rec.polygons.some((poly) => pointInRing(x, z, poly[0]) && !poly.slice(1).some((h) => pointInRing(x, z, h)));

/** The non-part OSM outline at (x, z); the tallest when several overlap. Throws when there is none. */
function outlineAt(osm, x, z, what) {
  const hits = osm.filter((o) => !o.isPart && contains(o, x, z));
  if (hits.length === 0) throw new Error(`skyline: ${what} has no OSM building outline at its coordinate`);
  return hits.sort((a, b) => (b.heightM ?? 0) - (a.heightM ?? 0))[0];
}

/** → the raster (mutated); report.skyline = [{rank, name, key, fromBlocks, toBlocks, columns, mode}] */
export function calibrateSkyline(raster, ctx, { skyline = loadSkyline(), landmarks = loadLandmarks() } = {}) {
  const covered = new Set();
  for (const lm of landmarks) for (const s of [lm, ...(lm.recipe ?? []).filter((o) => o.op === "site")]) if (s.heightRef) covered.add(s.heightRef);
  const log = [];
  for (const row of skyline.rows.slice(0, SKYLINE_ROWS)) {
    if (covered.has(row.key)) continue;
    const what = `#${row.rank} ${row.name}`;
    const p = lonLatToBlock(row.lon, row.lat, ctx.proj);
    const rec = outlineAt(ctx.osm, p.x, p.z, what);
    const want = Math.round(row.heightM / BLOCK_M);
    const cols = [];
    for (const [x, z] of polygonColumns(rec.polygons)) {
      const i = rasterIndex(raster, x, z);
      if (i >= 0) cols.push({ x, z, i, h: raster.owner[i] >= 0 ? raster.top[i] - raster.ground[i] : 0 });
    }
    if (cols.length === 0) throw new Error(`skyline: ${what} outline ${rec.key} has no columns in the raster`);
    const built = cols.filter((c) => c.h > 0);
    const max = Math.max(0, ...built.map((c) => c.h));
    const entry = { rank: row.rank, name: row.name, key: rec.key, fromBlocks: max, toBlocks: want, columns: 0, mode: "ok", match: matchEvidence(rec, row) ?? "coordinate" };
    if (Math.abs(max - want) <= 1) {
      log.push(entry);
      continue;
    }
    if (max > want) {
      for (const c of built) {
        if (c.h <= want) continue;
        raster.setColumn(c.x, c.z, { bldg: raster.entries[raster.owner[c.i]].id, base: raster.ground[c.i], top: raster.ground[c.i] + want });
        entry.columns++;
      }
      entry.mode = "clamped";
    } else if (built.length < cols.length * UNBUILT_SHARE || max < want * UNBUILT_SHARE) {
      if (entry.match === "coordinate") {
        entry.mode = "dropped";
        entry.why = `outline ${rec.key} matches the row by coordinate only (no name, address or floor count)`;
        log.push(entry);
        continue;
      }
      const land = cols.filter((c) => raster.ground[c.i] >= 1);
      if (land.length === 0) throw new Error(`skyline: ${what} outline ${rec.key} has no land columns`);
      const base = Math.max(...land.map((c) => raster.ground[c.i]));
      const roof = row.floors ? Math.min(want, Math.round((row.floors * ROOF_FLOOR_M) / BLOCK_M)) : want;
      const id = raster.newId();
      raster.addEntry({ id, base, top: base + roof, palette: paletteFor(roof, id, rec.tags?.["building:colour"] ? { colour: rec.tags["building:colour"] } : {}) });
      for (const c of land) { raster.setColumn(c.x, c.z, { bldg: id, base, top: base + roof }); c.h = roof; }
      entry.columns = land.length;
      entry.roofBlocks = roof;
      entry.mode = "stamped";
      if (want - roof > RAISE_SLACK) entry.spire = addSpire(raster, land, want);
    } else if (want - max <= RAISE_SLACK) {
      for (const c of built) {
        if (c.h < max - TIER_SLACK) continue;
        raster.setColumn(c.x, c.z, { bldg: raster.entries[raster.owner[c.i]].id, base: raster.ground[c.i], top: raster.ground[c.i] + want });
        entry.columns++;
      }
      entry.mode = "raised";
    } else {
      entry.spire = addSpire(raster, built, want);
      entry.roofBlocks = max;
      entry.mode = "spire";
    }
    log.push(entry);
  }
  ctx.report.skyline = log;
  return raster;
}
