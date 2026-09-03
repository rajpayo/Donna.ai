/**
 * PostgreSQL retrieval index (Specification 3.2): the RetrievalIndex
 * port over the retrieval_index projection table.
 *
 * Scope and filters run in SQL inside a scoped transaction — RLS plus
 * explicit tenant/user predicates mean ACL filtering happens before any
 * scoring (SR-1/SR-2). The semantic signal is computed by pgvector
 * (`<=>` cosine distance, guarded by vector_dims so a dimension mismatch
 * degrades to 0 instead of erroring); the text signal uses the shared
 * deterministic tokenizer from @donna/retrieval over the projection
 * row's summary + text. Score components are always exposed (FR-2).
 *
 * Scoring version `donna.pg-retrieval.v1`: same signals and weights as
 * `donna.local-retrieval.v1`, with the cosine computed in SQL (float4
 * precision — see database/README.md for the fixed-dimension upgrade
 * path).
 */
import type pg from "pg";
import type {
  Bucket,
  MemoryStore,
  RetrievalHit,
  RetrievalIndex,
  RetrievalQuery,
  Thought,
} from "@donna/core";
import { combinedScore, textScore, tokenize } from "@donna/retrieval";
import { scoped } from "./client.js";
import { upsertProjectionRow } from "./projection.pg.js";
import { thoughtFromRow } from "./rows.js";

export const PG_SCORE_VERSION = "donna.pg-retrieval.v1";
const DEFAULT_LIMIT = 20;

export interface PostgresRetrievalIndexDeps {
  pool: pg.Pool;
  /** When present, memory links are maintained in the projection. */
  memories?: Pick<MemoryStore, "listMemories">;
}

export class PostgresRetrievalIndex implements RetrievalIndex {
  constructor(private readonly deps: PostgresRetrievalIndexDeps) {}

  private async linkedMemoryIds(thought: Thought): Promise<string[]> {
    if (this.deps.memories === undefined) return [];
    const memories = await this.deps.memories.listMemories(
      thought.tenantId,
      thought.userId,
    );
    return memories
      .filter((memory) =>
        memory.sources.some(
          (source) => source.kind === "thought" && source.id === thought.id,
        ),
      )
      .map((memory) => memory.id)
      .sort();
  }

  async indexItem(
    item: { thought: Thought; bucketId: string },
    _bucket: Bucket,
  ): Promise<void> {
    const { tenantId, userId } = item.thought;
    const memoryIds = await this.linkedMemoryIds(item.thought);
    await scoped(this.deps.pool, { tenantId, userId }, async (client) => {
      await upsertProjectionRow(client, item.thought, item.bucketId, memoryIds);
    });
  }

  async removeThought(
    tenantId: string,
    userId: string,
    thoughtId: string,
  ): Promise<boolean> {
    return scoped(this.deps.pool, { tenantId, userId }, async (client) => {
      const result = await client.query(
        `DELETE FROM retrieval_index
          WHERE tenant_id = $1 AND user_id = $2 AND thought_id = $3`,
        [tenantId, userId, thoughtId],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async removeCapture(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<{ removed: number }> {
    return scoped(this.deps.pool, { tenantId, userId }, async (client) => {
      const result = await client.query(
        `DELETE FROM retrieval_index
          WHERE tenant_id = $1 AND user_id = $2 AND capture_id = $3`,
        [tenantId, userId, captureId],
      );
      return { removed: result.rowCount ?? 0 };
    });
  }

  /**
   * SR-3: discard the scoped projection and rebuild it from the
   * source-of-truth items ⋈ buckets join. Deterministic and idempotent.
   */
  async rebuild(
    tenantId: string,
    userId: string,
  ): Promise<{ indexed: number }> {
    const memoryLinks = await this.memoryLinksByThought(tenantId, userId);
    return scoped(this.deps.pool, { tenantId, userId }, async (client) => {
      await client.query(
        `DELETE FROM retrieval_index
          WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId],
      );
      const items = await client.query(
        `SELECT * FROM items
          WHERE tenant_id = $1 AND user_id = $2
          ORDER BY thought_id`,
        [tenantId, userId],
      );
      for (const row of items.rows) {
        const thought = thoughtFromRow(row);
        await upsertProjectionRow(
          client,
          thought,
          row.bucket_id as string,
          memoryLinks.get(thought.id) ?? [],
        );
      }
      return { indexed: items.rows.length };
    });
  }

  async search(query: RetrievalQuery): Promise<RetrievalHit[]> {
    const { tenantId, userId } = query;
    return scoped(this.deps.pool, { tenantId, userId }, async (client) => {
      const values: unknown[] = [tenantId, userId];
      const push = (value: unknown): string => {
        values.push(value);
        return `$${values.length}`;
      };

      const conditions = [
        "r.tenant_id = $1",
        "r.user_id = $2",
      ];
      const filters = query.filters;
      if (filters?.bucketIds !== undefined && filters.bucketIds.length > 0) {
        conditions.push(`r.bucket_id = ANY(${push(filters.bucketIds)}::text[])`);
      }
      if (filters?.createdFrom !== undefined || filters?.createdTo !== undefined) {
        // Fail closed: undated rows cannot be proven in range.
        conditions.push("r.created_at IS NOT NULL");
        if (filters.createdFrom !== undefined) {
          conditions.push(`r.created_at >= ${push(filters.createdFrom)}::timestamptz`);
        }
        if (filters.createdTo !== undefined) {
          conditions.push(`r.created_at <= ${push(filters.createdTo)}::timestamptz`);
        }
      }
      if (filters?.hasTask === true) {
        conditions.push("r.has_task");
      }
      if (filters?.people !== undefined && filters.people.length > 0) {
        conditions.push(
          `EXISTS (
             SELECT 1 FROM unnest(${push(filters.people)}::text[]) AS hint
             WHERE position(lower(hint) in lower(
               array_to_string(r.people, ' ') || ' ' || r.summary || ' ' || r.text
             )) > 0
           )`,
        );
      }
      if (filters?.memoryIds !== undefined && filters.memoryIds.length > 0) {
        conditions.push(`r.memory_ids && ${push(filters.memoryIds)}::text[]`);
      }

      const hasText =
        query.text !== undefined && tokenize(query.text).size > 0;
      const hasSemantic = query.embedding !== undefined;
      const embeddingParam = push(
        query.embedding === undefined ? null : `[${query.embedding.join(",")}]`,
      );

      const result = await client.query(
        `SELECT i.*, r.bucket_name,
                CASE
                  WHEN ${embeddingParam}::vector IS NOT NULL
                       AND r.embedding IS NOT NULL
                       AND vector_dims(r.embedding) = vector_dims(${embeddingParam}::vector)
                  THEN 1 - (r.embedding <=> ${embeddingParam}::vector)
                  ELSE 0
                END AS semantic_sim
           FROM retrieval_index r
           JOIN items i
             ON i.tenant_id = r.tenant_id AND i.user_id = r.user_id
            AND i.thought_id = r.thought_id
          WHERE ${conditions.join(" AND ")}`,
        values,
      );

      const queryTokens = hasText ? tokenize(query.text!) : new Set<string>();
      const hits: RetrievalHit[] = result.rows.map((row) => {
        const thought = thoughtFromRow(row);
        const text = textScore(
          queryTokens,
          tokenize(`${thought.summary} ${thought.text}`),
        );
        const semantic = Math.max(0, Number(row.semantic_sim));
        return {
          thought,
          bucketId: row.bucket_id as string,
          bucketName: row.bucket_name as string,
          scores: {
            text,
            semantic,
            combined: combinedScore(hasText, hasSemantic, text, semantic),
          },
          scoreVersion: PG_SCORE_VERSION,
        };
      });

      const eligible =
        hasText || hasSemantic
          ? hits.filter((hit) => hit.scores.combined > 0)
          : hits;
      return eligible
        .sort(
          (a, b) =>
            b.scores.combined - a.scores.combined ||
            (b.thought.createdAt ?? "").localeCompare(a.thought.createdAt ?? "") ||
            a.thought.id.localeCompare(b.thought.id),
        )
        .slice(0, query.limit ?? DEFAULT_LIMIT);
    });
  }

  /** Memory links per thought ID for this scope (rebuild support). */
  private async memoryLinksByThought(
    tenantId: string,
    userId: string,
  ): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (this.deps.memories === undefined) return map;
    const memories = await this.deps.memories.listMemories(tenantId, userId);
    for (const memory of memories) {
      for (const source of memory.sources) {
        if (source.kind !== "thought") continue;
        const list = map.get(source.id) ?? [];
        list.push(memory.id);
        map.set(source.id, list);
      }
    }
    for (const list of map.values()) list.sort();
    return map;
  }
}
