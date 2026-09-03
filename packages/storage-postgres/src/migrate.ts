/**
 * Versioned migration runner (Specification 3.2).
 *
 * Migrations live in `database/migrations/` as `NNNN_name.up.sql` /
 * `NNNN_name.down.sql` pairs. Each migration runs in its own
 * transaction: a migration applies fully or not at all, and the
 * `schema_migrations` ledger records exactly which versions are live.
 * `migrateDown` rolls versions back newest-first using the paired down
 * files, so rollback is deterministic and testable (AC-1).
 *
 * The runner uses plain multi-statement SQL files executed with the
 * simple query protocol — no interpolation, no user input (SR-4).
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";

export interface Migration {
  version: number;
  name: string;
  upFile: string;
  downFile: string;
}

const MIGRATION_FILE = /^(\d{4})_(.+)\.(up|down)\.sql$/;

/** Discover the ordered migration pairs in a migrations directory. */
export async function discoverMigrations(dir: string): Promise<Migration[]> {
  const names = await readdir(dir);
  const byVersion = new Map<number, { name: string; up?: string; down?: string }>();
  for (const file of names) {
    const match = MIGRATION_FILE.exec(file);
    if (match === null) continue;
    const version = Number(match[1]);
    const name = match[2]!;
    const entry = byVersion.get(version) ?? { name };
    entry.name = name;
    if (match[3] === "up") entry.up = file;
    else entry.down = file;
    byVersion.set(version, entry);
  }
  return [...byVersion.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([version, entry]) => {
      if (entry.up === undefined || entry.down === undefined) {
        throw new Error(
          `Migration ${version} is incomplete: both .up.sql and .down.sql are required`,
        );
      }
      return {
        version,
        name: entry.name,
        upFile: join(dir, entry.up),
        downFile: join(dir, entry.down),
      };
    });
}

async function ensureLedger(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    integer PRIMARY KEY,
      name       text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/** Versions currently recorded as applied, ascending. */
export async function appliedVersions(client: pg.PoolClient): Promise<number[]> {
  await ensureLedger(client);
  const result = await client.query<{ version: number }>(
    "SELECT version FROM schema_migrations ORDER BY version",
  );
  return result.rows.map((row) => row.version);
}

/**
 * Apply every pending migration in version order. Returns the versions
 * applied during this call. Idempotent: an up-to-date database applies
 * nothing.
 */
export async function migrateUp(
  pool: pg.Pool,
  dir: string,
): Promise<{ applied: number[] }> {
  const migrations = await discoverMigrations(dir);
  const client = await pool.connect();
  try {
    const applied = new Set(await appliedVersions(client));
    const done: number[] = [];
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      const sql = await readFile(migration.upFile, "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version, name) VALUES ($1, $2)",
          [migration.version, migration.name],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
      done.push(migration.version);
    }
    return { applied: done };
  } finally {
    client.release();
  }
}

/**
 * Roll back applied migrations newest-first until only versions
 * `<= target` remain (default 0 — a clean slate). Returns the versions
 * rolled back.
 */
export async function migrateDown(
  pool: pg.Pool,
  dir: string,
  target = 0,
): Promise<{ rolledBack: number[] }> {
  const migrations = await discoverMigrations(dir);
  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  const client = await pool.connect();
  try {
    const applied = await appliedVersions(client);
    const done: number[] = [];
    for (const version of [...applied].sort((a, b) => b - a)) {
      if (version <= target) continue;
      const migration = byVersion.get(version);
      if (migration === undefined) {
        throw new Error(
          `Cannot roll back version ${version}: migration files are missing`,
        );
      }
      const sql = await readFile(migration.downFile, "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "DELETE FROM schema_migrations WHERE version = $1",
          [version],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
      done.push(version);
    }
    return { rolledBack: done };
  } finally {
    client.release();
  }
}
