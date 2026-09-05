import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  Bucket,
  CorrectionEvent,
  Embedder,
  Thought,
} from "@donna/core";
import { HybridRetriever, DEFAULT_HYBRID_CONFIG } from "./hybrid-search.js";
import { LocalRetrievalIndex } from "./local-index.js";

/* ---------- fixtures ---------- */

const SCOPE = { tenantId: "t", userId: "u" };
const NOW = new Date("2026-09-03T12:00:00.000Z");

function bucket(id: string, name: string, centroid: number[]): Bucket {
  return {
    id,
    tenantId: SCOPE.tenantId,
    userId: SCOPE.userId,
    name,
    description: `${name} bucket`,
    centroid,
    itemCount: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    origin: "auto",
  };
}

function thought(
  id: string,
  text: string,
  embedding: number[],
  createdAt: string,
  extra?: Partial<Thought>,
): Thought {
  return {
    id,
    tenantId: SCOPE.tenantId,
    userId: SCOPE.userId,
    summary: extra?.summary ?? text,
    text,
    confidence: 0.9,
    provenance: {
      captureId: `cap-${id}`,
      segmentIds: ["seg-0"],
      sourceText: text,
      startSec: 0,
      endSec: 1,
    },
    versions: {
      organizerModel: "test",
      organizeSchemaVersion: "s",
      organizePromptVersion: "p",
    },
    embedding,
    createdAt,
    ...extra,
  };
}

/** Deterministic stub embedder: keyword-seeded unit vectors. */
function stubEmbedder(vectors: Record<string, number[]>): Embedder {
  return {
    modelId: "stub-embedder",
    dimensions: 3,
    embed: async (texts: string[]) =>
      texts.map((text) => {
        for (const [key, vector] of Object.entries(vectors)) {
          if (text.toLowerCase().includes(key)) return vector;
        }
        return [0, 0, 0];
      }),
  };
}

class MemBucketStore {
  buckets: Bucket[] = [];
  items: Array<{ thought: Thought; bucketId: string }> = [];
  async listBuckets(): Promise<Bucket[]> {
    return this.buckets;
  }
  async listItems() {
    return this.items;
  }
}

async function withRetriever(
  fn: (ctx: {
    retriever: HybridRetriever;
    store: MemBucketStore;
    index: LocalRetrievalIndex;
  }) => Promise<void>,
  options: {
    embedder?: Embedder;
    corrections?: CorrectionEvent[];
    config?: typeof DEFAULT_HYBRID_CONFIG;
  } = {},
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "donna-hybrid-"));
  try {
    const store = new MemBucketStore();
    const index = new LocalRetrievalIndex({
      dataDir,
      store: store as never,
    });
    const retriever = new HybridRetriever({
      index,
      buckets: store as never,
      ...(options.corrections !== undefined
        ? {
            corrections: {
              listAccepted: async () => options.corrections!,
            },
          }
        : {}),
      ...(options.embedder !== undefined ? { embedder: options.embedder } : {}),
      config: options.config ?? DEFAULT_HYBRID_CONFIG,
      now: () => NOW,
    });
    await fn({ retriever, store, index });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function seed(
  store: MemBucketStore,
  index: LocalRetrievalIndex,
): Promise<void> {
  store.buckets.push(
    bucket("b-hiring", "Hiring", [1, 0, 0]),
    bucket("b-errands", "Errands", [0, 0, 1]),
  );
  const items = [
    {
      thought: thought(
        "th-old",
        "interview feedback for the backend candidate",
        [1, 0, 0],
        "2026-07-15T10:00:00.000Z", // ~50 days old at NOW
      ),
      bucketId: "b-hiring",
    },
    {
      thought: thought(
        "th-new",
        "onboarding plan for the new analyst hire",
        [0.95, 0.05, 0],
        "2026-09-03T09:00:00.000Z", // 3 hours old at NOW
      ),
      bucketId: "b-hiring",
    },
    {
      thought: thought(
        "th-task",
        "buy the team offsite groceries",
        [0, 0, 1],
        "2026-09-02T10:00:00.000Z",
        { task: { title: "Buy groceries", assigneeHint: "Meera" } },
      ),
      bucketId: "b-errands",
    },
  ];
  for (const item of items) {
    store.items.push(item);
    await index.indexItem(
      item,
      store.buckets.find((b) => b.id === item.bucketId)!,
    );
  }
}

/* ---------- tests ---------- */

describe("HybridRetriever — hybrid ranking (FR-1, FR-3)", () => {
  it("combines text, semantic, bucket affinity, recency and reports features", async () => {
    await withRetriever(
      async ({ retriever, store, index }) => {
        await seed(store, index);
        const hits = await retriever.search(SCOPE, {
          text: "onboarding hire",
          embedding: [0.95, 0.05, 0],
        });
        assert.ok(hits.length >= 2);
        const top = hits[0]!;
        assert.equal(top.thought.id, "th-new");
        // FR-3: every feature and weight is exposed on the hit.
        assert.equal(top.rankingVersion, "donna.hybrid-ranking.v1");
        assert.ok(top.features.text > 0);
        assert.ok(top.features.semantic > 0.9);
        assert.ok(top.features.bucketAffinity > 0.9);
        assert.ok(top.features.recency > 0.9); // 3 hours old
        assert.deepEqual(top.weights, DEFAULT_HYBRID_CONFIG.weights);
        // The older hiring thought loses on recency.
        const older = hits.find((h) => h.thought.id === "th-old")!;
        assert.ok(older.features.recency < 0.4); // ~50 days, 30-day half-life
      },
      { embedder: stubEmbedder({}) },
    );
  });

  it("taskMatch boosts task-bearing thoughts for task-intent queries", async () => {
    await withRetriever(async ({ retriever, store, index }) => {
      await seed(store, index);
      const hits = await retriever.search(SCOPE, {
        text: "what tasks are due",
        embedding: [0, 0, 1],
      });
      const taskHit = hits.find((h) => h.thought.id === "th-task")!;
      assert.equal(taskHit.features.taskMatch, 1);
      // A non-task-intent query leaves the feature at 0.
      const plain = await retriever.search(SCOPE, {
        text: "groceries offsite",
        embedding: [0, 0, 1],
      });
      assert.equal(plain[0]!.features.taskMatch, 0);
    });
  });

  it("personalization: an accepted correction boosts its preferred bucket", async () => {
    const correction: CorrectionEvent = {
      id: "cor-1",
      tenantId: SCOPE.tenantId,
      userId: SCOPE.userId,
      type: "bucket.move",
      createdAt: "2026-09-01T00:00:00.000Z",
      target: { kind: "thought", id: "th-x" },
      payload: {
        toBucketId: "b-hiring",
        toBucketName: "Hiring",
        thoughtSummary: "onboarding plan for the new analyst hire",
      },
      sources: [{ kind: "thought", id: "th-x", reason: "test" }],
      status: "accepted",
      followedCount: 0,
      contradictedCount: 0,
    };
    await withRetriever(
      async ({ retriever, store, index }) => {
        await seed(store, index);
        const hits = await retriever.search(SCOPE, {
          text: "analyst onboarding",
        });
        const boosted = hits.find((h) => h.thought.id === "th-new")!;
        assert.equal(boosted.features.personalization, 1);
        // A hit in a different bucket gets no personalization signal.
        const other = hits.find((h) => h.thought.id === "th-task");
        if (other !== undefined) {
          assert.equal(other.features.personalization, 0);
        }
      },
      { corrections: [correction] },
    );
  });

  it("ranking is deterministic and weight-driven (reportable)", async () => {
    await withRetriever(async ({ retriever, store, index }) => {
      await seed(store, index);
      const first = await retriever.search(SCOPE, { text: "the", embedding: [0.6, 0.1, 0.6] });
      const second = await retriever.search(SCOPE, { text: "the", embedding: [0.6, 0.1, 0.6] });
      assert.deepEqual(
        first.map((h) => h.thought.id),
        second.map((h) => h.thought.id),
      );
      // The combined score equals the documented weighted sum.
      for (const hit of first) {
        const w = hit.weights;
        const f = hit.features;
        const expected =
          w.text * f.text +
          w.semantic * f.semantic +
          w.bucketAffinity * f.bucketAffinity +
          w.recency * f.recency +
          w.personalization * f.personalization +
          w.taskMatch * f.taskMatch;
        assert.ok(Math.abs(hit.scores.combined - expected) < 1e-9);
      }
      const description = retriever.describeRanking();
      assert.equal(description.version, "donna.hybrid-ranking.v1");
    });
  });

  it("filters apply before ranking (SR-2): bucket and person filters", async () => {
    await withRetriever(async ({ retriever, store, index }) => {
      await seed(store, index);
      const hits = await retriever.search(SCOPE, {
        text: "the",
        filters: { bucketIds: ["b-errands"] },
      });
      assert.deepEqual(hits.map((h) => h.thought.id), ["th-task"]);
      const meera = await retriever.search(SCOPE, {
        text: "the",
        filters: { people: ["meera"] },
      });
      assert.deepEqual(meera.map((h) => h.thought.id), ["th-task"]);
    });
  });

  it("cross-tenant queries return nothing (SR-1)", async () => {
    await withRetriever(async ({ retriever, store, index }) => {
      await seed(store, index);
      const hits = await retriever.search(
        { tenantId: "other-tenant", userId: "u" },
        { text: "onboarding" },
      );
      assert.equal(hits.length, 0);
    });
  });

  it("follow-up questions expand with session context when bare query misses", async () => {
    await withRetriever(async ({ retriever, store, index }) => {
      await seed(store, index);
      // "What about that?" matches nothing on its own.
      const bare = await retriever.search(SCOPE, { text: "zzzz nothing" });
      assert.equal(bare.length, 0);
      // With session context, the follow-up finds the prior topic.
      const followed = await retriever.search(SCOPE, {
        text: "zzzz nothing",
        sessionContext: ["onboarding plan for the analyst"],
      });
      assert.ok(followed.length > 0);
      assert.equal(followed[0]!.thought.id, "th-new");
    });
  });

  it("deletion propagates: a removed thought never ranks (SR-3)", async () => {
    await withRetriever(async ({ retriever, store, index }) => {
      await seed(store, index);
      await index.removeThought(SCOPE.tenantId, SCOPE.userId, "th-new");
      const hits = await retriever.search(SCOPE, { text: "onboarding analyst" });
      assert.equal(hits.find((h) => h.thought.id === "th-new"), undefined);
    });
  });
});
