/**
 * Retrieval stage scorer (Specification 4.2): relevance (hit@k),
 * grounded-answer citation validity, abstention, and stale-result
 * handling — over the 22-case golden set wired from Phase 3 plus the
 * inline staleness cases added in 4.1.
 *
 * Metrics (documented in METRIC_DOCS):
 *   - retrieval.hit_at_k: positive cases pass when a relevant thought
 *     ranks in the top k (k from the dataset's metric label, default 3);
 *     negative cases (relevant: []) pass when no hit is returned.
 *   - retrieval.citation_validity: synthesized answers whose every claim
 *     cites live hits (verifyAnswer). Skipped — not failed — when no
 *     answer generator is configured (offline runs).
 *   - retrieval.abstention_correct: negative cases return zero hits, and
 *     (live) the synthesizer abstains.
 *   - retrieval.stale_excluded: after a fixture deletion, the deleted
 *     thought never appears in hits (deleted content cannot resurface,
 *     SR-3 in Spec 3.3).
 *
 * The index is rebuilt after any staleness case so cases stay independent
 * (rebuild is deterministic — Spec 3.1 FR-3).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnswerGenerator, Bucket, BucketStore, Thought } from "@donna/core";
import {
  AnswerSynthesizer,
  HybridRetriever,
  LocalRetrievalIndex,
  type HybridRankingConfig,
} from "@donna/retrieval";
import type { LoadedCase, LoadedDataset } from "../datasets.js";
import type { StageContext, StageScorer } from "../harness.js";
import type { CaseOutcome } from "../report.js";

interface RetrievalFixtures {
  now: string;
  metric?: string;
  successBar?: number;
  fixtures: {
    buckets: Array<{ id: string; name: string; centroid: number[] }>;
    thoughts: Array<{
      id: string;
      text: string;
      bucketId: string;
      createdAt: string;
      embedding: number[];
      task?: { title: string; assigneeHint?: string };
    }>;
  };
}

interface RetrievalCasePayload {
  query: string;
  embedding?: number[];
  filters?: {
    bucketIds?: string[];
    createdFrom?: string;
    createdTo?: string;
    hasTask?: boolean;
    people?: string[];
  };
  sessionContext?: string[];
  relevant: string[];
  /** Staleness cases: thoughts deleted from the index before querying. */
  deleteBeforeQuery?: string[];
  /** Staleness cases: thought IDs that must never appear in hits. */
  mustNotHit?: string[];
}

class FixtureBucketStore implements BucketStore {
  buckets: Bucket[] = [];
  items: Array<{ thought: Thought; bucketId: string }> = [];
  async listBuckets(): Promise<Bucket[]> {
    return this.buckets;
  }
  async getBucketByName(_t: string, _u: string, name: string) {
    return this.buckets.find((b) => b.name === name);
  }
  async createBucket(bucket: Bucket): Promise<Bucket> {
    this.buckets.push(bucket);
    return bucket;
  }
  async updateBucketStats(): Promise<void> {}
  async saveItem(item: { thought: Thought; bucketId: string }): Promise<void> {
    this.items.push(item);
  }
  async listItems() {
    return this.items;
  }
  async getItem(_t: string, _u: string, thoughtId: string) {
    return this.items.find((item) => item.thought.id === thoughtId);
  }
  async listItemsByBucket(_t: string, _u: string, bucketId: string) {
    return this.items.filter((item) => item.bucketId === bucketId);
  }
  async listItemsInRange(_t: string, _u: string, range: { from?: string; to?: string }) {
    return this.items.filter((item) => {
      const createdAt = item.thought.createdAt;
      if (createdAt === undefined) return false;
      if (range.from !== undefined && createdAt < range.from) return false;
      if (range.to !== undefined && createdAt > range.to) return false;
      return true;
    });
  }
  async deleteItemsForCapture() {
    return { removed: 0 };
  }
  async moveItem(): Promise<void> {}
  async renameBucket(): Promise<void> {}
  async mergeBuckets(): Promise<void> {}
  async updateItem(): Promise<void> {}
}

export interface RetrievalScorerOptions {
  ranking: HybridRankingConfig;
  /** When configured (live), grounded-answer citation validity is scored. */
  answerGenerator?: AnswerGenerator;
}

export function createRetrievalScorer(options: RetrievalScorerOptions): StageScorer {
  let retriever: HybridRetriever | undefined;
  let index: LocalRetrievalIndex | undefined;
  let dataDir: string | undefined;
  let scopeRef: { tenantId: string; userId: string } | undefined;
  let hitK = 3;
  const synthesizer = new AnswerSynthesizer(
    options.answerGenerator !== undefined ? { generator: options.answerGenerator } : {},
  );

  return {
    stage: "retrieval",

    async setup(context: StageContext, dataset: LoadedDataset) {
      const extras = dataset.extras as unknown as RetrievalFixtures;
      const fixtures = extras.fixtures;
      const kMatch = /hit@(\d+)/.exec(extras.metric ?? "");
      hitK = kMatch !== null ? Number(kMatch[1]) : 3;
      scopeRef = context.scope;
      dataDir = await mkdtemp(join(context.scratchDir, "retrieval-"));
      const store = new FixtureBucketStore();
      for (const b of fixtures.buckets) {
        store.buckets.push({
          id: b.id,
          tenantId: context.scope.tenantId,
          userId: context.scope.userId,
          name: b.name,
          description: `${b.name} bucket`,
          centroid: b.centroid,
          itemCount: 0,
          createdAt: "2026-08-01T00:00:00.000Z",
          origin: "auto",
        });
      }
      index = new LocalRetrievalIndex({ dataDir, store });
      for (const t of fixtures.thoughts) {
        const thought: Thought = {
          id: t.id,
          tenantId: context.scope.tenantId,
          userId: context.scope.userId,
          summary: t.text,
          text: t.text,
          confidence: 0.9,
          ...(t.task !== undefined ? { task: t.task } : {}),
          provenance: {
            captureId: `cap-${t.id}`,
            segmentIds: ["seg-0"],
            sourceText: t.text,
            startSec: 0,
            endSec: 1,
          },
          versions: { organizerModel: "eval", organizeSchemaVersion: "s", organizePromptVersion: "p" },
          embedding: t.embedding,
          createdAt: t.createdAt,
        };
        const item = { thought, bucketId: t.bucketId };
        store.items.push(item);
        await index.indexItem(item, store.buckets.find((b) => b.id === t.bucketId)!);
      }
      retriever = new HybridRetriever({
        index,
        buckets: store,
        config: options.ranking,
        now: () => new Date(extras.now),
      });
    },

    async score(testCase: LoadedCase, context: StageContext): Promise<CaseOutcome[]> {
      const payload = testCase.payload as unknown as RetrievalCasePayload;
      if (retriever === undefined || index === undefined || scopeRef === undefined) {
        return [{
          caseId: testCase.id,
          scores: {},
          hardFailures: [],
          error: { class: "product", token: "retrieval-setup-missing" },
        }];
      }
      const started = Date.now();
      const notes: string[] = [];

      // Staleness setup: delete fixture thoughts before querying.
      const deleted = payload.deleteBeforeQuery ?? [];
      for (const thoughtId of deleted) {
        await index.removeThought(context.scope.tenantId, context.scope.userId, thoughtId);
      }
      try {
        const hits = await retriever.search(context.scope, {
          text: payload.query,
          ...(payload.embedding !== undefined ? { embedding: payload.embedding } : {}),
          ...(payload.filters !== undefined ? { filters: payload.filters } : {}),
          ...(payload.sessionContext !== undefined
            ? { sessionContext: payload.sessionContext }
            : {}),
          limit: hitK,
        });
        const hitIds = hits.map((hit) => hit.thought.id);

        const scores: Record<string, number> = {};
        const isNegative = payload.relevant.length === 0 && (payload.mustNotHit ?? []).length === 0;
        const hitPass =
          payload.relevant.length === 0
            ? (payload.mustNotHit ?? []).length > 0
              ? true // staleness cases score under stale_excluded below
              : hitIds.length === 0
            : hitIds.some((id) => payload.relevant.includes(id));
        scores["retrieval.hit_at_k"] = hitPass ? 1 : 0;

        if (isNegative) {
          scores["retrieval.abstention_correct"] = hitIds.length === 0 ? 1 : 0;
        }

        const mustNotHit = payload.mustNotHit ?? [];
        if (mustNotHit.length > 0) {
          const leaked = mustNotHit.filter((id) => hitIds.includes(id));
          scores["retrieval.stale_excluded"] = leaked.length === 0 ? 1 : 0;
          if (leaked.length > 0) notes.push(`stale-hits:${leaked.length}`);
        }

        // Grounded-answer citation validity (live only; skipped offline).
        // An abstention is not an answer: citation_validity scores only
        // actual answers, while abstention_correct scores whether the
        // model abstained exactly when it should (no hits → abstain;
        // hits → answer).
        if (options.answerGenerator !== undefined) {
          const answer = await synthesizer.answer(payload.query, hits);
          if (answer !== undefined) {
            const abstained = answer.failureReason === "model-abstained";
            if (hits.length === 0) {
              scores["retrieval.abstention_correct"] = abstained ? 1 : 0;
            } else if (abstained) {
              scores["retrieval.abstention_correct"] = 0;
              notes.push("answer:over-abstained");
            } else {
              scores["retrieval.abstention_correct"] = 1;
              scores["retrieval.citation_validity"] = answer.supported ? 1 : 0;
              if (!answer.supported) notes.push(`answer:${answer.failureReason ?? "unknown"}`);
            }
          }
        }

        return [{ caseId: testCase.id, scores, hardFailures: [], latencyMs: Date.now() - started, ...(notes.length > 0 ? { notes } : {}) }];
      } catch {
        return [{
          caseId: testCase.id,
          scores: {},
          hardFailures: [],
          error: { class: "product", token: "retrieval-query-failed" },
          latencyMs: Date.now() - started,
        }];
      } finally {
        // Restore fixture state so cases stay independent (deterministic
        // rebuild, Spec 3.1 FR-3).
        if (deleted.length > 0 && index !== undefined && scopeRef !== undefined) {
          await index.rebuild(scopeRef.tenantId, scopeRef.userId);
        }
      }
    },

    async teardown() {
      if (dataDir !== undefined) {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  };
}
