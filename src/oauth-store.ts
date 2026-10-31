// The OAuth store: a SQLite-backed Durable Object class with two kinds of instances.
//  - "clients": registered OAuth clients (DCR) and cached Client ID Metadata Documents (CIMD).
//  - "office:<id>": the grants, authorization codes and tokens of one office, so a token can only ever resolve to its office.
import { DurableObject } from "cloudflare:workers";
import { randomSecret } from "./auth";
import { ACCESS_PREFIX, CODE_PREFIX, hashToken, mintToken, pkceMatches, REFRESH_PREFIX, seal, unseal } from "./oauth-crypto";

export const CODE_TTL_MS = 60_000;
export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const DCR_IDLE_MS = 90 * 24 * 60 * 60_000;
const MAX_CLIENTS = 5000;
/** Used codes and refresh tokens are kept this long so a replay can be detected (and the grant revoked). */
const REPLAY_WINDOW_MS = 10 * 60_000;

export interface ClientRecord {
  id: string;
  name: string;
  redirectUris: string[];
  kind: "dcr" | "cimd";
}

export interface TokenSet {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export type TokenResult = { ok: true; tokens: TokenSet } | { ok: false; error: "invalid_grant" | "invalid_request"; description: string };

/** Who an access token speaks for: one grant (one human approval) in one office. */
export interface AccessInfo {
  grantId: string;
  name: string;
  /** The invite the grant signs in through ("via <label>"); revoking that invite cuts the grant off. */
  inviteId: string | null;
  clientId: string;
  resource: string;
  joinKey: string;
}

export interface AuthorizeInput {
  officeId: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
  name: string;
  joinKey: string;
  inviteId: string | null;
}

export interface ExchangeInput {
  code: string;
  clientId: string;
  redirectUri: string;
  verifier: string;
  resource: string | null;
}

export interface RefreshInput {
  refreshToken: string;
  clientId: string | null;
  resource: string | null;
}

export const SCOPE = "office";
const CLIENTS_SHARD = "clients";

export function clientsStub(env: Env): DurableObjectStub<Auth> {
  return env.AUTH.get(env.AUTH.idFromName(CLIENTS_SHARD));
}

export function officeAuthStub(env: Env, officeId: string): DurableObjectStub<Auth> {
  return env.AUTH.get(env.AUTH.idFromName(`office:${officeId}`));
}

interface ClientRow {
  id: string;
  name: string;
  redirect_uris: string;
  kind: string;
  expires_at: number | null;
  [k: string]: SqlStorageValue;
}

interface CodeRow {
  grant_id: string;
  client_id: string;
  redirect_uri: string;
  challenge: string;
  resource: string;
  expires_at: number;
  used: number;
  sealed: string;
  [k: string]: SqlStorageValue;
}

interface TokenRow {
  grant_id: string;
  client_id: string;
  resource: string;
  expires_at: number;
  used: number;
  sealed: string;
  name: string;
  invite_id: string | null;
  [k: string]: SqlStorageValue;
}

export class Auth extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, kind TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER)`);
    sql.exec("CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, office_id TEXT NOT NULL, client_id TEXT NOT NULL, name TEXT NOT NULL, invite_id TEXT, created_at INTEGER NOT NULL)");
    sql.exec(`CREATE TABLE IF NOT EXISTS codes (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
      challenge TEXT NOT NULL, resource TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, sealed TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, grant_id TEXT NOT NULL, client_id TEXT NOT NULL,
      resource TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, sealed TEXT NOT NULL)`);
    sql.exec("CREATE INDEX IF NOT EXISTS tokens_grant ON tokens (grant_id)");
  }

  // ---------- clients shard ----------

  /** Inserts or refreshes a client. Re-registering the same metadata lands on the same row (the id is derived from it). */
  putClient(client: ClientRecord, ttlMs: number | null): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO clients (id, name, redirect_uris, kind, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, redirect_uris = excluded.redirect_uris, last_seen = excluded.last_seen, expires_at = excluded.expires_at`,
      client.id, client.name, JSON.stringify(client.redirectUris), client.kind, now, now, ttlMs === null ? null : now + ttlMs,
    );
    this.pruneClients(now);
  }

  getClient(id: string): ClientRecord | null {
    const now = Date.now();
    const row = this.ctx.storage.sql.exec<ClientRow>("SELECT id, name, redirect_uris, kind, expires_at FROM clients WHERE id = ?", id).toArray()[0];
    if (!row || (row.expires_at !== null && row.expires_at < now)) return null;
    this.ctx.storage.sql.exec("UPDATE clients SET last_seen = ? WHERE id = ?", now, id);
    return { id: row.id, name: row.name, redirectUris: JSON.parse(row.redirect_uris) as string[], kind: row.kind as ClientRecord["kind"] };
  }

  private pruneClients(now: number): void {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM clients WHERE (kind = 'dcr' AND last_seen < ?) OR (expires_at IS NOT NULL AND expires_at < ?)", now - DCR_IDLE_MS, now);
    const count = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM clients").one().n;
    if (count > MAX_CLIENTS) sql.exec("DELETE FROM clients WHERE id IN (SELECT id FROM clients ORDER BY last_seen ASC LIMIT ?)", count - MAX_CLIENTS);
  }

  // ---------- office shards ----------

  /** A human approved: records the grant and returns a single-use code (valid CODE_TTL_MS) that carries the join key, sealed. */
  async authorize(input: AuthorizeInput): Promise<string> {
    const now = Date.now();
    this.pruneOffice(now);
    const grantId = `g_${randomSecret().slice(0, 22)}`;
    const code = mintToken(CODE_PREFIX, input.officeId);
    this.ctx.storage.sql.exec("INSERT INTO grants (id, office_id, client_id, name, invite_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      grantId, input.officeId, input.clientId, input.name, input.inviteId, now,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO codes (hash, grant_id, client_id, redirect_uri, challenge, resource, expires_at, sealed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      await hashToken(code), grantId, input.clientId, input.redirectUri, input.challenge, input.resource, now + CODE_TTL_MS, await seal(input.joinKey, code),
    );
    return code;
  }

  async exchangeCode(input: ExchangeInput): Promise<TokenResult> {
    const now = Date.now();
    const hash = await hashToken(input.code);
    const row = this.ctx.storage.sql.exec<CodeRow>("SELECT * FROM codes WHERE hash = ?", hash).toArray()[0];
    if (!row) return bad("invalid_grant", "unknown authorization code");
    if (row.used) {
      this.revokeGrant(row.grant_id); // a replayed code means it leaked: kill everything it minted
      return bad("invalid_grant", "authorization code already used; its tokens are revoked");
    }
    this.ctx.storage.sql.exec("UPDATE codes SET used = 1 WHERE hash = ?", hash);
    if (row.expires_at < now) return bad("invalid_grant", "authorization code expired");
    if (row.client_id !== input.clientId) return bad("invalid_grant", "authorization code was issued to another client");
    if (row.redirect_uri !== input.redirectUri) return bad("invalid_grant", "redirect_uri does not match the authorization request");
    if (input.resource !== null && input.resource !== row.resource) return bad("invalid_grant", "resource does not match the authorization request");
    if (!(await pkceMatches(input.verifier, row.challenge))) return bad("invalid_grant", "PKCE code_verifier does not match the code_challenge");
    const joinKey = await unseal(row.sealed, input.code);
    return { ok: true, tokens: await this.issue(row.grant_id, row.client_id, row.resource, joinKey, now) };
  }

  /** Rotates: the presented refresh token is spent, a fresh pair comes back. Replaying a spent one revokes the grant. */
  async refresh(input: RefreshInput): Promise<TokenResult> {
    const now = Date.now();
    const hash = await hashToken(input.refreshToken);
    const row = this.tokenRow(hash, REFRESH_PREFIX);
    if (!row) return bad("invalid_grant", "unknown or revoked refresh token");
    if (row.used) {
      this.revokeGrant(row.grant_id);
      return bad("invalid_grant", "refresh token already used; the grant is revoked, sign in again");
    }
    if (row.expires_at < now) return bad("invalid_grant", "refresh token expired, sign in again");
    if (input.clientId !== null && input.clientId !== row.client_id) return bad("invalid_grant", "refresh token was issued to another client");
    if (input.resource !== null && input.resource !== row.resource) return bad("invalid_grant", "resource does not match the original grant");
    this.ctx.storage.sql.exec("UPDATE tokens SET used = 1, expires_at = MIN(expires_at, ?) WHERE hash = ?", now + REPLAY_WINDOW_MS, hash);
    const joinKey = await unseal(row.sealed, input.refreshToken);
    this.pruneOffice(now);
    return { ok: true, tokens: await this.issue(row.grant_id, row.client_id, row.resource, joinKey, now) };
  }

  async verifyAccess(accessToken: string): Promise<AccessInfo | null> {
    const row = this.tokenRow(await hashToken(accessToken), ACCESS_PREFIX);
    if (!row || row.expires_at < Date.now()) return null;
    return { grantId: row.grant_id, name: row.name, inviteId: row.invite_id, clientId: row.client_id, resource: row.resource, joinKey: await unseal(row.sealed, accessToken) };
  }

  revokeGrant(grantId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM tokens WHERE grant_id = ?", grantId);
    this.ctx.storage.sql.exec("DELETE FROM grants WHERE id = ?", grantId);
  }

  private tokenRow(hash: string, kind: string): TokenRow | undefined {
    return this.ctx.storage.sql
      .exec<TokenRow>(
        "SELECT t.grant_id, t.client_id, t.resource, t.expires_at, t.used, t.sealed, g.name, g.invite_id FROM tokens t JOIN grants g ON g.id = t.grant_id WHERE t.hash = ? AND t.kind = ?",
        hash, kind,
      )
      .toArray()[0];
  }

  private async issue(grantId: string, clientId: string, resource: string, joinKey: string, now: number): Promise<TokenSet> {
    const officeId = this.ctx.storage.sql.exec<{ office_id: string }>("SELECT office_id FROM grants WHERE id = ?", grantId).toArray()[0]?.office_id;
    if (!officeId) throw new Error(`oauth: grant ${grantId} vanished while issuing tokens`);
    const access = mintToken(ACCESS_PREFIX, officeId);
    const refresh = mintToken(REFRESH_PREFIX, officeId);
    const insert = "INSERT INTO tokens (hash, kind, grant_id, client_id, resource, expires_at, sealed) VALUES (?, ?, ?, ?, ?, ?, ?)";
    this.ctx.storage.sql.exec(insert, await hashToken(access), ACCESS_PREFIX, grantId, clientId, resource, now + ACCESS_TTL_MS, await seal(joinKey, access));
    this.ctx.storage.sql.exec(insert, await hashToken(refresh), REFRESH_PREFIX, grantId, clientId, resource, now + REFRESH_TTL_MS, await seal(joinKey, refresh));
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: SCOPE };
  }

  private pruneOffice(now: number): void {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM codes WHERE expires_at < ?", now - REPLAY_WINDOW_MS);
    sql.exec("DELETE FROM tokens WHERE expires_at < ?", now);
    sql.exec("DELETE FROM grants WHERE created_at < ? AND id NOT IN (SELECT grant_id FROM tokens) AND id NOT IN (SELECT grant_id FROM codes)", now - REPLAY_WINDOW_MS);
  }
}

function bad(error: "invalid_grant" | "invalid_request", description: string): TokenResult {
  return { ok: false, error, description };
}
