// The City Durable Object (spec-v2 §7.2–7.4): one per city (idFromName("sf")). It holds office↔site links, the
// presence the offices bridge in, walkers moved by office_city, and city chat, all in DO SQLite; viewers watch over
// a hibernating WebSocket. The server owns intent, not ticks: a walker is {path, t0, speed} and one alarm serves
// arrivals, away/removal, presence expiry, broadcast flushes and the walk-graph check.
//
// Trust: walker methods (call, officePresence, removeWalker, officeGone, requestLink) are reached only over DO RPC
// from the Office DO, which passes an identity it has verified; the worker routes only the public read endpoints and
// the Bearer-checked admin methods here. Every walker call and presence push re-checks the link.
import { DurableObject } from "cloudflare:workers";
import {
  blockToLonLat, decodeWalk, lonLatToBlock, validateCompanies, validateManifest, validatePlaces,
  type CompanySite, type Manifest, type Place, type PlacesDoc, type WalkGraph,
} from "../../public/shared/city.js";
import { route as walkRoute, ROUTE_MAX_EXPANSIONS, type RouteResult } from "./route";
import { resolvePlace, type PlaceContext } from "./places";
import { CHAT_WAIT_DEFAULT_SEC } from "../tools";
import {
  BLOCK_M, CHAT_READ_MAX, CHAT_RING, CHAT_TAIL, CITY_AWAY_MS, CITY_CHAT_LIMITS, CITY_REMOVE_MS, FLUSH_MS, GO_LIMITS, GRAPH_CHECK_MS, GRAPH_RETRY_MAX_MS,
  GRAPH_RETRY_MS, legAt, LOOK_LIMITS, LOOK_PLACES_BLOCKS, LOOK_PLACES_MAX, MAX_CITY_AGENTS, MAX_CITY_VIEWERS, MAX_OFFICE_WALKERS, MAX_PENDING_LINKS,
  MAX_PENDING_PER_SITE, MAX_VIEWERS_PER_IP, modeFor, NEAR_BLOCKS, nearestNode, nodePoint, normName, pathLength, PENDING_TTL_MS, positionAt,
  PRESENCE_TTL_MS, PUBLIC_IP_LIMITS, REVOKED_COOLDOWN_MS, round1, simplifyPath, SNAP_MAX_BLOCKS, SNAPSHOT_CACHE_MS, travelMs, uniqueName, Windows,
  type Leg, type Pt, type WalkMode,
} from "./walkers";

export const CITY_ID = "sf";
export const LINK_STATES = ["pending", "approved", "rejected", "revoked"] as const;
export type LinkState = (typeof LINK_STATES)[number];
export const LINK_ACTIONS = { approve: "approved", reject: "rejected", revoke: "revoked" } as const;
export type LinkAction = keyof typeof LINK_ACTIONS;
export const NO_LINK = (officeId: string) => `this office has no approved city link; the owner can request one with PUT /api/o/${officeId}/city`;

/** The office agent behind a walker, as the Office DO vouches for it. */
export interface CityCaller {
  agentId: string;
  name: string;
  hue: number;
  status: string;
}
export interface BridgeAgent extends CityCaller {
  /** true while the agent has a live walker: the city draws the walker only */
  out: boolean;
}
export interface CityArgs {
  op: "go" | "look" | "chat";
  to?: string | { lat: number; lon: number } | null;
  about?: "here" | "places" | "agents";
  chat?: "read" | "send" | "say" | "wait";
  scope?: "near" | "city";
  text?: string;
  timeoutSec?: number;
}
export type CityResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string; extra: Record<string, unknown> };
export interface LinkRow {
  officeId: string;
  siteId: string;
  state: LinkState;
  officeName: string;
  requestedAt: number;
  decidedAt: number | null;
}

export class CityError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CityError";
  }
}

/** Where a walker stands or is headed; never block coordinates (§7.7). */
type At = { place: string } | { lat: number; lon: number };

interface Walker {
  id: string;
  pid: string;
  officeId: string;
  agentId: string;
  name: string;
  hue: number;
  siteId: string;
  path: Pt[] | null;
  t0: number;
  speed: number;
  mode: WalkMode;
  at: At;
  goal: string;
  inside: boolean;
  lastSeen: number;
  status: string;
  lastRead: number;
  /** derived from `at` against the loaded graph; not persisted */
  node: number;
}

interface PresenceRow {
  officeId: string;
  siteId: string;
  agents: BridgeAgent[];
  ts: number;
}

interface ChatRow {
  seq: number;
  ts: number;
  fromWalker: string;
  fromPid: string;
  fromName: string;
  scope: "near" | "city" | "dm";
  to: string | null;
  text: string;
  x: number;
  z: number;
  say: boolean;
  recips: string[];
}

interface Graph {
  builtAt: string;
  manifest: Manifest;
  walk: WalkGraph;
  places: PlacesDoc;
  sites: CompanySite[];
  placeById: Map<string, Place>;
  siteById: Map<string, CompanySite>;
  loadMs: number;
}

/** A* and the place resolver (W5). A field so the tests can swap them while route.ts/places.ts are stubs. */
export interface Nav {
  route(graph: WalkGraph, from: number, to: number, opts?: { maxExpansions?: number }): RouteResult;
  resolvePlace(query: string, ctx: PlaceContext): Place;
}

type WakeReason = "message" | "timeout" | "gone";

const DDL = [
  "CREATE TABLE IF NOT EXISTS links (officeId TEXT PRIMARY KEY, siteId TEXT NOT NULL, state TEXT NOT NULL, officeName TEXT NOT NULL, requestedAt INTEGER NOT NULL, decidedAt INTEGER)",
  "CREATE TABLE IF NOT EXISTS walkers (id TEXT PRIMARY KEY, pid TEXT NOT NULL UNIQUE, officeId TEXT NOT NULL, agentId TEXT NOT NULL, name TEXT NOT NULL, hue INTEGER NOT NULL, siteId TEXT NOT NULL, path TEXT, t0 INTEGER NOT NULL, speed REAL NOT NULL, mode TEXT NOT NULL, at TEXT NOT NULL, goal TEXT NOT NULL, inside INTEGER NOT NULL, lastSeen INTEGER NOT NULL, status TEXT NOT NULL, lastRead INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS presence (officeId TEXT PRIMARY KEY, siteId TEXT NOT NULL, agents TEXT NOT NULL, ts INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS chat (seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, fromWalker TEXT NOT NULL, fromPid TEXT NOT NULL, fromName TEXT NOT NULL, scope TEXT NOT NULL, \"to\" TEXT, text TEXT NOT NULL, x REAL NOT NULL, z REAL NOT NULL, say INTEGER NOT NULL, recips TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
];

async function publicId(id: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`walker:${id}`)));
  return "w" + [...d.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function wrapError(e: unknown): CityResult<never> {
  if (e instanceof CityError) return { ok: false, status: e.status, error: e.message, extra: e.extra };
  console.error("city: unexpected error", e);
  return { ok: false, status: 500, error: `city: ${e instanceof Error ? e.message : String(e)}`, extra: {} };
}

export class City extends DurableObject<Env> {
  /** Test seams: the clock every deadline uses, and the W5 navigation functions. */
  clock: () => number = () => Date.now();
  nav: Nav = { route: walkRoute, resolvePlace };

  private graph: Graph | null = null;
  private loading: Promise<Graph> | null = null;
  private graphCheckedAt = 0;
  private graphFailures = 0;
  /** After a failed data load: walker deadlines wait for this (no alarm in the past while the graph is missing). */
  private graphRetryAt = 0;
  /** The leg index each moving walker's last queued walk frame carried. */
  private legShown = new Map<string, number>();
  /** Bumped on every queued frame: the cached GET snapshot is reused only while it matches. */
  private version = 0;
  private snapCache: { version: number; at: number; body: string } | null = null;
  private links = new Map<string, LinkRow>();
  private walkers = new Map<string, Walker>();
  private presence = new Map<string, PresenceRow>();
  private seq = 0;
  private pending = new Map<string, Record<string, unknown>>();
  private lastFlush = 0;
  private alarmAt: number | null = null;
  private limits = new Windows();
  private waiters = new Map<string, (why: WakeReason) => void>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
    ctx.blockConcurrencyWhile(async () => this.load());
  }

  private sql<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T[] {
    return this.ctx.storage.sql.exec<T>(query, ...bindings).toArray();
  }

  private async load(): Promise<void> {
    for (const d of DDL) this.ctx.storage.sql.exec(d);
    for (const r of this.sql<Record<string, SqlStorageValue>>("SELECT * FROM links")) this.links.set(r.officeId as string, r as unknown as LinkRow);
    for (const r of this.sql<Record<string, SqlStorageValue>>("SELECT * FROM walkers")) {
      this.walkers.set(r.id as string, {
        ...(r as unknown as Walker),
        path: r.path === null ? null : (JSON.parse(r.path as string) as Pt[]),
        at: JSON.parse(r.at as string) as At,
        inside: r.inside === 1,
        node: -1,
      });
    }
    for (const r of this.sql<Record<string, SqlStorageValue>>("SELECT * FROM presence")) {
      this.presence.set(r.officeId as string, { officeId: r.officeId as string, siteId: r.siteId as string, agents: JSON.parse(r.agents as string), ts: r.ts as number });
    }
    this.seq = (this.sql<{ s: number | null }>("SELECT MAX(seq) AS s FROM chat")[0]?.s ?? 0) as number;
    this.graphCheckedAt = Number(this.metaGet("graphCheckedAt") ?? 0);
    this.alarmAt = await this.ctx.storage.getAlarm();
  }

  private metaGet(key: string): string | null {
    return (this.sql<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)[0]?.value ?? null) as string | null;
  }

  private metaSet(key: string, value: string): void {
    this.ctx.storage.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  // ---------- city data (walk.bin, places.json, companies.json, manifest.json through ASSETS) ----------

  private assetBase(): string {
    const base = this.env.CITY_SF_ASSETS;
    if (typeof base !== "string" || !/^\/city\/[a-z0-9-]+\/$/.test(base)) throw new CityError(503, `city data path CITY_SF_ASSETS is unset or malformed: ${JSON.stringify(base)}`);
    return base;
  }

  private async asset(file: string): Promise<Response> {
    const url = `https://assets.local${this.assetBase()}${file}`;
    const res = await this.env.ASSETS.fetch(new Request(url));
    if (!res.ok) throw new CityError(503, `city data: ${this.assetBase()}${file} answered ${res.status}`);
    return res;
  }

  private async manifest(): Promise<Manifest> {
    try {
      return validateManifest(await (await this.asset("manifest.json")).json()) as Manifest;
    } catch (e) {
      if (e instanceof CityError) throw e;
      throw new CityError(503, `city data: manifest.json: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async readGraph(): Promise<Graph> {
    const manifest = await this.manifest();
    const [walkRes, placesRes, companiesRes] = await Promise.all([this.asset(manifest.walk), this.asset(manifest.places), this.asset("companies.json")]);
    const bytes = new Uint8Array(await walkRes.arrayBuffer());
    try {
      const t = performance.now();
      const walk = decodeWalk(bytes, manifest);
      const loadMs = performance.now() - t;
      const places = validatePlaces(await placesRes.json(), manifest, walk);
      const companies = validateCompanies(await companiesRes.json(), manifest);
      console.log(`city: walk.bin ${bytes.length} B, ${walk.nodes.length / 3} nodes decoded in ${loadMs.toFixed(2)} ms (builtAt ${manifest.builtAt})`);
      return {
        builtAt: manifest.builtAt,
        manifest,
        walk,
        places,
        sites: companies.sites,
        placeById: new Map(places.places.map((p) => [p.id, p])),
        siteById: new Map(companies.sites.map((s) => [s.id, s])),
        loadMs,
      };
    } catch (e) {
      throw new CityError(503, `city data: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** The loaded graph; at most once per GRAPH_CHECK_MS it re-reads manifest.builtAt and reloads + re-snaps on a change. */
  private async ensureGraph(): Promise<Graph> {
    if (!this.graph) {
      this.loading ??= this.readGraph().finally(() => (this.loading = null));
      const g = await this.loading;
      if (!this.graph) {
        this.graph = g;
        this.snapAll(false);
        this.markChecked();
      }
      return this.graph;
    }
    if (this.clock() - this.graphCheckedAt < GRAPH_CHECK_MS) return this.graph;
    this.markChecked();
    const m = await this.manifest();
    if (m.builtAt === this.graph.builtAt) return this.graph;
    const g = await this.readGraph();
    console.log(`city: data changed ${this.graph.builtAt} → ${g.builtAt}; re-snapping ${this.walkers.size} walkers`);
    this.graph = g;
    this.snapAll(true);
    return g;
  }

  private markChecked(): void {
    this.graphCheckedAt = this.clock();
    this.metaSet("graphCheckedAt", String(this.graphCheckedAt));
    this.metaSet("builtAt", this.graph?.builtAt ?? "");
  }

  /** Puts every walker on its `at` in the current graph; with `cancel`, in-flight paths end with `arrive` (§7.7). */
  private snapAll(cancel: boolean): void {
    const g = this.mustGraph();
    this.version++;
    this.dropVanishedSites(g);
    for (const w of [...this.walkers.values()]) {
      try {
        w.node = this.nodeOfAt(g, w.at);
      } catch (e) {
        console.error(`city: walker ${w.pid} can't be placed after a data change, removing it`, e);
        this.dropWalker(w);
        continue;
      }
      if (cancel && w.path) {
        w.path = null;
        w.speed = 0;
        this.saveWalker(w);
        this.queueWalker(w, "arrive", this.clock());
      }
    }
  }

  /** A data rebuild can drop a company site: its presence rows and walkers go; the link row stays for the admin to see. */
  private dropVanishedSites(g: Graph): void {
    for (const l of this.links.values()) {
      if (g.siteById.has(l.siteId)) continue;
      console.error(`city: ${l.state} link of office ${l.officeId} points at site ${l.siteId}, which is not in companies.json (builtAt ${g.builtAt}); its walkers and presence are dropped`);
    }
    for (const w of [...this.walkers.values()]) {
      if (g.siteById.has(w.siteId)) continue;
      console.error(`city: walker ${w.pid} (office ${w.officeId}) belongs to vanished site ${w.siteId}; removing it`);
      this.dropWalker(w);
    }
    for (const p of [...this.presence.values()]) {
      if (g.siteById.has(p.siteId)) continue;
      console.error(`city: presence of office ${p.officeId} is for vanished site ${p.siteId}; dropping it`);
      this.ctx.storage.sql.exec("DELETE FROM presence WHERE officeId = ?", p.officeId);
      this.presence.delete(p.officeId);
    }
  }

  private mustGraph(): Graph {
    if (!this.graph) throw new Error("city: graph not loaded");
    return this.graph;
  }

  private nodeOfAt(g: Graph, at: At): number {
    if ("place" in at) {
      const p = g.placeById.get(at.place);
      if (!p) throw new CityError(500, `place ${at.place} is not in places.json`);
      return p.node;
    }
    const b = lonLatToBlock(at.lon, at.lat, g.manifest.proj);
    const near = nearestNode(g.walk.nodes, b.x, b.z);
    if (near.dist > SNAP_MAX_BLOCKS) throw new CityError(400, `no walkable street within ${SNAP_MAX_BLOCKS} blocks of ${at.lat}, ${at.lon}`);
    return near.node;
  }

  private sitePlace(g: Graph, siteId: string): Place {
    const p = g.places.places.find((q) => q.kind === "company" && q.siteId === siteId);
    if (!p) throw new CityError(503, `site ${siteId} has no place (door) in places.json`);
    return p;
  }

  // ---------- links (§7.4) ----------

  async requestLink(officeId: string, siteId: string, officeName: string): Promise<CityResult<LinkRow>> {
    try {
      const g = await this.ensureGraph();
      if (!g.siteById.has(siteId)) throw new CityError(400, `unknown siteId "${siteId}": it must be a shipped site in companies.json`);
      const now = this.clock();
      this.sweepPending(now);
      const cur = this.links.get(officeId);
      if (cur?.state === "approved") {
        if (cur.siteId === siteId) return { ok: true, value: cur };
        throw new CityError(409, `this office already has an approved link to ${cur.siteId}; an admin must revoke it first`);
      }
      if (cur?.state === "rejected") throw new CityError(409, "link was rejected; ask the city admin");
      if (cur?.state === "revoked") {
        if (cur.decidedAt === null) throw new Error(`city: revoked link of office ${officeId} has no decidedAt`);
        const wait = cur.decidedAt + REVOKED_COOLDOWN_MS - now;
        if (wait > 0) {
          const retryAfter = Math.ceil(wait / 1000);
          throw new CityError(429, `link was revoked; a new request is possible in ${Math.ceil(wait / 3_600_000)} h (or ask the city admin)`, { retryAfter });
        }
      }
      const pending = [...this.links.values()].filter((l) => l.state === "pending" && l.officeId !== officeId);
      if (pending.filter((l) => l.siteId === siteId).length >= MAX_PENDING_PER_SITE) throw new CityError(429, `too many pending link requests for ${siteId}`);
      if (pending.length >= MAX_PENDING_LINKS) throw new CityError(429, `too many pending link requests city-wide (${MAX_PENDING_LINKS})`);
      const row: LinkRow = { officeId, siteId, state: "pending", officeName, requestedAt: now, decidedAt: null };
      this.ctx.storage.sql.exec(
        "INSERT INTO links (officeId, siteId, state, officeName, requestedAt, decidedAt) VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT(officeId) DO UPDATE SET siteId = excluded.siteId, state = excluded.state, officeName = excluded.officeName, requestedAt = excluded.requestedAt, decidedAt = NULL",
        officeId, siteId, row.state, officeName, now,
      );
      this.links.set(officeId, row);
      return { ok: true, value: row };
    } catch (e) {
      return wrapError(e);
    }
  }

  async listLinks(state: LinkState | null): Promise<LinkRow[]> {
    this.sweepPending(this.clock());
    return [...this.links.values()].filter((l) => state === null || l.state === state).sort((a, b) => a.requestedAt - b.requestedAt);
  }

  /** Admin decision. Reject/revoke take effect on the next call and drop the office's walkers and presence at once. */
  async decideLink(officeId: string, action: LinkAction): Promise<CityResult<LinkRow>> {
    try {
      this.sweepPending(this.clock());
      const cur = this.links.get(officeId);
      if (!cur) throw new CityError(404, `no link request from office ${officeId}`);
      const row = this.decide(cur, action);
      this.afterChange();
      return { ok: true, value: row };
    } catch (e) {
      return wrapError(e);
    }
  }

  /** Admin bulk reject: every pending request for `siteId`. */
  async rejectPending(siteId: string): Promise<CityResult<LinkRow[]>> {
    try {
      this.sweepPending(this.clock());
      const rows = [...this.links.values()].filter((l) => l.state === "pending" && l.siteId === siteId).map((l) => this.decide(l, "reject"));
      this.afterChange();
      return { ok: true, value: rows };
    } catch (e) {
      return wrapError(e);
    }
  }

  private decide(cur: LinkRow, action: LinkAction): LinkRow {
    const state = LINK_ACTIONS[action];
    if (action === "approve" && cur.state !== "pending") throw new CityError(409, `link is ${cur.state}; only a pending link can be approved`);
    if (action === "reject" && cur.state !== "pending") throw new CityError(409, `link is ${cur.state}; only a pending link can be rejected`);
    if (action === "revoke" && cur.state !== "approved") throw new CityError(409, `link is ${cur.state}; only an approved link can be revoked`);
    const row: LinkRow = { ...cur, state, decidedAt: this.clock() };
    this.ctx.storage.sql.exec("UPDATE links SET state = ?, decidedAt = ? WHERE officeId = ?", state, row.decidedAt, cur.officeId);
    this.links.set(cur.officeId, row);
    if (state !== "approved") this.dropOffice(cur.officeId);
    const office = this.env.OFFICE.get(this.env.OFFICE.idFromName(cur.officeId));
    this.ctx.waitUntil(office.cityLinkDecided(row.siteId, state).catch((e: unknown) => console.error(`city: telling office ${cur.officeId} about its link failed`, e)));
    return row;
  }

  /** Pending requests older than PENDING_TTL_MS are deleted: the office may ask again. */
  private sweepPending(now: number): void {
    for (const l of [...this.links.values()]) {
      if (l.state !== "pending" || now - l.requestedAt < PENDING_TTL_MS) continue;
      this.ctx.storage.sql.exec("DELETE FROM links WHERE officeId = ? AND state = 'pending'", l.officeId);
      this.links.delete(l.officeId);
    }
  }

  /** The office was deleted: its link, walkers and presence go. */
  async officeGone(officeId: string): Promise<void> {
    this.dropOffice(officeId);
    this.ctx.storage.sql.exec("DELETE FROM links WHERE officeId = ?", officeId);
    this.links.delete(officeId);
    this.afterChange();
  }

  private dropOffice(officeId: string): void {
    for (const w of [...this.walkers.values()]) if (w.officeId === officeId) this.dropWalker(w);
    const p = this.presence.get(officeId);
    if (p) {
      this.ctx.storage.sql.exec("DELETE FROM presence WHERE officeId = ?", officeId);
      this.presence.delete(officeId);
      this.queuePresence(p.siteId);
    }
  }

  private approved(officeId: string): LinkRow {
    const l = this.links.get(officeId);
    if (!l || l.state !== "approved") throw new CityError(403, NO_LINK(officeId));
    return l;
  }

  // ---------- presence bridge (§7.4) ----------

  /** Roster push from an office. Dropped unless the link is approved. Returns the agents that have a live walker. */
  async officePresence(officeId: string, agents: BridgeAgent[]): Promise<{ state: LinkState | null; live: string[] }> {
    const link = this.links.get(officeId);
    if (!link || link.state !== "approved") return { state: link?.state ?? null, live: [] };
    const g = await this.ensureGraph();
    if (!g.siteById.has(link.siteId)) {
      console.error(`city: presence from office ${officeId} for site ${link.siteId}, which is not in companies.json (builtAt ${g.builtAt}); ignored`);
      return { state: link.state, live: [] };
    }
    const now = this.clock();
    const clean: BridgeAgent[] = [];
    for (const a of agents) {
      const name = this.bridgeName(a.name, g, link.siteId);
      if (name === null) {
        console.error(`city: office ${officeId} agent ${a.agentId}: "${a.name}" looks like a company or place even renamed; left out of presence`);
        continue;
      }
      clean.push({ agentId: a.agentId, name, hue: a.hue, status: a.status, out: a.out === true });
    }
    const row: PresenceRow = { officeId, siteId: link.siteId, agents: clean, ts: now };
    this.ctx.storage.sql.exec(
      "INSERT INTO presence (officeId, siteId, agents, ts) VALUES (?, ?, ?, ?) ON CONFLICT(officeId) DO UPDATE SET siteId = excluded.siteId, agents = excluded.agents, ts = excluded.ts",
      officeId, link.siteId, JSON.stringify(clean), now,
    );
    const old = this.presence.get(officeId);
    this.presence.set(officeId, row);
    if (old && old.siteId !== row.siteId) this.queuePresence(old.siteId);
    this.queuePresence(row.siteId);
    const live: string[] = [];
    for (const a of clean) {
      const w = this.walkers.get(`${officeId}:${a.agentId}`);
      if (!w) continue;
      live.push(a.agentId);
      const changed = w.status !== a.status || w.hue !== a.hue;
      w.lastSeen = now;
      w.status = a.status;
      w.hue = a.hue;
      this.saveWalker(w);
      if (changed && !w.inside) this.queueWalker(w, "walk", now);
    }
    this.afterChange();
    return { state: link.state, live };
  }

  /** office_leave, walk-out, kick or invite revocation: the walker goes at once. */
  async removeWalker(officeId: string, agentId: string): Promise<void> {
    const w = this.walkers.get(`${officeId}:${agentId}`);
    if (!w) return;
    this.dropWalker(w);
    this.afterChange();
  }

  // ---------- office_city (§7.3) ----------

  async call(officeId: string, caller: CityCaller, args: CityArgs): Promise<CityResult<unknown>> {
    try {
      const link = this.approved(officeId);
      const g = await this.ensureGraph();
      if (!g.siteById.has(link.siteId)) throw new CityError(503, `your office's site ${link.siteId} is no longer on the city map; ask the city admin`);
      const w = await this.walkerFor(officeId, link.siteId, caller, g);
      let value: unknown;
      if (args.op === "go") value = await this.go(w, args.to, g);
      else if (args.op === "look") value = this.look(w, args.about ?? "here", g);
      else if (args.op === "chat") value = await this.chat(w, args);
      else throw new CityError(400, `office_city: unknown op ${String(args.op)}`);
      this.afterChange();
      return { ok: true, value };
    } catch (e) {
      this.afterChange();
      return wrapError(e);
    }
  }

  private async walkerFor(officeId: string, siteId: string, caller: CityCaller, g: Graph): Promise<Walker> {
    const id = `${officeId}:${caller.agentId}`;
    const pid = await publicId(id);
    const now = this.clock();
    const existing = this.walkers.get(id);
    if (existing) {
      const statusChanged = existing.status !== caller.status;
      if (existing.name !== caller.name && normName(caller.name) !== normName(existing.name)) existing.name = this.cityName(caller.name, g, siteId, id);
      existing.hue = caller.hue;
      existing.status = caller.status;
      existing.lastSeen = now;
      this.saveWalker(existing);
      if (statusChanged && !existing.inside) this.queueWalker(existing, "walk", now);
      return existing;
    }
    if ([...this.walkers.values()].filter((w) => w.officeId === officeId).length >= MAX_OFFICE_WALKERS) {
      throw new CityError(429, `this office already has ${MAX_OFFICE_WALKERS} walkers in the city (MAX ${MAX_OFFICE_WALKERS} per office)`);
    }
    if (this.walkers.size >= MAX_CITY_AGENTS) throw new CityError(429, `the city is full: ${MAX_CITY_AGENTS} walkers (MAX_CITY_AGENTS)`);
    const door = this.sitePlace(g, siteId);
    const w: Walker = {
      id, pid, officeId, agentId: caller.agentId, name: this.cityName(caller.name, g, siteId, id), hue: caller.hue, siteId,
      path: null, t0: now, speed: 0, mode: "walk", at: { place: door.id }, goal: door.name, inside: false, lastSeen: now, status: caller.status, lastRead: this.seq, node: door.node,
    };
    this.walkers.set(id, w);
    this.saveWalker(w);
    this.queueWalker(w, "walk", now);
    return w;
  }

  /** The office name, refused if it reads as another company or a place, numbered if a present walker has it. */
  private cityName(name: string, g: Graph, siteId: string, selfId: string): string {
    const like = this.lookAlike(name, g, siteId);
    if (like !== null) throw new CityError(400, `name looks like ${like}; pick another`);
    const taken = new Set([...this.walkers.values()].filter((w) => w.id !== selfId).map((w) => normName(w.name)));
    return uniqueName(name, taken);
  }

  /** A bridged (office-only) agent's public name: as is, or "<name> (agent)" when it reads as a company or place; null if that does too. */
  private bridgeName(name: string, g: Graph, siteId: string): string | null {
    if (this.lookAlike(name, g, siteId) === null) return name;
    const renamed = `${name} (agent)`;
    return this.lookAlike(renamed, g, siteId) === null ? renamed : null;
  }

  /** The company or place `name` reads as (other than the caller's own company), or null. */
  private lookAlike(name: string, g: Graph, siteId: string): string | null {
    const n = normName(name);
    const own = g.siteById.get(siteId);
    for (const s of g.sites) {
      if (own && s.companyId === own.companyId) continue;
      if (normName(s.name) === n) return s.name;
    }
    for (const p of g.places.places) {
      if (p.kind === "company" && p.siteId && own && g.siteById.get(p.siteId)?.companyId === own.companyId) continue;
      if ([p.name, ...p.aliases].some((a) => normName(a) === n)) return p.name;
    }
    return null;
  }

  private posOf(w: Walker, now: number): { p: Pt; moving: boolean } {
    if (w.path && w.speed > 0) {
      const { p, done } = positionAt(w.path, w.speed, w.t0, now);
      return { p, moving: !done };
    }
    return { p: nodePoint(this.mustGraph().walk.nodes, w.node), moving: false };
  }

  private arrivalAt(w: Walker): number | null {
    return w.path && w.speed > 0 ? w.t0 + travelMs(w.path, w.speed) : null;
  }

  private rate(key: string, limits: Parameters<Windows["take"]>[1], what: string): void {
    const wait = this.limits.take(key, limits, this.clock());
    if (wait > 0) throw new CityError(429, `rate limited: ${what} — try again in ${wait}s`, { retryAfter: wait });
  }

  private async go(w: Walker, to: CityArgs["to"], g: Graph) {
    this.rate(`go:${w.id}`, GO_LIMITS, "office_city go is limited to 1 per 2 s and 20 per minute");
    if (to === undefined || to === null || to === "") throw new CityError(400, 'office_city go needs `to`: a place, "A & B", an agent name, {lat, lon}, "inside" or "outside"');
    const now = this.clock();
    const viewUrl = `/city/${CITY_ID}?follow=${w.pid}`;
    const here = this.posOf(w, now);
    const site = g.siteById.get(w.siteId);
    if (to === "inside" || to === "outside") {
      if (to === "inside") {
        const door = this.sitePlace(g, w.siteId);
        if (here.moving || w.node !== door.node) throw new CityError(400, `go inside works at your own site's door (${door.name}); go there first`);
        if (!w.inside) {
          w.inside = true;
          this.queue(`w:${w.pid}`, { type: "left", id: w.pid, inside: true });
        }
      } else if (w.inside) {
        w.inside = false;
        this.queueWalker(w, "walk", now);
      }
      this.saveWalker(w);
      return { to: { kind: to, name: site?.name ?? w.siteId, x: round1(here.p[0]), z: round1(here.p[1]) }, distanceM: 0, etaSec: 0, mode: "walk" as WalkMode, via: [], viewUrl };
    }
    const target = this.target(w, to, g, now);
    const fromNode = here.moving ? nearestNode(g.walk.nodes, here.p[0], here.p[1]).node : w.node;
    let r: RouteResult;
    try {
      r = this.nav.route(g.walk, fromNode, target.node, { maxExpansions: ROUTE_MAX_EXPANSIONS });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/^no walking route/.test(msg)) throw new CityError(400, `no walking route to ${target.name}`);
      if (/route search too long/.test(msg)) throw new CityError(400, "route search too long");
      throw e;
    }
    let path = r.path.map((p) => [p[0], p[1], p[2]] as Pt);
    for (const p of path) if (p.length !== 3 || !p.every(Number.isFinite)) throw new Error(`route returned a path point without x, z, y: ${JSON.stringify(p)}`);
    const start = here.p;
    if (here.moving && (path.length === 0 || Math.hypot(path[0]![0] - start[0], path[0]![1] - start[1]) > 0.01)) path = [start, ...path];
    path = simplifyPath(path);
    const length = pathLength(path);
    const { mode, speed } = modeFor(length);
    w.inside = false;
    w.at = target.at;
    w.node = target.node;
    w.goal = target.name;
    w.mode = mode;
    w.t0 = now;
    if (length > 0) {
      w.path = path;
      w.speed = speed;
      this.queueWalker(w, "walk", now);
    } else {
      w.path = null;
      w.speed = 0;
      this.queueWalker(w, "arrive", now);
    }
    this.saveWalker(w);
    return {
      to: { kind: target.kind, name: target.name, x: round1(target.x), z: round1(target.z) },
      distanceM: Math.round(length * BLOCK_M),
      etaSec: length > 0 ? round1(length / speed) : 0,
      mode,
      via: r.via,
      viewUrl,
    };
  }

  /** `to` → a node and what to store as `at`: {lat, lon}, a present walker's name, or a place (W5 resolver). */
  private target(w: Walker, to: string | { lat: number; lon: number }, g: Graph, now: number): { kind: string; name: string; x: number; z: number; node: number; at: At } {
    if (typeof to === "object") {
      const at = { lat: to.lat, lon: to.lon };
      const node = this.nodeOfAt(g, at);
      const b = lonLatToBlock(to.lon, to.lat, g.manifest.proj);
      return { kind: "point", name: `${to.lat}, ${to.lon}`, x: b.x, z: b.z, node, at };
    }
    const n = normName(to);
    const agents = [...this.walkers.values()].filter((o) => o.id !== w.id && normName(o.name) === n);
    if (agents.length > 1) throw new CityError(400, `"${to}" matches ${agents.length} walkers`, { candidates: agents.map((a) => a.name) });
    if (agents.length === 1) {
      const other = agents[0]!;
      if (other.inside) {
        const door = this.sitePlace(g, other.siteId);
        return { kind: "agent", name: other.name, x: door.x, z: door.z, node: door.node, at: { place: door.id } };
      }
      const p = this.posOf(other, now).p;
      const ll = blockToLonLat(p[0], p[1], g.manifest.proj);
      const at = { lat: ll.lat, lon: ll.lon };
      return { kind: "agent", name: other.name, x: p[0], z: p[1], node: nearestNode(g.walk.nodes, p[0], p[1]).node, at };
    }
    let place: Place;
    try {
      place = this.nav.resolvePlace(to, { places: g.places, sites: g.sites });
    } catch (e) {
      if (e instanceof Error && e.name === "PlaceError") {
        const candidates = ((e as Error & { candidates?: readonly Place[] }).candidates ?? []).slice(0, 5).map((c) => c.name);
        throw new CityError(400, e.message, { candidates });
      }
      throw e;
    }
    return { kind: place.kind, name: place.name, x: place.x, z: place.z, node: place.node, at: { place: place.id } };
  }

  private look(w: Walker, about: "here" | "places" | "agents", g: Graph) {
    this.rate(`look:${w.id}`, LOOK_LIMITS, "office_city look is limited to 2 per second");
    const now = this.clock();
    const me = this.posOf(w, now);
    const dist = (x: number, z: number) => round1(Math.hypot(x - me.p[0], z - me.p[1]));
    const others = [...this.walkers.values()].filter((o) => o.id !== w.id && !o.inside);
    if (about === "places") {
      const named = g.places.places.filter((p) => p.kind !== "intersection");
      return {
        places: named.map((p) => ({ name: p.name, kind: p.kind, aliases: p.aliases, distanceBlocks: dist(p.x, p.z) })).sort((a, b) => a.distanceBlocks - b.distanceBlocks),
        intersections: g.places.places.length - named.length,
        note: 'go also takes "A & B" intersections, street addresses of shipped companies, agent names and {lat, lon}',
      };
    }
    if (about === "agents") {
      return {
        agents: others
          .map((o) => {
            const p = this.posOf(o, now);
            return { name: o.name, status: this.statusOf(o, now), site: o.siteId, moving: p.moving, distanceBlocks: dist(p.p[0], p.p[1]) };
          })
          .sort((a, b) => a.distanceBlocks - b.distanceBlocks),
        inside: [...this.walkers.values()].filter((o) => o.inside).map((o) => ({ name: o.name, site: o.siteId })),
      };
    }
    const placesByDist = g.places.places.map((p) => ({ name: p.name, kind: p.kind, distanceBlocks: dist(p.x, p.z) })).sort((a, b) => a.distanceBlocks - b.distanceBlocks);
    const arrival = this.arrivalAt(w);
    return {
      you: {
        id: w.pid, name: w.name, site: w.siteId, x: round1(me.p[0]), z: round1(me.p[1]), y: round1(me.p[2]), inside: w.inside, moving: me.moving,
        heading: me.moving ? w.goal : null, mode: me.moving ? w.mode : null, etaSec: me.moving && arrival !== null ? round1(Math.max(0, arrival - now) / 1000) : 0,
      },
      nearestPlace: placesByDist[0] ?? null,
      agents: others
        .map((o) => {
          const p = this.posOf(o, now);
          return { name: o.name, status: this.statusOf(o, now), moving: p.moving, distanceBlocks: dist(p.p[0], p.p[1]) };
        })
        .filter((a) => a.distanceBlocks <= NEAR_BLOCKS)
        .sort((a, b) => a.distanceBlocks - b.distanceBlocks),
      places: placesByDist.filter((p) => p.distanceBlocks <= LOOK_PLACES_BLOCKS).slice(0, LOOK_PLACES_MAX),
      unreadChat: this.unreadFor(w).length,
    };
  }

  private statusOf(w: Walker, now: number): string {
    return now - w.lastSeen >= CITY_AWAY_MS ? "away" : w.status;
  }

  // ---------- chat ----------

  private visibleTo(w: Walker, r: ChatRow): boolean {
    if (r.fromWalker === w.id) return true;
    if (r.scope === "city") return true;
    if (r.scope === "dm") return r.to === w.id;
    return r.recips.includes(w.id);
  }

  private rows(where = "", ...bind: unknown[]): ChatRow[] {
    return this.sql<Record<string, SqlStorageValue>>(`SELECT * FROM chat ${where} ORDER BY seq`, ...bind).map((r) => ({
      ...(r as unknown as ChatRow),
      say: r.say === 1,
      recips: JSON.parse(r.recips as string) as string[],
    }));
  }

  private unreadFor(w: Walker): ChatRow[] {
    return this.rows("WHERE seq > ?", w.lastRead).filter((r) => r.fromWalker !== w.id && this.visibleTo(w, r));
  }

  private chatView(r: ChatRow) {
    return { seq: r.seq, ts: r.ts, from: r.fromName, scope: r.scope, ...(r.say ? { say: true } : {}), ...(r.scope === "dm" ? { to: this.walkers.get(r.to ?? "")?.name ?? null } : {}), text: r.text };
  }

  private publicChat(r: ChatRow) {
    if (r.scope === "dm") throw new Error("publicChat: a DM never leaves the DO");
    return { seq: r.seq, ts: r.ts, from: { id: r.fromPid, name: r.fromName }, scope: r.scope, ...(r.say ? { say: true } : {}), text: r.text, x: round1(r.x), z: round1(r.z) };
  }

  private readChat(w: Walker) {
    const mine = this.rows("WHERE seq > ?", w.lastRead).filter((r) => this.visibleTo(w, r));
    const messages = mine.slice(0, CHAT_READ_MAX);
    const more = mine.length > messages.length;
    w.lastRead = more ? messages.at(-1)!.seq : this.seq;
    this.saveWalker(w);
    return { messages: messages.map((r) => this.chatView(r)), more, now: this.clock() };
  }

  private async chat(w: Walker, args: CityArgs) {
    const op = args.chat ?? "read";
    if (op === "read") return this.readChat(w);
    if (op === "wait") {
      if (this.unreadFor(w).length) return this.readChat(w);
      this.waiters.get(w.id)?.("gone");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const why = await new Promise<WakeReason>((resolve) => {
        const wake = (reason: WakeReason) => {
          if (this.waiters.get(w.id) === wake) this.waiters.delete(w.id);
          clearTimeout(timer);
          resolve(reason);
        };
        this.waiters.set(w.id, wake);
        timer = setTimeout(() => wake("timeout"), (args.timeoutSec ?? CHAT_WAIT_DEFAULT_SEC) * 1000);
      });
      const still = this.walkers.get(w.id);
      if (!still || why === "gone") return { messages: [], more: false, now: this.clock(), ended: true };
      if (why === "message") return this.readChat(still);
      return { messages: [], more: false, now: this.clock(), timedOut: true };
    }
    const text = args.text?.trim();
    if (!text) throw new CityError(400, `office_city chat ${op} needs \`text\``);
    if (op === "say" && w.inside) throw new CityError(400, 'you are inside your building, where nobody on the street sees a speech bubble; go {to: "outside"} first');
    const now = this.clock();
    const at = this.posOf(w, now).p;
    let scope: ChatRow["scope"] = args.scope ?? "near";
    let to: string | null = null;
    let recips: string[] = [];
    if (op === "say" && (args.to || args.scope === "city")) throw new CityError(400, "office_city chat say is a speech bubble: near scope only, no `to`");
    if (typeof args.to === "object" && args.to !== null) throw new CityError(400, "office_city chat `to` is a walker name");
    if (args.to) {
      if (args.scope) throw new CityError(400, "office_city chat: `to` (a DM) and `scope` don't mix");
      const n = normName(args.to);
      const hits = [...this.walkers.values()].filter((o) => o.id !== w.id && normName(o.name) === n);
      if (hits.length === 0) throw new CityError(404, `no walker "${args.to}" in the city (office_city look {about: "agents"} lists them)`);
      if (hits.length > 1) throw new CityError(400, `"${args.to}" matches ${hits.length} walkers`, { candidates: hits.map((h) => h.name) });
      scope = "dm";
      to = hits[0]!.id;
      recips = [to];
    } else if (scope === "city") {
      this.rate(`citychat:${w.id}`, CITY_CHAT_LIMITS, "city-wide chat is limited to 1 per 30 s");
    } else {
      recips = [...this.walkers.values()]
        .filter((o) => o.id !== w.id && !o.inside && (() => {
          const p = this.posOf(o, now).p;
          return Math.hypot(p[0] - at[0], p[1] - at[1]) <= NEAR_BLOCKS;
        })())
        .map((o) => o.id);
    }
    const row: ChatRow = { seq: ++this.seq, ts: now, fromWalker: w.id, fromPid: w.pid, fromName: w.name, scope, to, text, x: at[0], z: at[1], say: op === "say", recips };
    this.ctx.storage.sql.exec(
      "INSERT INTO chat (seq, ts, fromWalker, fromPid, fromName, scope, \"to\", text, x, z, say, recips) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      row.seq, row.ts, row.fromWalker, row.fromPid, row.fromName, row.scope, row.to, row.text, row.x, row.z, row.say ? 1 : 0, JSON.stringify(row.recips),
    );
    this.ctx.storage.sql.exec("DELETE FROM chat WHERE seq <= ?", row.seq - CHAT_RING);
    if (scope !== "dm") {
      if (row.say) {
        this.flushWalker(w);
        this.send({ type: "say", id: w.pid, text, ts: now });
      }
      this.send({ type: "chat", msg: this.publicChat(row) });
    }
    for (const [id, wake] of [...this.waiters]) {
      const o = this.walkers.get(id);
      if (o && id !== w.id && this.visibleTo(o, row)) wake("message");
    }
    return { ok: true, msg: this.chatView(row), heardBy: scope === "near" ? recips.length : undefined };
  }

  // ---------- walkers: storage and public shape ----------

  private saveWalker(w: Walker): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO walkers (id, pid, officeId, agentId, name, hue, siteId, path, t0, speed, mode, at, goal, inside, lastSeen, status, lastRead) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET name = excluded.name, hue = excluded.hue, path = excluded.path, t0 = excluded.t0, speed = excluded.speed, mode = excluded.mode, at = excluded.at, goal = excluded.goal, inside = excluded.inside, lastSeen = excluded.lastSeen, status = excluded.status, lastRead = excluded.lastRead",
      w.id, w.pid, w.officeId, w.agentId, w.name, w.hue, w.siteId, w.path ? JSON.stringify(w.path) : null, w.t0, w.speed, w.mode, JSON.stringify(w.at), w.goal, w.inside ? 1 : 0, w.lastSeen, w.status, w.lastRead,
    );
  }

  private dropWalker(w: Walker): void {
    this.ctx.storage.sql.exec("DELETE FROM walkers WHERE id = ?", w.id);
    this.walkers.delete(w.id);
    this.legShown.delete(w.id);
    for (const k of ["go", "look", "citychat"]) this.limits.forget(`${k}:${w.id}`);
    this.waiters.get(w.id)?.("gone");
    this.queue(`w:${w.pid}`, { type: "left", id: w.pid });
  }

  /** The leg of a moving walker's route viewers get at `now` (a frame carries ≤ MAX_PATH_POINTS points); null when standing. */
  private legOf(w: Walker, now: number): Leg | null {
    return w.path && w.speed > 0 ? legAt(w.path, w.speed, w.t0, now) : null;
  }

  private publicWalker(w: Walker, now: number) {
    const leg = this.legOf(w, now);
    const path = leg ? w.path!.slice(leg.from, leg.to + 1) : [nodePoint(this.mustGraph().walk.nodes, w.node)];
    return { id: w.pid, name: w.name, hue: w.hue, status: this.statusOf(w, now), site: w.siteId, path, t0: leg ? leg.t0 : w.t0, speed: leg ? w.speed : 0, mode: w.mode };
  }

  private queueWalker(w: Walker, type: "walk" | "arrive", now: number): void {
    const leg = this.legOf(w, now);
    if (leg) this.legShown.set(w.id, leg.index);
    else this.legShown.delete(w.id);
    this.queue(`w:${w.pid}`, { type, walker: this.publicWalker(w, now) });
  }

  /** When the walker's next leg starts (or now, if viewers never got its current one); null when no leg frame is due. */
  private nextLegAt(w: Walker, now: number): number | null {
    if (w.inside) return null;
    const leg = this.legOf(w, now);
    if (!leg) return null;
    if (this.legShown.get(w.id) !== leg.index) return now;
    if (leg.last) return null;
    return leg.t0 + travelMs(w.path!.slice(leg.from, leg.to + 1), w.speed);
  }

  private siteSummaries(g: Graph) {
    const bySite = new Map<string, { name: string; hue: number; status: string }[]>();
    for (const p of this.presence.values()) {
      const list = bySite.get(p.siteId) ?? [];
      for (const a of p.agents) if (!a.out) list.push({ name: a.name, hue: a.hue, status: a.status });
      bySite.set(p.siteId, list);
    }
    const inside = new Map<string, number>();
    for (const w of this.walkers.values()) if (w.inside) inside.set(w.siteId, (inside.get(w.siteId) ?? 0) + 1);
    const ids = [...new Set([...bySite.keys(), ...inside.keys()])].filter((siteId) => this.knownSite(g, siteId));
    return ids.sort().map((siteId) => this.siteSummary(g, siteId, bySite.get(siteId) ?? [], inside.get(siteId) ?? 0));
  }

  /** false (and logged) for a site a data rebuild dropped: one stale row must not fail every snapshot. */
  private knownSite(g: Graph, siteId: string): boolean {
    if (g.siteById.has(siteId)) return true;
    console.error(`city: presence or walkers for site ${siteId}, which is not in companies.json (builtAt ${g.builtAt}); left out`);
    return false;
  }

  private siteSummary(g: Graph, siteId: string, agents: { name: string; hue: number; status: string }[], inside: number) {
    const site = g.siteById.get(siteId);
    if (!site) throw new Error(`city: presence for site ${siteId}, which is not in companies.json`);
    return { siteId, companyId: site.companyId, agentCount: agents.length, agents, inside };
  }

  private snapshot(g: Graph) {
    const now = this.clock();
    return {
      now,
      builtAt: g.builtAt,
      sites: this.siteSummaries(g),
      walkers: [...this.walkers.values()].filter((w) => !w.inside).map((w) => this.publicWalker(w, now)),
    };
  }

  // ---------- broadcast ----------

  /** walk/arrive/left (per walker) and presence (per site) frames coalesce; latest wins; flushed at most once per FLUSH_MS. */
  private queue(key: string, frame: Record<string, unknown>): void {
    this.version++;
    this.pending.set(key, frame);
  }

  private queuePresence(siteId: string): void {
    this.queue(`p:${siteId}`, { type: "presence", siteId });
  }

  /** Sends this walker's queued frame now, so a say never reaches viewers before the walker it belongs to. */
  private flushWalker(w: Walker): void {
    const key = `w:${w.pid}`;
    const frame = this.pending.get(key);
    if (!frame) return;
    this.pending.delete(key);
    this.send(frame);
  }

  private send(frame: Record<string, unknown>): void {
    const data = JSON.stringify(frame);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // closing socket; the hibernation API cleans it up
      }
    }
  }

  private flush(now: number): void {
    if (this.pending.size === 0 || now - this.lastFlush < FLUSH_MS) return;
    const frames = [...this.pending.values()];
    this.pending.clear();
    this.lastFlush = now;
    const g = this.graph;
    for (const f of frames) {
      if (f.type === "presence") {
        if (!g) continue;
        const siteId = f.siteId as string;
        if (!this.knownSite(g, siteId)) continue;
        const agents = [...this.presence.values()].filter((p) => p.siteId === siteId).flatMap((p) => p.agents.filter((a) => !a.out).map((a) => ({ name: a.name, hue: a.hue, status: a.status })));
        const inside = [...this.walkers.values()].filter((w) => w.inside && w.siteId === siteId).length;
        this.send({ type: "presence", site: this.siteSummary(g, siteId, agents, inside) });
      } else {
        this.send(f);
      }
    }
  }

  /** After any state change: flush what is due and re-arm the one alarm. */
  private afterChange(): void {
    this.flush(this.clock());
    this.ctx.waitUntil(this.scheduleAlarm());
  }

  private nextDeadline(): number | null {
    let next: number | null = null;
    const at = (t: number | null) => {
      if (t !== null && (next === null || t < next)) next = t;
    };
    // walker deadlines need the graph: while it is missing after a failed load they wait for the retry
    const floor = this.graph ? -Infinity : this.graphRetryAt;
    const walkerAt = (t: number | null) => at(t === null ? null : Math.max(t, floor));
    const now = this.clock();
    for (const w of this.walkers.values()) {
      walkerAt(this.arrivalAt(w));
      if (this.graph) walkerAt(this.nextLegAt(w, now));
      walkerAt(w.lastSeen + CITY_REMOVE_MS);
      if (w.status !== "away") walkerAt(w.lastSeen + CITY_AWAY_MS);
    }
    for (const p of this.presence.values()) at(p.ts + PRESENCE_TTL_MS);
    if (this.pending.size) at(this.lastFlush + FLUSH_MS);
    if (this.walkers.size) walkerAt(this.graphCheckedAt + GRAPH_CHECK_MS);
    return next;
  }

  private async scheduleAlarm(): Promise<void> {
    const next = this.nextDeadline();
    if (next === null) {
      if (this.alarmAt !== null) await this.ctx.storage.deleteAlarm();
      this.alarmAt = null;
      return;
    }
    if (this.alarmAt === next) return;
    this.alarmAt = next;
    await this.ctx.storage.setAlarm(next);
  }

  override async alarm(): Promise<void> {
    this.alarmAt = null;
    const now = this.clock();
    this.sweepPending(now);
    this.limits.prune(now);
    if (!this.graph || (this.walkers.size && now - this.graphCheckedAt >= GRAPH_CHECK_MS)) {
      try {
        await this.ensureGraph();
        this.graphFailures = 0;
        this.graphRetryAt = 0;
      } catch (e) {
        this.graphFailures++;
        this.graphRetryAt = now + Math.min(GRAPH_RETRY_MAX_MS, GRAPH_RETRY_MS * 2 ** (this.graphFailures - 1));
        console.error(`city: loading city data failed (${this.graphFailures} in a row); walkers wait until ${new Date(this.graphRetryAt).toISOString()}`, e);
      }
    }
    if (this.graph) {
      for (const w of [...this.walkers.values()]) {
        const idle = now - w.lastSeen;
        if (idle >= CITY_REMOVE_MS) {
          this.dropWalker(w);
          continue;
        }
        let changed = false;
        const arrival = this.arrivalAt(w);
        if (arrival !== null && arrival <= now) {
          w.path = null;
          w.speed = 0;
          changed = true;
          this.saveWalker(w);
          if (!w.inside) this.queueWalker(w, "arrive", now);
        } else if (!w.inside) {
          const leg = this.legOf(w, now);
          if (leg && this.legShown.get(w.id) !== leg.index) this.queueWalker(w, "walk", now);
        }
        if (idle >= CITY_AWAY_MS && w.status !== "away") {
          w.status = "away";
          this.saveWalker(w);
          if (!w.inside) this.queueWalker(w, changed ? "arrive" : "walk", now);
        }
      }
    }
    for (const p of [...this.presence.values()]) {
      if (now - p.ts < PRESENCE_TTL_MS) continue;
      this.ctx.storage.sql.exec("DELETE FROM presence WHERE officeId = ?", p.officeId);
      this.presence.delete(p.officeId);
      this.queuePresence(p.siteId);
    }
    this.flush(now);
    await this.scheduleAlarm();
  }

  // ---------- public HTTP: GET /api/city/sf and WS /city/sf/ws ----------

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      const ip = req.headers.get("cf-connecting-ip");
      if (!ip) throw new CityError(400, "city: the request has no CF-Connecting-IP header");
      if (url.pathname === `/api/city/${CITY_ID}`) {
        if (req.method !== "GET") return Response.json({ error: `GET /api/city/${CITY_ID}` }, { status: 405 });
        this.publicRate(ip);
        return new Response(await this.cachedSnapshot(), { headers: { "content-type": "application/json" } });
      }
      if (url.pathname === `/city/${CITY_ID}/ws`) {
        if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return Response.json({ error: "expected a WebSocket upgrade" }, { status: 426 });
        this.publicRate(ip);
        if (this.ctx.getWebSockets().length >= MAX_CITY_VIEWERS) return Response.json({ error: `too many city viewers (${MAX_CITY_VIEWERS})` }, { status: 503 });
        const tag = `ip:${ip}`;
        if (this.ctx.getWebSockets(tag).length >= MAX_VIEWERS_PER_IP) return Response.json({ error: `too many city viewers from one address (${MAX_VIEWERS_PER_IP})` }, { status: 429 });
        const g = await this.ensureGraph();
        this.afterChange();
        const pair = new WebSocketPair();
        const [client, server] = [pair[0], pair[1]];
        this.ctx.acceptWebSocket(server, ["viewer", tag]);
        server.serializeAttachment({ since: this.clock() });
        const chatTail = this.rows("WHERE scope != 'dm' AND seq > ?", this.seq - CHAT_RING).slice(-CHAT_TAIL).map((r) => this.publicChat(r));
        server.send(JSON.stringify({ type: "snapshot", ...this.snapshot(g), chatTail }));
        return new Response(null, { status: 101, webSocket: client });
      }
      return Response.json({ error: `no route ${url.pathname}` }, { status: 404 });
    } catch (e) {
      const r = wrapError(e) as { status: number; error: string; extra: Record<string, unknown> };
      const headers = typeof r.extra.retryAfter === "number" ? { "retry-after": String(r.extra.retryAfter) } : undefined;
      return Response.json({ error: r.error, ...r.extra }, { status: r.status, headers });
    }
  }

  private publicRate(ip: string): void {
    const [w] = PUBLIC_IP_LIMITS;
    this.rate(`ip:${ip}`, PUBLIC_IP_LIMITS, `max ${w!.max} city requests per ${w!.ms / 1000}s from one address`);
  }

  /** GET /api/city/sf body, rebuilt (and the alarm re-armed) only when something changed or SNAPSHOT_CACHE_MS passed. */
  private async cachedSnapshot(): Promise<string> {
    const now = this.clock();
    const c = this.snapCache;
    if (c && c.version === this.version && now - c.at < SNAPSHOT_CACHE_MS) return c.body;
    const g = await this.ensureGraph();
    this.afterChange();
    const body = JSON.stringify({ ...this.snapshot(g), graph: { nodes: g.walk.nodes.length / 3, edges: g.walk.edges.length / 5, decodeMs: round1(g.loadMs) } });
    this.snapCache = { version: this.version, at: now, body };
    return body;
  }

  override async webSocketMessage(ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    ws.send(JSON.stringify({ type: "error", error: "the city socket is view-only" }));
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {
      // already closed
    }
  }
}
