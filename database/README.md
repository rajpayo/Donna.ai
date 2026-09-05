# Donna database — PostgreSQL + pgvector (Specification 3.2)

Transactional, tenant-isolated storage for captures, transcripts,
thoughts/items, buckets, memories, corrections, consent, and the
retrieval projection. The file adapters remain the default for tests and
the local CLI; this store implements the same ports.

## Layout

- `database/migrations/NNNN_name.up.sql` / `.down.sql` — versioned
  migration pairs, applied/rolled back by
  `packages/storage-postgres/src/migrate.ts` (`migrateUp` / `migrateDown`).
  Each migration runs in its own transaction; `schema_migrations` is the
  ledger.
- `packages/storage-postgres/` — the adapters (one class per existing
  port), the scoped-transaction helper, and the file-fixture importer.

## Roles

Three roles, least privilege:

| Role | Purpose | Notes |
|---|---|---|
| migration/owner role (local dev: `postgres`) | runs migrations | owns the tables; subject to FORCE RLS only if non-superuser |
| `donna_app` | the application | `SELECT/INSERT/UPDATE/DELETE` on data tables; `INSERT/SELECT` only on append-only tables (`memory_events`, `consents`); bound by RLS |
| `donna_backup` | dumps | `BYPASSRLS` + `SELECT` on all tables and sequences (required: FORCE RLS otherwise yields empty dumps) |

Local test setup (matches the integration tests):

```sql
CREATE ROLE donna_app LOGIN PASSWORD '<runtime-secret>';
CREATE ROLE donna_backup LOGIN PASSWORD '<runtime-secret>' BYPASSRLS;
CREATE DATABASE donna_test;            -- owned by the migration role
-- in donna_test:
CREATE EXTENSION vector;
-- after migrations:
GRANT SELECT ON ALL TABLES IN SCHEMA public TO donna_backup;
GRANT SELECT, USAGE ON ALL SEQUENCES IN SCHEMA public TO donna_backup;
```

Run the integration suite with runtime-injected, non-production URLs:

```bash
DONNA_TEST_DATABASE_URL=<donna_app connection URL>
DONNA_TEST_ADMIN_URL=<migration/admin connection URL>
DONNA_TEST_BACKUP_URL=<optional BYPASSRLS backup URL>
npm test --workspace @donna/storage-postgres
```

The pull-request workflow provisions a pinned pgvector container and runs this
suite automatically. Local test URLs remain outside the repository.

## Credentials and TLS (SR-2)

Connection strings come from runtime secrets (e.g. `DONNA_DATABASE_URL`),
never from the repository. `createPool` verifies TLS when `ssl: true`;
`allowInsecureTls` exists only for local development without certificates.

## Tenant/user isolation (SR-1)

Every personal-data table has `tenant_id` + `user_id`, RLS `ENABLE` +
`FORCE`, and a `scope_isolation` policy bound to the transaction-local
settings `app.tenant_id` / `app.user_id`. Adapters set them per
transaction via `set_config(..., true)` inside `scoped()`. Unset context
→ NULL → zero rows: the database denies unscoped access even when
application code omits a filter (tested in
`packages/storage-postgres/src/postgres.test.ts`).

## Running migrations

```ts
import { createPool, migrateUp, migrateDown } from "@donna/storage-postgres";

const admin = createPool({ connectionString: process.env.DONNA_ADMIN_DATABASE_URL! });
await migrateUp(admin, "database/migrations");      // apply pending, in order
await migrateDown(admin, "database/migrations", 0); // roll back to version 0
```

Rollback is the paired `.down.sql` per version, newest first. A clean
install (down to 0, up to latest) is covered by the AC-1 test.

## Backup and restore (SR-3)

```bash
pg_dump "$DONNA_BACKUP_DATABASE_URL" --no-owner --no-privileges -f backup.sql
createdb donna_restore
psql "$DONNA_ADMIN_DATABASE_URL_FOR_RESTORE_DB" -v ON_ERROR_STOP=1 -f backup.sql
```

- Use the `donna_backup` (BYPASSRLS) role for dumps; FORCE RLS makes
  dumps by ordinary roles silently empty.
- Audio is never in the database (encrypted file store, Spec 1.3), so
  backups inherit no extra decryption obligations; deletion obligations
  are preserved because deletes remove rows, and dumps are point-in-time
  snapshots that must be handled under the same retention policy.
- The backup/restore round trip is tested (AC-5).

## Retrieval index rebuild (SR-3)

The `retrieval_index` table is a rebuildable projection of
`items ⋈ buckets`. To rebuild one scope:

```ts
const index = new PostgresRetrievalIndex({ pool: appPool });
await index.rebuild(tenantId, userId); // deletes + re-derives the scope
```

SQL equivalent per scope: `DELETE FROM retrieval_index WHERE tenant_id =
… AND user_id = …` followed by re-insert from the join (the adapter's
`rebuild` does exactly this, transactionally). Corrupt or suspect
projection state is never repaired by hand — rebuild it.

## Concurrency (FR-1/FR-2)

- `saveItem` persists the item, exact bucket stats (`avg(vector)`), and
  the retrieval projection in ONE transaction, serialized per bucket by a
  row lock — concurrent placements cannot lose items or centroid updates.
- `updateBucketStats` is an optimistic version-checked write (bounded
  retries, then `OptimisticLockError`); every mutation bumps
  `buckets.version`.

## Monetary values

No monetary/cost columns exist in this schema version. The rule for any
future one (e.g. per-loop cost): `BIGINT` minor units or `NUMERIC` —
never float. This is a review-enforced migration convention.

## Embedding columns

`vector` (dimensionless) in this version, so the embedding model can
change without a schema change; cosine uses `<=>` guarded by
`vector_dims`. Precision is float4 (pgvector's `vector`). When the
embedding model is pinned for production, migrate to fixed-dimension
`vector(N)` columns and add an HNSW index:

```sql
ALTER TABLE items ALTER COLUMN embedding TYPE vector(1024);
CREATE INDEX ON items USING hnsw (embedding vector_cosine_ops);
```

Memory records carry no embedding today (the Spec 2.1 domain has none);
when semantic memory retrieval lands, add a nullable `embedding vector`
to `memories` in a new migration.
