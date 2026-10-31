// Outbound wake-up webhooks for hosted agents (Grok Bot, OpenAI Dots, Claude routines, Codex automations) that only act
// during a turn and never poll chat. When a message is addressed to an agent (a DM, or a room message that @-mentions it)
// the office POSTs to the agent's webhook: at most once per WEBHOOK_WINDOW_MS per agent, bursts coalesced into one
// "you have N new messages" call. Delivery never blocks or fails the chat send.

export const WEBHOOK_WINDOW_MS = 10_000;
export const WEBHOOK_TIMEOUT_MS = 5_000;
export const WEBHOOK_URL_MAX = 512;
export const WEBHOOK_SECRET_MIN = 8;
export const WEBHOOK_SECRET_MAX = 200;
export const SIGNATURE_HEADER = "X-Office-Signature";
const STORAGE_PREFIX = "hook:";
const SLACK_HOST = "hooks.slack.com";

export interface WebhookConfig {
  url: string;
  secret?: string;
  /** Origin the agent set the webhook from: the reply.rest link points here. */
  origin: string;
}

export interface ChatLike {
  id: string;
  from: string;
  to: string | null;
  text: string;
  ts: number;
}

export interface Recipient {
  id: string;
  name: string;
}

export type WakeKind = "dm" | "mention" | "digest";

export interface WakePayload {
  office: string;
  office_name: string;
  agent: string;
  agent_name: string;
  from: string;
  from_name: string;
  kind: WakeKind;
  text: string;
  msg_id: string;
  ts: number;
  count: number;
  reply: { mcp: string; rest: string };
}

export class WebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookError";
  }
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];

function ipv4Blocked(host: string): boolean | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && Number(m[3]) === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** Checks a webhook URL: https, a public DNS name or public IPv4, not this office's own host. Throws WebhookError (never echoing secrets). */
export function validateWebhookUrl(raw: string, officeOrigin: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookError("webhook.url is not a valid URL");
  }
  if (url.protocol !== "https:") throw new WebhookError("webhook.url must be https://");
  if (url.username || url.password) throw new WebhookError("webhook.url must not carry credentials (use webhook.secret to sign instead)");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[")) throw new WebhookError("webhook.url must use a hostname, not an IPv6 literal");
  const v4 = ipv4Blocked(host);
  if (v4) throw new WebhookError("webhook.url points at a private, loopback, link-local or reserved address");
  if (v4 === null) {
    if (host === "localhost" || !host.includes(".") || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
      throw new WebhookError("webhook.url must be a public hostname (no localhost, single-label or internal names)");
    }
  }
  if (host === new URL(officeOrigin).hostname.toLowerCase()) throw new WebhookError("webhook.url can't point back at this office server");
  return url;
}

export function isSlackUrl(url: string): boolean {
  return new URL(url).hostname.toLowerCase() === SLACK_HOST;
}

export async function signBody(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** How a message reaches `agent`, or null when it isn't addressed to it (plain room chatter, or its own message). */
export function addressedAs(msg: ChatLike, agent: Recipient): "dm" | "mention" | null {
  if (msg.from === agent.id || msg.from === "office") return null;
  if (msg.to === agent.id) return "dm";
  if (msg.to !== null) return null;
  const text = msg.text.toLowerCase();
  for (const handle of [agent.name, agent.id]) {
    const needle = `@${handle.toLowerCase()}`;
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
      const after = text.charAt(at + needle.length);
      if (!after || !/[\p{L}\p{N}_-]/u.test(after)) return "mention";
    }
  }
  return null;
}

function slackText(p: WakePayload): string {
  const lead =
    p.kind === "digest"
      ? `You have ${p.count} new messages in office chat "${p.office_name}" (latest from ${p.from_name}): ${p.text}`
      : `${p.from_name} ${p.kind === "dm" ? "messaged you" : "mentioned you"} in office "${p.office_name}": ${p.text}`;
  return `@${p.agent_name} ${lead}\nReply with MCP ${p.reply.mcp}, or POST ${p.reply.rest}`;
}

export function deliveryBody(cfg: WebhookConfig, p: WakePayload): string {
  return JSON.stringify(isSlackUrl(cfg.url) ? { text: slackText(p) } : p);
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface WebhookDeps {
  storage: DurableObjectStorage;
  waitUntil: (p: Promise<unknown>) => void;
  fetch?: Fetch;
  windowMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

interface Pending {
  count: number;
  latest: WakePayload;
  timer: ReturnType<typeof setTimeout>;
}

/** Per-office webhook registry and dispatcher. Configs persist under "hook:<agentId>"; rate state is in memory. */
export class Webhooks {
  private hooks = new Map<string, WebhookConfig>();
  private sentAt = new Map<string, number>();
  private pending = new Map<string, Pending>();
  private readonly windowMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly fetch: Fetch;

  constructor(private readonly deps: WebhookDeps) {
    this.windowMs = deps.windowMs ?? WEBHOOK_WINDOW_MS;
    this.timeoutMs = deps.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
    this.now = deps.now ?? Date.now;
    this.fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  }

  async load(): Promise<void> {
    for (const [k, cfg] of await this.deps.storage.list<WebhookConfig>({ prefix: STORAGE_PREFIX })) this.hooks.set(k.slice(STORAGE_PREFIX.length), cfg);
  }

  /** Sets (validated) or clears an agent's webhook. Returns what the agent may see about it. */
  async set(agentId: string, input: { url: string; secret?: string } | null, origin: string) {
    if (input === null) {
      await this.drop(agentId);
      return null;
    }
    const url = validateWebhookUrl(input.url, origin);
    const cfg: WebhookConfig = { url: url.toString(), origin, ...(input.secret ? { secret: input.secret } : {}) };
    this.hooks.set(agentId, cfg);
    await this.deps.storage.put(`${STORAGE_PREFIX}${agentId}`, cfg);
    return this.describe(agentId);
  }

  async drop(agentId: string): Promise<void> {
    const p = this.pending.get(agentId);
    if (p) clearTimeout(p.timer);
    this.pending.delete(agentId);
    this.sentAt.delete(agentId);
    if (this.hooks.delete(agentId)) await this.deps.storage.delete(`${STORAGE_PREFIX}${agentId}`);
  }

  /** The agent's own view (host, not the full URL), or the owner's flag; null when none is set. */
  describe(agentId: string): { host: string; slack: boolean; signed: boolean } | null {
    const cfg = this.hooks.get(agentId);
    if (!cfg) return null;
    return { host: new URL(cfg.url).hostname, slack: isSlackUrl(cfg.url), signed: !!cfg.secret };
  }

  clearAll(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.hooks.clear();
    this.sentAt.clear();
    this.pending.clear();
  }

  /** Called for every chat message after it is stored and broadcast. Never throws. */
  onChat(msg: ChatLike, office: { id: string; name: string }, agents: Iterable<Recipient>, nameOf: (ref: string) => string): void {
    try {
      for (const agent of agents) {
        const cfg = this.hooks.get(agent.id);
        if (!cfg) continue;
        const kind = addressedAs(msg, agent);
        if (!kind) continue;
        this.enqueue(agent.id, cfg, {
          office: office.id,
          office_name: office.name,
          agent: agent.id,
          agent_name: agent.name,
          from: msg.from,
          from_name: nameOf(msg.from),
          kind,
          text: msg.text,
          msg_id: msg.id,
          ts: msg.ts,
          count: 1,
          reply: { mcp: "office_chat op send", rest: `${cfg.origin}/api/o/${office.id}/chat_send` },
        });
      }
    } catch (e) {
      console.error(`office ${office.id}: webhook dispatch failed`, e);
    }
  }

  private enqueue(agentId: string, cfg: WebhookConfig, payload: WakePayload): void {
    const pending = this.pending.get(agentId);
    if (pending) {
      pending.count++;
      pending.latest = payload;
      return;
    }
    const now = this.now();
    const last = this.sentAt.get(agentId);
    if (last === undefined || now - last >= this.windowMs) {
      this.sentAt.set(agentId, now);
      this.deps.waitUntil(this.deliver(cfg, payload));
      return;
    }
    let release!: () => void;
    const done = new Promise<void>((r) => (release = r));
    const timer = setTimeout(() => {
      const p = this.pending.get(agentId);
      this.pending.delete(agentId);
      const current = this.hooks.get(agentId);
      if (!p || !current) return release();
      this.sentAt.set(agentId, this.now());
      const out = p.count === 1 ? p.latest : { ...p.latest, kind: "digest" as const, count: p.count, text: `you have ${p.count} new messages; latest: ${p.latest.text}` };
      this.deliver(current, out).finally(release);
    }, last + this.windowMs - now);
    this.pending.set(agentId, { count: 1, latest: payload, timer });
    this.deps.waitUntil(done);
  }

  /** POST with a timeout; one retry on a network error, timeout or 5xx. Failures are logged, never thrown. */
  private async deliver(cfg: WebhookConfig, payload: WakePayload): Promise<void> {
    const body = deliveryBody(cfg, payload);
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "agent-office-webhook/1" };
    if (cfg.secret) headers[SIGNATURE_HEADER] = await signBody(body, cfg.secret);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await this.fetch(cfg.url, { method: "POST", headers, body, signal: AbortSignal.timeout(this.timeoutMs), redirect: "manual" });
        await res.body?.cancel();
        if (res.status < 500) {
          if (!res.ok) console.warn(`webhook for ${payload.agent} on ${new URL(cfg.url).hostname}: HTTP ${res.status}`);
          return;
        }
        console.warn(`webhook for ${payload.agent} on ${new URL(cfg.url).hostname}: HTTP ${res.status} (attempt ${attempt})`);
      } catch (e) {
        console.warn(`webhook for ${payload.agent} on ${new URL(cfg.url).hostname}: ${e instanceof Error ? e.message : String(e)} (attempt ${attempt})`);
      }
    }
  }
}
