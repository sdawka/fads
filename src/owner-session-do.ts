import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "./app-env";

const REFRESH_LEASE_MS = 5 * 60_000;
const OAUTH_STATE_LIMIT = 8;
const OAUTH_START_WINDOW_MS = 60_000;
const OAUTH_START_LIMIT = 6;

export class OwnerSessionDO extends DurableObject<AppEnv> {
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS session_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL)",
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS oauth_states (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL)",
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS oauth_sessions (did TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS app_sessions (token_hash TEXT PRIMARY KEY, did TEXT NOT NULL, idle_expires_at INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL)",
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS refresh_locks (name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at INTEGER NOT NULL)",
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS oauth_start_rate (name TEXT PRIMARY KEY, window_started_at INTEGER NOT NULL, count INTEGER NOT NULL)",
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS auth_generation (name TEXT PRIMARY KEY, generation INTEGER NOT NULL)",
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO auth_generation (name, generation) VALUES ('owner', 1)",
      );
      return Promise.resolve();
    });
  }

  getAuthGeneration(): Promise<number> {
    return Promise.resolve(this.authGeneration());
  }

  resetAuthentication(): Promise<number> {
    const generation = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE auth_generation SET generation = generation + 1 WHERE name = 'owner'",
      );
      for (const table of [
        "session_events",
        "oauth_states",
        "oauth_sessions",
        "app_sessions",
        "refresh_locks",
        "oauth_start_rate",
      ]) {
        this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
      }
      return this.authGeneration();
    });
    return Promise.resolve(generation);
  }

  record(event: string): Promise<void> {
    this.ctx.storage.sql.exec("INSERT INTO session_events (event) VALUES (?)", event);
    return Promise.resolve();
  }

  putOAuthState(input: { key: string; value: unknown; generation?: number }): Promise<boolean> {
    if (!this.matchesAuthGeneration(input.generation)) return Promise.resolve(false);
    const value = JSON.stringify(input.value);
    const expiresAt = getExpiresAt(input.value, Date.now() + 10 * 60_000);
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO oauth_states (key, value, expires_at) VALUES (?, ?, ?)",
      input.key,
      value,
      expiresAt,
    );
    this.ctx.storage.sql.exec("DELETE FROM oauth_states WHERE expires_at <= ?", Date.now());
    this.ctx.storage.sql.exec(
      "DELETE FROM oauth_states WHERE key IN (SELECT key FROM oauth_states ORDER BY expires_at DESC, key DESC LIMIT -1 OFFSET ?)",
      OAUTH_STATE_LIMIT,
    );
    return Promise.resolve(true);
  }

  tryStartOAuth(input: { now: number; generation?: number }): Promise<boolean> {
    if (!this.matchesAuthGeneration(input.generation)) return Promise.resolve(false);
    const row = Array.from(
      this.ctx.storage.sql.exec<{ window_started_at: number; count: number }>(
        "SELECT window_started_at, count FROM oauth_start_rate WHERE name = 'start'",
      ),
    )[0];
    if (!row || row.window_started_at + OAUTH_START_WINDOW_MS <= input.now) {
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO oauth_start_rate (name, window_started_at, count) VALUES ('start', ?, 1)",
        input.now,
      );
      return Promise.resolve(true);
    }
    if (row.count >= OAUTH_START_LIMIT) return Promise.resolve(false);
    this.ctx.storage.sql.exec("UPDATE oauth_start_rate SET count = count + 1 WHERE name = 'start'");
    return Promise.resolve(true);
  }

  getOAuthState(input: { key: string }): Promise<unknown> {
    const row = Array.from(
      this.ctx.storage.sql.exec<{ value: string; expires_at: number }>(
        "SELECT value, expires_at FROM oauth_states WHERE key = ?",
        input.key,
      ),
    )[0];
    this.ctx.storage.sql.exec("DELETE FROM oauth_states WHERE key = ?", input.key);
    if (!row || row.expires_at <= Date.now()) return Promise.resolve(undefined);
    return Promise.resolve(JSON.parse(row.value) as unknown);
  }

  deleteOAuthState(input: { key: string }): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM oauth_states WHERE key = ?", input.key);
    return Promise.resolve();
  }

  putOAuthSession(input: { did: string; value: unknown; generation?: number }): Promise<boolean> {
    if (!this.matchesAuthGeneration(input.generation)) return Promise.resolve(false);
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO oauth_sessions (did, value) VALUES (?, ?)",
      input.did,
      JSON.stringify(input.value),
    );
    return Promise.resolve(true);
  }

  getOAuthSession(input: { did: string }): Promise<unknown> {
    const row = Array.from(
      this.ctx.storage.sql.exec<{ value: string }>(
        "SELECT value FROM oauth_sessions WHERE did = ?",
        input.did,
      ),
    )[0];
    return Promise.resolve(row ? (JSON.parse(row.value) as unknown) : undefined);
  }

  deleteOAuthSession(input: { did: string }): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM oauth_sessions WHERE did = ?", input.did);
    return Promise.resolve();
  }

  createAppSession(input: {
    tokenHash: string;
    did: string;
    idleExpiresAt: number;
    absoluteExpiresAt: number;
    generation?: number;
  }): Promise<boolean> {
    if (!this.matchesAuthGeneration(input.generation)) return Promise.resolve(false);
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO app_sessions (token_hash, did, idle_expires_at, absolute_expires_at) VALUES (?, ?, ?, ?)",
      input.tokenHash,
      input.did,
      input.idleExpiresAt,
      input.absoluteExpiresAt,
    );
    return Promise.resolve(true);
  }

  readAppSession(input: {
    tokenHash: string;
    now: number;
  }): Promise<{ did: string; absoluteExpiresAt: number; generation: number } | undefined> {
    const row = Array.from(
      this.ctx.storage.sql.exec<{
        did: string;
        idle_expires_at: number;
        absolute_expires_at: number;
      }>(
        "SELECT did, idle_expires_at, absolute_expires_at FROM app_sessions WHERE token_hash = ?",
        input.tokenHash,
      ),
    )[0];
    if (!row) return Promise.resolve(undefined);
    if (row.idle_expires_at <= input.now || row.absolute_expires_at <= input.now) {
      this.ctx.storage.sql.exec("DELETE FROM app_sessions WHERE token_hash = ?", input.tokenHash);
      return Promise.resolve(undefined);
    }
    return Promise.resolve({
      did: row.did,
      absoluteExpiresAt: row.absolute_expires_at,
      generation: this.authGeneration(),
    });
  }

  touchAppSession(input: {
    tokenHash: string;
    now: number;
    idleExpiresAt: number;
    generation?: number;
  }): Promise<boolean> {
    if (!this.matchesAuthGeneration(input.generation)) return Promise.resolve(false);
    this.ctx.storage.sql.exec(
      "UPDATE app_sessions SET idle_expires_at = MIN(?, absolute_expires_at) WHERE token_hash = ? AND idle_expires_at > ? AND absolute_expires_at > ?",
      input.idleExpiresAt,
      input.tokenHash,
      input.now,
      input.now,
    );
    const retained = Array.from(
      this.ctx.storage.sql.exec<{ present: number }>(
        "SELECT 1 AS present FROM app_sessions WHERE token_hash = ? AND idle_expires_at > ? AND absolute_expires_at > ?",
        input.tokenHash,
        input.now,
        input.now,
      ),
    )[0];
    return Promise.resolve(Boolean(retained));
  }

  deleteAppSession(input: { tokenHash: string }): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM app_sessions WHERE token_hash = ?", input.tokenHash);
    return Promise.resolve();
  }

  deleteAllAppSessions(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM app_sessions");
    return Promise.resolve();
  }

  tryAcquireRefreshLock(input: {
    name: string;
    holder: string;
    now: number;
    generation?: number;
  }): Promise<boolean> {
    if (!this.matchesAuthGeneration(input.generation)) return Promise.resolve(false);
    this.ctx.storage.sql.exec("DELETE FROM refresh_locks WHERE expires_at <= ?", input.now);
    const existing = Array.from(
      this.ctx.storage.sql.exec<{ holder: string }>(
        "SELECT holder FROM refresh_locks WHERE name = ?",
        input.name,
      ),
    )[0];
    if (existing) return Promise.resolve(existing.holder === input.holder);
    this.ctx.storage.sql.exec(
      "INSERT INTO refresh_locks (name, holder, expires_at) VALUES (?, ?, ?)",
      input.name,
      input.holder,
      input.now + REFRESH_LEASE_MS,
    );
    return Promise.resolve(true);
  }

  renewRefreshLock(input: {
    name: string;
    holder: string;
    now: number;
    generation?: number;
  }): Promise<boolean> {
    if (!this.matchesAuthGeneration(input.generation)) return Promise.resolve(false);
    const lease = Array.from(
      this.ctx.storage.sql.exec<{ holder: string; expires_at: number }>(
        "SELECT holder, expires_at FROM refresh_locks WHERE name = ?",
        input.name,
      ),
    )[0];
    if (!lease || lease.holder !== input.holder || lease.expires_at <= input.now)
      return Promise.resolve(false);
    this.ctx.storage.sql.exec(
      "UPDATE refresh_locks SET expires_at = ? WHERE name = ? AND holder = ?",
      input.now + REFRESH_LEASE_MS,
      input.name,
      input.holder,
    );
    return Promise.resolve(true);
  }

  releaseRefreshLock(input: { name: string; holder: string }): Promise<void> {
    this.ctx.storage.sql.exec(
      "DELETE FROM refresh_locks WHERE name = ? AND holder = ?",
      input.name,
      input.holder,
    );
    return Promise.resolve();
  }

  private authGeneration(): number {
    return this.ctx.storage.sql
      .exec<{ generation: number }>("SELECT generation FROM auth_generation WHERE name = 'owner'")
      .one().generation;
  }

  private matchesAuthGeneration(generation: number | undefined): boolean {
    return generation === undefined || generation === this.authGeneration();
  }
}

function getExpiresAt(value: unknown, fallback: number): number {
  if (!value || typeof value !== "object") return fallback;
  const candidate = (value as { expiresAt?: unknown }).expiresAt;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : fallback;
}
