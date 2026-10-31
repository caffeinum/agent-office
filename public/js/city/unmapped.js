// Everything outside the listed chunks (spec-v2 §2): manifest.water chunks and landmask sea render as sea (the
// water plane), landmask land renders as low-relief "unbuilt" terrain in a paper tone (meshUnbuilt in the
// worker), and listed chunks next to unbuilt land get skirts down to its coarse height (meshChunk {unbuilt}
// neighbours). Pure helpers; imports only shared/city.js and the mesher.
import { CHUNK, LANDMASK_CELL, chunkKey, chunkOf, landmaskHeight } from "../../shared/city.js";
import { unbuiltEdge } from "./mesher.js";

/**
 * → {kind(cx, cz) → "listed" | "water" | "unbuilt" | "sea", heightAt(x, z) → coarse height | null (null unless the
 * column is unbuilt land), neighbour(cx, cz, side) → null | {unbuilt: Int16Array} for meshChunk}.
 * manifest: validated v2 manifest. mask: decoded landmask.
 */
export function createUnmapped(manifest, mask) {
  if (!mask || !(mask.cells instanceof Uint8Array)) throw new Error("createUnmapped: mask must be a decoded landmask");
  const listed = new Set(manifest.chunks.list.map(([cx, cz]) => chunkKey(cx, cz)));
  const water = new Set(manifest.water.map(([cx, cz]) => chunkKey(cx, cz)));
  const [gx, gz] = manifest.chunks.grid;
  const per = CHUNK / LANDMASK_CELL;
  const landChunk = new Map();
  /** Does chunk cx,cz hold any landmask land? */
  const hasLand = (cx, cz) => {
    const key = chunkKey(cx, cz);
    if (landChunk.has(key)) return landChunk.get(key);
    let land = false;
    const cell0x = cx * per, cell0z = cz * per;
    for (let j = 0; j < per && !land; j++) for (let i = 0; i < per; i++) if (mask.cells[(cell0z + j) * mask.cellsX + cell0x + i]) { land = true; break; }
    landChunk.set(key, land);
    return land;
  };
  const kind = (cx, cz) => {
    const key = chunkKey(cx, cz);
    if (listed.has(key)) return "listed";
    if (water.has(key)) return "water";
    if (cx < 0 || cz < 0 || cx >= gx || cz >= gz) return "sea";
    return hasLand(cx, cz) ? "unbuilt" : "sea";
  };
  return {
    kind,
    heightAt(x, z) {
      const [cx, cz] = chunkOf(Math.floor(x), Math.floor(z));
      if (kind(cx, cz) !== "unbuilt") return null;
      const h = landmaskHeight(mask, x, z);
      return h === null ? null : Math.max(1, h);
    },
    neighbour(cx, cz, side) {
      if (kind(cx, cz) !== "unbuilt") return null;
      const edge = unbuiltEdge(mask, cx, cz, side);
      return edge.some((h) => h > 0) ? { unbuilt: edge } : null;
    },
  };
}
