// One Durable Object per office: furniture, agents, chat, viewer WebSockets (hibernation API) and presence.
import { DurableObject } from "cloudflare:workers";
import { applyOp, defaultLayout, findFreeSpot, GRID, KINDS, kindOf, MAX_AGENTS, MAX_ITEMS, OfficeError, TEXT_MAX, validateLayout, type Grid, type Item, type Op } from "./shared/catalog";
import {
  allSpots, brandTheme, BOXES_MAX, describeTheme, CUSTOM_KINDS_MAX, DEFAULT_THEME, designSummary, FOOTPRINT_MAX, HEIGHT_MAX, mergeTheme, summarizeKind, ThemeError,
  UNITS, validateKindDef, validateTheme, type CustomKind, type Theme, type ThemePatch,
} from "./shared/design";
import { ASSET_BYTES_MAX, ASSET_DIM_MAX, ASSETS_MAX, ASSETS_TOTAL_MAX, decodeBase64, sniffImage } from "./images";
import { newOfficeKey, randomSecret, roleOfKey, sha256hex, keyFromRequest, WS_PROTOCOL, type KeyHashes, type Role } from "./auth";
import { CORS_HEADERS, errorResponse, HttpError, json, readJson } from "./http";
import { isMergedTool, MERGED_ROUTES, NAME_MAX, parseArgs, parseOwnerFrame, ToolError, type MergedTool, type Status, type ToolArgs, type ToolName, ACTIVITY_MAX } from "./tools";
import { handleMcp } from "./mcp";
import { handleRest } from "./api";

export const MAX_CHAT = 200;
/** The join key in plaintext, so the owner's viewer can show agents how to connect. */
const JOIN_KEY_SLOT = "joinKey";
export const CHAT_READ_MAX = 50;
export const MAX_VIEWERS = 256;
export const AWAY_MS = 5 * 60_000;
export const REMOVE_MS = 60 * 60_000;
export const RATE_WINDOW_MS = 10_000;
export const RATE_MAX = 30;
export const IP_RATE_MAX = 120;
export const WS_FRAME_MAX = 4096;
export const WS_RATE_MAX = 30;
export const JOIN_WINDOW_MS = 60_000;
export const JOIN_RATE_MAX = 10;
/** Desks the office adds by itself when every desk is taken; beyond this, late joiners stand. */
export const MAX_AUTO_DESKS = 16;
export const MAX_MCP_SESSIONS = 2000;
export const MCP_SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
/** A same-name+client agent counts as "still at work" (and is not reclaimed by a new join) while seen this recently. */
export const RECLAIM_AFTER_MS = 90_000;
/** Storage schema: 1 = meta/items/agents/chat only; 2 = + theme, custom kinds ("kind:<slug>"), assets table, designer. */
export const SCHEMA_VERSION = 2;
export const UPLOAD_WINDOW_MS = 60_000;
export const UPLOAD_RATE_MAX = 10;
const ASSETS_DDL =
  "CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, w INTEGER NOT NULL, h INTEGER NOT NULL, size INTEGER NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL, bytes BLOB NOT NULL)";

export interface Agent {
  id: string;
  name: string;
  hue: number;
  emoji?: string;
  client?: string;
  status: Status;
  activity?: string;
  deskId?: string;
  joinedAt: number;
  lastSeen: number;
  says?: { text: string; ts: number };
}

interface AgentRecord extends Agent {
  tokenHash: string;
  lastRead: number;
  sessions: string[];
  /** The name it joined with, before a " 2"-style suffix made it unique; records saved before suffixes lack it. */
  askedName?: string;
}

export interface ChatMsg {
  id: string;
  from: string;
  to: string | null;
  text: string;
  ts: number;
}

/** Asset metadata (the bytes stay in SQLite). url is office-relative: /o/:office/assets/:id */
export interface AssetMeta {
  id: string;
  url: string;
  name: string;
  type: string;
  w: number;
  h: number;
  size: number;
  by: string;
  at: number;
}

export interface OfficeState {
  id: string;
  name: string;
  grid: Grid;
  items: Item[];
  agents: Agent[];
  chat: ChatMsg[];
  theme: Theme;
  customKinds: CustomKind[];
  assets: AssetMeta[];
  /** Agent id the owner marked as the office's designer, or null. */
  designer: string | null;
}

interface Meta {
  id: string;
  name: string;
  grid: Grid;
  keys: KeyHashes;
  createdAt: number;
}

export interface CallCtx {
  role: Role;
  token: string | null;
  sessionId: string | null;
  ip: string;
  /** Request origin, for absolute asset urls in tool results. */
  origin: string;
}

export interface ToolHost {
  callTool(name: ToolName, args: unknown, ctx: CallCtx): Promise<unknown>;
  /** Raw-body upload (REST): same checks and result as office_upload. */
  upload(bytes: Uint8Array, filename: string, contentType: string | undefined, ctx: CallCtx): Promise<unknown>;
  startSession(sessionId: string): Promise<void>;
  hasSession(sessionId: string): Promise<boolean>;
  endSession(sessionId: string): Promise<void>;
}

type Frame =
  | { type: "snapshot"; state: OfficeState; role: Role }
  | { type: "agent"; agent: Agent }
  | { type: "agent-left"; id: string }
  | { type: "item"; item: Item }
  | { type: "item-removed"; id: string }
  | { type: "chat"; msg: ChatMsg }
  | { type: "theme"; theme: Theme }
  | { type: "kind"; kind: CustomKind }
  | { type: "kind-removed"; kind: string }
  | { type: "asset"; asset: AssetMeta }
  | { type: "asset-removed"; id: string }
  | { type: "designer"; id: string | null }
  | { type: "error"; error: string; retryAfter?: number };

/** Tools a human with the ownerKey may call without joining (acting as "human:owner"). */
const OWNER_TOOLS = new Set<ToolName>(["office_theme_get", "office_theme_set", "office_define_kind", "office_delete_kind", "office_upload", "office_set_logo", "office_delete_asset"]);

interface WsAttachment {
  role: Role;
  sid: string;
}

const publicAgent = ({ tokenHash: _t, lastRead: _r, sessions: _s, askedName: _n, ...a }: AgentRecord): Agent => a;

function hueOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % 360;
}

function slug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20);
  return s || "agent";
}

function shortId(): string {
  return randomSecret().replace(/[^a-z0-9]/gi, "").slice(0, 6).toLowerCase();
}

export class Office extends DurableObject<Env> implements ToolHost {
  private meta: Meta | null = null;
  private items = new Map<string, Item>();
  private agents = new Map<string, AgentRecord>();
  private chat: ChatMsg[] = [];
  private byToken = new Map<string, string>();
  private sessions = new Map<string, string>();
  private hits = new Map<string, number[]>();
  private wsWarned = new Map<string, number>();
  private mcpSessions = new Map<string, number>();
  private alarmAt: number | null = null;
  private theme: Theme = validateTheme(DEFAULT_THEME);
  private customKinds: Record<string, CustomKind> = {};
  private assets = new Map<string, AssetMeta>();
  private designer: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
    ctx.blockConcurrencyWhile(() => this.load());
  }

  /** Loads the office from storage (migrating older schemas first). Runs once, in the constructor. */
  private async load(): Promise<void> {
    const ctx = this.ctx;
    this.meta = (await ctx.storage.get<Meta>("meta")) ?? null;
    if (!this.meta) return;
    await this.migrate();
    for (const [, it] of await ctx.storage.list<Item>({ prefix: "item:" })) this.items.set(it.id, it);
    for (const [, a] of await ctx.storage.list<AgentRecord>({ prefix: "agent:" })) {
      this.agents.set(a.id, a);
      this.byToken.set(a.tokenHash, a.id);
      for (const s of a.sessions) this.sessions.set(s, a.id);
    }
    this.chat = (await ctx.storage.get<ChatMsg[]>("chat")) ?? [];
    for (const [k, at] of await ctx.storage.list<number>({ prefix: "mcps:" })) this.mcpSessions.set(k.slice(5), at);
    this.alarmAt = await ctx.storage.getAlarm();
    this.theme = await this.loadTheme();
    for (const [, k] of await ctx.storage.list<CustomKind>({ prefix: "kind:" })) this.customKinds[k.kind] = k;
    this.designer = (await ctx.storage.get<string>("designer")) ?? null;
    const rows = ctx.storage.sql.exec<{ id: string; name: string; type: string; w: number; h: number; size: number; by: string; at: number }>(
      "SELECT id, name, type, w, h, size, by, at FROM assets ORDER BY at",
    );
    for (const r of rows) this.assets.set(r.id, { ...r, url: this.assetUrl(r.id) });
  }

  /** Brings a stored office up to SCHEMA_VERSION. v1 offices get the default theme and an empty assets table. */
  private async migrate(): Promise<void> {
    this.ctx.storage.sql.exec(ASSETS_DDL);
    const version = (await this.ctx.storage.get<number>("schema")) ?? 1;
    if (version > SCHEMA_VERSION) throw new Error(`office storage is schema ${version}, this build understands up to ${SCHEMA_VERSION}`);
    if (version < 2) await this.ctx.storage.put({ schema: SCHEMA_VERSION, theme: DEFAULT_THEME });
  }

  /**
   * The stored theme, filled up to today's shape: a theme written before a field existed gets that field's
   * default (merged over DEFAULT_THEME) and is written back. Unknown or invalid fields still fail loudly.
   */
  private async loadTheme(): Promise<Theme> {
    const stored = await this.ctx.storage.get<Theme>("theme");
    if (!stored) return DEFAULT_THEME;
    const theme = mergeTheme(DEFAULT_THEME, stored) as Theme;
    if (JSON.stringify(theme) !== JSON.stringify(stored)) await this.ctx.storage.put("theme", theme);
    return theme;
  }

  private assetUrl(id: string): string {
    return `/o/${this.mustMeta().id}/assets/${id}`;
  }

  // ---------- HTTP entry (the worker forwards here) ----------

  override async fetch(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      if (url.pathname === "/internal/init") return await this.init(req);
      if (!this.meta) return errorResponse(404, "no such office");
      const asset = /^\/o\/[^/]+\/assets\/([^/]+)$/.exec(url.pathname);
      if (asset) return this.serveAsset(req, asset[1]!);
      const ip = req.headers.get("cf-connecting-ip") ?? "local";
      this.rateLimit(`ip:${ip}`, IP_RATE_MAX);
      const role = await roleOfKey(keyFromRequest(req), this.meta.keys);
      if (!role) return errorResponse(401, "missing or wrong key for this office (Authorization: Bearer <key> or ?key=)");
      if (/^\/o\/[^/]+\/ws$/.test(url.pathname)) return this.acceptViewer(req, role);
      const base = { role, token: req.headers.get("x-agent-token"), sessionId: null, ip, origin: url.origin } satisfies CallCtx;
      if (url.pathname === "/mcp") {
        if (role === "view") return errorResponse(403, "a viewKey is read-only; MCP needs the joinKey");
        return await handleMcp(req, this, base);
      }
      const m = /^\/api\/o\/[^/]+\/([a-z_-]+)$/.exec(url.pathname);
      if (m && m[1] === "connect") {
        if (role === "view") return errorResponse(403, "a viewKey is watch-only: it can't bring agents in");
        if (req.method !== "GET") return errorResponse(405, "GET /api/o/:office/connect");
        return json(200, await this.connectInfo(role, url.origin));
      }
      if (m && (m[1] === "kick" || m[1] === "rotate-keys" || m[1] === "rotate_keys" || m[1] === "designer")) {
        if (role !== "owner") return errorResponse(403, `${m[1]} needs the ownerKey`);
        if (req.method !== "POST") return errorResponse(405, `POST /api/o/:office/${m[1]}`);
        const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
        if (m[1] === "kick") return json(200, await this.kick(body.id, "human:owner"));
        if (m[1] === "designer") return json(200, await this.setDesigner(body.id));
        return json(200, await this.rotateKeys(body.which, new URL(req.url).origin));
      }
      if (m) {
        if (role === "view") return errorResponse(403, "a viewKey is read-only; the API needs the joinKey");
        return await handleRest(req, this, base, m[1]!);
      }
      return errorResponse(404, `no route ${url.pathname}`);
    } catch (e) {
      return this.errorToResponse(e);
    }
  }

  private errorToResponse(e: unknown): Response {
    if (e instanceof ToolError || e instanceof HttpError) return errorResponse(e.status, e.message, e.extra);
    if (e instanceof OfficeError || e instanceof ThemeError) return errorResponse(400, e.message);
    console.error("office: unexpected error", e);
    return errorResponse(500, "internal error");
  }

  private async init(req: Request): Promise<Response> {
    if (this.meta) return errorResponse(409, "office already exists");
    const body = (await readJson(req)) as { id: string; name: string; keys: KeyHashes; joinKey: string };
    if (typeof body.joinKey !== "string" || (await sha256hex(body.joinKey)) !== body.keys.join) return errorResponse(400, "init needs the joinKey matching keys.join");
    const meta: Meta = { id: body.id, name: body.name, grid: { ...GRID }, keys: body.keys, createdAt: Date.now() };
    const items = defaultLayout(meta.createdAt);
    const puts: Record<string, unknown> = { meta, schema: SCHEMA_VERSION, theme: DEFAULT_THEME, [JOIN_KEY_SLOT]: body.joinKey };
    this.ctx.storage.sql.exec(ASSETS_DDL);
    for (const it of items) puts[`item:${it.id}`] = it;
    await this.ctx.storage.put(puts);
    this.meta = meta;
    for (const it of items) this.items.set(it.id, it);
    return json(201, { id: meta.id, name: meta.name });
  }

  private rateLimit(bucket: string, max: number, windowMs = RATE_WINDOW_MS): void {
    const now = Date.now();
    const recent = (this.hits.get(bucket) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      const retryAfter = Math.max(1, Math.ceil((recent[0]! + windowMs - now) / 1000));
      this.hits.set(bucket, recent);
      throw new ToolError(429, `rate limited: max ${max} calls per ${windowMs / 1000}s — slow down`, { retryAfter });
    }
    recent.push(now);
    this.hits.set(bucket, recent);
  }

  // ---------- state helpers ----------

  state(): OfficeState {
    const meta = this.mustMeta();
    return {
      id: meta.id,
      name: meta.name,
      grid: meta.grid,
      items: [...this.items.values()],
      agents: [...this.agents.values()].map(publicAgent),
      chat: this.chat,
      theme: this.theme,
      customKinds: Object.values(this.customKinds),
      assets: [...this.assets.values()],
      designer: this.designer,
    };
  }

  private mustMeta(): Meta {
    if (!this.meta) throw new ToolError(404, "no such office");
    return this.meta;
  }

  private itemList(): Item[] {
    return [...this.items.values()];
  }

  private broadcast(frame: Frame): void {
    const data = JSON.stringify(frame);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // socket already closing; hibernation API cleans it up
      }
    }
  }

  private async saveAgent(a: AgentRecord, broadcast = true): Promise<void> {
    await this.ctx.storage.put(`agent:${a.id}`, a);
    if (broadcast) this.broadcast({ type: "agent", agent: publicAgent(a) });
  }

  private async removeAgent(a: AgentRecord): Promise<void> {
    if (this.designer === a.id) await this.setDesigner(null);
    this.agents.delete(a.id);
    this.byToken.delete(a.tokenHash);
    for (const s of a.sessions) this.sessions.delete(s);
    await this.ctx.storage.delete(`agent:${a.id}`);
    this.broadcast({ type: "agent-left", id: a.id });
  }

  private async postChat(from: string, to: string | null, text: string): Promise<ChatMsg> {
    const msg: ChatMsg = { id: `m-${Date.now().toString(36)}-${shortId()}`, from, to, text, ts: Date.now() };
    this.chat.push(msg);
    if (this.chat.length > MAX_CHAT) this.chat.splice(0, this.chat.length - MAX_CHAT);
    await this.ctx.storage.put("chat", this.chat);
    this.broadcast({ type: "chat", msg });
    return msg;
  }

  private async applyItemOp(op: unknown, by: string): Promise<{ item: Item | null; removed: string | null }> {
    const res = applyOp(this.itemList(), op as Op, by, { grid: this.mustMeta().grid, now: Date.now(), kinds: this.customKinds });
    const item = res.item ?? null;
    const removed = res.removed ?? null;
    if (item) {
      this.items.set(item.id, item);
      await this.ctx.storage.put(`item:${item.id}`, item);
      this.broadcast({ type: "item", item });
    }
    if (removed) {
      this.items.delete(removed);
      await this.ctx.storage.delete(`item:${removed}`);
      this.broadcast({ type: "item-removed", id: removed });
      for (const a of this.agents.values()) {
        if (a.deskId !== removed) continue;
        delete a.deskId;
        await this.saveAgent(a);
      }
    }
    return { item, removed };
  }

  private async assignDesk(a: AgentRecord): Promise<void> {
    const taken = new Set([...this.agents.values()].map((x) => x.deskId).filter(Boolean));
    const free = [...this.items.values()]
      .filter((it) => it.kind === "desk" && !taken.has(it.id))
      .sort((p, q) => p.z - q.z || p.x - q.x)[0];
    if (free) {
      a.deskId = free.id;
      return;
    }
    if (this.items.size >= MAX_ITEMS) return;
    const autoDesks = [...this.items.values()].filter((it) => it.kind === "desk" && it.by === "office").length;
    if (autoDesks >= MAX_AUTO_DESKS) return;
    const spot = findFreeSpot(this.itemList(), this.mustMeta().grid, "desk", 0, this.customKinds);
    if (!spot) return;
    const { item } = await this.applyItemOp({ op: "add", kind: "desk", x: spot.x, z: spot.z, rot: 0 }, "office");
    if (item) a.deskId = item.id;
  }

  // ---------- presence ----------

  private async scheduleAlarm(): Promise<void> {
    let next: number | null = null;
    for (const a of this.agents.values()) {
      const due = a.status === "away" ? a.lastSeen + REMOVE_MS : a.lastSeen + AWAY_MS;
      if (next === null || due < next) next = due;
    }
    if (next === null) return;
    if (this.alarmAt !== null && this.alarmAt <= next && this.alarmAt > Date.now() - 1000) return;
    this.alarmAt = next;
    await this.ctx.storage.setAlarm(next);
  }

  override async alarm(): Promise<void> {
    this.alarmAt = null;
    const now = Date.now();
    for (const a of [...this.agents.values()]) {
      const idle = now - a.lastSeen;
      if (idle >= REMOVE_MS) await this.removeAgent(a);
      else if (idle >= AWAY_MS && a.status !== "away") {
        a.status = "away";
        await this.saveAgent(a);
      }
    }
    await this.scheduleAlarm();
  }

  // ---------- tools ----------

  private async resolveAgent(ctx: CallCtx, explicit: string | undefined): Promise<AgentRecord | null> {
    const token = explicit ?? ctx.token;
    if (token) {
      const id = this.byToken.get(await sha256hex(token));
      const a = id ? this.agents.get(id) : undefined;
      if (!a) throw new ToolError(401, "unknown agentToken — call office_join again (agents are walked out after 1h of silence)");
      return a;
    }
    if (ctx.sessionId) {
      const id = this.sessions.get(await sha256hex(ctx.sessionId));
      const a = id ? this.agents.get(id) : undefined;
      if (a) return a;
    }
    return null;
  }

  private async requireAgent(ctx: CallCtx, explicit: string | undefined): Promise<AgentRecord> {
    const a = await this.resolveAgent(ctx, explicit);
    if (!a) throw new ToolError(401, "you are not in the office yet — call office_join first (or pass your agentToken)");
    return a;
  }

  /** Marks the agent as seen; an away agent comes back as idle. Returns true if visible state changed. */
  private touch(a: AgentRecord): boolean {
    a.lastSeen = Date.now();
    if (a.status === "away") {
      a.status = "idle";
      return true;
    }
    return false;
  }

  async startSession(sessionId: string): Promise<void> {
    const h = await sha256hex(sessionId);
    const now = Date.now();
    this.mcpSessions.set(h, now);
    const puts: Record<string, number> = { [`mcps:${h}`]: now };
    await this.ctx.storage.put(puts);
    if (this.mcpSessions.size > MAX_MCP_SESSIONS) {
      const oldest = [...this.mcpSessions.entries()].sort((a, b) => a[1] - b[1]).slice(0, this.mcpSessions.size - MAX_MCP_SESSIONS);
      for (const [k] of oldest) this.mcpSessions.delete(k);
      await this.ctx.storage.delete(oldest.map(([k]) => `mcps:${k}`));
    }
  }

  async hasSession(sessionId: string): Promise<boolean> {
    const h = await sha256hex(sessionId);
    const at = this.mcpSessions.get(h);
    if (at === undefined) return false;
    const now = Date.now();
    if (now - at > MCP_SESSION_TTL_MS) {
      this.mcpSessions.delete(h);
      await this.ctx.storage.delete(`mcps:${h}`);
      return false;
    }
    if (now - at > 60 * 60_000) {
      this.mcpSessions.set(h, now);
      await this.ctx.storage.put(`mcps:${h}`, now);
    }
    return true;
  }

  async endSession(sessionId: string): Promise<void> {
    const h = await sha256hex(sessionId);
    if (this.mcpSessions.delete(h)) await this.ctx.storage.delete(`mcps:${h}`);
    const id = this.sessions.get(h);
    if (!id) return;
    this.sessions.delete(h);
    const a = this.agents.get(id);
    if (!a) return;
    a.sessions = a.sessions.filter((s) => s !== h);
    await this.saveAgent(a, false);
  }

  /** office_edit / office_chat: pick the single-purpose tool for `op`, pass it only the args that op takes. */
  private async callMerged(name: MergedTool, args: Record<string, unknown>, ctx: CallCtx): Promise<unknown> {
    const op = args.op as string;
    const route = (MERGED_ROUTES[name] as Record<string, { tool: ToolName; args: readonly string[] }>)[op];
    if (!route) throw new ToolError(400, `${name}: unknown op "${op}"`);
    const stray = Object.keys(args).filter((k) => k !== "op" && k !== "agentToken" && args[k] !== undefined && !route.args.includes(k));
    if (stray.length) throw new ToolError(400, `${name} op "${op}" takes ${route.args.join(", ")} — not ${stray.join(", ")}`);
    const picked: Record<string, unknown> = { agentToken: args.agentToken };
    for (const k of route.args) if (args[k] !== undefined) picked[k] = args[k];
    try {
      return await this.callTool(route.tool, picked, ctx);
    } catch (e) {
      if (e instanceof ToolError && e.message.startsWith(`${route.tool}:`)) {
        throw new ToolError(e.status, `${name} op "${op}":${e.message.slice(route.tool.length + 1)}`, e.extra);
      }
      throw e;
    }
  }

  async callTool(name: ToolName, rawArgs: unknown, ctx: CallCtx): Promise<unknown> {
    this.mustMeta();
    const args = parseArgs(name, rawArgs) as Record<string, unknown> & { agentToken?: string };
    if (isMergedTool(name)) return this.callMerged(name, args, ctx);
    if (name === "office_kinds") return this.kinds((args as ToolArgs<"office_kinds">).kind);
    if (OWNER_TOOLS.has(name)) {
      const by = await this.designActor(ctx, args.agentToken);
      return this.designTool(name, args, by, ctx);
    }
    if (name === "office_join") {
      this.rateLimit(`join:${ctx.ip}`, JOIN_RATE_MAX, JOIN_WINDOW_MS);
      return this.join(args as ToolArgs<"office_join">, ctx);
    }
    const agent = name === "office_look" ? await this.resolveAgent(ctx, args.agentToken) : await this.requireAgent(ctx, args.agentToken);
    this.rateLimit(agent ? `agent:${agent.id}` : `anon:${ctx.ip}`, RATE_MAX);
    if (!agent) return this.look(null);
    const changed = this.touch(agent);
    let result: unknown;
    switch (name) {
      case "office_leave":
        await this.removeAgent(agent);
        return { ok: true, left: agent.id };
      case "office_status": {
        const { status, activity } = args as ToolArgs<"office_status">;
        agent.status = status;
        if (activity?.trim()) agent.activity = activity.trim().slice(0, ACTIVITY_MAX);
        else delete agent.activity;
        await this.saveAgent(agent);
        result = { ok: true, agent: publicAgent(agent) };
        break;
      }
      case "office_say": {
        const { text } = args as ToolArgs<"office_say">;
        const ts = Date.now();
        agent.says = { text, ts };
        await this.saveAgent(agent);
        const msg = await this.postChat(agent.id, null, text);
        result = { ok: true, msg };
        break;
      }
      case "office_chat_send": {
        const { to, text } = args as ToolArgs<"office_chat_send">;
        const target = to ? this.chatTarget(to) : null;
        const msg = await this.postChat(agent.id, target, text);
        result = { ok: true, msg };
        break;
      }
      case "office_chat_read": {
        const { since } = args as ToolArgs<"office_chat_read">;
        const from = since ?? agent.lastRead;
        const mine = this.chat.filter((m) => m.ts > from && (m.to === null || m.to === agent.id || m.from === agent.id));
        const messages = mine.slice(0, CHAT_READ_MAX);
        const more = mine.length > messages.length;
        const now = Date.now();
        agent.lastRead = Math.max(agent.lastRead, more ? messages.at(-1)!.ts : now);
        result = { messages, more, now, names: this.namesFor(messages) };
        break;
      }
      case "office_look":
        result = this.look(agent);
        break;
      case "office_add": {
        const { agentToken: _t, ...op } = args as ToolArgs<"office_add">;
        result = { ok: true, ...(await this.applyItemOp({ op: "add", ...op }, agent.id)) };
        break;
      }
      case "office_remove": {
        const { id } = args as ToolArgs<"office_remove">;
        this.guardOccupiedDesk(id, agent, "remove");
        result = { ok: true, ...(await this.applyItemOp({ op: "remove", id }, agent.id)) };
        break;
      }
      case "office_move": {
        const { id, x, z } = args as ToolArgs<"office_move">;
        this.guardOccupiedDesk(id, agent, "move");
        result = { ok: true, ...(await this.applyItemOp({ op: "move", id, x, z }, agent.id)) };
        break;
      }
      case "office_rotate": {
        const { id, rot } = args as ToolArgs<"office_rotate">;
        this.guardOccupiedDesk(id, agent, "rotate");
        result = { ok: true, ...(await this.applyItemOp({ op: "rotate", id, rot }, agent.id)) };
        break;
      }
      case "office_text": {
        const { id, text } = args as ToolArgs<"office_text">;
        result = { ok: true, ...(await this.applyItemOp({ op: "text", id, text }, agent.id)) };
        break;
      }
      default:
        throw new ToolError(400, `unknown tool ${name}`);
    }
    if (this.agents.has(agent.id)) await this.saveAgent(agent, changed && name !== "office_status" && name !== "office_say");
    await this.scheduleAlarm();
    return result;
  }

  private guardOccupiedDesk(id: string, me: AgentRecord, verb: string): void {
    const sitter = [...this.agents.values()].find((a) => a.deskId === id && a.id !== me.id);
    if (sitter) throw new ToolError(409, `${id} is ${sitter.name}'s desk — be a polite office-mate and don't ${verb} it`);
  }

  /** Chat target: an agent id or name, "human:<name>" for a person watching the office, or null (the room) for "room"/"all"/"everyone" when no agent has that name. */
  private chatTarget(ref: string): string | null {
    const roomAlias = ["room", "all", "everyone"].includes(ref.trim().toLowerCase());
    if (roomAlias && !this.agents.has(ref) && ![...this.agents.values()].some((a) => a.name.toLowerCase() === ref.trim().toLowerCase())) return null;
    if (ref.startsWith("human:")) {
      const name = ref.slice(6).trim();
      if (!name || name.length > NAME_MAX) throw new ToolError(400, `"human:<name>" needs a name of 1-${NAME_MAX} chars`);
      return `human:${name}`;
    }
    return this.findAgentRef(ref);
  }

  private findAgentRef(ref: string): string {
    if (this.agents.has(ref)) return ref;
    const lower = ref.toLowerCase();
    const byName = [...this.agents.values()].filter((a) => a.name.toLowerCase() === lower);
    if (byName.length === 1) return byName[0]!.id;
    if (byName.length > 1) throw new ToolError(400, `"${ref}" matches ${byName.length} agents — use an agent id (${byName.map((a) => a.id).join(", ")})`);
    throw new ToolError(404, `no agent "${ref}" in the office (office_look lists who is here; omit "to" to post to the room, or use "human:<name>" to answer a person)`);
  }

  private namesFor(msgs: ChatMsg[]): Record<string, string> {
    const names: Record<string, string> = {};
    for (const m of msgs) {
      for (const ref of [m.from, m.to]) {
        if (!ref || names[ref]) continue;
        const a = this.agents.get(ref);
        if (a) names[ref] = a.name;
        else if (ref.startsWith("human:")) names[ref] = ref.slice(6);
      }
    }
    return names;
  }

  private kinds(one?: string) {
    if (one !== undefined) {
      const k = kindOf(one, this.customKinds);
      if (!k) throw new ToolError(404, `no kind "${one}" (built-ins: ${Object.keys(KINDS).join(", ")}; custom: ${Object.keys(this.customKinds).join(", ") || "none"})`);
      return { kind: one, ...k };
    }
    return {
      grid: this.mustMeta().grid,
      kinds: KINDS,
      custom: Object.fromEntries(Object.values(this.customKinds).map((k) => [k.kind, summarizeKind(k)])),
      limits: { customKinds: CUSTOM_KINDS_MAX, boxesPerKind: BOXES_MAX, footprintMax: FOOTPRINT_MAX, unitsPerCell: UNITS, heightMax: HEIGHT_MAX, assets: ASSETS_MAX, assetBytes: ASSET_BYTES_MAX, assetPx: ASSET_DIM_MAX },
      rules: [
        "(x, z) is the footprint's min corner; x runs along the back wall, z away from it.",
        "rot 90/270 swaps a footprint's w and d. A model's front faces +z at rot 0.",
        "Items collide only within their layer: rugs (floor) lie under furniture, wall items hang above it.",
        "Wall kinds hang on a wall: rot 0 with z 0 (back wall) or rot 90 with x 0 (left wall).",
        `Text (sign, poster, whiteboard) ≤ ${TEXT_MAX} chars.`,
        "Seats/stations are in local units (16 per cell) from the footprint's min corner at rot 0; office_look lists them placed in the world.",
        "Custom kinds: office_define_kind (voxel boxes), then office_edit {op: \"add\"} like any built-in; office_kinds {kind} returns a kind in full.",
      ],
    };
  }

  private async join(args: ToolArgs<"office_join">, ctx: CallCtx) {
    const now = Date.now();
    const token = randomSecret();
    const tokenHash = await sha256hex(token);
    const sessionHash = ctx.sessionId ? await sha256hex(ctx.sessionId) : null;
    const own = await this.resolveAgent(ctx, undefined).catch(() => null);
    let a = own ?? this.reclaimable(args.name, args.client, now);
    if (a) {
      this.byToken.delete(a.tokenHash);
      a.tokenHash = tokenHash;
      if (!own) this.detachSessions(a); // a reclaimed character answers only to the session that reclaimed it
    } else {
      if (this.agents.size >= MAX_AGENTS) throw new ToolError(409, `the office is full (${MAX_AGENTS} agents) — try again later`);
      a = { id: `${slug(args.name)}-${shortId()}`, name: "", hue: 0, status: "idle", joinedAt: now, lastSeen: now, tokenHash, lastRead: 0, sessions: [] };
    }
    a.askedName = args.name.trim().slice(0, NAME_MAX);
    a.name = this.uniqueName(a.askedName, a.id);
    a.hue = args.hue ?? hueOf(a.name);
    if (args.emoji) a.emoji = args.emoji;
    else delete a.emoji;
    if (args.client) a.client = args.client;
    else delete a.client;
    a.lastSeen = now;
    if (a.status === "away") a.status = "idle";
    if (sessionHash && !a.sessions.includes(sessionHash)) {
      a.sessions = [...a.sessions, sessionHash].slice(-8);
      this.sessions.set(sessionHash, a.id);
    }
    this.agents.set(a.id, a);
    this.byToken.set(tokenHash, a.id);
    if (!a.deskId || !this.items.has(a.deskId)) await this.assignDesk(a);
    await this.saveAgent(a);
    await this.scheduleAlarm();
    const desk = a.deskId ? this.items.get(a.deskId) : undefined;
    return {
      agentToken: token,
      agent: publicAgent(a),
      desk: desk ? { id: desk.id, x: desk.x, z: desk.z, rot: desk.rot } : null,
      office: { id: this.mustMeta().id, name: this.mustMeta().name },
      next:
        this.designer === a.id
          ? "You are this office's designer: over MCP, connect with ?mode=design for the design tools and the office-designer prompt (prompts/get), then follow it — office_look's design summary is your floor plan; humans will ask you for changes in chat."
          : "Set office_status to working with a short activity when you start a task; check chat between tasks (MCP office_chat {op: \"read\"}, CLI `chat read`).",
    };
  }

  /** A same-name+client agent left behind by an earlier session (not seen in the last 90s): rejoining takes it over. */
  private reclaimable(name: string, client: string | undefined, now: number): AgentRecord | null {
    const n = name.trim().toLowerCase();
    return (
      [...this.agents.values()]
        .filter((a) => (a.askedName ?? a.name).toLowerCase() === n && (a.client ?? "") === (client ?? "") && now - a.lastSeen > RECLAIM_AFTER_MS)
        .sort((p, q) => q.lastSeen - p.lastSeen)[0] ?? null
    );
  }

  private detachSessions(a: AgentRecord) {
    for (const h of a.sessions) this.sessions.delete(h);
    a.sessions = [];
  }

  /** Two sessions joining as "claude" become "claude" and "claude 2", so humans and chat `to` can tell them apart. */
  private uniqueName(name: string, selfId: string): string {
    const taken = new Set([...this.agents.values()].filter((o) => o.id !== selfId).map((o) => o.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; ; n++) {
      const suffix = ` ${n}`;
      const candidate = name.slice(0, NAME_MAX - suffix.length) + suffix;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  // ---------- design: theme, custom kinds, assets, designer ----------

  /** Who is acting on a design tool: a joined agent (touched + rate limited), or the owner without joining. */
  private async designActor(ctx: CallCtx, explicit: string | undefined): Promise<string> {
    const agent = await this.resolveAgent(ctx, explicit);
    if (!agent) {
      if (ctx.role !== "owner") await this.requireAgent(ctx, explicit);
      this.rateLimit("owner-api", RATE_MAX);
      return "human:owner";
    }
    this.rateLimit(`agent:${agent.id}`, RATE_MAX);
    const changed = this.touch(agent);
    await this.saveAgent(agent, changed);
    await this.scheduleAlarm();
    return agent.id;
  }

  private async designTool(name: ToolName, args: Record<string, unknown>, by: string, ctx: CallCtx): Promise<unknown> {
    switch (name) {
      case "office_theme_get":
        return { theme: this.theme, summary: describeTheme(this.theme), assets: this.assetList(ctx.origin) };
      case "office_theme_set": {
        const { theme, brand } = args as ToolArgs<"office_theme_set">;
        if (!theme && !brand) throw new ToolError(400, "office_theme_set needs `theme` (the parts to change) and/or `brand` {primary, dark?, accent?}");
        return this.setTheme(theme as ThemePatch | undefined, brand);
      }
      case "office_set_logo": {
        const { assetId, onSigns } = args as ToolArgs<"office_set_logo">;
        return this.setTheme(onSigns === undefined ? { logo: assetId } : { logo: assetId, logoOnSigns: onSigns }, undefined);
      }
      case "office_define_kind": {
        const { agentToken: _t, ...def } = args as ToolArgs<"office_define_kind">;
        return this.defineKind(def, by);
      }
      case "office_delete_kind":
        return this.deleteKind((args as ToolArgs<"office_delete_kind">).kind);
      case "office_upload": {
        const { filename, contentType, base64 } = args as ToolArgs<"office_upload">;
        return this.storeAsset(decodeBase64(base64), filename, contentType, by, ctx.origin);
      }
      case "office_delete_asset":
        return this.deleteAsset((args as ToolArgs<"office_delete_asset">).assetId);
      default:
        throw new ToolError(400, `unknown design tool ${name}`);
    }
  }

  async upload(bytes: Uint8Array, filename: string, contentType: string | undefined, ctx: CallCtx): Promise<unknown> {
    this.mustMeta();
    const by = await this.designActor(ctx, undefined);
    return this.storeAsset(bytes, filename, contentType, by, ctx.origin);
  }

  private async setTheme(patch: ThemePatch | undefined, brand: { primary: string; dark?: string; accent?: string } | undefined) {
    let next = brand ? brandTheme(brand, this.theme) : this.theme;
    if (patch) next = mergeTheme(next, patch);
    if (next.logo && !this.assets.has(next.logo)) throw new ToolError(404, `no asset ${next.logo} in this office — office_upload it first (office_theme_get lists assets)`);
    this.theme = next;
    await this.ctx.storage.put("theme", next);
    this.broadcast({ type: "theme", theme: next });
    return { ok: true, theme: next };
  }

  private async defineKind(def: unknown, by: string) {
    let kind: CustomKind;
    try {
      kind = validateKindDef(def);
    } catch (e) {
      if (e instanceof OfficeError) throw new ToolError(400, `office_define_kind: ${e.message}`);
      throw e;
    }
    const existing = this.customKinds[kind.kind];
    if (!existing && Object.keys(this.customKinds).length >= CUSTOM_KINDS_MAX) {
      throw new ToolError(409, `this office already has ${CUSTOM_KINDS_MAX} custom kinds — office_delete_kind one you no longer use`);
    }
    const stored: CustomKind = { ...kind, by, at: Date.now() };
    const next = { ...this.customKinds, [kind.kind]: stored };
    const placed = this.itemList().filter((it) => it.kind === kind.kind);
    if (placed.length) {
      try {
        validateLayout(this.itemList(), this.mustMeta().grid, next);
      } catch (e) {
        if (e instanceof OfficeError) throw new ToolError(409, `can't redefine ${kind.kind}: with the new shape ${e.message} — move or remove the placed ones first`);
        throw e;
      }
    }
    this.customKinds = next;
    await this.ctx.storage.put(`kind:${kind.kind}`, stored);
    this.broadcast({ type: "kind", kind: stored });
    return {
      ok: true,
      kind: { kind: kind.kind, ...summarizeKind(stored) },
      updated: existing ? placed.map((it) => it.id) : undefined,
      next: placed.length ? undefined : `place it: office_edit {op: "add", kind: "${kind.kind}", x, z, rot}`,
    };
  }

  private async deleteKind(slug: string) {
    if (kindOf(slug)) throw new ToolError(400, `${slug} is a built-in kind`);
    if (!this.customKinds[slug]) throw new ToolError(404, `no custom kind "${slug}" (custom kinds: ${Object.keys(this.customKinds).join(", ") || "none"})`);
    const placed = this.itemList().filter((it) => it.kind === slug).map((it) => it.id);
    if (placed.length) throw new ToolError(409, `${slug} is in use by ${placed.join(", ")} — remove them first (office_edit {op: "remove"})`);
    const { [slug]: _gone, ...rest } = this.customKinds;
    this.customKinds = rest;
    await this.ctx.storage.delete(`kind:${slug}`);
    this.broadcast({ type: "kind-removed", kind: slug });
    return { ok: true, deleted: slug };
  }

  private assetList(origin: string) {
    return [...this.assets.values()].map((a) => ({ ...a, url: `${origin}${a.url}` }));
  }

  private async storeAsset(bytes: Uint8Array, rawName: string, contentType: string | undefined, by: string, origin: string) {
    const info = sniffImage(bytes, contentType);
    const id = `a${[...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 23)}`;
    const name = (rawName.split(/[\\/]/).pop() ?? "").replace(/[^\w.\- ]+/g, "_").slice(0, 100) || "image";
    const have = this.assets.get(id);
    if (have) return { ok: true, assetId: id, url: `${origin}${have.url}`, w: have.w, h: have.h, type: have.type, size: have.size, deduped: true, next: `office_set_logo {assetId: "${id}"}` };
    this.rateLimit("upload", UPLOAD_RATE_MAX, UPLOAD_WINDOW_MS);
    if (this.assets.size >= ASSETS_MAX) throw new ToolError(409, `this office has ${ASSETS_MAX} images already — office_delete_asset one first`);
    const total = [...this.assets.values()].reduce((n, a) => n + a.size, 0);
    if (total + bytes.length > ASSETS_TOTAL_MAX) {
      throw new ToolError(409, `images would take ${total + bytes.length} bytes, max ${ASSETS_TOTAL_MAX} (8 MB) per office — office_delete_asset something first`);
    }
    const at = Date.now();
    this.ctx.storage.sql.exec("INSERT INTO assets (id, name, type, w, h, size, by, at, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", id, name, info.type, info.w, info.h, bytes.length, by, at, bytes);
    const meta: AssetMeta = { id, url: this.assetUrl(id), name, type: info.type, w: info.w, h: info.h, size: bytes.length, by, at };
    this.assets.set(id, meta);
    this.broadcast({ type: "asset", asset: meta });
    return { ok: true, assetId: id, url: `${origin}${meta.url}`, w: info.w, h: info.h, type: info.type, size: bytes.length, next: `office_set_logo {assetId: "${id}"}` };
  }

  private async deleteAsset(id: string) {
    if (!this.assets.has(id)) throw new ToolError(404, `no asset ${id} in this office`);
    if (this.theme.logo === id) throw new ToolError(409, `${id} is the office logo — office_set_logo {assetId: null} (or another) first`);
    this.ctx.storage.sql.exec("DELETE FROM assets WHERE id = ?", id);
    this.assets.delete(id);
    this.broadcast({ type: "asset-removed", id });
    return { ok: true, deleted: id };
  }

  private serveAsset(req: Request, id: string): Response {
    if (req.method !== "GET" && req.method !== "HEAD") return errorResponse(405, "assets are GET only");
    this.rateLimit(`asset:${req.headers.get("cf-connecting-ip") ?? "local"}`, IP_RATE_MAX * 2);
    const meta = this.assets.get(id);
    if (!meta) return errorResponse(404, "no such asset");
    const etag = `"${id}"`;
    const headers: Record<string, string> = {
      "content-type": meta.type,
      // a day, not a year: a deleted asset (office_delete_asset) stops being served by caches soon after
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
      "access-control-allow-origin": "*",
      etag,
    };
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    const row = this.ctx.storage.sql.exec<{ bytes: ArrayBuffer }>("SELECT bytes FROM assets WHERE id = ?", id).one();
    headers["content-length"] = String(row.bytes.byteLength);
    return new Response(req.method === "HEAD" ? null : row.bytes, { status: 200, headers });
  }

  private async setDesigner(rawId: unknown) {
    let id: string | null = null;
    if (rawId !== null && rawId !== undefined && rawId !== "") {
      if (typeof rawId !== "string") throw new ToolError(400, "designer needs {id: <agent id or name>} or {id: null} to clear");
      id = this.findAgentRef(rawId);
    }
    this.designer = id;
    if (id) await this.ctx.storage.put("designer", id);
    else await this.ctx.storage.delete("designer");
    this.broadcast({ type: "designer", id });
    return { ok: true, designer: id };
  }

  // ---------- owner moderation ----------

  private async kick(rawId: unknown, by: string) {
    if (typeof rawId !== "string" || !rawId) throw new ToolError(400, "kick needs {id: <agent id or name>}");
    const id = this.findAgentRef(rawId);
    const a = this.agents.get(id)!;
    await this.removeAgent(a);
    await this.postChat("office", null, `${a.name} was shown out by ${by.replace(/^human:/, "")}`);
    return { ok: true, kicked: id };
  }

  /** What a viewer needs to bring agents in. Only the owner gets the join key back (a join viewer already holds it); offices made before it was kept have none until the owner rotates it. */
  private async connectInfo(role: Role, origin: string) {
    const joinKey = role === "owner" ? ((await this.ctx.storage.get<string>(JOIN_KEY_SLOT)) ?? null) : null;
    return { office: this.mustMeta().id, mcpUrl: `${origin}/mcp`, designMcpUrl: `${origin}/mcp?mode=design`, joinKey };
  }

  private async rotateKeys(which: unknown, origin: string) {
    const roles = which === undefined ? ["join"] : which === "all" ? ["owner", "join", "view"] : [which];
    if (!roles.every((r): r is Role => r === "owner" || r === "join" || r === "view")) {
      throw new ToolError(400, 'rotate-keys {which: "join" | "view" | "owner" | "all"} (default "join")');
    }
    const meta = this.mustMeta();
    const fresh: Partial<Record<Role, string>> = {};
    const keys = { ...meta.keys };
    for (const r of roles) {
      const key = newOfficeKey(meta.id);
      fresh[r] = key;
      keys[r] = await sha256hex(key);
    }
    this.meta = { ...meta, keys };
    await this.ctx.storage.put(fresh.join ? { meta: this.meta, [JOIN_KEY_SLOT]: fresh.join } : { meta: this.meta });
    for (const r of roles) for (const ws of this.ctx.getWebSockets(r)) ws.close(4401, "this key was rotated");
    const out: Record<string, string> = {};
    if (fresh.owner) {
      out.ownerKey = fresh.owner;
      out.ownerUrl = `${origin}/o/${meta.id}#k=${encodeURIComponent(fresh.owner)}`;
    }
    if (fresh.join) out.joinKey = fresh.join;
    if (fresh.view) {
      out.viewKey = fresh.view;
      out.viewUrl = `${origin}/o/${meta.id}#k=${encodeURIComponent(fresh.view)}`;
    }
    return { ok: true, rotated: roles, ...out, note: "old keys stop working now; agents already in keep their agentTokens (kick them to remove)" };
  }

  private look(me: AgentRecord | null) {
    const meta = this.mustMeta();
    const now = Date.now();
    const deskOf = (a: Agent) => (a.deskId ? this.items.get(a.deskId) : undefined);
    const unread = me ? this.chat.filter((m) => m.ts > me.lastRead && m.from !== me.id && (m.to === null || m.to === me.id)).length : 0;
    const myDesk = me ? deskOf(me) : undefined;
    const items = this.itemList();
    const spots = allSpots(items, this.customKinds);
    return {
      office: { id: meta.id, name: meta.name, grid: meta.grid },
      you: me
        ? { ...publicAgent(me), desk: myDesk ? { id: myDesk.id, x: myDesk.x, z: myDesk.z, rot: myDesk.rot } : null, designer: this.designer === me.id }
        : null,
      agents: [...this.agents.values()].map((a) => ({
        id: a.id,
        name: a.name,
        client: a.client,
        status: a.status,
        activity: a.activity,
        deskId: a.deskId,
        idleSec: Math.round((now - a.lastSeen) / 1000),
        says: a.says && now - a.says.ts < 120_000 ? a.says.text : undefined,
      })),
      items: [...this.items.values()].map(
        (it) => `${it.id} ${it.kind} x${it.x} z${it.z} r${it.rot}${it.text ? ` "${it.text.slice(0, 40)}"` : ""}`,
      ),
      seats: spots.seats.map((p) => `${p.id} x${p.x} z${p.z} face${Math.round((p.yaw * 180) / Math.PI)}`),
      stations: spots.stations.map((p) => `${p.id} ${p.activity} x${p.x} z${p.z} face${Math.round((p.yaw * 180) / Math.PI)}`),
      design: designSummary({ grid: meta.grid, items, theme: this.theme, custom: this.customKinds }),
      designer: this.designer,
      unreadChat: unread,
    };
  }

  // ---------- viewers ----------

  private acceptViewer(req: Request, role: Role): Response {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return errorResponse(426, "expected a WebSocket upgrade");
    if (this.ctx.getWebSockets().length >= MAX_VIEWERS) return errorResponse(503, `too many viewers (${MAX_VIEWERS})`);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, sid: shortId() + shortId() } satisfies WsAttachment);
    server.send(JSON.stringify({ type: "snapshot", state: this.state(), role } satisfies Frame));
    const offered = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim());
    const headers = offered.includes(WS_PROTOCOL) ? { "sec-websocket-protocol": WS_PROTOCOL } : undefined;
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const send = (f: Frame) => ws.send(JSON.stringify(f));
    const { role, sid } = ws.deserializeAttachment() as WsAttachment;
    try {
      this.rateLimit(`ws:${sid}`, WS_RATE_MAX);
    } catch (e) {
      // flooding socket: one visible error per window, then drop quietly until it slows down
      const now = Date.now();
      if (now - (this.wsWarned.get(sid) ?? 0) >= RATE_WINDOW_MS) {
        this.wsWarned.set(sid, now);
        const retryAfter = e instanceof ToolError ? (e.extra?.retryAfter as number | undefined) : undefined;
        send({ type: "error", error: `rate limited: max ${WS_RATE_MAX} frames per ${RATE_WINDOW_MS / 1000}s — later frames were dropped`, retryAfter });
      }
      return;
    }
    try {
      const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
      if (raw.length > WS_FRAME_MAX) throw new ToolError(413, `frame too large, max ${WS_FRAME_MAX} bytes`);
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(raw);
      } catch {
        throw new ToolError(400, "frame is not JSON");
      }
      if (frame.type === "ping") return;
      if (role !== "owner") throw new ToolError(403, "read-only view: chat and edits need the ownerKey");
      this.rateLimit("owner-ws", RATE_MAX);
      const f = parseOwnerFrame(frame);
      const as = f.as ?? "owner";
      if (f.type === "chat") {
        const to = f.to ? this.findAgentRef(f.to) : null;
        await this.postChat(`human:${as}`, to, f.text);
      } else if (f.type === "op") {
        await this.applyItemOp(f.op, `human:${as}`);
      } else if (f.type === "theme") {
        if (!f.theme && !f.brand) throw new ToolError(400, "theme frame needs `theme` and/or `brand`");
        await this.setTheme(f.theme as ThemePatch | undefined, f.brand);
      } else if (f.type === "designer") {
        await this.setDesigner(f.id);
      } else if (f.type === "delete-kind") {
        await this.deleteKind(f.kind);
      } else {
        await this.kick(f.id, `human:${as}`);
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      send({ type: "error", error });
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {
      // already closed
    }
  }
}
