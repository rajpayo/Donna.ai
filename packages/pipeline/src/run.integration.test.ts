/**
 * Spec 1.2 AC-3/AC-4: the capture → transcript → thought chain survives a
 * process reload, and a thought's exact source segments are recoverable
 * from disk without invoking any model.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Capture,
  Embedder,
  OrganizeOutput,
  Organizer,
  Transcriber,
} from "@donna/core";
import { FileBucketStore } from "@donna/buckets";
import { DonnaPipeline } from "./run.js";
import { FileCaptureStore, FileTranscriptStore } from "./stores.file.js";

const TUNING = { assign_threshold: 0.82, create_threshold: 0.65 };

const STUB_TRANSCRIPT = {
  text: "the onboarding drop-off is at step three. I promised Arjun the pricing deck by Thursday.",
  segments: [
    {
      id: "seg-0",
      text: "the onboarding drop-off is at step three.",
      startSec: 0,
      endSec: 3.2,
    },
    {
      id: "seg-1",
      text: "I promised Arjun the pricing deck by Thursday.",
      startSec: 3.2,
      endSec: 7.8,
    },
  ],
  model: "gpt-4o-transcribe",
};

const STUB_OUTPUT: OrganizeOutput = {
  thoughts: [
    {
      summary: "Onboarding drop-off is at step three",
      text: "onboarding drop-off at step three",
      confidence: 0.9,
      newBucketName: "Product Ideas",
      newBucketDescription: "product observations",
      provenance: {
        segmentIds: ["seg-0"],
        sourceText: "ignored",
        startSec: 0,
        endSec: 0,
      },
    },
    {
      summary: "Send Arjun the pricing deck by Thursday",
      text: "send Arjun the pricing deck",
      confidence: 0.95,
      task: { title: "Send pricing deck", assigneeHint: "Arjun", dueHint: "Thursday" },
      provenance: {
        segmentIds: ["seg-1"],
        sourceText: "ignored",
        startSec: 0,
        endSec: 0,
      },
    },
  ],
};

function stubAdapters(): {
  transcriber: Transcriber;
  organizer: Organizer;
  embedder: Embedder;
} {
  return {
    transcriber: {
      modelId: "gpt-4o-transcribe",
      transcribe: async (capture: Capture) => ({
        captureId: capture.id,
        ...STUB_TRANSCRIPT,
      }),
    },
    organizer: {
      modelId: "stub-organizer",
      schemaVersion: "test-schema-v1",
      promptVersion: "test-prompt-v1",
      organize: async () => STUB_OUTPUT,
    },
    embedder: {
      modelId: "text-embedding-3-large",
      dimensions: 3,
      embed: async (texts: string[]) =>
        texts.map((_t, i) => {
          const v = [0, 0, 0];
          v[i % 3] = 1;
          return v;
        }),
    },
  };
}

describe("pipeline + file stores end-to-end (Spec 1.2)", () => {
  it("preserves the capture → transcript → thought chain across reload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "donna-integration-"));
    try {
      const audioPath = join(dir, "note.m4a");
      await writeFile(audioPath, Buffer.from([9, 8, 7, 6]));
      const capture: Capture = {
        id: "cap-reload",
        tenantId: "tenant-a",
        userId: "user-1",
        audioPath,
        capturedAt: "2026-09-02T10:00:00.000Z",
      };

      const adapters = stubAdapters();
      const pipeline = new DonnaPipeline({
        ...adapters,
        store: new FileBucketStore(dir),
        captures: new FileCaptureStore(dir),
        transcripts: new FileTranscriptStore(dir),
        bucketTuning: TUNING,
      });
      const result = await pipeline.run(capture);
      assert.equal(result.items.length, 2);

      // Simulate a process restart: brand-new store instances on the same dir.
      const captures = new FileCaptureStore(dir);
      const transcripts = new FileTranscriptStore(dir);
      const buckets = new FileBucketStore(dir);

      const reloadedCapture = await captures.getCapture(
        "tenant-a",
        "user-1",
        "cap-reload",
      );
      assert.ok(reloadedCapture);
      assert.equal(reloadedCapture.capturedAt, capture.capturedAt);

      const reloadedTranscript = await transcripts.getTranscript(
        "tenant-a",
        "user-1",
        "cap-reload",
      );
      assert.ok(reloadedTranscript);
      assert.equal(reloadedTranscript.segments.length, 2);

      // AC-4: recover one thought's exact transcript segments without a model.
      const storedBuckets = await buckets.listBuckets("tenant-a", "user-1");
      assert.ok(storedBuckets.length >= 2);
      const taskItem = result.items.find((i) => i.thought.task);
      assert.ok(taskItem);
      const byId = new Map(reloadedTranscript.segments.map((s) => [s.id, s]));
      const recovered = taskItem.thought.provenance.segmentIds.map((id) => {
        const segment = byId.get(id);
        assert.ok(segment, `segment ${id} must exist in the stored transcript`);
        return segment;
      });
      assert.equal(
        taskItem.thought.provenance.sourceText,
        recovered.map((s) => s.text.trim()).join(" "),
      );
      assert.equal(
        taskItem.thought.provenance.startSec,
        Math.min(...recovered.map((s) => s.startSec)),
      );
      assert.equal(
        taskItem.thought.provenance.endSec,
        Math.max(...recovered.map((s) => s.endSec)),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps tenant partitions isolated through the whole chain", async () => {
    const dir = await mkdtemp(join(tmpdir(), "donna-integration-"));
    try {
      const audioPath = join(dir, "note.m4a");
      await writeFile(audioPath, Buffer.from([1]));
      const capture: Capture = {
        id: "cap-iso",
        tenantId: "tenant-a",
        userId: "user-1",
        audioPath,
        capturedAt: "2026-09-02T10:00:00.000Z",
      };
      const pipeline = new DonnaPipeline({
        ...stubAdapters(),
        store: new FileBucketStore(dir),
        captures: new FileCaptureStore(dir),
        transcripts: new FileTranscriptStore(dir),
        bucketTuning: TUNING,
      });
      await pipeline.run(capture);

      const captures = new FileCaptureStore(dir);
      const transcripts = new FileTranscriptStore(dir);
      const buckets = new FileBucketStore(dir);
      assert.equal(
        await captures.getCapture("tenant-b", "user-1", "cap-iso"),
        undefined,
      );
      assert.equal(
        await transcripts.getTranscript("tenant-b", "user-1", "cap-iso"),
        undefined,
      );
      assert.deepEqual(await buckets.listBuckets("tenant-b", "user-1"), []);
      assert.deepEqual(await captures.listCaptures("tenant-b", "user-1"), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
