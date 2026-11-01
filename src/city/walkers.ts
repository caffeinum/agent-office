// Pure walker logic for the City DO (spec-v2 §7.2–7.3): speeds, path interpolation, path caps, names, rate windows,
// nearest-node snapping. No storage and no clock of its own: every function takes `now` or plain data.
import { NAME_MAX } from "../tools";

export type Pt = [x: number, z: number, y: number];
export type WalkMode = "walk" | "ride";

export const WALK_SPEED = 2;
export const RIDE_SPEED = 8;
/** Trips longer than this (blocks of path) ride instead of walk. */
export const RIDE_OVER_BLOCKS = 300;
export const CITY_AWAY_MS = 5 * 60_000;
export const CITY_REMOVE_MS = 60 * 60_000;
export const PRESENCE_TTL_MS = 3 * 60_000;
export const FLUSH_MS = 1000;
export const GRAPH_CHECK_MS = 60_000;
export const NEAR_BLOCKS = 40;
export const LOOK_PLACES_BLOCKS = 100;
export const LOOK_PLACES_MAX = 20;
/** A walk frame carries at most this many path points; a longer route goes out as consecutive legs. */
export const MAX_PATH_POINTS = 256;
/** Interior points closer than this (blocks, 3-D) to the line through their neighbours carry no shape. */
export const SIMPLIFY_EPS = 0.01;
export const CHAT_RING = 500;
export const CHAT_TAIL = 50;
export const CHAT_READ_MAX = 50;
export const MAX_CITY_AGENTS = 300;
export const MAX_OFFICE_WALKERS = 20;
export const MAX_CITY_VIEWERS = 500;
export const MAX_VIEWERS_PER_IP = 8;
/** GET /api/city/sf and WS upgrades per client IP, the Office DO's ip: budget. */
export const PUBLIC_IP_LIMITS: readonly Window[] = [{ max: 120, ms: 10_000 }];
export const SNAPSHOT_CACHE_MS = 1000;
export const PENDING_TTL_MS = 7 * 24 * 60 * 60_000;
export const REVOKED_COOLDOWN_MS = 24 * 60 * 60_000;
/** After a failed city data load the alarm retries no sooner than this, doubling up to GRAPH_RETRY_MAX_MS. */
export const GRAPH_RETRY_MS = 5_000;
export const GRAPH_RETRY_MAX_MS = 5 * 60_000;
export const MAX_PENDING_PER_SITE = 5;
export const MAX_PENDING_LINKS = 200;
/** A {lat, lon} target farther than this from every walk node is refused. */
export const SNAP_MAX_BLOCKS = 64;
export const BLOCK_M = 3;

export interface Window {
  max: number;
  ms: number;
}
export const GO_LIMITS: readonly Window[] = [
  { max: 1, ms: 2000 },
  { max: 20, ms: 60_000 },
];
export const LOOK_LIMITS: readonly Window[] = [{ max: 2, ms: 1000 }];
export const CITY_CHAT_LIMITS: readonly Window[] = [{ max: 1, ms: 30_000 }];

export function modeFor(lengthBlocks: number): { mode: WalkMode; speed: number } {
  return lengthBlocks > RIDE_OVER_BLOCKS ? { mode: "ride", speed: RIDE_SPEED } : { mode: "walk", speed: WALK_SPEED };
}

const segLen = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[2] - a[2], b[1] - a[1]);
const planar = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);

export function pathLength(path: readonly Pt[]): number {
  let n = 0;
  for (let i = 1; i < path.length; i++) n += planar(path[i - 1]!, path[i]!);
  return n;
}

export function travelMs(path: readonly Pt[], speed: number): number {
  if (speed <= 0) throw new Error(`travelMs: speed must be > 0, got ${speed}`);
  return (pathLength(path) / speed) * 1000;
}

/** Where a walker that left path[0] at t0 at `speed` blocks/s is at `now`; y interpolates the path's own y. */
export function positionAt(path: readonly Pt[], speed: number, t0: number, now: number): { p: Pt; done: boolean } {
  if (path.length === 0) throw new Error("positionAt: empty path");
  let left = Math.max(0, ((now - t0) / 1000) * speed);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const d = planar(a, b);
    if (left <= d) {
      const t = d === 0 ? 1 : left / d;
      return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], done: false };
    }
    left -= d;
  }
  return { p: [...path.at(-1)!] as Pt, done: true };
}

/** Distance from p to segment ab in 3D (x, z, y). */
function offSegment(p: Pt, a: Pt, b: Pt): number {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l2 = d[0]! * d[0]! + d[1]! * d[1]! + d[2]! * d[2]!;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0]! + (p[1] - a[1]) * d[1]! + (p[2] - a[2]) * d[2]!) / l2));
  return segLen(p, [a[0] + d[0]! * t, a[1] + d[1]! * t, a[2] + d[2]! * t]);
}

/** Drops only interior points that lie on the line through their kept neighbours: the route's shape and length stay. */
export function simplifyPath(path: readonly Pt[], eps = SIMPLIFY_EPS): Pt[] {
  const out: Pt[] = [];
  for (const p of path) {
    while (out.length >= 2 && offSegment(out.at(-1)!, out.at(-2)!, p) < eps) out.pop();
    out.push([...p] as Pt);
  }
  return out;
}

export interface Leg {
  index: number;
  /** path[from..to] inclusive; consecutive legs share their boundary point */
  from: number;
  to: number;
  /** when the walker leaves path[from] */
  t0: number;
  last: boolean;
}

/** The ≤ `max`-point leg a walker on `path` (left path[0] at t0) is on at `now`; past the end, the last leg. */
export function legAt(path: readonly Pt[], speed: number, t0: number, now: number, max = MAX_PATH_POINTS): Leg {
  if (max < 2) throw new Error(`legAt: max must be ≥ 2, got ${max}`);
  if (speed <= 0) throw new Error(`legAt: speed must be > 0, got ${speed}`);
  if (path.length === 0) throw new Error("legAt: empty path");
  const step = max - 1;
  const count = Math.max(1, Math.ceil((path.length - 1) / step));
  const travelled = Math.max(0, ((now - t0) / 1000) * speed);
  let index = 0;
  let start = 0;
  for (let i = 1; i < count; i++) {
    const at = start + pathLength(path.slice((i - 1) * step, i * step + 1));
    if (travelled < at) break;
    index = i;
    start = at;
  }
  const from = index * step;
  return { index, from, to: Math.min(path.length - 1, from + step), t0: t0 + (start / speed) * 1000, last: index === count - 1 };
}

/** Case- and punctuation-blind form used for name collisions and agent lookups. */
export function normName(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** The office numbering rule ("claude@paw 2") against the names in `taken` (as normName keys). */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(normName(name))) return name;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = name.slice(0, NAME_MAX - suffix.length) + suffix;
    if (!taken.has(normName(candidate))) return candidate;
  }
}

/** Sliding-window limiter: returns seconds to wait when any window is full, else records the hit and returns 0. */
export class Windows {
  private hits = new Map<string, number[]>();

  take(key: string, limits: readonly Window[], now: number): number {
    const longest = Math.max(...limits.map((l) => l.ms));
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < longest);
    for (const l of limits) {
      const inWindow = recent.filter((t) => now - t < l.ms);
      if (inWindow.length >= l.max) {
        this.hits.set(key, recent);
        return Math.max(1, Math.ceil((inWindow[0]! + l.ms - now) / 1000));
      }
    }
    recent.push(now);
    this.hits.set(key, recent);
    return 0;
  }

  /** Drops keys with no hit in the last `olderThanMs` (longer than every window in use). */
  prune(now: number, olderThanMs = 60_000): void {
    for (const [k, hits] of [...this.hits]) if (!hits.length || now - hits.at(-1)! >= olderThanMs) this.hits.delete(k);
  }

  forget(prefix: string): void {
    for (const k of [...this.hits.keys()]) if (k.startsWith(prefix)) this.hits.delete(k);
  }
}

export function nodePoint(nodes: Int32Array, n: number): Pt {
  if (n < 0 || n * 3 + 2 >= nodes.length) throw new Error(`walk node ${n} out of range`);
  return [nodes[n * 3]! / 10, nodes[n * 3 + 1]! / 10, nodes[n * 3 + 2]! / 10];
}

export function nearestNode(nodes: Int32Array, x: number, z: number): { node: number; dist: number } {
  const n = nodes.length / 3;
  if (n === 0) throw new Error("nearestNode: the walk graph has no nodes");
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const dx = nodes[i * 3]! / 10 - x;
    const dz = nodes[i * 3 + 1]! / 10 - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return { node: best, dist: Math.sqrt(bestD) };
}

export const round1 = (v: number) => Math.round(v * 10) / 10;
