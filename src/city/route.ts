// W5 (spec-v2 §7.6): pure A* over walk.bin. W1 stub with the final signature; W5 owns this file from the W1 merge.
import type { WalkGraph } from "../../public/shared/city.js";

/** A* stops with `route search too long` after this many node expansions. */
export const ROUTE_MAX_EXPANSIONS = 20000;

export interface RouteResult {
  /** node indices, from → to */
  nodes: number[];
  /** simplified path points [x, z, y] in blocks; y always present (ground or deck top) */
  path: [x: number, z: number, y: number][];
  lengthBlocks: number;
  /** street names along the route, in order, deduped consecutively */
  via: string[];
}

export interface RouteOptions {
  maxExpansions?: number;
}

/** Throws `no walking route to …` when unreachable and `route search too long` past the expansion bound. */
export function route(graph: WalkGraph, from: number, to: number, opts: RouteOptions = {}): RouteResult {
  throw new Error("route: not implemented yet (W5, spec-v2 §7.6)");
}
