// One Durable Object per office: furniture, agents, chat, viewer WebSockets (hibernation API) and presence.
import { DurableObject } from "cloudflare:workers";
import { applyOp, defaultLayout, findFreeSpot, GRID, KINDS, MAX_AGENTS, MAX_ITEMS, OfficeError, TEXT_MAX, type Grid, type Item, type Op } from "./shared/catalog";
import { newOfficeKey, randomSecret, roleOfKey, sha256hex, keyFromRequest, WS_PROTOCOL, type KeyHashes, type Role } from "./auth";
import { errorResponse, HttpError, json, readJson } from "./http";
import { NAME_MAX, parseArgs, parseOwnerFrame, ToolError, type Status, type ToolArgs, type ToolName, ACTIVITY_MAX } from "./tools";
import { handleMcp } from "./mcp";
import { handleRest } from "./api";

export const MAX_CHAT = 200;
export const CHAT_READ_MAX = 50;
export const MAX_VIEWERS = 256;
export const AWAY_MS = 5 * 60_000;
export const REMOVE_MS = 60 * 60_000;
export const RATE_WINDOW_MS = 10_000;
export const RATE_MAX = 30;
export const IP_RATE_MAX = 120;
export const WS_FRAME_MAX = 4096;
export const WS_RATE_MAX = 20;
export const JOIN_WINDOW_MS = 60_000;
export const JOIN_RATE_MAX = 10;
/** Desks the office adds by itself when every desk is taken; beyond this, late joiners stand. */
export const MAX_AUTO_DESKS = 16;
export const MAX_MCP_SESSIONS = 2000;
export const MCP_SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
/** A same-name+client agent counts as "still at work" (and is not reclaimed by a new join) while seen this recently. */
export const RECLAIM_AFTER_MS = 90_000;

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
}

export interface ChatMsg {
  id: string;
  from: string;
  to: string | null;
  text: string;
  ts: number;
}

export interface OfficeState {
  id: string;
  name: string;
  grid: Grid;
  items: Item[];
  agents: Agent[];
  chat: ChatMsg[];
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
}

export interface ToolHost {
  callTool(name: ToolName, args: unknown, ctx: CallCtx): Promise<unknown>;
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
  | { type: "error"; error: string };

interface WsAttachment {
  role: Role;
  sid: string;
}

const publicAgent = ({ tokenHash: _t, lastRead: _r, sessions: _s, ...a }: AgentRecord): Agent => a;

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
  private mcpSessions = new Map<string, number>();
  private alarmAt: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
    ctx.blockConcurrencyWhile(async () => {
      this.meta = (await ctx.storage.get<Meta>("meta")) ?? null;
      if (!this.meta) return;
      for (const [, it] of await ctx.storage.list<Item>({ prefix: "item:" })) this.items.set(it.id, it);
      for (const [, a] of await ctx.storage.list<AgentRecord>({ prefix: "agent:" })) {
        this.agents.set(a.id, a);
        this.byToken.set(a.tokenHash, a.id);
        for (const s of a.sessions) this.sessions.set(s, a.id);
      }
      this.chat = (await ctx.storage.get<ChatMsg[]>("chat")) ?? [];
      for (const [k, at] of await ctx.storage.list<number>({ prefix: "mcps:" })) this.mcpSessions.set(k.slice(5), at);
      this.alarmAt = await ctx.storage.getAlarm();
    });
  }

  // ---------- HTTP entry (the worker forwards here) ----------

  override async fetch(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      if (url.pathname === "/internal/init") return await this.init(req);
      if (!this.meta) return errorResponse(404, "no such office");
      const ip = req.headers.get("cf-connecting-ip") ?? "local";
      this.rateLimit(`ip:${ip}`, IP_RATE_MAX);
      const role = await roleOfKey(keyFromRequest(req), this.meta.keys);
      if (!role) return errorResponse(401, "missing or wrong key for this office (Authorization: Bearer <key> or ?key=)");
      if (/^\/o\/[^/]+\/ws$/.test(url.pathname)) return this.acceptViewer(req, role);
      const base = { role, token: req.headers.get("x-agent-token"), sessionId: null, ip } satisfies CallCtx;
      if (url.pathname === "/mcp") {
        if (role === "view") return errorResponse(403, "a viewKey is read-only; MCP needs the joinKey");
        return await handleMcp(req, this, base);
      }
      const m = /^\/api\/o\/[^/]+\/([a-z_-]+)$/.exec(url.pathname);
      if (m && (m[1] === "kick" || m[1] === "rotate-keys" || m[1] === "rotate_keys")) {
        if (role !== "owner") return errorResponse(403, `${m[1]} needs the ownerKey`);
        if (req.method !== "POST") return errorResponse(405, `POST /api/o/:office/${m[1]}`);
        const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
        if (m[1] === "kick") return json(200, await this.kick(body.id, "human:owner"));
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
    if (e instanceof OfficeError) return errorResponse(400, e.message);
    console.error("office: unexpected error", e);
    return errorResponse(500, "internal error");
  }

  private async init(req: Request): Promise<Response> {
    if (this.meta) return errorResponse(409, "office already exists");
    const body = (await readJson(req)) as { id: string; name: string; keys: KeyHashes };
    const meta: Meta = { id: body.id, name: body.name, grid: { ...GRID }, keys: body.keys, createdAt: Date.now() };
    const items = defaultLayout(meta.createdAt);
    const puts: Record<string, unknown> = { meta };
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
    const res = applyOp(this.itemList(), op as Op, by, { grid: this.mustMeta().grid, now: Date.now() });
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
    const spot = findFreeSpot(this.itemList(), this.mustMeta().grid, "desk", 0);
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

  async callTool(name: ToolName, rawArgs: unknown, ctx: CallCtx): Promise<unknown> {
    this.mustMeta();
    const args = parseArgs(name, rawArgs) as Record<string, unknown> & { agentToken?: string };
    if (name === "office_kinds") return this.kinds();
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

  /** Chat target: an agent id or name, or "human:<name>" for a person watching the office. */
  private chatTarget(ref: string): string {
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
    throw new ToolError(404, `no agent "${ref}" in the office (office_look lists who is here)`);
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

  private kinds() {
    return {
      grid: this.mustMeta().grid,
      kinds: KINDS,
      rules: [
        "(x, z) is the footprint's min corner; x runs along the back wall, z away from it.",
        "rot 90/270 swaps a footprint's w and d. A model's front faces +z at rot 0.",
        "Items collide only within their layer: rugs (floor) lie under furniture, wall items hang above it.",
        "Wall kinds hang on a wall: rot 0 with z 0 (back wall) or rot 90 with x 0 (left wall).",
        `Text (sign, poster, whiteboard) ≤ ${TEXT_MAX} chars.`,
      ],
    };
  }

  private async join(args: ToolArgs<"office_join">, ctx: CallCtx) {
    const now = Date.now();
    const token = randomSecret();
    const tokenHash = await sha256hex(token);
    const sessionHash = ctx.sessionId ? await sha256hex(ctx.sessionId) : null;
    let a = (await this.resolveAgent(ctx, undefined).catch(() => null)) ?? this.reclaimable(args.name, args.client, now);
    if (a) {
      this.byToken.delete(a.tokenHash);
      a.tokenHash = tokenHash;
    } else {
      if (this.agents.size >= MAX_AGENTS) throw new ToolError(409, `the office is full (${MAX_AGENTS} agents) — try again later`);
      a = { id: `${slug(args.name)}-${shortId()}`, name: "", hue: 0, status: "idle", joinedAt: now, lastSeen: now, tokenHash, lastRead: 0, sessions: [] };
    }
    a.name = args.name.trim().slice(0, NAME_MAX);
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
      next: "Set office_status to working with a short activity when you start a task; check office_chat_read between tasks.",
    };
  }

  /** A same-name+client agent left behind by an earlier session (not seen in the last 90s): rejoining takes it over. */
  private reclaimable(name: string, client: string | undefined, now: number): AgentRecord | null {
    const n = name.trim().toLowerCase();
    return (
      [...this.agents.values()]
        .filter((a) => a.name.toLowerCase() === n && (a.client ?? "") === (client ?? "") && now - a.lastSeen > RECLAIM_AFTER_MS)
        .sort((p, q) => q.lastSeen - p.lastSeen)[0] ?? null
    );
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
    await this.ctx.storage.put("meta", this.meta);
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
    return {
      office: { id: meta.id, name: meta.name, grid: meta.grid },
      you: me ? { ...publicAgent(me), desk: myDesk ? { id: myDesk.id, x: myDesk.x, z: myDesk.z, rot: myDesk.rot } : null } : null,
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
    } catch {
      return; // flooding socket: drop silently rather than answer every frame
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
