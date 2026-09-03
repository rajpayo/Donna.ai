import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  Bucket,
  BucketStore,
  MemoryRecord,
  Thought,
} from "@donna/core";
import { LocalRetrievalIndex } from "./local-index.js";
import { LOCAL_SCORE_VERSION } from "./scoring.js";

/* ---------- fixtures ---------- */

const SCOPE = { tenantId: "tenant-a", userId: "user-1" };

function bucket(id: string, name: string): Bucket {
  return {
    id,
    tenantId: SCOPE.tenantId,
    userId: SCOPE.userId,
    name,
    description: `${name} bucket`,
    centroid: [1, 0],
    itemCount: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
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
      captureId: extra?.provenance?.captureId ?? `cap-${id}`,
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

/** In-memory source-of-truth store for rebuild tests. */
class MemBucketStore implements BucketStore {
  buckets: Bucket[] = [];
  items: Array<{ thought: Thought; bucketId: string }> = [];

  async listBuckets(t: string, u: string): Promise<Bucket[]> {
    return this.buckets.filter((b) => b.tenantId === t && b.userId === u);
  }
  async getBucketByName(t: string, u: string, name: string) {
    return this.buckets.find(
      (b) => b.tenantId === t && b.userId === u && b.name === name,
    );
  }
  async createBucket(b: Bucket): Promise<Bucket> {
    this.buckets.push(b);
    return b;
  }
  async updateBucketStats(): Promise<void> {}
  async saveItem(item: { thought: Thought; bucketId: string }): Promise<void> {
    this.items.push(item);
  }
  async listItems(t: string, u: string) {
    return this.items.filter(
      (item) => item.thought.tenantId === t && item.thought.userId === u,
    );
  }
  async getItem(t: string, u: string, thoughtId: string) {
    return this.items.find(
      (item) =>
        item.thought.tenantId === t &&
        item.thought.userId === u &&
        item.thought.id === thoughtId,
    );
  }
  async listItemsByBucket(t: string, u: string, bucketId: string) {
    return this.items.filter(
      (item) =>
        item.thought.tenantId === t &&
        item.thought.userId === u &&
        item.bucketId === bucketId,
    );
  }
  async listItemsInRange(t: string, u: string, range: { from?: string; to?: string }) {
    return this.items.filter((item) => {
      if (item.thought.tenantId !== t || item.thought.userId !== u) return false;
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

function memoryLinkingTo(memoryId: string, thoughtId: string): MemoryRecord {
  return {
    id: memoryId,
    tenantId: SCOPE.tenantId,
    userId: SCOPE.userId,
    layer: "episodic",
    status: "confirmed",
    origin: "explicit",
    text: `memory about ${thoughtId}`,
    kind: "fact",
    subject: `fact:${thoughtId}`,
    confidence: 1,
    sources: [{ kind: "thought", id: thoughtId, reason: "test link" }],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

async function withIndex(
  fn: (ctx: {
    index: LocalRetrievalIndex;
    store: MemBucketStore;
    dataDir: string;
  }) => Promise<void>,
  memories: MemoryRecord[] = [],
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "donna-retrieval-"));
  try {
    const store = new MemBucketStore();
    const index = new LocalRetrievalIndex({
      dataDir,
      store,
      memories: { listMemories: async () => memories },
    });
    await fn({ index, store, dataDir });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** withIndex + the standard fixture set already seeded. */
async function withStandardIndex(
  fn: (index: LocalRetrievalIndex, store: MemBucketStore) => Promise<void>,
): Promise<void> {
  await withIndex(async ({ index, store }) => {
    await seedStandard(store, index);
    await fn(index, store);
  });
}

/** Seed the source store AND the index with the standard fixture set. */
async function seedStandard(
  store: MemBucketStore,
  index: LocalRetrievalIndex,
): Promise<void> {
  const hiring = bucket("b-hiring", "Hiring");
  const errands = bucket("b-errands", "Errands");
  store.buckets.push(hiring, errands);
  const items = [
    {
      thought: thought(
        "th-1",
        "interview the backend candidate on Friday",
        [1, 0, 0],
        "2026-09-01T10:00:00.000Z",
      ),
      bucketId: "b-hiring",
    },
    {
      thought: thought(
        "th-2",
        "prepare the onboarding plan for the new hire",
        [0.9, 0.1, 0],
        "2026-09-02T10:00:00.000Z",
      ),
      bucketId: "b-hiring",
    },
    {
      thought: thought(
        "th-3",
        "pick up groceries for the team offsite",
        [0, 0, 1],
        "2026-09-03T10:00:00.000Z",
        { task: { title: "Pick up groceries", assigneeHint: "Meera" } },
      ),
      bucketId: "b-errands",
    },
  ];
  for (const item of items) {
    store.items.push(item);
    await index.indexItem(item, store.buckets.find((b) => b.id === item.bucketId)!);
  }
}

/* ---------- tests ---------- */

describe("LocalRetrievalIndex — text and semantic retrieval (AC-1)", () => {
  it("full-text query retrieves the expected fixtures with score components and provenance", async () => {
    await withIndex(async ({ index, store }) => {
      await seedStandard(store, index);
      const hits = await index.search({ ...SCOPE, text: "onboarding new hire" });
      assert.ok(hits.length > 0);
      assert.equal(hits[0]!.thought.id, "th-2");
      // FR-2: score components and provenance are exposed.
      assert.ok(hits[0]!.scores.text > 0);
      assert.equal(hits[0]!.scoreVersion, LOCAL_SCORE_VERSION);
      assert.equal(hits[0]!.thought.provenance.captureId, "cap-th-2");
      assert.deepEqual(hits[0]!.thought.provenance.segmentIds, ["seg-0"]);
      assert.equal(hits[0]!.bucketName, "Hiring");
      // Non-matching text retrieves nothing.
      assert.equal(
        (await index.search({ ...SCOPE, text: "zebra" })).length,
        0,
      );
    });
  });

  it("semantic query retrieves by cosine similarity over stored embeddings", async () => {
    await withIndex(async ({ index, store }) => {
      await seedStandard(store, index);
      // A query embedding near the hiring axis finds hiring thoughts even
      // with text that shares no tokens ("recruiting" vs fixture text).
      const hits = await index.search({
        ...SCOPE,
        text: "recruiting pipeline",
        embedding: [1, 0.05, 0],
      });
      assert.ok(hits.length >= 2);
      const ids = hits.map((h) => h.thought.id);
      assert.ok(ids.includes("th-1") && ids.includes("th-2"));
      // The hiring thoughts outrank the errands thought semantically.
      assert.ok(hits[0]!.scores.semantic > 0.9);
      assert.equal(hits[0]!.bucketName, "Hiring");
      // Pure semantic mode (no text) works too.
      const semanticOnly = await index.search({ ...SCOPE, embedding: [0, 0, 1] });
      assert.equal(semanticOnly[0]!.thought.id, "th-3");
      assert.equal(semanticOnly[0]!.scores.text, 0);
      assert.ok(semanticOnly[0]!.scores.semantic > 0.99);
    });
  });

  it("ranking is deterministic: identical queries return identical orders", async () => {
    await withStandardIndex(async (index) => {
      const first = await index.search({ ...SCOPE, text: "the", embedding: [0.7, 0.2, 0.7] });
      const second = await index.search({ ...SCOPE, text: "the", embedding: [0.7, 0.2, 0.7] });
      assert.deepEqual(
        first.map((h) => h.thought.id),
        second.map((h) => h.thought.id),
      );
    });
  });
});

describe("LocalRetrievalIndex — filters (AC-2)", () => {
  it("bucket filter restricts results to the named bucket", async () => {
    await withStandardIndex(async (index) => {
      const hits = await index.search({
        ...SCOPE,
        text: "the",
        filters: { bucketIds: ["b-errands"] },
      });
      assert.deepEqual(hits.map((h) => h.thought.id), ["th-3"]);
    });
  });

  it("time filters bound results by thought creation time", async () => {
    await withStandardIndex(async (index) => {
      const hits = await index.search({
        ...SCOPE,
        text: "the",
        filters: {
          createdFrom: "2026-09-02T00:00:00.000Z",
          createdTo: "2026-09-02T23:59:59.000Z",
        },
      });
      assert.deepEqual(hits.map((h) => h.thought.id), ["th-2"]);
    });
  });

  it("task and person filters select task-bearing thoughts by assignee hint", async () => {
    await withStandardIndex(async (index) => {
      const tasks = await index.search({
        ...SCOPE,
        text: "the",
        filters: { hasTask: true },
      });
      assert.deepEqual(tasks.map((h) => h.thought.id), ["th-3"]);

      const meera = await index.search({
        ...SCOPE,
        text: "the",
        filters: { people: ["meera"] },
      });
      assert.deepEqual(meera.map((h) => h.thought.id), ["th-3"]);

      const nobody = await index.search({
        ...SCOPE,
        text: "the",
        filters: { people: ["nobody"] },
      });
      assert.equal(nobody.length, 0);
    });
  });

  it("memory-link filter selects thoughts linked to a memory", async () => {
    await withIndex(
      async ({ index, store }) => {
        await seedStandard(store, index);
        const hits = await index.search({
          ...SCOPE,
          text: "the",
          filters: { memoryIds: ["mem-1"] },
        });
        assert.deepEqual(hits.map((h) => h.thought.id), ["th-1"]);
      },
      [memoryLinkingTo("mem-1", "th-1")],
    );
  });
});

describe("LocalRetrievalIndex — deletion, rebuild, duplicates (AC-3, FR-3, FR-4)", () => {
  it("removeThought deletes the hit; removeCapture deletes every derived hit", async () => {
    await withStandardIndex(async (index) => {
      assert.equal(await index.removeThought(SCOPE.tenantId, SCOPE.userId, "th-1"), true);
      assert.equal(await index.removeThought(SCOPE.tenantId, SCOPE.userId, "th-1"), false);
      let hits = await index.search({ ...SCOPE, text: "interview candidate" });
      assert.equal(hits.length, 0);

      // th-2 and th-3 came from different captures; removing cap-th-2
      // leaves th-3.
      const removed = await index.removeCapture(SCOPE.tenantId, SCOPE.userId, "cap-th-2");
      assert.equal(removed.removed, 1);
      hits = await index.search({ ...SCOPE, text: "onboarding" });
      assert.equal(hits.length, 0);
      hits = await index.search({ ...SCOPE, text: "groceries" });
      assert.equal(hits.length, 1);
    });
  });

  it("duplicate indexing is idempotent — one entry per thought", async () => {
    await withStandardIndex(async (index, store) => {
      const item = store.items[0]!;
      const bucket = store.buckets.find((b) => b.id === item.bucketId)!;
      await index.indexItem(item, bucket);
      await index.indexItem(item, bucket);
      const hits = await index.search({ ...SCOPE, text: "interview" });
      assert.equal(hits.length, 1);
    });
  });

  it("rebuild from the source of truth is deterministic and idempotent", async () => {
    await withIndex(async ({ index, store, dataDir }) => {
      await seedStandard(store, index);
      // Corrupt the index by removing an entry directly, then rebuild.
      await index.removeThought(SCOPE.tenantId, SCOPE.userId, "th-1");
      const first = await index.rebuild(SCOPE.tenantId, SCOPE.userId);
      assert.equal(first.indexed, 3);
      const filePath = join(dataDir, SCOPE.tenantId, SCOPE.userId, "retrieval-index.v1.json");
      const bytesAfterFirst = await readFile(filePath, "utf8");
      const second = await index.rebuild(SCOPE.tenantId, SCOPE.userId);
      assert.equal(second.indexed, 3);
      const bytesAfterSecond = await readFile(filePath, "utf8");
      assert.equal(bytesAfterFirst, bytesAfterSecond);
      // The rebuilt index serves the deleted entry again (it was only
      // deleted from the projection, not the source of truth).
      const hits = await index.search({ ...SCOPE, text: "interview" });
      assert.equal(hits.length, 1);
    });
  });

  it("corrupt index state fails closed and rebuild recovers (SR-3)", async () => {
    await withIndex(async ({ index, store, dataDir }) => {
      await seedStandard(store, index);
      const filePath = join(dataDir, SCOPE.tenantId, SCOPE.userId, "retrieval-index.v1.json");
      await writeFile(filePath, '{"schema":"bogus","entries":42}', "utf8");
      await assert.rejects(
        index.search({ ...SCOPE, text: "interview" }),
        /Invalid retrieval index data/,
      );
      const rebuilt = await index.rebuild(SCOPE.tenantId, SCOPE.userId);
      assert.equal(rebuilt.indexed, 3);
      const hits = await index.search({ ...SCOPE, text: "interview" });
      assert.equal(hits.length, 1);
    });
  });
});

describe("LocalRetrievalIndex — tenant isolation (SR-1)", () => {
  it("a query in another tenant/user partition never sees this scope's entries", async () => {
    await withStandardIndex(async (index) => {
      for (const scope of [
        { tenantId: "tenant-b", userId: SCOPE.userId },
        { tenantId: SCOPE.tenantId, userId: "user-2" },
      ]) {
        const hits = await index.search({ ...scope, text: "onboarding" });
        assert.equal(hits.length, 0);
        const browse = await index.search(scope);
        assert.equal(browse.length, 0);
      }
    });
  });

  it("rejects path-traversal partition IDs", async () => {
    await withStandardIndex(async (index) => {
      await assert.rejects(
        index.search({ tenantId: "../tenant-b", userId: "user-1", text: "x" }),
        /Invalid tenant ID/,
      );
      await assert.rejects(
        index.rebuild("tenant-a", "../user-2"),
        /Invalid user ID/,
      );
    });
  });

  it("an index file containing foreign-scope entries fails closed", async () => {
    await withIndex(async ({ index, store, dataDir }) => {
      await seedStandard(store, index);
      const filePath = join(dataDir, SCOPE.tenantId, SCOPE.userId, "retrieval-index.v1.json");
      const foreign = thought("th-x", "foreign", [1, 0, 0], "2026-09-01T00:00:00.000Z");
      foreign.tenantId = "tenant-b";
      await writeFile(
        filePath,
        JSON.stringify({
          schema: "donna.retrieval-index.v1",
          entries: [
            {
              thought: foreign,
              bucketId: "b-hiring",
              bucketName: "Hiring",
              tokens: ["foreign"],
              people: [],
              memoryIds: [],
            },
          ],
        }),
        "utf8",
      );
      await assert.rejects(
        index.search({ ...SCOPE, text: "foreign" }),
        /does not match its tenant\/user partition/,
      );
    });
  });
});

describe("LocalRetrievalIndex — browse mode and limits", () => {
  it("no text and no embedding returns the filtered partition by recency", async () => {
    await withStandardIndex(async (index) => {
      const hits = await index.search(SCOPE);
      assert.deepEqual(
        hits.map((h) => h.thought.id),
        ["th-3", "th-2", "th-1"],
      );
      assert.ok(hits.every((h) => h.scores.combined === 0));
    });
  });

  it("limit caps the result count deterministically", async () => {
    await withStandardIndex(async (index) => {
      const hits = await index.search({ ...SCOPE, text: "the", limit: 2 });
      assert.equal(hits.length, 2);
    });
  });
});
