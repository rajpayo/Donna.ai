/**
 * Shared maintenance of the retrieval_index projection (Specification
 * 3.2). The projection is derived state: every source-of-truth mutation
 * (saveItem, updateItem, move, merge, rename, delete) refreshes it in
 * the same transaction, and `rebuild` can regenerate it wholesale from
 * items ⋈ buckets (SR-3).
 */
import type pg from "pg";
import type { Thought } from "@donna/core";
import { vectorParam } from "./client.js";

/** Upsert the projection row for one thought from caller-supplied data. */
export async function upsertProjectionRow(
  client: pg.PoolClient,
  thought: Thought,
  bucketId: string,
  memoryIds: string[] = [],
): Promise<void> {
  await client.query(
    `INSERT INTO retrieval_index
       (tenant_id, user_id, thought_id, bucket_id, bucket_name,
        summary, text, tsv, embedding, has_task, people, memory_ids,
        capture_id, created_at)
     SELECT $1, $2, $3, $4, b.name, $5, $6,
            to_tsvector('english', $5 || ' ' || $6),
            $7::vector, $8, $9, $10, $11, $12
       FROM buckets b
      WHERE b.tenant_id = $1 AND b.user_id = $2 AND b.id = $4
     ON CONFLICT (tenant_id, user_id, thought_id) DO UPDATE SET
       bucket_id = EXCLUDED.bucket_id,
       bucket_name = EXCLUDED.bucket_name,
       summary = EXCLUDED.summary,
       text = EXCLUDED.text,
       tsv = EXCLUDED.tsv,
       embedding = EXCLUDED.embedding,
       has_task = EXCLUDED.has_task,
       people = EXCLUDED.people,
       memory_ids = EXCLUDED.memory_ids,
       capture_id = EXCLUDED.capture_id,
       created_at = EXCLUDED.created_at`,
    [
      thought.tenantId,
      thought.userId,
      thought.id,
      bucketId,
      thought.summary,
      thought.text,
      vectorParam(thought.embedding),
      thought.task !== undefined,
      thought.task?.assigneeHint !== undefined
        ? [thought.task.assigneeHint.trim().toLowerCase()]
        : [],
      memoryIds,
      thought.provenance.captureId,
      thought.createdAt ?? null,
    ],
  );
}

/**
 * Re-derive one projection row from the items ⋈ buckets join (used after
 * item field updates so the projection tracks the source row exactly).
 * Memory links are preserved across the refresh.
 */
export async function refreshProjectionFromItem(
  client: pg.PoolClient,
  tenantId: string,
  userId: string,
  thoughtId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO retrieval_index
       (tenant_id, user_id, thought_id, bucket_id, bucket_name,
        summary, text, tsv, embedding, has_task, people, memory_ids,
        capture_id, created_at)
     SELECT i.tenant_id, i.user_id, i.thought_id, i.bucket_id, b.name,
            i.summary, i.text,
            to_tsvector('english', i.summary || ' ' || i.text),
            i.embedding, i.task IS NOT NULL,
            COALESCE(ARRAY(SELECT lower(i.task ->> 'assigneeHint')
                           WHERE i.task ? 'assigneeHint'), '{}'),
            COALESCE(old.memory_ids, '{}'),
            i.provenance ->> 'captureId', i.created_at
       FROM items i
       JOIN buckets b
         ON b.tenant_id = i.tenant_id AND b.user_id = i.user_id
        AND b.id = i.bucket_id
       LEFT JOIN retrieval_index old
         ON old.tenant_id = i.tenant_id AND old.user_id = i.user_id
        AND old.thought_id = i.thought_id
      WHERE i.tenant_id = $1 AND i.user_id = $2 AND i.thought_id = $3
     ON CONFLICT (tenant_id, user_id, thought_id) DO UPDATE SET
       bucket_id = EXCLUDED.bucket_id,
       bucket_name = EXCLUDED.bucket_name,
       summary = EXCLUDED.summary,
       text = EXCLUDED.text,
       tsv = EXCLUDED.tsv,
       embedding = EXCLUDED.embedding,
       has_task = EXCLUDED.has_task,
       people = EXCLUDED.people,
       memory_ids = EXCLUDED.memory_ids,
       capture_id = EXCLUDED.capture_id,
       created_at = EXCLUDED.created_at`,
    [tenantId, userId, thoughtId],
  );
}
