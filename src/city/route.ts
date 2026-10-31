// W5 (spec-v2 §7.6): pure A* over walk.bin. No I/O; the City DO hands in the decoded graph.
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

/** Path points closer than this (blocks) to the straight line through their neighbours are dropped. */
const PATH_EPS = 0.05;
/** Slightly under 1 so the straight-line bound stays below the rounded decimetre edge lengths. */
const H_SCALE = 0.98;

interface Adjacency {
  /** CSR: edges leaving node n are out[start[n] .. start[n + 1]) (edge indices) */
  start: Int32Array;
  out: Int32Array;
  /** connected component label per node */
  comp: Int32Array;
}

const adjacencyCache = new WeakMap<WalkGraph, Adjacency>();

function adjacency(g: WalkGraph): Adjacency {
  const cached = adjacencyCache.get(g);
  if (cached) return cached;
  const n = g.nodes.length / 3, m = g.edges.length / 5;
  const start = new Int32Array(n + 1);
  for (let e = 0; e < m; e++) start[g.edges[e * 5]! + 1]!++;
  for (let i = 0; i < n; i++) start[i + 1]! += start[i]!;
  const fill = start.slice(0, n);
  const out = new Int32Array(m);
  for (let e = 0; e < m; e++) out[fill[g.edges[e * 5]!]!++] = e;
  const comp = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  let label = 0;
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1) continue;
    comp[s] = label;
    stack.push(s);
    while (stack.length) {
      const v = stack.pop()!;
      for (let k = start[v]!; k < start[v + 1]!; k++) {
        const w = g.edges[out[k]! * 5 + 1]!;
        if (comp[w] === -1) {
          comp[w] = label;
          stack.push(w);
        }
      }
    }
    label++;
  }
  const adj = { start, out, comp };
  adjacencyCache.set(g, adj);
  return adj;
}

/** Binary min-heap of node indices keyed by f. */
class Heap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  push(id: number, key: number): void {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p]! <= key) break;
      ids[i] = ids[p]!;
      keys[i] = keys[p]!;
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }
  pop(): number {
    const { ids, keys } = this;
    const top = ids[0]!;
    const lastId = ids.pop()!, lastKey = keys.pop()!;
    if (ids.length === 0) return top;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let c = l;
      if (l >= ids.length) break;
      if (r < ids.length && keys[r]! < keys[l]!) c = r;
      if (keys[c]! >= lastKey) break;
      ids[i] = ids[c]!;
      keys[i] = keys[c]!;
      i = c;
    }
    ids[i] = lastId;
    keys[i] = lastKey;
    return top;
  }
}

function checkNode(g: WalkGraph, v: number, what: string): void {
  const n = g.nodes.length / 3;
  if (!Number.isInteger(v) || v < 0 || v >= n) throw new Error(`route: ${what} node ${v} outside 0..${n - 1}`);
}

const point = (g: WalkGraph, v: number): [number, number, number] => [g.nodes[v * 3]! / 10, g.nodes[v * 3 + 1]! / 10, g.nodes[v * 3 + 2]! / 10];

/** Distance from p to segment a–b in x/z, and |y error| against the linear y at the foot point. */
function deviation(p: readonly number[], a: readonly number[], b: readonly number[]): number {
  const dx = b[0]! - a[0]!, dz = b[1]! - a[1]!;
  const L2 = dx * dx + dz * dz;
  const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0]! - a[0]!) * dx + (p[1]! - a[1]!) * dz) / L2));
  const xz = Math.hypot(p[0]! - (a[0]! + t * dx), p[1]! - (a[1]! + t * dz));
  const y = Math.abs(p[2]! - (a[2]! + t * (b[2]! - a[2]!)));
  return Math.max(xz, y);
}

/** Drop points that lie on the straight 3D line between their kept neighbours (within PATH_EPS). */
function simplifyPath(pts: [number, number, number][]): [number, number, number][] {
  if (pts.length <= 2) return pts;
  const out: [number, number, number][] = [pts[0]!];
  let dropped: [number, number, number][] = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1]!, b = pts[i + 1]!;
    const cand = [...dropped, pts[i]!];
    if (cand.every((p) => deviation(p, a, b) <= PATH_EPS)) dropped = cand;
    else {
      out.push(pts[i]!);
      dropped = [];
    }
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

/** Throws `no walking route to …` when unreachable and `route search too long` past the expansion bound. */
export function route(graph: WalkGraph, from: number, to: number, opts: RouteOptions = {}): RouteResult {
  checkNode(graph, from, "from");
  checkNode(graph, to, "to");
  const maxExpansions = opts.maxExpansions ?? ROUTE_MAX_EXPANSIONS;
  if (!Number.isInteger(maxExpansions) || maxExpansions < 1) throw new Error(`route: maxExpansions must be a positive integer, got ${maxExpansions}`);
  const { start, out, comp } = adjacency(graph);
  if (comp[from] !== comp[to]) throw new Error(`no walking route to node ${to}`);
  const N = graph.nodes, E = graph.edges;
  const n = N.length / 3;
  const [tx, tz, ty] = [N[to * 3]!, N[to * 3 + 1]!, N[to * 3 + 2]!];
  const h = (v: number): number => H_SCALE * Math.hypot(N[v * 3]! - tx, N[v * 3 + 1]! - tz, N[v * 3 + 2]! - ty);
  const gScore = new Float64Array(n).fill(Infinity);
  const via = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const open = new Heap();
  gScore[from] = 0;
  open.push(from, h(from));
  let expansions = 0;
  while (open.size) {
    const v = open.pop();
    if (closed[v]) continue;
    if (v === to) break;
    closed[v] = 1;
    if (++expansions > maxExpansions) throw new Error(`route search too long (over ${maxExpansions} expansions)`);
    for (let k = start[v]!; k < start[v + 1]!; k++) {
      const e = out[k]!;
      const w = E[e * 5 + 1]!;
      if (closed[w]) continue;
      const gw = gScore[v]! + E[e * 5 + 2]!;
      if (gw < gScore[w]!) {
        gScore[w] = gw;
        via[w] = e;
        open.push(w, gw + h(w));
      }
    }
  }
  if (gScore[to] === Infinity) throw new Error(`no walking route to node ${to}`);

  const edges: number[] = [];
  for (let v = to; v !== from; v = E[via[v]! * 5]!) edges.push(via[v]!);
  edges.reverse();
  const nodes = [from, ...edges.map((e) => E[e * 5 + 1]!)];
  const names: string[] = [];
  let len10 = 0;
  for (const e of edges) {
    len10 += E[e * 5 + 2]!;
    const idx = E[e * 5 + 3]!;
    if (idx < 0) continue;
    const name = graph.names[idx];
    if (name === undefined) throw new Error(`route: edge ${e} names index ${idx}, graph has ${graph.names.length} names`);
    if (names[names.length - 1] !== name) names.push(name);
  }
  return { nodes, path: simplifyPath(nodes.map((v) => point(graph, v))), lengthBlocks: len10 / 10, via: names };
}

/** Index of the graph node nearest to block (x, z) in x/z; throws on an empty graph. */
export function nearestNode(graph: WalkGraph, x: number, z: number): number {
  const n = graph.nodes.length / 3;
  if (n === 0) throw new Error("nearestNode: the walk graph has no nodes");
  if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error(`nearestNode: bad point ${x},${z}`);
  let best = 0, bestD = Infinity;
  for (let v = 0; v < n; v++) {
    const d = Math.hypot(graph.nodes[v * 3]! / 10 - x, graph.nodes[v * 3 + 1]! / 10 - z);
    if (d < bestD) [best, bestD] = [v, d];
  }
  return best;
}
