// OSM building:part rasterization (spec-v2 §3.5). Format v2 keeps one [base, top] span per column, so each
// column's parts are merged bottom-up: a part whose span touches or overlaps the ground-attached span raises the
// column top to its own top; a part that starts above the current top floats (overhangs, skybridges, open crowns)
// and is dropped from chunks (report.droppedFloatingParts; a landmark `mesh` op may draw it in landmarks.bin).
// Inside a ground-attached part the outline height no longer applies: the column top is the merged part top.
import { BLOCK_M } from "../../../public/shared/city.js";
import { scanPolygon } from "./geo.mjs";
import { rasterIndex } from "./raster.mjs";

/** A part touches the current span when it starts within this many metres of the span's top. */
export const TOUCH_M = 0.5;

/**
 * Merge one column's part spans [{minM, topM, key}] (metres above the building's roof reference) bottom-up.
 * → {topM: merged top or null when no part reaches the ground, floating: keys of parts left above a gap}
 */
export function mergeColumnSpans(spans) {
  const sorted = [...spans].sort((a, b) => a.minM - b.minM || a.topM - b.topM);
  let top = 0;
  let attached = false;
  const floating = [];
  for (const s of sorted) {
    if (!(s.topM > s.minM)) throw new Error(`part ${s.key}: top ${s.topM} m is not above min ${s.minM} m`);
    if (s.minM <= top + TOUCH_M) {
      attached = true;
      if (s.topM > top) top = s.topM;
    } else floating.push(s.key);
  }
  return { topM: attached ? top : null, floating };
}

/**
 * parts = OSM records with isPart (ctx.osm shape). refOf(entryIndex) → {roofRef, base} of the owning building
 * (roofRef = max ground under its footprint). Writes raster.top for owned columns; columns no building owns are
 * counted as orphans (the part's outline building is missing or lost the column).
 * → report {parts, withoutHeight[], columns, raised, lowered, orphanColumns, droppedFloatingParts[]}
 */
export function applyParts(raster, parts, refOf) {
  const spans = new Map();
  const withoutHeight = [];
  for (const p of parts) {
    if (!p.isPart) throw new Error(`applyParts: ${p.key} is not a building:part`);
    if (p.heightM === null) {
      withoutHeight.push(p.key);
      continue;
    }
    const minM = p.minHeightM ?? 0;
    if (!(p.heightM > minM)) {
      withoutHeight.push(p.key);
      continue;
    }
    for (const poly of p.polygons) {
      scanPolygon(poly, (x, z) => {
        const i = rasterIndex(raster, x, z);
        if (i < 0) return;
        if (!spans.has(i)) spans.set(i, []);
        spans.get(i).push({ minM, topM: p.heightM, key: p.key });
      });
    }
  }
  const floatingCols = new Map();
  let raised = 0, lowered = 0, orphanColumns = 0, columns = 0;
  for (const [i, list] of spans) {
    const k = raster.owner[i];
    if (k < 0) {
      orphanColumns++;
      continue;
    }
    const { topM, floating } = mergeColumnSpans(list);
    for (const key of floating) floatingCols.set(key, (floatingCols.get(key) ?? 0) + 1);
    if (topM === null) continue;
    const { roofRef } = refOf(k);
    const top = roofRef + Math.max(1, Math.round(topM / BLOCK_M));
    if (top <= raster.ground[i]) continue;
    if (top > raster.top[i]) raised++;
    else if (top < raster.top[i]) lowered++;
    raster.top[i] = top;
    columns++;
  }
  return {
    parts: parts.length,
    withoutHeight,
    columns,
    raised,
    lowered,
    orphanColumns,
    droppedFloatingParts: [...floatingCols].map(([key, cols]) => ({ key, columns: cols })).sort((a, b) => (a.key < b.key ? -1 : 1)),
  };
}
