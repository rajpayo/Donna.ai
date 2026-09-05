import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Bucket,
  BucketStore,
  Capture,
  CaptureRecord,
  CaptureStore,
  Embedder,
  EmotionalContext,
  OrganizeOutput,
  Organizer,
  SessionContext,
  Thought,
  Transcriber,
  Transcript,
  TranscriptRecord,
  TranscriptStore,
} from "@donna/core";
import { DonnaPipeline } from "./run.js";

class MemStores implements CaptureStore, TranscriptStore, BucketStore {
  captures: CaptureRecord[] = [];
  transcripts: TranscriptRecord[] = [];
  buckets: Bucket[] = [];
  items: Array<{ thought: Thought; bucketId: string }> = [];

  async saveCapture(record: CaptureRecord): Promise<void> {
    this.captures.push(record);
  }
  async getCapture(t: string, u: string, id: string) {
    return this.captures.find(
      (c) => c.tenantId === t && c.userId === u && c.id === id,
    );
  }
  async listCaptures(t: string, u: string) {
    return this.captures.filter((c) => c.tenantId === t && c.userId === u);
  }
  async markAudioDeleted(): Promise<void> {}
  async deleteCapture(): Promise<void> {}
  async saveTranscript(record: TranscriptRecord): Promise<void> {
    this.transcripts.push(record);
  }
  async getTranscript(t: string, u: string, captureId: string) {
    return this.transcripts.find(
      (r) => r.tenantId === t && r.userId === u && r.captureId === captureId,
    );
  }
  async deleteTranscript(): Promise<void> {}
  async listBuckets(t: string, u: string): Promise<Bucket[]> {
    return this.buckets.filter((b) => b.tenantId === t && b.userId === u);
  }
  async getBucketById(t: string, u: string, bucketId: string) {
    return this.buckets.find((b) => b.tenantId === t && b.userId === u && b.id === bucketId);
  }
  async getBucketByName(_t: string, _u: string, name: string) {
    return this.buckets.find((b) => b.name === name);
  }
  async createBucket(bucket: Bucket): Promise<Bucket> {
    this.buckets.push(bucket);
    return bucket;
  }
  async updateBucketStats(_t: string, _u: string, id: string, centroid: number[], itemCount: number) {
    const b = this.buckets.find((x) => x.id === id);
    if (b) {
      b.centroid = centroid;
      b.itemCount = itemCount;
    }
  }
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
  async listItemsInRange(
    _t: string,
    _u: string,
    range: { from?: string; to?: string },
  ) {
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

const TRANSCRIPT: Transcript = {
  captureId: "cap-1",
  text: "the metrics dashboard is late again and that is annoying.",
  segments: [
    { id: "seg-0", text: "the metrics dashboard is late again and that is annoying.", startSec: 0, endSec: 3 },
  ],
  model: "test",
};

const OUTPUT: OrganizeOutput = {
  thoughts: [
    {
      summary: "Metrics dashboard is late",
      text: "the metrics dashboard is late again",
      confidence: 0.9,
      newBucketName: "Metrics",
      newBucketDescription: "metrics things",
      provenance: {
        segmentIds: ["seg-0"],
        sourceText: "x",
        startSec: 0,
        endSec: 3,
      },
    },
  ],
};

function stubEmbedder(): Embedder {
  return {
    modelId: "test-embedder",
    dimensions: 2,
    embed: async (texts: string[]) => texts.map(() => [1, 0]),
  };
}

async function makeCapture(dir: string, withSession: boolean): Promise<Capture> {
  const audioPath = join(dir, "audio.bin");
  await writeFile(audioPath, Buffer.from([1, 2, 3]));
  return {
    id: "cap-1",
    tenantId: "tenant-a",
    userId: "user-1",
    audioPath,
    capturedAt: "2026-09-03T10:00:00.000Z",
    ...(withSession
      ? { session: { id: "sess-1", expiresAt: "2026-09-03T14:00:00.000Z" } }
      : {}),
  };
}

describe("DonnaPipeline session emotion context (Spec 2.4)", () => {
  it("adds a tentative prompt note and review bias — never changes placement (SR-2)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "donna-emo-run-"));
    try {
      const seenSession: Array<SessionContext | undefined> = [];
      const organizer: Organizer = {
        modelId: "stub-organizer",
        organize: async (_t, _b, _c, session) => {
          seenSession.push(session);
          return OUTPUT;
        },
      };
      const emotionalContext: EmotionalContext = {
        analyzeAndStore: async () => ({
          note: "Tentative session guess: the speaker may be frustrated.",
          reviewPriority: 0.55,
          abstained: false,
        }),
      };
      const stores = new MemStores();
      const pipeline = new DonnaPipeline({
        transcriber: { modelId: "stub-stt", transcribe: async () => TRANSCRIPT },
        organizer,
        embedder: stubEmbedder(),
        store: stores,
        captures: stores,
        transcripts: stores,
        bucketTuning: { assign_threshold: 0.82, create_threshold: 0.65 },
        emotionalContext,
      });
      const result = await pipeline.run(await makeCapture(dir, true));

      // The organizer received the tentative session note.
      assert.equal(seenSession.length, 1);
      assert.ok(seenSession[0]?.note?.includes("may be frustrated"));
      // Review priority was applied...
      assert.equal(result.items[0]?.needsReview, true);
      // ...but placement was untouched: the thought still lands in the
      // bucket the engine chose.
      assert.equal(result.items[0]?.bucket.name, "Metrics");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does nothing without a session binding", async () => {
    const dir = await mkdtemp(join(tmpdir(), "donna-emo-run-"));
    try {
      let called = 0;
      const emotionalContext: EmotionalContext = {
        analyzeAndStore: async () => {
          called += 1;
          return { reviewPriority: 0.9, abstained: false };
        },
      };
      const stores = new MemStores();
      const pipeline = new DonnaPipeline({
        transcriber: { modelId: "stub-stt", transcribe: async () => TRANSCRIPT },
        organizer: { modelId: "stub-organizer", organize: async () => OUTPUT },
        embedder: stubEmbedder(),
        store: stores,
        captures: stores,
        transcripts: stores,
        bucketTuning: { assign_threshold: 0.82, create_threshold: 0.65 },
        emotionalContext,
      });
      const result = await pipeline.run(await makeCapture(dir, false));
      assert.equal(called, 0);
      assert.equal(result.items[0]?.needsReview, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the core loop functional when emotion analysis fails or is disabled (AC-4)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "donna-emo-run-"));
    try {
      const stores = new MemStores();
      const pipeline = new DonnaPipeline({
        transcriber: { modelId: "stub-stt", transcribe: async () => TRANSCRIPT },
        organizer: { modelId: "stub-organizer", organize: async () => OUTPUT },
        embedder: stubEmbedder(),
        store: stores,
        captures: stores,
        transcripts: stores,
        bucketTuning: { assign_threshold: 0.82, create_threshold: 0.65 },
        emotionalContext: {
          analyzeAndStore: async () => {
            throw new Error("session store down");
          },
        },
      });
      const result = await pipeline.run(await makeCapture(dir, true));
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0]?.needsReview, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
