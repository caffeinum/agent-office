// Stand-in navigation for the City DO tests while W5's route.ts / places.ts are still W1 stubs. As soon as the real
// ones answer, navForTests() returns them instead, so these tests run against W5's code after the merge.
import type { Place, WalkGraph } from "../public/shared/city.js";
import { route, type RouteResult } from "../src/city/route";
import { PlaceError, resolvePlace, type PlaceContext } from "../src/city/places";
import type { Nav } from "../src/city/do";

function fixtureRoute(g: WalkGraph, from: number, to: number, opts: { maxExpansions?: number } = {}): RouteResult {
  const n = g.nodes.length / 3;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const prevEdge = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[from] = 0;
  let expansions = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i]! < Infinity && (u < 0 || dist[i]! < dist[u]!)) u = i;
    if (u < 0) throw new Error(`no walking route to node ${to}`);
    if (++expansions > (opts.maxExpansions ?? 20000)) throw new Error("route search too long");
    if (u === to) break;
    done[u] = 1;
    for (let e = 0; e < g.edges.length / 5; e++) {
      if (g.edges[e * 5] !== u) continue;
      const v = g.edges[e * 5 + 1]!;
      const d = dist[u]! + g.edges[e * 5 + 2]! / 10;
      if (d < dist[v]!) {
        dist[v] = d;
        prev[v] = u;
        prevEdge[v] = e;
      }
    }
  }
  const nodes: number[] = [];
  const via: string[] = [];
  for (let v = to; v !== -1; v = prev[v]!) {
    nodes.unshift(v);
    const e = prevEdge[v]!;
    const name = e >= 0 ? g.names[g.edges[e * 5 + 3]!] : undefined;
    if (name && via[0] !== name) via.unshift(name);
  }
  const path = nodes.map((v) => [g.nodes[v * 3]! / 10, g.nodes[v * 3 + 1]! / 10, g.nodes[v * 3 + 2]! / 10] as [number, number, number]);
  let lengthBlocks = 0;
  for (let i = 1; i < path.length; i++) lengthBlocks += Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1]);
  return { nodes, path, lengthBlocks, via };
}

const norm = (s: string) => s.toLowerCase().replace(/\s+(and|at)\s+/g, " & ").replace(/[^a-z0-9&]+/g, "");

function fixtureResolve(query: string, ctx: PlaceContext): Place {
  const q = norm(query);
  const hits = ctx.places.places.filter((p) => [p.name, ...p.aliases].some((a) => norm(a) === q));
  if (hits.length === 1) return hits[0]!;
  const loose = ctx.places.places.filter((p) => norm(p.name).includes(q));
  throw new PlaceError(hits.length > 1 ? `"${query}" is ambiguous` : `no place "${query}"`, (hits.length > 1 ? hits : loose).slice(0, 5));
}

const stubbed = (f: () => unknown) => {
  try {
    f();
    return false;
  } catch (e) {
    return e instanceof Error && /not implemented yet/.test(e.message);
  }
};

export function navForTests(): Nav {
  const empty: WalkGraph = { builtAt: 1, nodes: new Int32Array([0, 0, 0]), edges: new Int32Array(0), names: [] };
  return {
    route: stubbed(() => route(empty, 0, 0)) ? fixtureRoute : route,
    resolvePlace: stubbed(() => resolvePlace("x", { places: { builtAt: "", places: [] }, sites: [] })) ? fixtureResolve : resolvePlace,
  };
}
