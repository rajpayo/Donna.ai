/**
 * Golden retrieval eval (Specification 3.3, AC-1).
 *
 * Runs the labeled retrieval set (datasets/golden/retrieval.v1.json)
 * against the REAL deterministic local index and the REAL hybrid ranker,
 * configured from models.config.yaml — nothing is mocked except the
 * embedder (the dataset carries hand-crafted query/thought embeddings so
 * the eval is deterministic and offline).
 *
 * Metric: hit@3 — a positive case passes when at least one relevant
 * thought ranks in the top 3; a negative case (relevant: []) passes when
 * no hit is returned. The success bar is 80% (DECISIONS.md quality
 * gate). The report is written honestly either way.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Bucket, BucketStore, Thought } from "@donna/core";
import {
  HybridRetriever,
  LocalRetrievalIndex,
  type HybridRankingConfig,
} from "@donna/retrieval";

export interface RetrievalDataset {
  name: string;
  metric: string;
  successBar: number;
  now: string;
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
  cases: Array<{
    id: string;
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
    note?: string;
  }>;
}

export interface RetrievalEvalReport {
  dataset: string;
  metric: string;
  ranAt: string;
  total: number;
  passed: number;
  successRate: number;
  successBar: number;
  barMet: boolean;
  /** Per-case outcomes — IDs and hit IDs only, never content. */
  cases: Array<{
    id: string;
    passed: boolean;
    hitIds: string[];
    relevant: string[];
  }>;
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

const SCOPE = { tenantId: "eval-tenant", userId: "eval-user" };

export async function runRetrievalEval(options: {
  datasetPath: string;
  ranking: HybridRankingConfig;
  reportsDir?: string;
}): Promise<RetrievalEvalReport> {
  const dataset = JSON.parse(
    await readFile(options.datasetPath, "utf8"),
  ) as RetrievalDataset;
  const now = new Date(dataset.now);

  const dataDir = await mkdtemp(join(tmpdir(), "donna-retrieval-eval-"));
  try {
    const store = new FixtureBucketStore();
    for (const b of dataset.fixtures.buckets) {
      store.buckets.push({
        id: b.id,
        tenantId: SCOPE.tenantId,
        userId: SCOPE.userId,
        name: b.name,
        description: `${b.name} bucket`,
        centroid: b.centroid,
        itemCount: 0,
        createdAt: "2026-08-01T00:00:00.000Z",
        origin: "auto",
      });
    }
    const index = new LocalRetrievalIndex({ dataDir, store });
    for (const t of dataset.fixtures.thoughts) {
      const thought: Thought = {
        id: t.id,
        tenantId: SCOPE.tenantId,
        userId: SCOPE.userId,
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
        versions: {
          organizerModel: "eval",
          organizeSchemaVersion: "s",
          organizePromptVersion: "p",
        },
        embedding: t.embedding,
        createdAt: t.createdAt,
      };
      const item = { thought, bucketId: t.bucketId };
      store.items.push(item);
      await index.indexItem(
        item,
        store.buckets.find((b) => b.id === t.bucketId)!,
      );
    }

    const retriever = new HybridRetriever({
      index,
      buckets: store,
      config: options.ranking,
      now: () => now,
    });

    const cases: RetrievalEvalReport["cases"] = [];
    for (const testCase of dataset.cases) {
      const hits = await retriever.search(SCOPE, {
        text: testCase.query,
        ...(testCase.embedding !== undefined
          ? { embedding: testCase.embedding }
          : {}),
        ...(testCase.filters !== undefined ? { filters: testCase.filters } : {}),
        ...(testCase.sessionContext !== undefined
          ? { sessionContext: testCase.sessionContext }
          : {}),
        limit: 3,
      });
      const hitIds = hits.map((hit) => hit.thought.id);
      const passed =
        testCase.relevant.length === 0
          ? hitIds.length === 0
          : hitIds.some((id) => testCase.relevant.includes(id));
      cases.push({ id: testCase.id, passed, hitIds, relevant: testCase.relevant });
    }

    const passed = cases.filter((c) => c.passed).length;
    const successRate = cases.length === 0 ? 0 : passed / cases.length;
    const report: RetrievalEvalReport = {
      dataset: dataset.name,
      metric: dataset.metric,
      ranAt: new Date().toISOString(),
      total: cases.length,
      passed,
      successRate,
      successBar: dataset.successBar,
      barMet: successRate >= dataset.successBar,
      cases,
    };

    if (options.reportsDir !== undefined) {
      await mkdir(options.reportsDir, { recursive: true });
      await writeFile(
        join(options.reportsDir, `${dataset.name}-${Date.now()}.json`),
        JSON.stringify(report, null, 2),
      );
    }
    return report;
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}
