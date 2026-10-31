// The furniture catalog has ONE source of truth: public/shared/catalog.js (plain ESM + .d.ts), which the
// bundler-free viewer loads as /shared/catalog.js and the worker bundles from here. This module re-exports it
// and adds the server-only helpers.
import { footprint, kindOf, KINDS, overlaps, validateItem, type Grid, type Item, type Rot } from "../../public/shared/catalog.js";

export * from "../../public/shared/catalog.js";

/** Validates every item against the ones before it (dup ids, overlaps, bounds). Returns the items. */
export function validateLayout(items: readonly Item[], grid: Grid): readonly Item[] {
  const placed: Item[] = [];
  for (const it of items) {
    validateItem(it, placed, grid);
    placed.push(it);
  }
  return items;
}

/** First free spot (rows from the back wall) where `kind` fits at `rot`, or null if the floor is full. */
export function findFreeSpot(items: readonly Item[], grid: Grid, kind: keyof typeof KINDS, rot: Rot = 0): { x: number; z: number } | null {
  const def = KINDS[kind];
  const turned = rot === 90 || rot === 270;
  const w = turned ? def.d : def.w;
  const d = turned ? def.w : def.d;
  const sameLayer = items.filter((it) => kindOf(it.kind)?.layer === def.layer).map(footprint);
  for (let z = 1; z + d <= grid.d; z++) {
    for (let x = 1; x + w <= grid.w; x++) {
      const f = { x, z, w, d };
      if (!sameLayer.some((o) => overlaps(o, f))) return { x, z };
    }
  }
  return null;
}
