/**
 * Deterministic local retrieval index (Specification 3.1).
 *
 * A file-backed read model — one JSON file per user under DONNA_DATA_DIR:
 *
 *   <dataDir>/<tenant>/<user>/retrieval-index.v1.json
 *
 * The bucket store remains the source of truth. This projection is
 * disposable: `rebuild` re-derives it from the scoped source records, so
 * corrupt or stale index state is recovered by rebuilding, never by
 * trusting the index (SR-3). Indexing is idempotent per thought ID —
 * re-indexing a thought replaces its entry, so duplicate indexing cannot
 * produce duplicate hits.
 *
 * Isolation (SR-1): the index file lives inside the tenant/user
 * partition directory with the same identifier validation as the other
 * file stores, and every loaded entry is scope-checked against its
 * partition — a foreign record fails closed. There is no cross-scope
 * operation anywhere on the port.
 *
 * Logging (SR-2): this adapter never logs; callers log timing and hit
 * counts only, never query or result text.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  Bucket,
  BucketStore,
  MemoryStore,
  RetrievalFilters,
  RetrievalHit,
  RetrievalIndex,
  RetrievalQuery,
  Thought,
} from "@donna/core";
import {
  combinedScore,
  LOCAL_SCORE_VERSION,
  semanticScore,
  textScore,
  tokenize,
} from "./scoring.js";

const PARTITION_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

function assertPartitionId(kind: "tenant" | "user", value: string): void {
  if (!PARTITION_ID.test(value)) {
    throw new Error(`Invalid ${kind} ID for file-backed storage`);
  }
}

const INDEX_SCHEMA = "donna.retrieval-index.v1";
const DEFAULT_LIMIT = 20;

/**
 * One denormalized index entry: the full thought (including provenance
 * and embedding) plus precomputed retrieval fields. This is a projection
 * — rebuild regenerates it from the source-of-truth records.
 */
export interface IndexEntry {
  thought: Thought;
  bucketId: string;
  bucketName: string;
  /** Normalized tokens of summary + text (full-text signal). */
  tokens: string[];
  /** Lowercased people hints (task assignee). */
  people: string[];
  /** IDs of memory records that link to this thought. */
  memoryIds: string[];
}

interface IndexFile {
  schema: typeof INDEX_SCHEMA;
  entries: IndexEntry[];
}

export interface LocalRetrievalIndexDeps {
  dataDir: string;
  /** Source of truth, used by rebuild. */
  store: BucketStore;
  /**
   * When present, memory links are indexed: a memory whose sources name
   * a thought makes that thought discoverable via the memoryIds filter.
   */
  memories?: Pick<MemoryStore, "listMemories">;
}

export class LocalRetrievalIndex implements RetrievalIndex {
  constructor(private readonly deps: LocalRetrievalIndexDeps) {}

  private fileFor(tenantId: string, userId: string): string {
    assertPartitionId("tenant", tenantId);
    assertPartitionId("user", userId);
    return join(this.deps.dataDir, tenantId, userId, "retrieval-index.v1.json");
  }

  private async load(tenantId: string, userId: string): Promise<IndexFile> {
    const file = this.fileFor(tenantId, userId);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return { schema: INDEX_SCHEMA, entries: [] };
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as Partial<IndexFile>;
    if (parsed.schema !== INDEX_SCHEMA || !Array.isArray(parsed.entries)) {
      // SR-3: corrupt index state is never trusted. Rebuild recovers.
      throw new Error(
        "Invalid retrieval index data — discard and rebuild from the source records (donna reindex)",
      );
    }
    for (const entry of parsed.entries) {
      if (
        entry.thought.tenantId !== tenantId ||
        entry.thought.userId !== userId
      ) {
        throw new Error(
          "Stored retrieval index does not match its tenant/user partition",
        );
      }
    }
    return parsed as IndexFile;
  }

  private async save(
    tenantId: string,
    userId: string,
    data: IndexFile,
  ): Promise<void> {
    const file = this.fileFor(tenantId, userId);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    // Entries are stored sorted by thought ID so a rebuild over unchanged
    // source records produces a byte-identical index (FR-3).
    const ordered = [...data.entries].sort((a, b) =>
      a.thought.id.localeCompare(b.thought.id),
    );
    await writeFile(
      file,
      JSON.stringify({ schema: INDEX_SCHEMA, entries: ordered }, null, 2),
      { mode: 0o600 },
    );
  }

  /** Memory records linking to this thought (empty without a memory store). */
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

  private async toEntry(
    item: { thought: Thought; bucketId: string },
    bucket: Bucket,
  ): Promise<IndexEntry> {
    if (
      bucket.tenantId !== item.thought.tenantId ||
      bucket.userId !== item.thought.userId
    ) {
      throw new Error("Bucket scope does not match thought scope");
    }
    const people: string[] = [];
    if (item.thought.task?.assigneeHint !== undefined) {
      people.push(item.thought.task.assigneeHint.trim().toLowerCase());
    }
    return {
      thought: item.thought,
      bucketId: item.bucketId,
      bucketName: bucket.name,
      tokens: [...tokenize(`${item.thought.summary} ${item.thought.text}`)],
      people,
      memoryIds: await this.linkedMemoryIds(item.thought),
    };
  }

  async indexItem(
    item: { thought: Thought; bucketId: string },
    bucket: Bucket,
  ): Promise<void> {
    const { tenantId, userId } = item.thought;
    const data = await this.load(tenantId, userId);
    const entry = await this.toEntry(item, bucket);
    // Idempotent upsert: re-indexing replaces the existing entry.
    data.entries = [
      ...data.entries.filter((candidate) => candidate.thought.id !== entry.thought.id),
      entry,
    ];
    await this.save(tenantId, userId, data);
  }

  async removeThought(
    tenantId: string,
    userId: string,
    thoughtId: string,
  ): Promise<boolean> {
    const data = await this.load(tenantId, userId);
    const kept = data.entries.filter(
      (entry) => entry.thought.id !== thoughtId,
    );
    if (kept.length === data.entries.length) return false;
    data.entries = kept;
    await this.save(tenantId, userId, data);
    return true;
  }

  async removeCapture(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<{ removed: number }> {
    const data = await this.load(tenantId, userId);
    const kept = data.entries.filter(
      (entry) => entry.thought.provenance.captureId !== captureId,
    );
    const removed = data.entries.length - kept.length;
    if (removed === 0) return { removed: 0 };
    data.entries = kept;
    await this.save(tenantId, userId, data);
    return { removed };
  }

  async rebuild(
    tenantId: string,
    userId: string,
  ): Promise<{ indexed: number }> {
    // SR-3: rebuild reads ONLY the scoped source-of-truth records — the
    // existing index file is never consulted, so corruption cannot
    // propagate into the rebuilt state.
    const [items, buckets] = await Promise.all([
      this.deps.store.listItems(tenantId, userId),
      this.deps.store.listBuckets(tenantId, userId),
    ]);
    const bucketsById = new Map(buckets.map((bucket) => [bucket.id, bucket]));
    const entries: IndexEntry[] = [];
    for (const item of items) {
      const bucket = bucketsById.get(item.bucketId);
      if (bucket === undefined) {
        throw new Error(
          "Source records reference a bucket missing from the scoped store",
        );
      }
      entries.push(await this.toEntry(item, bucket));
    }
    await this.save(tenantId, userId, { schema: INDEX_SCHEMA, entries });
    return { indexed: entries.length };
  }

  async search(query: RetrievalQuery): Promise<RetrievalHit[]> {
    const { tenantId, userId } = query;
    const data = await this.load(tenantId, userId);
    const filtered = data.entries.filter((entry) =>
      matchesFilters(entry, query.filters),
    );

    const hasText = query.text !== undefined && tokenize(query.text).size > 0;
    const hasSemantic = query.embedding !== undefined;
    const queryTokens = hasText ? tokenize(query.text!) : new Set<string>();

    const hits: RetrievalHit[] = filtered.map((entry) => {
      const text = textScore(queryTokens, new Set(entry.tokens));
      const semantic = semanticScore(query.embedding, entry.thought.embedding);
      return {
        thought: entry.thought,
        bucketId: entry.bucketId,
        bucketName: entry.bucketName,
        scores: {
          text,
          semantic,
          combined: combinedScore(hasText, hasSemantic, text, semantic),
        },
        scoreVersion: LOCAL_SCORE_VERSION,
      };
    });

    // A scored query returns only actual matches; browse mode (no text,
    // no embedding) returns the whole filtered partition.
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
  }
}

/** Every filter is ANDed; all run inside the already-scoped partition. */
function matchesFilters(
  entry: IndexEntry,
  filters: RetrievalFilters | undefined,
): boolean {
  if (filters === undefined) return true;
  if (
    filters.bucketIds !== undefined &&
    !filters.bucketIds.includes(entry.bucketId)
  ) {
    return false;
  }
  if (filters.createdFrom !== undefined || filters.createdTo !== undefined) {
    const createdAt = entry.thought.createdAt;
    // Fail closed: no creation time → cannot be proven in range.
    if (createdAt === undefined) return false;
    if (filters.createdFrom !== undefined && createdAt < filters.createdFrom) {
      return false;
    }
    if (filters.createdTo !== undefined && createdAt > filters.createdTo) {
      return false;
    }
  }
  if (filters.hasTask === true && entry.thought.task === undefined) {
    return false;
  }
  if (filters.people !== undefined && filters.people.length > 0) {
    const haystack =
      `${entry.people.join(" ")} ${entry.thought.summary} ${entry.thought.text}`.toLowerCase();
    const matched = filters.people.some((person) =>
      haystack.includes(person.trim().toLowerCase()),
    );
    if (!matched) return false;
  }
  if (filters.memoryIds !== undefined && filters.memoryIds.length > 0) {
    const matched = filters.memoryIds.some((id) =>
      entry.memoryIds.includes(id),
    );
    if (!matched) return false;
  }
  return true;
}
