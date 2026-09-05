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
  ContextAssembler,
  ContextPacket,
  CorrectionObserver,
  Embedder,
  EventSink,
  OrganizeOutput,
  Organizer,
  Thought,
  Transcriber,
  Transcript,
  TranscriptRecord,
  TranscriptStore,
} from "@donna/core";
import { DonnaPipeline } from "./run.js";

/* Minimal in-memory stores (same contract as run.test.ts). */
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
  async moveItem(): Promise<void> {
    throw new Error("not used in context tests");
  }
  async renameBucket(): Promise<void> {
    throw new Error("not used in context tests");
  }
  async mergeBuckets(): Promise<void> {
    throw new Error("not used in context tests");
  }
  async updateItem(): Promise<void> {
    throw new Error("not used in context tests");
  }
}

const TRANSCRIPT: Transcript = {
  captureId: "cap-1",
  text: "send the deck.",
  segments: [{ id: "seg-0", text: "send the deck.", startSec: 0, endSec: 2 }],
  model: "gpt-4o-transcribe",
};

const OUTPUT: OrganizeOutput = {
  thoughts: [
    {
      summary: "Send the deck",
      text: "send the deck",
      confidence: 0.95,
      task: { title: "Send the deck" },
      provenance: {
        segmentIds: ["seg-0"],
        sourceText: "send the deck.",
        startSec: 0,
        endSec: 2,
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

function packet(): ContextPacket {
  return {
    id: "packet-1",
    tenantId: "tenant-a",
    userId: "user-1",
    createdAt: "2026-09-03T10:00:00.000Z",
    degraded: false,
    degradedReasons: [],
    elements: [
      {
        sourceId: "mem-1",
        sourceKind: "memory",
        trust: "trusted-user-settings",
        text: "Prefers short bullet summaries",
        asOf: "2026-09-01T10:00:00.000Z",
        tokens: 8,
      },
      {
        sourceId: "bucket-1",
        sourceKind: "bucket",
        trust: "untrusted-retrieved",
        text: '"Tasks": Commitments (1 items)',
        asOf: "2026-09-01T10:00:00.000Z",
        tokens: 9,
      },
    ],
    budgets: {
      maxTokens: 1200,
      maxItems: 24,
      recentCaptures: 3,
      maxMemories: 12,
      maxBucketSummaries: 10,
      maxCorrectionExamples: 3,
      maxExternalSnippets: 6,
    },
    totals: { tokens: 17, items: 2, truncated: 0 },
  };
}

async function makeCapture(dir: string): Promise<Capture> {
  const audioPath = join(dir, "audio.bin");
  await writeFile(audioPath, Buffer.from([1, 2, 3]));
  return {
    id: "cap-1",
    tenantId: "tenant-a",
    userId: "user-1",
    audioPath,
    capturedAt: "2026-09-03T10:00:00.000Z",
  };
}

describe("DonnaPipeline context assembly (Spec 2.2)", () => {
  it("hands the assembled packet to the organizer and records source IDs (FR-4)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "donna-ctx-run-"));
    try {
      const stores = new MemStores();
      const seen: Array<ContextPacket | undefined> = [];
      const organizer: Organizer = {
        modelId: "stub-organizer",
        schemaVersion: "s",
        promptVersion: "p",
        organize: async (_t, _b, context) => {
          seen.push(context);
          return OUTPUT;
        },
      };
      const events: Array<{ name: string; attrs?: Record<string, string | number | boolean> }> = [];
      const sink: EventSink = {
        emit: (e) => {
          events.push({ name: e.name, ...(e.attrs !== undefined ? { attrs: e.attrs } : {}) });
        },
      };
      const assembler: ContextAssembler = {
        assemble: async () => packet(),
      };
      const pipeline = new DonnaPipeline({
        transcriber: { modelId: "stub-stt", transcribe: async () => TRANSCRIPT },
        organizer,
        embedder: stubEmbedder(),
        store: stores,
        captures: stores,
        transcripts: stores,
        bucketTuning: { assign_threshold: 0.82, create_threshold: 0.65 },
        contextAssembler: assembler,
        events: sink,
      });
      const result = await pipeline.run(await makeCapture(dir));

      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.id, "packet-1");
      assert.deepEqual(result.context, {
        packetId: "packet-1",
        sourceIds: ["mem-1", "bucket-1"],
        degraded: false,
      });
      const telemetry = events.find((e) => e.name === "context.assembled");
      assert.ok(telemetry);
      assert.equal(telemetry.attrs?.["packetId"], "packet-1");
      assert.equal(telemetry.attrs?.["elements"], 2);
      assert.equal(telemetry.attrs?.["sourceIds"], "mem-1,bucket-1");
      // SR-3: telemetry must never carry element content.
      assert.ok(!JSON.stringify(telemetry).includes("Prefers short bullet"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still organizes in degraded mode when the assembler fails (AC-4)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "donna-ctx-run-"));
    try {
      const stores = new MemStores();
      const seen: Array<ContextPacket | undefined> = [];
      const organizer: Organizer = {
        modelId: "stub-organizer",
        organize: async (_t, _b, context) => {
          seen.push(context);
          return OUTPUT;
        },
      };
      const events: string[] = [];
      const pipeline = new DonnaPipeline({
        transcriber: { modelId: "stub-stt", transcribe: async () => TRANSCRIPT },
        organizer,
        embedder: stubEmbedder(),
        store: stores,
        captures: stores,
        transcripts: stores,
        bucketTuning: { assign_threshold: 0.82, create_threshold: 0.65 },
        contextAssembler: {
          assemble: async () => {
            throw new Error("memory store unavailable");
          },
        },
        events: { emit: (e) => events.push(e.name) },
      });
      const result = await pipeline.run(await makeCapture(dir));

      assert.equal(result.items.length, 1);
      assert.equal(result.context, undefined);
      assert.equal(seen.length, 1);
      assert.equal(seen[0], undefined);
      assert.ok(events.includes("context.degraded"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs unchanged when no assembler is configured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "donna-ctx-run-"));
    try {
      const stores = new MemStores();
      const pipeline = new DonnaPipeline({
        transcriber: { modelId: "stub-stt", transcribe: async () => TRANSCRIPT },
        organizer: {
          modelId: "stub-organizer",
          organize: async () => OUTPUT,
        },
        embedder: stubEmbedder(),
        store: stores,
        captures: stores,
        transcripts: stores,
        bucketTuning: { assign_threshold: 0.82, create_threshold: 0.65 },
      });
      const result = await pipeline.run(await makeCapture(dir));
      assert.equal(result.items.length, 1);
      assert.equal(result.context, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports placement adherence for injected correction examples (Spec 2.3)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "donna-ctx-run-"));
    try {
      const stores = new MemStores();
      const observations: Array<{
        thoughtText: string;
        placedBucketId: string;
        examples: Array<{ correctionId: string; preferredBucketId: string; text: string }>;
      }> = [];
      const observer: CorrectionObserver = {
        observePlacement: async (_scope, observation) => {
          observations.push(observation);
          return { followed: 1, contradicted: 0 };
        },
      };
      const packetWithCorrection: ContextPacket = {
        ...packet(),
        elements: [
          {
            sourceId: "corr-1",
            sourceKind: "correction",
            trust: "untrusted-retrieved",
            text: 'The user corrected: "send the deck" belongs in "Tasks"',
            asOf: "2026-09-02T10:00:00.000Z",
            tokens: 14,
            correction: { correctionId: "corr-1", preferredBucketId: "bucket-tasks" },
          },
        ],
      };
      const events: string[] = [];
      const pipeline = new DonnaPipeline({
        transcriber: { modelId: "stub-stt", transcribe: async () => TRANSCRIPT },
        organizer: { modelId: "stub-organizer", organize: async () => OUTPUT },
        embedder: stubEmbedder(),
        store: stores,
        captures: stores,
        transcripts: stores,
        bucketTuning: { assign_threshold: 0.82, create_threshold: 0.65 },
        contextAssembler: { assemble: async () => packetWithCorrection },
        correctionObserver: observer,
        events: { emit: (e) => events.push(e.name) },
      });
      const result = await pipeline.run(await makeCapture(dir));

      assert.equal(observations.length, 1);
      assert.equal(observations[0]?.thoughtText, "send the deck");
      assert.equal(observations[0]?.examples[0]?.correctionId, "corr-1");
      assert.equal(
        observations[0]?.placedBucketId,
        result.items[0]?.bucket.id,
      );
      assert.ok(events.includes("correction.adherence"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a failing adherence observer never breaks the core loop", async () => {
    const dir = await mkdtemp(join(tmpdir(), "donna-ctx-run-"));
    try {
      const stores = new MemStores();
      const packetWithCorrection: ContextPacket = {
        ...packet(),
        elements: [
          {
            sourceId: "corr-1",
            sourceKind: "correction",
            trust: "untrusted-retrieved",
            text: "example",
            asOf: "2026-09-02T10:00:00.000Z",
            tokens: 2,
            correction: { correctionId: "corr-1", preferredBucketId: "bucket-tasks" },
          },
        ],
      };
      const events: string[] = [];
      const pipeline = new DonnaPipeline({
        transcriber: { modelId: "stub-stt", transcribe: async () => TRANSCRIPT },
        organizer: { modelId: "stub-organizer", organize: async () => OUTPUT },
        embedder: stubEmbedder(),
        store: stores,
        captures: stores,
        transcripts: stores,
        bucketTuning: { assign_threshold: 0.82, create_threshold: 0.65 },
        contextAssembler: { assemble: async () => packetWithCorrection },
        correctionObserver: {
          observePlacement: async () => {
            throw new Error("observer down");
          },
        },
        events: { emit: (e) => events.push(e.name) },
      });
      const result = await pipeline.run(await makeCapture(dir));
      assert.equal(result.items.length, 1);
      assert.ok(events.includes("correction.adherence.error"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
