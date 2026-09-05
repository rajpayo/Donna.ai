/**
 * PostgreSQL bucket store (Specification 3.2).
 *
 * Concurrency design — this adapter fixes the read-modify-write race the
 * whole-file store has:
 *
 *   - Every method runs in ONE scoped transaction (see client.ts), so
 *     RLS context is always pinned (SR-1) and multi-row mutations are
 *     atomic (FR-1).
 *   - `saveItem` locks the bucket row (SELECT ... FOR UPDATE), inserts
 *     the item (idempotent on the thought-ID primary key), recomputes the
 *     bucket's centroid and item count EXACTLY from the items table with
 *     avg(vector), bumps the bucket version, and upserts the retrieval
 *     projection — all in the same transaction. Concurrent placements
 *     serialize on the bucket row lock; no item or centroid update can
 *     be lost (FR-2, AC-3).
 *   - `updateBucketStats` is a genuinely optimistic version-checked
 *     write: read the version, UPDATE ... WHERE version = seen, retry on
 *     conflict up to 3 attempts, then throw OptimisticLockError. No
 *     partial update is ever applied.
 *   - moveItem / mergeBuckets / deleteItemsForCapture follow the same
 *     pattern: lock the affected bucket rows in ID order (deadlock-safe),
 *     mutate items, recompute stats exactly from survivors.
 *
 * SR-4: every query is parameterized; no user input ever becomes an
 * operator or identifier.
 */
import type pg from "pg";
import { OptimisticLockError, type Bucket, type BucketStore, type Thought } from "@donna/core";
import { canonicalNameKey } from "@donna/buckets";
import { scoped, vectorParam } from "./client.js";
import {
  refreshProjectionFromItem,
  upsertProjectionRow,
} from "./projection.pg.js";
import { bucketFromRow, thoughtFromRow } from "./rows.js";

const OPTIMISTIC_RETRY_LIMIT = 10;

export class PostgresBucketStore implements BucketStore {
  constructor(private readonly pool: pg.Pool) {}

  async listBuckets(tenantId: string, userId: string): Promise<Bucket[]> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      const result = await client.query(
        `SELECT * FROM buckets
          WHERE tenant_id = $1 AND user_id = $2
          ORDER BY created_at, id`,
        [tenantId, userId],
      );
      return result.rows.map(bucketFromRow);
    });
  }

  async getBucketById(
    tenantId: string,
    userId: string,
    bucketId: string,
  ): Promise<Bucket | undefined> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      const result = await client.query(
        `SELECT * FROM buckets
          WHERE tenant_id = $1 AND user_id = $2 AND id = $3`,
        [tenantId, userId, bucketId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : bucketFromRow(row);
    });
  }

  async getBucketByName(
    tenantId: string,
    userId: string,
    name: string,
  ): Promise<Bucket | undefined> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      const result = await client.query(
        `SELECT * FROM buckets
          WHERE tenant_id = $1 AND user_id = $2 AND lower(name) = lower($3)
          ORDER BY created_at, id
          LIMIT 1`,
        [tenantId, userId, name.trim()],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : bucketFromRow(row);
    });
  }

  async createBucket(bucket: Bucket): Promise<Bucket> {
    return scoped(
      this.pool,
      { tenantId: bucket.tenantId, userId: bucket.userId },
      async (client) => {
        // Spec 6.7: the per-user canonical-name key is enforced by the
        // buckets_unique_canonical_name unique index; a collision fails
        // closed with a constraint error — never a duplicate bucket.
        await client.query(
          `INSERT INTO buckets
             (tenant_id, user_id, id, name, description, centroid,
              item_count, origin, created_at, canonical_name_key)
           VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8, $9, $10)`,
          [
            bucket.tenantId,
            bucket.userId,
            bucket.id,
            bucket.name,
            bucket.description,
            vectorParam(bucket.centroid),
            bucket.itemCount,
            bucket.origin,
            bucket.createdAt,
            canonicalNameKey(bucket.name),
          ],
        );
        return bucket;
      },
    );
  }

  /**
   * Optimistic version-checked stats write. The values are absolute
   * (callers derive them from a full read); a concurrent stats change is
   * detected via the version column and retried — after the retry bound
   * the caller learns about the conflict explicitly (FR-2).
   */
  async updateBucketStats(
    tenantId: string,
    userId: string,
    bucketId: string,
    centroid: number[],
    itemCount: number,
  ): Promise<void> {
    for (let attempt = 1; attempt <= OPTIMISTIC_RETRY_LIMIT; attempt++) {
      const outcome = await scoped(
        this.pool,
        { tenantId, userId },
        async (client) => {
          const current = await client.query<{ version: number }>(
            `SELECT version FROM buckets
              WHERE tenant_id = $1 AND user_id = $2 AND id = $3`,
            [tenantId, userId, bucketId],
          );
          if (current.rows.length === 0) return "missing" as const;
          const seen = current.rows[0]!.version;
          const updated = await client.query(
            `UPDATE buckets
                SET centroid = $4::vector, item_count = $5, version = version + 1
              WHERE tenant_id = $1 AND user_id = $2 AND id = $3
                AND version = $6`,
            [tenantId, userId, bucketId, vectorParam(centroid), itemCount, seen],
          );
          return updated.rowCount === 1 ? ("ok" as const) : ("conflict" as const);
        },
      );
      if (outcome === "ok") return;
      if (outcome === "missing") {
        throw new Error("Bucket does not exist in the requested tenant/user scope");
      }
    }
    throw new OptimisticLockError(
      `Bucket stats update conflicted ${OPTIMISTIC_RETRY_LIMIT} times`,
    );
  }

  /**
   * FR-1: one transaction persists the item, the exact bucket stats, and
   * the retrieval projection — or none of them. Idempotent on the
   * thought-ID primary key (safe retry of a placement).
   */
  async saveItem(item: { thought: Thought; bucketId: string }): Promise<void> {
    const { tenantId, userId } = item.thought;
    await scoped(this.pool, { tenantId, userId }, async (client) => {
      await this.lockBucket(client, tenantId, userId, item.bucketId);
      await client.query(
        `INSERT INTO items
           (tenant_id, user_id, thought_id, bucket_id, summary, text,
            confidence, task, provenance, versions, embedding, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector, $12)
         ON CONFLICT (tenant_id, user_id, thought_id) DO NOTHING`,
        [
          tenantId,
          userId,
          item.thought.id,
          item.bucketId,
          item.thought.summary,
          item.thought.text,
          item.thought.confidence,
          item.thought.task === undefined ? null : JSON.stringify(item.thought.task),
          JSON.stringify(item.thought.provenance),
          JSON.stringify(item.thought.versions),
          vectorParam(item.thought.embedding),
          item.thought.createdAt ?? null,
        ],
      );
      await this.recomputeBucketStats(client, tenantId, userId, item.bucketId);
      await upsertProjectionRow(client, item.thought, item.bucketId);
    });
  }

  async listItems(
    tenantId: string,
    userId: string,
  ): Promise<Array<{ thought: Thought; bucketId: string }>> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      const result = await client.query(
        `SELECT * FROM items
          WHERE tenant_id = $1 AND user_id = $2
          ORDER BY created_at NULLS LAST, thought_id`,
        [tenantId, userId],
      );
      return result.rows.map((row) => ({
        thought: thoughtFromRow(row),
        bucketId: row.bucket_id as string,
      }));
    });
  }

  async getItem(
    tenantId: string,
    userId: string,
    thoughtId: string,
  ): Promise<{ thought: Thought; bucketId: string } | undefined> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      const result = await client.query(
        `SELECT * FROM items
          WHERE tenant_id = $1 AND user_id = $2 AND thought_id = $3`,
        [tenantId, userId, thoughtId],
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : { thought: thoughtFromRow(row), bucketId: row.bucket_id as string };
    });
  }

  async listItemsByBucket(
    tenantId: string,
    userId: string,
    bucketId: string,
  ): Promise<Array<{ thought: Thought; bucketId: string }>> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      const bucket = await client.query(
        `SELECT 1 FROM buckets
          WHERE tenant_id = $1 AND user_id = $2 AND id = $3`,
        [tenantId, userId, bucketId],
      );
      if (bucket.rows.length === 0) {
        throw new Error("Bucket does not exist in the requested tenant/user scope");
      }
      const result = await client.query(
        `SELECT * FROM items
          WHERE tenant_id = $1 AND user_id = $2 AND bucket_id = $3
          ORDER BY created_at NULLS LAST, thought_id`,
        [tenantId, userId, bucketId],
      );
      return result.rows.map((row) => ({
        thought: thoughtFromRow(row),
        bucketId: row.bucket_id as string,
      }));
    });
  }

  async listItemsInRange(
    tenantId: string,
    userId: string,
    range: { from?: string; to?: string },
  ): Promise<Array<{ thought: Thought; bucketId: string }>> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      // Fail closed: created_at IS NULL rows (pre-3.1) are excluded.
      const result = await client.query(
        `SELECT * FROM items
          WHERE tenant_id = $1 AND user_id = $2
            AND created_at IS NOT NULL
            AND ($3::timestamptz IS NULL OR created_at >= $3::timestamptz)
            AND ($4::timestamptz IS NULL OR created_at <= $4::timestamptz)
          ORDER BY created_at, thought_id`,
        [tenantId, userId, range.from ?? null, range.to ?? null],
      );
      return result.rows.map((row) => ({
        thought: thoughtFromRow(row),
        bucketId: row.bucket_id as string,
      }));
    });
  }

  async deleteItemsForCapture(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<{ removed: number }> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      const affected = await client.query<{ bucket_id: string }>(
        `SELECT DISTINCT bucket_id FROM items
          WHERE tenant_id = $1 AND user_id = $2
            AND provenance ->> 'captureId' = $3`,
        [tenantId, userId, captureId],
      );
      const bucketIds = affected.rows.map((row) => row.bucket_id).sort();
      for (const bucketId of bucketIds) {
        await this.lockBucket(client, tenantId, userId, bucketId);
      }
      const deleted = await client.query(
        `DELETE FROM items
          WHERE tenant_id = $1 AND user_id = $2
            AND provenance ->> 'captureId' = $3`,
        [tenantId, userId, captureId],
      );
      for (const bucketId of bucketIds) {
        await this.recomputeBucketStats(client, tenantId, userId, bucketId);
      }
      // retrieval_index rows cascade with the items DELETE.
      return { removed: deleted.rowCount ?? 0 };
    });
  }

  async moveItem(
    tenantId: string,
    userId: string,
    thoughtId: string,
    toBucketId: string,
  ): Promise<void> {
    await scoped(this.pool, { tenantId, userId }, async (client) => {
      const item = await client.query<{ bucket_id: string }>(
        `SELECT bucket_id FROM items
          WHERE tenant_id = $1 AND user_id = $2 AND thought_id = $3`,
        [tenantId, userId, thoughtId],
      );
      if (item.rows.length === 0) {
        throw new Error("Thought does not exist in the requested tenant/user scope");
      }
      const fromBucketId = item.rows[0]!.bucket_id;
      if (fromBucketId === toBucketId) return; // idempotent no-op
      // Lock both buckets in ID order — deadlock-safe.
      for (const bucketId of [fromBucketId, toBucketId].sort()) {
        await this.lockBucket(client, tenantId, userId, bucketId);
      }
      await client.query(
        `UPDATE items SET bucket_id = $4
          WHERE tenant_id = $1 AND user_id = $2 AND thought_id = $3`,
        [tenantId, userId, thoughtId, toBucketId],
      );
      await this.recomputeBucketStats(client, tenantId, userId, fromBucketId);
      await this.recomputeBucketStats(client, tenantId, userId, toBucketId);
      await client.query(
        `UPDATE retrieval_index SET bucket_id = $4,
           bucket_name = (SELECT name FROM buckets
             WHERE tenant_id = $1 AND user_id = $2 AND id = $4)
          WHERE tenant_id = $1 AND user_id = $2 AND thought_id = $3`,
        [tenantId, userId, thoughtId, toBucketId],
      );
    });
  }

  async renameBucket(
    tenantId: string,
    userId: string,
    bucketId: string,
    newName: string,
  ): Promise<void> {
    if (newName.trim().length === 0) {
      throw new Error("Bucket name must not be empty");
    }
    await scoped(this.pool, { tenantId, userId }, async (client) => {
      const updated = await client.query(
        `UPDATE buckets SET name = $4, canonical_name_key = $5, version = version + 1
          WHERE tenant_id = $1 AND user_id = $2 AND id = $3`,
        [tenantId, userId, bucketId, newName.trim(), canonicalNameKey(newName)],
      );
      if (updated.rowCount === 0) {
        throw new Error("Bucket does not exist in the requested tenant/user scope");
      }
      await client.query(
        `UPDATE retrieval_index SET bucket_name = $4
          WHERE tenant_id = $1 AND user_id = $2 AND bucket_id = $3`,
        [tenantId, userId, bucketId, newName.trim()],
      );
    });
  }

  async mergeBuckets(
    tenantId: string,
    userId: string,
    sourceBucketId: string,
    targetBucketId: string,
  ): Promise<void> {
    if (sourceBucketId === targetBucketId) {
      throw new Error("Cannot merge a bucket into itself");
    }
    await scoped(this.pool, { tenantId, userId }, async (client) => {
      for (const bucketId of [sourceBucketId, targetBucketId].sort()) {
        await this.lockBucket(client, tenantId, userId, bucketId);
      }
      await client.query(
        `UPDATE items SET bucket_id = $4
          WHERE tenant_id = $1 AND user_id = $2 AND bucket_id = $3`,
        [tenantId, userId, sourceBucketId, targetBucketId],
      );
      await client.query(
        `UPDATE retrieval_index SET bucket_id = $4,
           bucket_name = (SELECT name FROM buckets
             WHERE tenant_id = $1 AND user_id = $2 AND id = $4)
          WHERE tenant_id = $1 AND user_id = $2 AND bucket_id = $3`,
        [tenantId, userId, sourceBucketId, targetBucketId],
      );
      await client.query(
        `DELETE FROM buckets
          WHERE tenant_id = $1 AND user_id = $2 AND id = $3`,
        [tenantId, userId, sourceBucketId],
      );
      await this.recomputeBucketStats(client, tenantId, userId, targetBucketId);
    });
  }

  async updateItem(
    tenantId: string,
    userId: string,
    thoughtId: string,
    updates: {
      text?: string;
      summary?: string;
      task?: Thought["task"] | null;
      provenance?: Thought["provenance"];
      embedding?: number[];
    },
  ): Promise<void> {
    await scoped(this.pool, { tenantId, userId }, async (client) => {
      const sets: string[] = [];
      const values: unknown[] = [tenantId, userId, thoughtId];
      const push = (value: unknown): string => {
        values.push(value);
        return `$${values.length}`;
      };
      if (updates.text !== undefined) sets.push(`text = ${push(updates.text)}`);
      if (updates.summary !== undefined) sets.push(`summary = ${push(updates.summary)}`);
      if (updates.task !== undefined) {
        sets.push(
          `task = ${push(updates.task === null ? null : JSON.stringify(updates.task))}`,
        );
      }
      if (updates.provenance !== undefined) {
        sets.push(`provenance = ${push(JSON.stringify(updates.provenance))}`);
      }
      if (updates.embedding !== undefined) {
        sets.push(`embedding = ${push(vectorParam(updates.embedding))}::vector`);
      }
      if (sets.length === 0) return;
      const updated = await client.query(
        `UPDATE items SET ${sets.join(", ")}
          WHERE tenant_id = $1 AND user_id = $2 AND thought_id = $3`,
        values,
      );
      if (updated.rowCount === 0) {
        throw new Error("Thought does not exist in the requested tenant/user scope");
      }
      // Keep the retrieval projection in step with the source row.
      await refreshProjectionFromItem(client, tenantId, userId, thoughtId);
    });
  }

  /**
   * Lock a bucket row for this transaction (deadlock-safe when callers
   * lock in sorted ID order) and prove it exists in scope.
   */
  private async lockBucket(
    client: pg.PoolClient,
    tenantId: string,
    userId: string,
    bucketId: string,
  ): Promise<void> {
    const result = await client.query(
      `SELECT id FROM buckets
        WHERE tenant_id = $1 AND user_id = $2 AND id = $3
        FOR UPDATE`,
      [tenantId, userId, bucketId],
    );
    if (result.rows.length === 0) {
      throw new Error("Bucket does not exist in the requested tenant/user scope");
    }
  }

  /**
   * Exact centroid/count recompute from the items table (avg(vector) in
   * SQL), with the optimistic version bumped. Callers hold the bucket
   * row lock, so concurrent recomputes serialize.
   */
  private async recomputeBucketStats(
    client: pg.PoolClient,
    tenantId: string,
    userId: string,
    bucketId: string,
  ): Promise<void> {
    await client.query(
      `UPDATE buckets b
          SET item_count = stats.count,
              centroid = stats.centroid,
              version = version + 1
        FROM (
          SELECT count(*)::integer AS count,
                 avg(embedding) AS centroid
            FROM items
           WHERE tenant_id = $1 AND user_id = $2 AND bucket_id = $3
        ) AS stats
        WHERE b.tenant_id = $1 AND b.user_id = $2 AND b.id = $3`,
      [tenantId, userId, bucketId],
    );
  }

}
