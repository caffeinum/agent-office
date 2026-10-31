// Skyline calibration (spec-v2 §3.4 rank 1 extended to the top-50 snapshot rows, §5 "heights are generated, not
// typed"). Runs after applyLandmarks. For each of the first 50 rows of skyline.src.json that no landmark recipe
// covers, the OSM outline under the row's coordinate is brought to round(heightM / 3) blocks:
//   - columns above the target are clamped to it (OSM/DataSF heights that include rooftop mechanicals);
//   - when the outline's top tier is below it, that tier is raised to it;
//   - when the outline is unbuilt in the data (DataSF lidar older than the tower), the whole outline becomes one new
//     entry at the target height.
// Every change is logged in report.skyline. The heights come from the snapshot (Wikipedia, revision pinned).
import { BLOCK_M, paletteFor } from "../../../public/shared/city.js";
import { lonLatToBlock } from "../../../public/shared/city.js";
import { rasterIndex } from "./raster.mjs";
import { polygonColumns } from "./structures.mjs";
import { loadLandmarks, loadSkyline } from "./landmarks.mjs";

export const SKYLINE_ROWS = 50;
/** A top tier is the outline's columns within this many blocks of its tallest column. */
const TIER_SLACK = 2;
/** Below this share of built columns (or this share of the target height) an outline counts as unbuilt in the data. */
const UNBUILT_SHARE = 0.5;

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
    const entry = { rank: row.rank, name: row.name, key: rec.key, fromBlocks: max, toBlocks: want, columns: 0, mode: "ok" };
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
      const land = cols.filter((c) => raster.ground[c.i] >= 1);
      if (land.length === 0) throw new Error(`skyline: ${what} outline ${rec.key} has no land columns`);
      const base = Math.max(...land.map((c) => raster.ground[c.i]));
      const id = raster.newId();
      raster.addEntry({ id, base, top: base + want, palette: paletteFor(want, id, rec.tags?.["building:colour"] ? { colour: rec.tags["building:colour"] } : {}) });
      for (const c of land) raster.setColumn(c.x, c.z, { bldg: id, base, top: base + want });
      entry.columns = land.length;
      entry.mode = "stamped";
    } else {
      for (const c of built) {
        if (c.h < max - TIER_SLACK) continue;
        raster.setColumn(c.x, c.z, { bldg: raster.entries[raster.owner[c.i]].id, base: raster.ground[c.i], top: raster.ground[c.i] + want });
        entry.columns++;
      }
      entry.mode = "raised";
    }
    log.push(entry);
  }
  ctx.report.skyline = log;
  return raster;
}
