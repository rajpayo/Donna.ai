import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AudioStore,
  AuditEntry,
  AuditLog,
  Bucket,
  BucketStore,
  Capture,
  CaptureRecord,
  CaptureStore,
  Embedder,
  OrganizeOutput,
  Organizer,
  RetrievalIndex,
  Thought,
  Transcriber,
  Transcript,
  TranscriptRecord,
  TranscriptStore,
} from "@donna/core";
import { DonnaPipeline } from "./run.js";
import { ProvenanceError } from "./provenance.js";

/* ---------- in-memory stores recording write order ---------- */

class MemStores implements CaptureStore, TranscriptStore, BucketStore {
  captures: CaptureRecord[] = [];
  transcripts: TranscriptRecord[] = [];
  buckets: Bucket[] = [];
  items: Array<{ thought: Thought; bucketId: string }> = [];
  order: string[] = [];

  async saveCapture(record: CaptureRecord): Promise<void> {
    this.order.push(`capture:${record.id}`);
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
  async markAudioDeleted(t: string, u: string, id: string, deletedAt: string) {
    const c = this.captures.find(
      (x) => x.tenantId === t && x.userId === u && x.id === id,
    );
    if (!c) throw new Error("Capture does not exist in the requested scope");
    c.audioDeletedAt = deletedAt;
  }
  async deleteCapture(t: string, u: string, id: string) {
    this.captures = this.captures.filter(
      (c) => !(c.tenantId === t && c.userId === u && c.id === id),
    );
  }
  async saveTranscript(record: TranscriptRecord): Promise<void> {
    this.order.push(`transcript:${record.captureId}`);
    this.transcripts.push(record);
  }
  async getTranscript(t: string, u: string, captureId: string) {
    return this.transcripts.find(
      (r) => r.tenantId === t && r.userId === u && r.captureId === captureId,
    );
  }
  async deleteTranscript(t: string, u: string, captureId: string) {
    this.transcripts = this.transcripts.filter(
      (r) => !(r.tenantId === t && r.userId === u && r.captureId === captureId),
    );
  }
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
  async updateBucketStats(t: string, u: string, id: string, centroid: number[], itemCount: number) {
    const b = this.buckets.find((x) => x.id === id);
    if (b) {
      b.centroid = centroid;
      b.itemCount = itemCount;
    }
  }
  async saveItem(item: { thought: Thought; bucketId: string }): Promise<void> {
    this.order.push(`item:${item.thought.id}`);
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
  async deleteItemsForCapture(_t: string, _u: string, captureId: string) {
    const before = this.items.length;
    this.items = this.items.filter(
      (item) => item.thought.provenance.captureId !== captureId,
    );
    return { removed: before - this.items.length };
  }
  async moveItem(): Promise<void> {
    throw new Error("not used in pipeline tests");
  }
  async renameBucket(): Promise<void> {
    throw new Error("not used in pipeline tests");
  }
  async mergeBuckets(): Promise<void> {
    throw new Error("not used in pipeline tests");
  }
  async updateItem(): Promise<void> {
    throw new Error("not used in pipeline tests");
  }
}

/* ---------- stub adapters ---------- */

const TRANSCRIPT: Transcript = {
  captureId: "cap-1",
  text: "first idea. second idea. send the deck.",
  segments: [
    { id: "seg-0", text: "first idea.", startSec: 0, endSec: 2 },
    { id: "seg-1", text: "second idea.", startSec: 2, endSec: 4 },
    { id: "seg-2", text: "send the deck.", startSec: 4, endSec: 6 },
  ],
  model: "gpt-4o-transcribe",
};

function stubTranscriber(): Transcriber {
  return {
    modelId: "gpt-4o-transcribe",
    transcribe: async () => TRANSCRIPT,
  };
}

function stubEmbedder(): Embedder {
  return {
    modelId: "text-embedding-3-large",
    dimensions: 3,
    embed: async (texts: string[]) =>
      texts.map((_t, i) => {
        const v = [0, 0, 0];
        v[i % 3] = 1;
        return v;
      }),
  };
}

function organizerReturning(
  outputs: OrganizeOutput[],
  calls: { count: number } = { count: 0 },
): Organizer {
  return {
    modelId: "stub-organizer",
    schemaVersion: "test-schema-v1",
    promptVersion: "test-prompt-v1",
    organize: async () => {
      const out = outputs[Math.min(calls.count, outputs.length - 1)]!;
      calls.count += 1;
      return out;
    },
  };
}

function validOutput(): OrganizeOutput {
  return {
    thoughts: [
      {
        summary: "First idea",
        text: "first idea",
        confidence: 0.9,
        newBucketName: "Alpha",
        newBucketDescription: "alpha things",
        provenance: {
          segmentIds: ["seg-0"],
          sourceText: "GARBAGE model-supplied text",
          startSec: 999,
          endSec: 1000,
        },
      },
      {
        summary: "Send the deck",
        text: "send the deck",
        confidence: 0.95,
        task: { title: "Send the deck" },
        provenance: {
          segmentIds: ["seg-2"],
          sourceText: "GARBAGE",
          startSec: -50,
          endSec: 9999,
        },
      },
    ],
  };
}

const TUNING = { assign_threshold: 0.82, create_threshold: 0.65 };

async function makeCapture(dir: string): Promise<Capture> {
  const audioPath = join(dir, "audio.bin");
  await writeFile(audioPath, Buffer.from([1, 2, 3, 4, 5]));
  return {
    id: "cap-1",
    tenantId: "tenant-a",
    userId: "user-1",
    audioPath,
    capturedAt: "2026-09-02T10:00:00.000Z",
  };
}

async function withPipeline<T>(
  fn: (ctx: {
    pipeline: DonnaPipeline;
    stores: MemStores;
    capture: Capture;
    escalationCalls: { count: number };
  }) => Promise<T>,
  options: {
    defaultOutputs?: OrganizeOutput[];
    escalationOutputs?: OrganizeOutput[];
    withEscalation?: boolean;
  } = {},
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "donna-run-"));
  try {
    const stores = new MemStores();
    const escalationCalls = { count: 0 };
    const pipeline = new DonnaPipeline({
      transcriber: stubTranscriber(),
      organizer: organizerReturning(options.defaultOutputs ?? [validOutput()]),
      ...(options.withEscalation !== false
        ? {
            escalationOrganizer: organizerReturning(
              options.escalationOutputs ?? [validOutput()],
              escalationCalls,
            ),
          }
        : {}),
      embedder: stubEmbedder(),
      store: stores,
      captures: stores,
      transcripts: stores,
      bucketTuning: TUNING,
    });
    const capture = await makeCapture(dir);
    return await fn({ pipeline, stores, capture, escalationCalls });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ---------- tests ---------- */

describe("DonnaPipeline persistence and provenance (Spec 1.2)", () => {
  it("persists capture and transcript before any thought (FR-1)", async () => {
    await withPipeline(async ({ pipeline, stores, capture }) => {
      const result = await pipeline.run(capture);
      assert.equal(result.items.length, 2);

      const captureIdx = stores.order.findIndex((e) => e === "capture:cap-1");
      const transcriptIdx = stores.order.findIndex(
        (e) => e === "transcript:cap-1",
      );
      const firstItemIdx = stores.order.findIndex((e) =>
        e.startsWith("item:"),
      );
      assert.ok(captureIdx >= 0 && transcriptIdx > captureIdx);
      assert.ok(firstItemIdx > transcriptIdx);

      const storedCapture = await stores.getCapture("tenant-a", "user-1", "cap-1");
      assert.ok(storedCapture);
      assert.match(storedCapture.contentHash, /^[0-9a-f]{64}$/);
      const storedTranscript = await stores.getTranscript(
        "tenant-a",
        "user-1",
        "cap-1",
      );
      assert.ok(storedTranscript);
      assert.equal(storedTranscript.segments.length, 3);
    });
  });

  it("canonicalizes provenance from stored segments, ignoring model values", async () => {
    await withPipeline(async ({ pipeline, stores, capture }) => {
      await pipeline.run(capture);
      const [first, second] = stores.items;
      // Model sent sourceText "GARBAGE model-supplied text", 999–1000s.
      assert.equal(first!.thought.provenance.sourceText, "first idea.");
      assert.equal(first!.thought.provenance.startSec, 0);
      assert.equal(first!.thought.provenance.endSec, 2);
      assert.deepEqual(first!.thought.provenance.segmentIds, ["seg-0"]);
      assert.equal(second!.thought.provenance.sourceText, "send the deck.");
      assert.equal(second!.thought.provenance.startSec, 4);
      assert.equal(second!.thought.provenance.endSec, 6);
    });
  });

  it("attaches organizer model and schema/prompt versions (FR-4)", async () => {
    await withPipeline(async ({ pipeline, stores, capture }) => {
      await pipeline.run(capture);
      for (const { thought } of stores.items) {
        assert.deepEqual(thought.versions, {
          organizerModel: "stub-organizer",
          organizeSchemaVersion: "test-schema-v1",
          organizePromptVersion: "test-prompt-v1",
        });
      }
    });
  });

  it("routes task thoughts to Tasks and normal thoughts to a new bucket", async () => {
    await withPipeline(async ({ pipeline, capture }) => {
      const result = await pipeline.run(capture);
      const taskItem = result.items.find((i) => i.thought.task);
      const ideaItem = result.items.find((i) => !i.thought.task);
      assert.equal(taskItem?.bucket.name, "Tasks");
      assert.equal(ideaItem?.bucket.name, "Alpha");
    });
  });

  it("matches organizer output to thoughts by stable index, not text", async () => {
    // Two thoughts with IDENTICAL text but different provenance and
    // different bucket suggestions. Text-equality matching would cross-wire
    // them; index-based matching must not.
    const duplicateTextOutput: OrganizeOutput = {
      thoughts: [
        {
          summary: "dup A",
          text: "same words",
          confidence: 0.9,
          newBucketName: "Alpha",
          newBucketDescription: "alpha",
          provenance: {
            segmentIds: ["seg-0"],
            sourceText: "x",
            startSec: 0,
            endSec: 1,
          },
        },
        {
          summary: "dup B",
          text: "same words",
          confidence: 0.9,
          newBucketName: "Beta",
          newBucketDescription: "beta",
          provenance: {
            segmentIds: ["seg-1"],
            sourceText: "x",
            startSec: 0,
            endSec: 1,
          },
        },
      ],
    };
    await withPipeline(
      async ({ pipeline, capture }) => {
        const result = await pipeline.run(capture);
        assert.equal(result.items[0]!.bucket.name, "Alpha");
        assert.equal(result.items[1]!.bucket.name, "Beta");
        assert.deepEqual(result.items[0]!.thought.provenance.segmentIds, [
          "seg-0",
        ]);
        assert.deepEqual(result.items[1]!.thought.provenance.segmentIds, [
          "seg-1",
        ]);
      },
      { defaultOutputs: [duplicateTextOutput] },
    );
  });

  it("escalates once on invalid provenance and accepts valid escalation output", async () => {
    const invalid: OrganizeOutput = {
      thoughts: [
        {
          summary: "bad",
          text: "bad",
          confidence: 0.9,
          provenance: {
            segmentIds: ["seg-99"],
            sourceText: "x",
            startSec: 0,
            endSec: 1,
          },
        },
      ],
    };
    await withPipeline(
      async ({ pipeline, stores, capture, escalationCalls }) => {
        const result = await pipeline.run(capture);
        assert.equal(escalationCalls.count, 1);
        assert.equal(result.items.length, 2);
        assert.equal(stores.items.length, 2);
      },
      { defaultOutputs: [invalid], escalationOutputs: [validOutput()] },
    );
  });

  it("fails closed when provenance is still invalid after one escalation", async () => {
    const invalid: OrganizeOutput = {
      thoughts: [
        {
          summary: "bad",
          text: "bad",
          confidence: 0.9,
          provenance: {
            segmentIds: ["seg-99"],
            sourceText: "x",
            startSec: 0,
            endSec: 1,
          },
        },
      ],
    };
    await withPipeline(
      async ({ pipeline, stores, capture, escalationCalls }) => {
        await assert.rejects(pipeline.run(capture), ProvenanceError);
        // Escalated exactly once, then failed closed.
        assert.equal(escalationCalls.count, 1);
        // No thoughts persisted; capture and transcript remain for audit.
        assert.equal(stores.items.length, 0);
        assert.equal(stores.captures.length, 1);
        assert.equal(stores.transcripts.length, 1);
      },
      { defaultOutputs: [invalid], escalationOutputs: [invalid] },
    );
  });

  it("fails closed immediately on invalid provenance with no escalation lane", async () => {
    const invalid: OrganizeOutput = {
      thoughts: [
        {
          summary: "bad",
          text: "bad",
          confidence: 0.9,
          provenance: {
            segmentIds: [],
            sourceText: "x",
            startSec: 0,
            endSec: 1,
          },
        },
      ],
    };
    await withPipeline(
      async ({ pipeline, stores, capture }) => {
        await assert.rejects(pipeline.run(capture), ProvenanceError);
        assert.equal(stores.items.length, 0);
      },
      { defaultOutputs: [invalid], withEscalation: false },
    );
  });

  it("stores encrypted audio and audits it when an audio store is configured", async () => {
    const stored: Array<{ captureId: string; bytes: number }> = [];
    const auditEntries: AuditEntry[] = [];
    const audio: AudioStore = {
      put: async (_t, _u, captureId, bytes) => {
        stored.push({ captureId, bytes: bytes.byteLength });
      },
      get: async () => undefined,
      has: async () => false,
      delete: async () => false,
    };
    const audit: AuditLog = {
      append: async (entry) => {
        auditEntries.push(entry);
      },
      list: async () => auditEntries,
    };
    const dir = await mkdtemp(join(tmpdir(), "donna-run-"));
    try {
      const stores = new MemStores();
      const pipeline = new DonnaPipeline({
        transcriber: stubTranscriber(),
        organizer: organizerReturning([validOutput()]),
        embedder: stubEmbedder(),
        store: stores,
        captures: stores,
        transcripts: stores,
        audio,
        audit,
        bucketTuning: TUNING,
      });
      const capture = await makeCapture(dir);
      await pipeline.run(capture);

      assert.equal(stored.length, 1);
      assert.equal(stored[0]!.captureId, "cap-1");
      assert.equal(stored[0]!.bytes, 5);
      const audioAudit = auditEntries.find((e) => e.op === "audio.store");
      assert.ok(audioAudit);
      assert.equal(audioAudit.captureId, "cap-1");
      assert.equal(audioAudit.result, "ok");
      // Non-content: byte count only, never audio data.
      assert.equal(audioAudit.detail, "bytes=5");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects cross-capture segment references", async () => {
    // The organizer cites segments that only exist in some OTHER capture's
    // transcript — unknown in this one.
    const crossCapture: OrganizeOutput = {
      thoughts: [
        {
          summary: "wrong capture",
          text: "wrong capture",
          confidence: 0.9,
          provenance: {
            segmentIds: ["seg-0-of-another-capture"],
            sourceText: "x",
            startSec: 0,
            endSec: 1,
          },
        },
      ],
    };
    await withPipeline(
      async ({ pipeline, capture }) => {
        await assert.rejects(
          pipeline.run(capture),
          /unknown-segment-reference/,
        );
      },
      { defaultOutputs: [crossCapture], escalationOutputs: [crossCapture] },
    );
  });
});

describe("DonnaPipeline retrieval indexing (Spec 3.1)", () => {
  function stubIndex(state: {
    indexed: Array<{ thoughtId: string; bucketId: string }>;
    fail?: boolean;
  }): RetrievalIndex {
    return {
      indexItem: async (item, bucket) => {
        if (state.fail === true) throw new Error("index unavailable");
        state.indexed.push({ thoughtId: item.thought.id, bucketId: bucket.id });
      },
      removeThought: async () => false,
      removeCapture: async () => ({ removed: 0 }),
      search: async () => [],
      rebuild: async () => ({ indexed: 0 }),
    };
  }

  it("indexes every placed item as it is persisted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "donna-run-"));
    try {
      const stores = new MemStores();
      const state = { indexed: [] as Array<{ thoughtId: string; bucketId: string }> };
      const pipeline = new DonnaPipeline({
        transcriber: stubTranscriber(),
        organizer: organizerReturning([validOutput()]),
        embedder: stubEmbedder(),
        store: stores,
        captures: stores,
        transcripts: stores,
        bucketTuning: TUNING,
        retrievalIndex: stubIndex(state),
      });
      const capture = await makeCapture(dir);
      const result = await pipeline.run(capture);
      assert.equal(state.indexed.length, result.items.length);
      for (const item of result.items) {
        assert.ok(
          state.indexed.some(
            (entry) =>
              entry.thoughtId === item.thought.id &&
              entry.bucketId === item.bucket.id,
          ),
        );
      }
      // Thoughts carry a creation time for time-filtered reads.
      for (const { thought } of stores.items) {
        assert.ok(thought.createdAt !== undefined);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("an index failure degrades without breaking the core loop", async () => {
    const dir = await mkdtemp(join(tmpdir(), "donna-run-"));
    try {
      const stores = new MemStores();
      const events: string[] = [];
      const pipeline = new DonnaPipeline({
        transcriber: stubTranscriber(),
        organizer: organizerReturning([validOutput()]),
        embedder: stubEmbedder(),
        store: stores,
        captures: stores,
        transcripts: stores,
        bucketTuning: TUNING,
        retrievalIndex: stubIndex({ indexed: [], fail: true }),
        events: {
          emit: (e) => {
            events.push(e.name);
          },
        },
      });
      const capture = await makeCapture(dir);
      const result = await pipeline.run(capture);
      assert.equal(result.items.length, 2);
      assert.equal(stores.items.length, 2);
      assert.ok(events.includes("retrieval.index.error"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
