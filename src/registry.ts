// The office registry: one SQLite-backed Durable Object (idFromName("registry")) listing every office it has
// heard of, for the admin list. Offices write their own row (on create, lazily on first open, throttled on activity).
import { DurableObject } from "cloudflare:workers";

export interface OfficeRow {
  id: string;
  name: string;
  createdAt: number;
  lastActiveAt: number;
  agentCount: number;
  /** true/false when the office was created after the registry existed; null for backfilled offices (unknown). */
  admin: boolean | null;
}

interface SqlRow {
  id: string;
  name: string;
  created_at: number;
  last_active_at: number;
  agent_count: number;
  admin: number | null;
  [k: string]: SqlStorageValue;
}

export const REGISTRY_NAME = "registry";

export function registryStub(env: Env): DurableObjectStub<Registry> {
  return env.REGISTRY.get(env.REGISTRY.idFromName(REGISTRY_NAME));
}

export class Registry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS offices (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL, agent_count INTEGER NOT NULL, admin INTEGER)",
    );
  }

  /** Inserts or refreshes a row. A known `admin` flag is never overwritten by an unknown (null) one. */
  upsert(row: OfficeRow): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO offices (id, name, created_at, last_active_at, agent_count, admin) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, created_at = excluded.created_at, last_active_at = excluded.last_active_at,
         agent_count = excluded.agent_count, admin = COALESCE(excluded.admin, offices.admin)`,
      row.id, row.name, row.createdAt, row.lastActiveAt, row.agentCount, row.admin === null ? null : row.admin ? 1 : 0,
    );
  }

  remove(id: string): boolean {
    return this.ctx.storage.sql.exec("DELETE FROM offices WHERE id = ?", id).rowsWritten > 0;
  }

  list(): OfficeRow[] {
    return this.ctx.storage.sql
      .exec<SqlRow>("SELECT id, name, created_at, last_active_at, agent_count, admin FROM offices ORDER BY created_at DESC")
      .toArray()
      .map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastActiveAt: r.last_active_at, agentCount: r.agent_count, admin: r.admin === null ? null : r.admin === 1 }));
  }
}
