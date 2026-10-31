import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { decodeWalk, packEdgeWidth, validateManifest, type CompanySite, type Manifest, type PlacesDoc, type WalkGraph } from "../public/shared/city.js";
import { resolvePlace } from "../src/city/places";
import { ROUTE_MAX_EXPANSIONS, nearestNode, route } from "../src/city/route";

/** Graph from [x, z, y] nodes (blocks) and [a, b, name|null] links; names are interned, len is the 3D distance. */
function graph(nodes: [number, number, number][], links: [number, number, string | null][]): WalkGraph {
  const names: string[] = [];
  const edges: number[] = [];
  for (const [a, b, name] of links) {
    const [pa, pb] = [nodes[a]!, nodes[b]!];
    const len10 = Math.max(1, Math.round(10 * Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2])));
    let idx = -1;
    if (name !== null) {
      idx = names.indexOf(name);
      if (idx < 0) idx = names.push(name) - 1;
    }
    const w = packEdgeWidth(10, false);
    edges.push(a, b, len10, idx, w, b, a, len10, idx, w);
  }
  return { builtAt: 1, nodes: new Int32Array(nodes.flatMap(([x, z, y]) => [x * 10, z * 10, y * 10])), edges: new Int32Array(edges), names };
}

async function asset(path: string): Promise<Response> {
  const res = await env.ASSETS.fetch(new Request(`https://assets.local${path}`));
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res;
}

describe("route (synthetic)", () => {
  // Main St 0 → 1 → 2 → 3 bends south through 2; Hill Path 1 → 4 → 3 is straight in x/z but climbs 40 blocks,
  // so the 3D-shortest route keeps Main St. 5 — 6 is an island.
  const g = graph(
    [[0, 0, 1], [10, 0, 1], [20, 8, 1], [30, 0, 1], [20, 0, 41], [100, 100, 1], [110, 100, 1]],
    [[0, 1, "Main St"], [1, 2, "Main St"], [2, 3, "Main St"], [1, 4, "Hill Path"], [4, 3, "Hill Path"], [5, 6, "Island Way"]],
  );

  it("finds the shortest 3D route and keeps y on every point", () => {
    const r = route(g, 0, 3);
    expect(r.nodes).toEqual([0, 1, 2, 3]);
    expect(r.via).toEqual(["Main St"]);
    expect(r.lengthBlocks).toBeCloseTo(35.6, 6);
    expect(r.path).toEqual([[0, 0, 1], [10, 0, 1], [20, 8, 1], [30, 0, 1]]);
    expect(route(g, 4, 0).via).toEqual(["Hill Path", "Main St"]);
  });

  it("collinear points merge; a climb is not collinear", () => {
    const line = graph([[0, 0, 1], [5, 0, 1], [10, 0, 1], [15, 0, 2], [20, 0, 3]], [[0, 1, "A"], [1, 2, "A"], [2, 3, "B"], [3, 4, "B"]]);
    const r = route(line, 0, 4);
    expect(r.path).toEqual([[0, 0, 1], [10, 0, 1], [20, 0, 3]]);
    expect(r.via).toEqual(["A", "B"]);
  });

  it("from == to is a one-point path", () => {
    expect(route(g, 2, 2)).toEqual({ nodes: [2], path: [[20, 8, 1]], lengthBlocks: 0, via: [] });
  });

  it("an unreachable target throws", () => {
    expect(() => route(g, 0, 6)).toThrow(/no walking route to node 6/);
    expect(() => route(g, 0, 99)).toThrow(/to node 99 outside/);
  });

  it("a search over the expansion bound throws `route search too long`", () => {
    expect(() => route(g, 0, 3, { maxExpansions: 2 })).toThrow(/route search too long/);
    // a serpentine of 25 600 nodes: the only way to the far end expands every node, past the default bound
    const W = 160, H = 160;
    const nodes: [number, number, number][] = [];
    for (let row = 0; row < H; row++) for (let k = 0; k < W; k++) nodes.push([row % 2 ? W - 1 - k : k, row * 2, 1]);
    const links: [number, number, null][] = [];
    for (let i = 1; i < nodes.length; i++) links.push([i - 1, i, null]);
    const snake = graph(nodes, links);
    expect(nodes.length).toBeGreaterThan(ROUTE_MAX_EXPANSIONS);
    expect(() => route(snake, 0, nodes.length - 1)).toThrow(/route search too long/);
    expect(route(snake, 0, W + 5).nodes.length).toBe(W + 6);
  });

  it("nearestNode picks the closest node in x/z", () => {
    expect(nearestNode(g, 19, 1)).toBe(4);
    expect(nearestNode(g, 104, 99)).toBe(5);
  });
});

describe("route (fixture walk.bin)", () => {
  it("every fixture place reaches the ferry, across the deck", async () => {
    const manifest = validateManifest(await (await asset("/city/fixture/manifest.json")).json()) as Manifest;
    const walk = decodeWalk(new Uint8Array(await (await asset("/city/fixture/walk.bin")).arrayBuffer()), manifest);
    const places = (await (await asset("/city/fixture/places.json")).json()) as PlacesDoc;
    const sites = ((await (await asset("/city/fixture/companies.json")).json()) as { sites: CompanySite[] }).sites;
    const ctx = { places, sites };
    const ferry = resolvePlace("the ferry", ctx);
    const labs = resolvePlace("Fixture Labs", ctx);
    const r = route(walk, labs.node, ferry.node);
    expect(r.via).toContain("Fixture Ave");
    expect(r.path.every((p) => p.length === 3 && Number.isFinite(p[2]))).toBe(true);
    for (const p of places.places) expect(route(walk, p.node, ferry.node).nodes.at(-1)).toBe(ferry.node);
  });
});

// [post-int] needs the v2 sf rebuild (public/city/sf/walk.bin); skipped while public/city/sf is a v1 build
const sfManifest = (await (await env.ASSETS.fetch(new Request("https://assets.local/city/sf/manifest.json"))).json()) as { version: number };
describe.skipIf(sfManifest.version !== 2)("route (sf) [post-int]", () => {
  it("Firegoat → Ferry Building goes via 2nd St at 1.0–1.6× the straight line", async () => {
    const manifest = validateManifest(sfManifest) as Manifest;
    const walk = decodeWalk(new Uint8Array(await (await asset(`/city/sf/${manifest.walk}`)).arrayBuffer()), manifest);
    const places = (await (await asset(`/city/sf/${manifest.places}`)).json()) as PlacesDoc;
    const sites = ((await (await asset("/city/sf/companies.json")).json()) as { sites: CompanySite[] }).sites;
    const ctx = { places, sites };
    const from = resolvePlace("Firegoat", ctx), to = resolvePlace("Ferry Building", ctx);
    const r = route(walk, from.node, to.node);
    expect(r.via).toContain("2nd St");
    const [a, b] = [r.path[0]!, r.path.at(-1)!];
    const straight = Math.hypot(a[0] - b[0], a[1] - b[1]);
    expect(r.lengthBlocks / straight).toBeGreaterThanOrEqual(1);
    expect(r.lengthBlocks / straight).toBeLessThanOrEqual(1.6);
  });
});
