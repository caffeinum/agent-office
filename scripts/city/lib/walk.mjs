// W5 (spec-v2 §7.6): the pedestrian graph (walk.bin) and the place list (places.json), built from OSM highway ways,
// the chunk ground and report.json deck tops. Pure: no file access; walk-sf.mjs does the I/O.
//
// Ways: footway, pedestrian, living_street, residential, unclassified (Presidio/Marine Dr), tertiary, secondary, primary, named service roads (not
// parking aisles) and busway, plus their _link ramps, after the v1 keepHighway filter (no tunnels, layer < 0, indoor,
// sidewalks or crossings: walkers use the street centreline with a right-hand offset of halfWidth). Unnamed service
// roads (driveways, lots, loading docks) are left out to keep walk.bin inside its 150 KB gzip budget. Bridges ≥ 300 m
// are left out; shorter ones are decks at the report.json deck top.
//
// y: a ground node stands at the chunk ground of its column; a deck node at its way's deck top. Where a deck way meets
// a ground way at a different y, the shared OSM vertex becomes one node per y, joined by a vertical connector edge.
//
// Pipeline: ways are sampled every block and cut where they leave the listed chunks or reach water (ground 0, not a
// deck) → junction-to-junction segments → same-street segments joined through degree-2 nodes, ground segments under
// CONTRACT blocks collapsed, unnamed dead ends under SPUR_MAX blocks dropped → each segment simplified with
// Douglas-Peucker, keeping a node wherever the straight edge would be more than XZ_TOL (unnamed: XZ_TOL_PATH) blocks
// off the polyline or more than Y_TOL = 1 block off the ground → islands (footways that met only the left-out
// sidewalks) linked to the main graph within LINK_MAX blocks, the rest dropped → intersections, doors and places
// snapped onto the graph.
import {
  CHUNK, WALK_NO_NAME, blockToLonLat, chunkKey, intersectionName, lonLatToBlock, packEdgeWidth, validatePlaces, validateWalk,
} from "../../../public/shared/city.js";
import { highwayClass, keepHighway, roadSpec } from "./osm.mjs";

export const WALK_CLASSES = Object.freeze(["footway", "pedestrian", "living_street", "residential", "unclassified", "tertiary", "secondary", "primary", "service", "busway"]);
/** Bridge ways at or over this length (metres) are not walkable (spec-v2 §3.8). */
export const DECK_MAX_M = 300;
/** Simplification tolerances, blocks. */
export const XZ_TOL = 3;
export const XZ_TOL_PATH = 6;
export const Y_TOL = 1;
/** A company door must lie within this many blocks of a walkable edge, a landmark or area within SNAP_PLACE. */
export const SNAP_DOOR = 30;
export const SNAP_PLACE = 80;
/** Nodes of one street pair closer than this (blocks) are one intersection place. */
export const INTERSECTION_MERGE = 24;
const BUSWAY_SPEC = Object.freeze({ roadway: 3, sidewalk: 0 });
const CONNECTOR_HW10 = 10;
/** Ground segments shorter than this (blocks) collapse into one node; unnamed dead ends shorter than SPUR_MAX go. */
export const CONTRACT = 2;
export const SPUR_MAX = 30;
/** An island component joins the main graph when one of its nodes is within LINK_MAX blocks of a main edge. */
export const LINK_MAX = 8;
const DOOR_HW10 = 10;
const BLOCK_M = 3;

const SUFFIX_ABBR = Object.freeze({
  Street: "St", Avenue: "Ave", Boulevard: "Blvd", Drive: "Dr", Place: "Pl", Lane: "Ln", Road: "Rd", Court: "Ct", Terrace: "Ter",
});

/** OSM street name → display name with the final suffix abbreviated ("2nd Street" → "2nd St"). */
export function streetName(name) {
  if (typeof name !== "string" || name.trim() === "") throw new Error(`streetName: bad name ${JSON.stringify(name)}`);
  const words = name.trim().split(/\s+/);
  const last = words[words.length - 1];
  if (words.length > 1 && SUFFIX_ABBR[last]) words[words.length - 1] = SUFFIX_ABBR[last];
  return words.join(" ");
}

/** Is this OSM highway way part of the walk graph? */
export function isWalkable(tags) {
  if (!keepHighway(tags)) return false;
  if (!WALK_CLASSES.includes(highwayClass(tags.highway))) return false;
  if (tags.highway === "service" && (tags.service === "parking_aisle" || !tags.name)) return false;
  if (tags.foot === "no") return false;
  if ((tags.access === "private" || tags.access === "no") && tags.foot !== "yes" && tags.foot !== "designated") return false;
  return true;
}

const isBridge = (tags) => tags.bridge !== undefined && tags.bridge !== "no";

function halfWidth10(tags) {
  const spec = highwayClass(tags.highway) === "busway" ? BUSWAY_SPEC : roadSpec(tags);
  if (!spec) throw new Error(`walk: no road width for highway=${tags.highway}`);
  return Math.max(5, Math.round(5 * (spec.roadway + 2 * spec.sidewalk)));
}

const r10 = (v) => Math.round(v * 10) / 10;

/** Polyline [{x, z, key}] → samples at most 1 block apart (vertices keep their key), rounded to 0.1 block. */
function densify(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    out.push({ x: r10(p.x), z: r10(p.z), key: p.key });
    if (i === pts.length - 1) break;
    const q = pts[i + 1];
    const n = Math.ceil(Math.hypot(q.x - p.x, q.z - p.z));
    for (let k = 1; k < n; k++) out.push({ x: r10(p.x + ((q.x - p.x) * k) / n), z: r10(p.z + ((q.z - p.z) * k) / n), key: null });
  }
  return out;
}

function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz;
  const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2));
  return { d: Math.hypot(px - (ax + t * dx), pz - (az + t * dz)), t };
}

/** Douglas-Peucker over samples [i..j] with the x/z and y tolerances; returns kept indices (sorted, i and j included). */
function simplify(s, arc, i, j, xzTol) {
  const keep = [i, j];
  const stack = [[i, j]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    let worst = 0, at = -1;
    const span = arc[b] - arc[a];
    for (let k = a + 1; k < b; k++) {
      const { d } = segDist(s[k].x, s[k].z, s[a].x, s[a].z, s[b].x, s[b].z);
      const yExp = span === 0 ? s[a].y : s[a].y + ((s[b].y - s[a].y) * (arc[k] - arc[a])) / span;
      const err = Math.max(d / xzTol, Math.abs(s[k].y - yExp) / Y_TOL);
      if (err > worst) [worst, at] = [err, k];
    }
    if (worst > 1) {
      keep.push(at);
      stack.push([a, at], [at, b]);
    }
  }
  return [...new Set(keep)].sort((p, q) => p - q);
}

function validateDecks(decks) {
  if (decks === null || typeof decks !== "object" || Array.isArray(decks)) throw new Error("walk: decks must be {wayId: deckY}");
  for (const [k, v] of Object.entries(decks)) {
    if (!/^[1-9]\d*$/.test(k)) throw new Error(`walk: decks key ${JSON.stringify(k)} is not an OSM way id`);
    if (!Number.isInteger(v) || v < 1) throw new Error(`walk: decks[${k}] = ${v} is not a deck top ≥ 1`);
  }
}

function validatePlaceSrc(p, i) {
  const what = `places.src[${i}]`;
  const keys = ["id", "kind", "name", "aliases", "lat", "lon", "source"];
  for (const k of keys) if (!(k in p)) throw new Error(`${what}: missing "${k}"`);
  for (const k of Object.keys(p)) if (!keys.includes(k)) throw new Error(`${what}: unknown field "${k}"`);
  if (p.kind !== "landmark" && p.kind !== "area") throw new Error(`${what}.kind must be landmark|area, got ${p.kind}`);
  if (!/^(lm|area):[a-z0-9-]+$/.test(p.id)) throw new Error(`${what}.id ${JSON.stringify(p.id)} must be lm:<slug> or area:<slug>`);
  if (!p.id.startsWith(p.kind === "landmark" ? "lm:" : "area:")) throw new Error(`${what}.id ${p.id} does not match kind ${p.kind}`);
  if (typeof p.source?.url !== "string" || !/^https:\/\//.test(p.source.url)) throw new Error(`${what}.source.url must be an https URL`);
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) throw new Error(`${what}: lat/lon must be numbers`);
}

class Graph {
  constructor() {
    this.x10 = [];
    this.z10 = [];
    this.y10 = [];
    this.byKey = new Map();
    /** pair "a,b" (a < b) → {a, b, len, name, hw10, deck} */
    this.edges = new Map();
    this.names = [];
    this.nameIdx = new Map();
  }
  node(x, z, y, key) {
    if (key !== null && this.byKey.has(key)) return this.byKey.get(key);
    const n = this.x10.length;
    this.x10.push(Math.round(x * 10));
    this.z10.push(Math.round(z * 10));
    this.y10.push(Math.round(y * 10));
    if (key !== null) this.byKey.set(key, n);
    return n;
  }
  name(s) {
    if (s === null) return WALK_NO_NAME;
    if (!this.nameIdx.has(s)) {
      this.nameIdx.set(s, this.names.length);
      this.names.push(s);
    }
    return this.nameIdx.get(s);
  }
  link(a, b, len, name, hw10, deck) {
    if (a === b) return;
    const k = a < b ? `${a},${b}` : `${b},${a}`;
    const old = this.edges.get(k);
    if (old && old.len <= len) return;
    this.edges.set(k, { a: Math.min(a, b), b: Math.max(a, b), len, name, hw10, deck });
  }
  dist(a, b) {
    return Math.hypot(this.x10[a] - this.x10[b], this.z10[a] - this.z10[b], this.y10[a] - this.y10[b]) / 10;
  }
}

/**
 * Build the pedestrian graph and the place list.
 * @param {{
 *   roads: object[],                         // cached OSM highway ways (osm-roads.json elements, merged areas)
 *   decks: Record<string, number>,           // report.json decks: {wayId: deckY}
 *   groundAt: (x: number, z: number) => number,
 *   manifest: import("../../../public/shared/city.js").Manifest,
 *   sites: import("../../../public/shared/city.js").CompanySite[],
 *   placesSrc: object[],                     // scripts/city/sf/places.src.json
 * }} input
 * @returns {{ walk: import("../../../public/shared/city.js").WalkGraph, places: import("../../../public/shared/city.js").PlacesDoc, stats: object }}
 *   walk.builtAt = Date.parse(manifest.builtAt); write with encodeWalk(walk, manifest) and validatePlaces.
 */
export function buildWalk({ roads, decks, groundAt, manifest, sites, placesSrc }) {
  if (!Array.isArray(roads)) throw new Error("buildWalk: roads must be an array of OSM ways");
  if (typeof groundAt !== "function") throw new Error("buildWalk: groundAt must be a function");
  if (!Array.isArray(sites)) throw new Error("buildWalk: sites must be an array");
  if (!Array.isArray(placesSrc)) throw new Error("buildWalk: placesSrc must be an array");
  validateDecks(decks);
  placesSrc.forEach(validatePlaceSrc);
  const proj = manifest.proj;
  const listed = new Set(manifest.chunks.list.map(([cx, cz]) => chunkKey(cx, cz)));
  const waterChunks = new Set(manifest.water.map(([cx, cz]) => chunkKey(cx, cz)));
  const chunkAt = (x, z) => chunkKey(Math.floor(Math.floor(x) / CHUNK), Math.floor(Math.floor(z) / CHUNK));
  const stats = { ways: 0, deckWays: 0, longBridges: 0, outside: 0, droppedWaterSamples: 0, connectors: 0 };

  const ways = [];
  const seen = new Set();
  for (const w of roads) {
    if (w.type !== "way" || !Array.isArray(w.geometry)) throw new Error(`walk: road element ${w.type}/${w.id} is not a way with geometry`);
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    const tags = w.tags ?? {};
    if (!isWalkable(tags)) continue;
    const pts = w.geometry.map((g) => ({ ...lonLatToBlock(g.lon, g.lat, proj), key: `${g.lat},${g.lon}` }));
    if (pts.length < 2) continue;
    let lenB = 0;
    for (let i = 1; i < pts.length; i++) lenB += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    if (!pts.some((p) => listed.has(chunkAt(p.x, p.z)) || waterChunks.has(chunkAt(p.x, p.z)))) {
      stats.outside++;
      continue;
    }
    let deckY = null;
    if (decks[w.id] !== undefined) deckY = decks[w.id];
    else if (isBridge(tags)) {
      if (lenB * BLOCK_M >= DECK_MAX_M) {
        stats.longBridges++;
        continue;
      }
      throw new Error(`walk: bridge way ${w.id} (${tags.name ?? tags.highway}, ${Math.round(lenB * BLOCK_M)} m) has no deck top in report.json decks`);
    }
    ways.push({ id: w.id, tags, pts, deckY });
  }

  const uses = new Map();
  for (const w of ways) {
    w.pts.forEach((p, i) => uses.set(p.key, (uses.get(p.key) ?? 0) + (i === 0 || i === w.pts.length - 1 ? 2 : 1)));
  }

  const sg = new SegGraph();
  const names = new Graph();
  const variants = new Map();
  for (const w of ways) {
    stats.ways++;
    if (w.deckY !== null) stats.deckWays++;
    const deck = w.deckY !== null;
    const attrs = { name: names.name(w.tags.name ? streetName(w.tags.name) : null), hw10: halfWidth10(w.tags), deck, conn: false };
    const s = densify(w.pts);
    for (const p of s) {
      const ck = chunkAt(p.x, p.z);
      if (deck) {
        p.y = listed.has(ck) || waterChunks.has(ck) ? w.deckY : null;
        continue;
      }
      if (!listed.has(ck)) {
        p.y = null;
        continue;
      }
      const y = groundAt(Math.floor(p.x), Math.floor(p.z));
      if (!Number.isInteger(y) || y < 0) throw new Error(`walk: groundAt(${Math.floor(p.x)}, ${Math.floor(p.z)}) = ${y}`);
      if (y === 0) stats.droppedWaterSamples++;
      p.y = y === 0 ? null : y;
    }
    let start = -1;
    for (let i = 0; i <= s.length; i++) {
      const ok = i < s.length && s[i].y !== null;
      if (ok && start < 0) start = i;
      if (!ok && start >= 0) {
        if (i - start >= 2) addRun(s.slice(start, i), attrs);
        start = -1;
      }
    }
  }

  function endNode(p) {
    if (!p.key) return sg.node(p, null);
    const n = sg.node(p, `${p.key}|${p.y}`);
    if (!variants.has(p.key)) variants.set(p.key, new Set());
    variants.get(p.key).add(n);
    return n;
  }
  function addRun(run, attrs) {
    let from = 0;
    for (let k = 1; k < run.length; k++) {
      if (k < run.length - 1 && !(run[k].key && uses.get(run[k].key) >= 2)) continue;
      const pts = run.slice(from, k + 1).map(({ x, z, y }) => ({ x, z, y }));
      sg.seg(endNode(run[from]), endNode(run[k]), pts, attrs);
      from = k;
    }
  }
  for (const set of variants.values()) {
    if (set.size < 2) continue;
    const v = [...set].sort((a, b) => sg.nodes[a].y - sg.nodes[b].y);
    for (let k = 1; k < v.length; k++) {
      const [lo, hi] = [sg.nodes[v[k - 1]], sg.nodes[v[k]]];
      sg.seg(v[k - 1], v[k], [{ ...lo }, { ...hi }], { name: WALK_NO_NAME, hw10: CONNECTOR_HW10, deck: false, conn: true });
      stats.connectors++;
    }
  }
  stats.rawSegments = sg.segs.length;
  mergeChains(sg);
  stats.contracted = contractShort(sg);
  mergeChains(sg);
  stats.prunedSpurs = pruneSpurs(sg);
  mergeChains(sg);

  const g = new Graph();
  g.names = names.names;
  g.nameIdx = names.nameIdx;
  const gNode = new Map();
  const toG = (n) => {
    if (!gNode.has(n)) gNode.set(n, g.node(sg.nodes[n].x, sg.nodes[n].z, sg.nodes[n].y, null));
    return gNode.get(n);
  };
  for (const seg of sg.segs) {
    if (!seg.alive) continue;
    const pts = seg.pts;
    if (seg.conn) {
      g.link(toG(seg.a), toG(seg.b), Math.abs(pts[1].y - pts[0].y), seg.name, seg.hw10, false);
      continue;
    }
    const arc = [0];
    for (let k = 1; k < pts.length; k++) arc.push(arc[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z));
    const kept = simplify(pts, arc, 0, pts.length - 1, seg.name === WALK_NO_NAME ? XZ_TOL_PATH : XZ_TOL);
    const ids = kept.map((k, i) => (i === 0 ? toG(seg.a) : i === kept.length - 1 ? toG(seg.b) : g.node(pts[k].x, pts[k].z, pts[k].y, null)));
    for (let k = 1; k < kept.length; k++) {
      let len = 0;
      for (let q = kept[k - 1] + 1; q <= kept[k]; q++) len += Math.hypot(pts[q].x - pts[q - 1].x, pts[q].z - pts[q - 1].z, pts[q].y - pts[q - 1].y);
      g.link(ids[k - 1], ids[k], len, seg.name, seg.hw10, seg.deck);
    }
  }

  Object.assign(stats, joinComponents(g, groundAt));
  const pruned = largestComponent(g);
  Object.assign(stats, pruned.stats);
  const G = pruned.graph;
  const intersections = buildIntersections(G, proj);
  const snapper = new Snapper(G, groundAt);

  const placeOut = [];
  const project = (lon, lat) => {
    const p = lonLatToBlock(lon, lat, proj);
    return { x: Number(p.x.toFixed(3)), z: Number(p.z.toFixed(3)) };
  };
  const doorNodes = new Map();
  for (const s of sites) {
    const door = [s.anchor.x, s.anchor.z];
    const dk = `${door[0]},${door[1]}`;
    if (!doorNodes.has(dk)) {
      const y = groundAt(door[0], door[1]);
      if (!Number.isInteger(y) || y < 1) throw new Error(`walk: site ${s.id} door ${dk} has ground ${y}, not land`);
      const snap = snapper.snap(door[0] + 0.5, door[1] + 0.5, SNAP_DOOR, `site ${s.id} door ${dk}`);
      let d = snap.node;
      if (snap.dist >= 0.5) {
        d = G.node(door[0] + 0.5, door[1] + 0.5, y, null);
        G.link(d, snap.node, G.dist(d, snap.node), WALK_NO_NAME, DOOR_HW10, false);
      }
      doorNodes.set(dk, d);
    }
    const aliases = [...new Set([s.address, s.address.split(",")[0].trim()])];
    placeOut.push({
      id: `site:${s.id}`, kind: "company", name: s.name, aliases, lat: s.lat, lon: s.lon, ...project(s.lon, s.lat),
      node: doorNodes.get(dk), siteId: s.id, door,
    });
  }
  for (const p of placesSrc) {
    const at = lonLatToBlock(p.lon, p.lat, proj);
    const snap = snapper.snap(at.x, at.z, SNAP_PLACE, `place ${p.id}`);
    placeOut.push({ id: p.id, kind: p.kind, name: p.name, aliases: [...p.aliases], lat: p.lat, lon: p.lon, ...project(p.lon, p.lat), node: snap.node });
  }
  placeOut.push(...intersections);
  stats.intersections = intersections.length;

  const { walk: built, order } = G.toWalk(Date.parse(manifest.builtAt));
  const walk = validateWalk(built, manifest);
  for (const p of placeOut) p.node = order[p.node];
  const places = validatePlaces({ builtAt: manifest.builtAt, places: placeOut }, manifest, walk);
  stats.nodes = walk.nodes.length / 3;
  stats.edges = walk.edges.length / 5;
  return { walk, places, stats };
}

/** Hilbert index of (x, z) on a 2^13 grid (the reserved grid is ≤ 7168 blocks a side). */
function hilbert(x, z) {
  let d = 0;
  for (let s = 1 << 12; s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0, ry = (z & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) [x, z] = [s - 1 - x, s - 1 - z];
      [x, z] = [z, x];
    }
  }
  return d;
}

/**
 * → {walk, order}: nodes in Hilbert order of their column and edges sorted by (min, max) end, so walk.bin
 * gzips well; order[old] = new node index.
 */
Graph.prototype.toWalk = function toWalk(builtAt) {
  const n = this.x10.length;
  const h = Array.from({ length: n }, (_, i) => hilbert(Math.floor(this.x10[i] / 10) & 8191, Math.floor(this.z10[i] / 10) & 8191));
  const perm = Array.from({ length: n }, (_, i) => i).sort((a, b) => h[a] - h[b] || a - b);
  const order = new Int32Array(n);
  perm.forEach((old, i) => (order[old] = i));
  const nodes = new Int32Array(n * 3);
  perm.forEach((old, i) => nodes.set([this.x10[old], this.z10[old], this.y10[old]], i * 3));
  const list = [];
  for (const e of this.edges.values()) {
    const len10 = Math.max(1, Math.round(e.len * 10));
    const w = packEdgeWidth(e.hw10, e.deck);
    const [a, b] = [Math.min(order[e.a], order[e.b]), Math.max(order[e.a], order[e.b])];
    list.push([a, b, len10, e.name, w, b, a, len10, e.name, w]);
  }
  list.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  return { walk: { builtAt, nodes, edges: new Int32Array(list.flat()), names: [...this.names] }, order };
};

/** Keep only the largest connected component (renumbered, names compacted). */
function largestComponent(g) {
  const n = g.x10.length;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (const e of g.edges.values()) parent[find(e.a)] = find(e.b);
  const size = new Map();
  for (let i = 0; i < n; i++) size.set(find(i), (size.get(find(i)) ?? 0) + 1);
  if (size.size === 0) throw new Error("walk: no walkable ways inside the listed chunks");
  const [root, keepN] = [...size.entries()].sort((a, b) => b[1] - a[1])[0];
  const out = new Graph();
  const map = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (find(i) !== root) continue;
    map[i] = out.x10.length;
    out.x10.push(g.x10[i]);
    out.z10.push(g.z10[i]);
    out.y10.push(g.y10[i]);
  }
  for (const e of g.edges.values()) {
    if (map[e.a] < 0) continue;
    out.link(map[e.a], map[e.b], e.len, e.name === WALK_NO_NAME ? WALK_NO_NAME : out.name(g.names[e.name]), e.hw10, e.deck);
  }
  const sizes = [...size.values()].sort((a, b) => b - a);
  return { graph: out, stats: { components: size.size, largestShare: keepN / n, droppedNodes: n - keepN, nextComponents: sizes.slice(1, 8) } };
}

function slug(s) {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** One place per street pair and cluster of meeting nodes (spec-v2 §4 places.json). */
function buildIntersections(g, proj) {
  const namesAt = Array.from({ length: g.x10.length }, () => new Set());
  for (const e of g.edges.values()) {
    if (e.name === WALK_NO_NAME) continue;
    namesAt[e.a].add(e.name);
    namesAt[e.b].add(e.name);
  }
  const byPair = new Map();
  const cmp = new Intl.Collator("en", { numeric: true }).compare;
  namesAt.forEach((set, n) => {
    if (set.size < 2) return;
    const list = [...set].map((i) => g.names[i]).sort(cmp);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const k = `${list[i]}\u0000${list[j]}`;
        if (!byPair.has(k)) byPair.set(k, []);
        byPair.get(k).push(n);
      }
    }
  });
  const out = [];
  for (const [k, nodes] of byPair) {
    const [a, b] = k.split("\u0000");
    const clusters = [];
    for (const n of nodes) {
      const c = clusters.find((cl) => cl.some((m) => Math.hypot(g.x10[m] - g.x10[n], g.z10[m] - g.z10[n]) / 10 <= INTERSECTION_MERGE));
      if (c) c.push(n);
      else clusters.push([n]);
    }
    clusters.forEach((cl, ci) => {
      const cx = cl.reduce((s, m) => s + g.x10[m], 0) / cl.length, cz = cl.reduce((s, m) => s + g.z10[m], 0) / cl.length;
      const node = cl.reduce((best, m) => (Math.hypot(g.x10[m] - cx, g.z10[m] - cz) < Math.hypot(g.x10[best] - cx, g.z10[best] - cz) ? m : best), cl[0]);
      const ll = blockToLonLat(g.x10[node] / 10, g.z10[node] / 10, proj);
      const lat = Number(ll.lat.toFixed(7)), lon = Number(ll.lon.toFixed(7));
      const p = lonLatToBlock(lon, lat, proj);
      out.push({
        id: `x:${slug(a)}&${slug(b)}${ci ? `-${ci + 1}` : ""}`, kind: "intersection", name: intersectionName(a, b),
        aliases: [intersectionName(b, a)], lat, lon, x: Number(p.x.toFixed(3)), z: Number(p.z.toFixed(3)), node,
      });
    });
  }
  return out;
}

/** Nearest-edge snapping on a 16-block bucket grid; splits the edge at the foot point. Deck and connector edges are skipped. */
class Snapper {
  constructor(g, groundAt, accept = () => true) {
    this.g = g;
    this.groundAt = groundAt;
    this.accept = accept;
    this.cell = 16;
    this.buckets = new Map();
    for (const [k, e] of g.edges) this.add(k, e);
  }
  add(k, e) {
    const g = this.g;
    if (e.deck || !this.accept(e) || (g.x10[e.a] === g.x10[e.b] && g.z10[e.a] === g.z10[e.b])) return;
    const c = this.cell * 10;
    const [x0, x1] = [Math.min(g.x10[e.a], g.x10[e.b]), Math.max(g.x10[e.a], g.x10[e.b])].map((v) => Math.floor(v / c));
    const [z0, z1] = [Math.min(g.z10[e.a], g.z10[e.b]), Math.max(g.z10[e.a], g.z10[e.b])].map((v) => Math.floor(v / c));
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const b = `${cx},${cz}`;
        if (!this.buckets.has(b)) this.buckets.set(b, new Set());
        this.buckets.get(b).add(k);
      }
    }
  }
  /** → {k, e, d (blocks), t} of the nearest indexed edge within maxDist, or null */
  nearest(x, z, maxDist) {
    const g = this.g;
    const r = Math.ceil(maxDist / this.cell);
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    let best = null;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const set = this.buckets.get(`${cx + dx},${cz + dz}`);
        if (!set) continue;
        for (const k of set) {
          const e = g.edges.get(k);
          if (!e) continue;
          const { d, t } = segDist(x * 10, z * 10, g.x10[e.a], g.z10[e.a], g.x10[e.b], g.z10[e.b]);
          if (!best || d < best.d || (d === best.d && k < best.k)) best = { k, e, d, t };
        }
      }
    }
    if (!best || best.d / 10 > maxDist) return null;
    return { ...best, d: best.d / 10 };
  }
  /** Node at the foot point of `hit` (an end node within 0.5 block, else a new node splitting the edge). */
  split(hit, what) {
    const g = this.g;
    const { k, e, t } = hit;
    const L = Math.hypot(g.x10[e.b] - g.x10[e.a], g.z10[e.b] - g.z10[e.a]) / 10;
    if (t * L < 0.5) return e.a;
    if ((1 - t) * L < 0.5) return e.b;
    const fx = Math.round(g.x10[e.a] + t * (g.x10[e.b] - g.x10[e.a])) / 10;
    const fz = Math.round(g.z10[e.a] + t * (g.z10[e.b] - g.z10[e.a])) / 10;
    const y = this.groundAt(Math.floor(fx), Math.floor(fz));
    if (!Number.isInteger(y) || y < 1) throw new Error(`walk: ${what} snaps to ${fx},${fz}, which has ground ${y}`);
    const node = g.node(fx, fz, y, null);
    g.edges.delete(k);
    for (const [a, b, f] of [[e.a, node, t], [node, e.b, 1 - t]]) {
      g.link(a, b, Math.max(0.1, e.len * f), e.name, e.hw10, e.deck);
      const nk = a < b ? `${a},${b}` : `${b},${a}`;
      this.add(nk, g.edges.get(nk));
    }
    return node;
  }
  snap(x, z, maxDist, what) {
    const hit = this.nearest(x, z, maxDist);
    if (!hit) throw new Error(`walk: ${what} is more than ${maxDist} blocks from any walkable edge`);
    return { node: this.split(hit, what), dist: hit.d };
  }
}

/** Raw graph: junction nodes and junction-to-junction segments that carry their dense samples. */
class SegGraph {
  constructor() {
    this.nodes = [];
    this.byKey = new Map();
    this.segs = [];
  }
  node(p, key) {
    if (key !== null && this.byKey.has(key)) return this.byKey.get(key);
    this.nodes.push({ x: p.x, z: p.z, y: p.y });
    if (key !== null) this.byKey.set(key, this.nodes.length - 1);
    return this.nodes.length - 1;
  }
  seg(a, b, pts, attrs) {
    this.segs.push({ a, b, pts, ...attrs, alive: true });
  }
  incidence() {
    const inc = new Map();
    const push = (n, i) => {
      if (!inc.has(n)) inc.set(n, []);
      inc.get(n).push(i);
    };
    this.segs.forEach((s, i) => {
      if (!s.alive) return;
      push(s.a, i);
      push(s.b, i);
    });
    return inc;
  }
}

const arcLen = (pts) => {
  let L = 0;
  for (let k = 1; k < pts.length; k++) L += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
  return L;
};
const sameAttrs = (s, t) => !s.conn && !t.conn && s.name === t.name && s.deck === t.deck && (s.hw10 === t.hw10 || s.name === WALK_NO_NAME);

/** Join segments through degree-2 nodes where both sides are the same street (OSM splits ways at tag changes). */
function mergeChains(sg) {
  const inc = sg.incidence();
  const replace = (n, from, to) => {
    const list = inc.get(n);
    const i = list.indexOf(from);
    if (i < 0) throw new Error(`walk: segment ${from} missing at node ${n}`);
    list[i] = to;
  };
  for (const [v, list] of inc) {
    if (list.length !== 2 || list[0] === list[1]) continue;
    let [s1, s2] = list.map((i) => sg.segs[i]);
    if (!sameAttrs(s1, s2)) continue;
    const [i1, i2] = list;
    if (s1.b !== v) s1 = { ...s1, a: s1.b, b: s1.a, pts: [...s1.pts].reverse() };
    if (s2.a !== v) s2 = { ...s2, a: s2.b, b: s2.a, pts: [...s2.pts].reverse() };
    sg.segs[i1].alive = false;
    sg.segs[i2].alive = false;
    sg.seg(s1.a, s2.b, s1.pts.concat(s2.pts.slice(1)), { name: s1.name, hw10: Math.max(s1.hw10, s2.hw10), deck: s1.deck, conn: false });
    const ni = sg.segs.length - 1;
    replace(s1.a, i1, ni);
    replace(s2.b, i2, ni);
    inc.set(v, []);
  }
}

/** Merge the ends of ground segments shorter than CONTRACT blocks (junction clusters). → merged node count */
function contractShort(sg) {
  const parent = sg.nodes.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  let merged = 0;
  for (const s of sg.segs) {
    if (!s.alive || s.conn || s.deck) continue;
    const [ra, rb] = [find(s.a), find(s.b)];
    if (ra === rb) continue;
    const [na, nb] = [sg.nodes[ra], sg.nodes[rb]];
    if (arcLen(s.pts) >= CONTRACT || Math.hypot(na.x - nb.x, na.z - nb.z) >= CONTRACT || Math.abs(na.y - nb.y) > Y_TOL) continue;
    parent[rb] = ra;
    s.alive = false;
    merged++;
  }
  for (const s of sg.segs) {
    if (!s.alive) continue;
    s.a = find(s.a);
    s.b = find(s.b);
    s.pts = [{ ...sg.nodes[s.a] }, ...s.pts.slice(1, -1), { ...sg.nodes[s.b] }];
    if (s.a === s.b && arcLen(s.pts) < CONTRACT) s.alive = false;
  }
  return merged;
}

/** Drop unnamed dead-end segments shorter than SPUR_MAX blocks (driveway and footway stubs) and dead-end vertical connectors, repeatedly. → count */
function pruneSpurs(sg) {
  let pruned = 0;
  for (let round = 0; round < 8; round++) {
    let changed = 0;
    for (const [, list] of sg.incidence()) {
      if (list.length !== 1) continue;
      const s = sg.segs[list[0]];
      if (!s.alive) continue;
      if (!s.conn && (s.name !== WALK_NO_NAME || arcLen(s.pts) >= SPUR_MAX)) continue; // a dangling connector always goes
      s.alive = false;
      changed++;
    }
    pruned += changed;
    if (!changed) break;
  }
  return pruned;
}

/**
 * Footways that met only sidewalks (left out) are islands: link each smaller component to the main one with an unnamed
 * edge from its closest node to the nearest main edge within LINK_MAX blocks. → stats
 */
function joinComponents(g, groundAt) {
  const n = g.x10.length;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (const e of g.edges.values()) parent[find(e.a)] = find(e.b);
  const comps = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!comps.has(r)) comps.set(r, { nodes: [], edges: [] });
    comps.get(r).nodes.push(i);
  }
  for (const [k, e] of g.edges) comps.get(find(e.a)).edges.push(k);
  if (comps.size === 0) throw new Error("walk: no walkable ways inside the listed chunks");
  const order = [...comps.values()].sort((a, b) => b.nodes.length - a.nodes.length);
  const inMain = new Uint8Array(n);
  for (const i of order[0].nodes) inMain[i] = 1;
  const snapper = new Snapper(g, groundAt, (e) => inMain[e.a] === 1 && inMain[e.b] === 1);
  const before = order[0].nodes.length / n;
  let linked = 0;
  let rest = order.slice(1);
  for (let pass = 0; pass < 3 && rest.length; pass++) {
    const left = [];
    for (const c of rest) {
      let best = null;
      for (const v of c.nodes) {
        const hit = snapper.nearest(g.x10[v] / 10, g.z10[v] / 10, LINK_MAX);
        if (hit && (!best || hit.d < best.hit.d)) best = { v, hit };
      }
      if (!best) {
        left.push(c);
        continue;
      }
      const m = snapper.split(best.hit, `component link from node ${best.v}`);
      for (const v of c.nodes) inMain[v] = 1;
      g.link(best.v, m, Math.max(0.1, g.dist(best.v, m)), WALK_NO_NAME, DOOR_HW10, false);
      for (const k of c.edges) if (g.edges.has(k)) snapper.add(k, g.edges.get(k));
      const lk = best.v < m ? `${best.v},${m}` : `${m},${best.v}`;
      snapper.add(lk, g.edges.get(lk));
      linked++;
    }
    rest = left;
  }
  return { largestShareUnlinked: before, linkedComponents: linked };
}
