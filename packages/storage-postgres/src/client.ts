/**
 * PostgreSQL connection handling for the Donna storage adapters
 * (Specification 3.2).
 *
 * SR-2: credentials come from runtime secrets (a connection string or
 * discrete settings supplied by the environment), never from the
 * repository. TLS is validated by default when `ssl` is enabled —
 * `rejectUnauthorized` is never silently disabled; an explicit
 * `allowInsecureTls: true` is required for local development without
 * certificates and is rejected unless deliberate.
 *
 * Isolation (SR-1): every adapter operation runs inside `scoped()` —
 * one transaction that first pins the tenant/user into the
 * transaction-local session context (set_config ..., is_local = true).
 * Row-level security policies read that context, so the database itself
 * denies unscoped or cross-scope access even when application code omits
 * a filter. The context dies with the transaction; pooled connections
 * can never leak one request's scope into another.
 */
import pg from "pg";

export interface Scope {
  tenantId: string;
  userId: string;
}

export interface PostgresConnectionConfig {
  /** Runtime-secret connection string, e.g. from DONNA_DATABASE_URL. */
  connectionString: string;
  /**
   * TLS validation. When `ssl` is true the driver verifies the server
   * certificate (rejectUnauthorized: true). Set `allowInsecureTls` only
   * for local development without certificates — never in production.
   */
  ssl?: boolean;
  allowInsecureTls?: boolean;
  /** Pool size cap (default 5). */
  maxConnections?: number;
}

export function createPool(config: PostgresConnectionConfig): pg.Pool {
  if (config.ssl === true && config.allowInsecureTls !== true) {
    return new pg.Pool({
      connectionString: config.connectionString,
      max: config.maxConnections ?? 5,
      ssl: { rejectUnauthorized: true },
    });
  }
  if (config.ssl === true && config.allowInsecureTls === true) {
    return new pg.Pool({
      connectionString: config.connectionString,
      max: config.maxConnections ?? 5,
      ssl: { rejectUnauthorized: false },
    });
  }
  return new pg.Pool({
    connectionString: config.connectionString,
    max: config.maxConnections ?? 5,
  });
}

/**
 * Run `fn` inside one transaction with the tenant/user scope pinned into
 * the transaction-local session context that RLS policies read. Every
 * adapter method goes through here — there is no unscoped query path.
 */
export async function scoped<T>(
  pool: pg.Pool,
  scope: Scope,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // set_config with is_local = true is the parameterized form of
    // SET LOCAL: the values live and die with this transaction.
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
      [scope.tenantId, scope.userId],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Parse a pgvector column value ("[1,2,3]") into a number array. */
export function parseVector(value: unknown): number[] | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(Number);
  const text = String(value);
  if (!text.startsWith("[") || !text.endsWith("]")) return undefined;
  if (text.length <= 2) return [];
  return text
    .slice(1, -1)
    .split(",")
    .map((component) => Number(component));
}

/** Serialize a number array for a pgvector parameter. */
export function vectorParam(embedding: number[] | undefined): string | null {
  // pgvector rejects zero-dimension vectors; an empty embedding is
  // semantically "no vector" and stores as NULL.
  if (embedding === undefined || embedding.length === 0) return null;
  return `[${embedding.join(",")}]`;
}

/** timestamptz → domain ISO 8601 string. */
export function isoString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
