import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bucket, CaptureRecord, Thought, TranscriptRecord } from "@donna/core";
import { hashTranscriptContent } from "@donna/core";
import { FileBucketStore } from "@donna/buckets";
import { FileCaptureStore, FileTranscriptStore } from "@donna/pipeline";
import { EncryptedFileAudioStore } from "./audio-store.file.js";
import { FileAuditLog } from "./audit.js";
import {
  CaptureDeletionError,
  CaptureLifecycleService,
  CaptureNotFoundError,
} from "./lifecycle.js";

const KEY = randomBytes(32);
const NOW = new Date("2026-09-02T12:00:00.000Z");

function captureRecord(tenantId: string, userId: string, id: string): CaptureRecord {
  return {
    id,
    tenantId,
    userId,
    contentHash: "c".repeat(64),
    capturedAt: "2026-09-01T09:00:00.000Z",
  };
}

function transcriptRecord(tenantId: string, userId: string, captureId: string): TranscriptRecord {
  const base = {
    captureId,
    tenantId,
    userId,
    text: `transcript words for ${captureId}`,
    segments: [
      {
        id: "seg-0",
        text: `transcript words for ${captureId}`,
        startSec: 0,
        endSec: 2,
      },
    ],
    model: "gpt-4o-transcribe",
  };
  return {
    ...base,
    contentHash: hashTranscriptContent(base),
    createdAt: "2026-09-01T09:00:05.000Z",
  };
}

function thought(tenantId: string, userId: string, captureId: string, embedding: number[]): Thought {
  return {
    id: `thought-${captureId}`,
    tenantId,
    userId,
    summary: `summary ${captureId}`,
    text: `text ${captureId}`,
    confidence: 0.9,
    provenance: {
      captureId,
      segmentIds: ["seg-0"],
      sourceText: `transcript words for ${captureId}`,
      startSec: 0,
      endSec: 2,
    },
    versions: {
      organizerModel: "stub",
      organizeSchemaVersion: "v1",
      organizePromptVersion: "v1",
    },
    embedding,
  };
}

function bucket(tenantId: string, userId: string): Bucket {
  return {
    id: "bucket-1",
    tenantId,
    userId,
    name: "Tasks",
    description: "tasks",
    centroid: [0.5, 0.5],
    itemCount: 2,
    createdAt: "2026-09-01T09:01:00.000Z",
    origin: "seeded",
  };
}

interface Harness {
  lifecycle: CaptureLifecycleService;
  audio: EncryptedFileAudioStore;
  captures: FileCaptureStore;
  transcripts: FileTranscriptStore;
  buckets: FileBucketStore;
  audit: FileAuditLog;
}

async function withHarness(
  fn: (h: Harness) => Promise<void>,
  options: { failingProjection?: boolean } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "donna-lifecycle-"));
  try {
    const audio = new EncryptedFileAudioStore(dir, KEY);
    const captures = new FileCaptureStore(dir);
    const transcripts = new FileTranscriptStore(dir);
    const buckets = new FileBucketStore(dir);
    const audit = new FileAuditLog(dir);
    const lifecycle = new CaptureLifecycleService({
      audio,
      captures,
      transcripts,
      buckets,
      audit,
      now: () => NOW,
      ...(options.failingProjection
        ? {
            extraProjections: [
              {
                name: "retrieval-index",
                deleteForCapture: async () => {
                  throw new Error("projection cannot delete yet");
                },
              },
            ],
          }
        : {}),
    });
    await fn({ lifecycle, audio, captures, transcripts, buckets, audit });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Seed tenant-a/user-1 with cap-1 and cap-2 sharing one bucket. */
async function seed(h: Harness): Promise<void> {
  await h.captures.saveCapture(captureRecord("tenant-a", "user-1", "cap-1"));
  await h.captures.saveCapture(captureRecord("tenant-a", "user-1", "cap-2"));
  await h.transcripts.saveTranscript(transcriptRecord("tenant-a", "user-1", "cap-1"));
  await h.transcripts.saveTranscript(transcriptRecord("tenant-a", "user-1", "cap-2"));
  await h.audio.put("tenant-a", "user-1", "cap-1", Buffer.from([1, 1, 1]));
  await h.audio.put("tenant-a", "user-1", "cap-2", Buffer.from([2, 2, 2]));
  await h.buckets.createBucket(bucket("tenant-a", "user-1"));
  await h.buckets.saveItem({
    thought: thought("tenant-a", "user-1", "cap-1", [1, 0]),
    bucketId: "bucket-1",
  });
  await h.buckets.saveItem({
    thought: thought("tenant-a", "user-1", "cap-2", [0, 1]),
    bucketId: "bucket-1",
  });
}

describe("CaptureLifecycleService", () => {
  it("export contains the scope's capture, transcript, thoughts, provenance (AC-4)", async () => {
    await withHarness(async (h) => {
      await seed(h);
      // Another tenant's data must never leak into the export.
      await h.captures.saveCapture(captureRecord("tenant-b", "user-1", "cap-9"));
      await h.transcripts.saveTranscript(transcriptRecord("tenant-b", "user-1", "cap-9"));

      const bundle = await h.lifecycle.exportCapture("tenant-a", "user-1", "cap-1");
      assert.equal(bundle.schema, "donna.capture-export.v1");
      assert.equal(bundle.capture.id, "cap-1");
      assert.equal(bundle.transcript?.captureId, "cap-1");
      assert.equal(bundle.thoughts.length, 1);
      assert.equal(bundle.thoughts[0]!.thought.provenance.captureId, "cap-1");
      assert.equal(bundle.thoughts[0]!.bucketName, "Tasks");
      assert.equal(bundle.audioAvailable, true);
      const raw = JSON.stringify(bundle);
      assert.ok(!raw.includes("cap-9"));
      assert.ok(!raw.includes("cap-2"));
      assert.ok(!raw.includes("tenant-b"));
    });
  });

  it("export rejects unknown captures and other scopes' captures", async () => {
    await withHarness(async (h) => {
      await seed(h);
      await assert.rejects(
        h.lifecycle.exportCapture("tenant-a", "user-1", "nope"),
        CaptureNotFoundError,
      );
      await assert.rejects(
        h.lifecycle.exportCapture("tenant-b", "user-1", "cap-1"),
        CaptureNotFoundError,
      );
    });
  });

  it("early audio deletion preserves transcript-only provenance (AC-5)", async () => {
    await withHarness(async (h) => {
      await seed(h);
      await h.lifecycle.deleteAudio("tenant-a", "user-1", "cap-1");

      assert.equal(await h.audio.has("tenant-a", "user-1", "cap-1"), false);
      const capture = await h.captures.getCapture("tenant-a", "user-1", "cap-1");
      assert.equal(capture?.audioDeletedAt, NOW.toISOString());
      // Transcript and thoughts survive.
      const transcript = await h.transcripts.getTranscript("tenant-a", "user-1", "cap-1");
      assert.ok(transcript);
      const items = await h.buckets.listItems("tenant-a", "user-1");
      assert.equal(items.length, 2);

      // Idempotent replay.
      await h.lifecycle.deleteAudio("tenant-a", "user-1", "cap-1");
      const entries = await h.audit.list("tenant-a", "user-1");
      assert.deepEqual(
        entries.map((e) => [e.op, e.detail]),
        [
          ["audio.delete", "deleted"],
          ["audio.delete", "already-deleted"],
        ],
      );
    });
  });

  it("complete deletion removes audio, transcript, thoughts, embeddings, capture", async () => {
    await withHarness(async (h) => {
      await seed(h);
      await h.lifecycle.deleteCapture("tenant-a", "user-1", "cap-1");

      assert.equal(await h.audio.has("tenant-a", "user-1", "cap-1"), false);
      assert.equal(await h.captures.getCapture("tenant-a", "user-1", "cap-1"), undefined);
      assert.equal(await h.transcripts.getTranscript("tenant-a", "user-1", "cap-1"), undefined);
      const items = await h.buckets.listItems("tenant-a", "user-1");
      assert.deepEqual(
        items.map((i) => i.thought.provenance.captureId),
        ["cap-2"],
      );
      // Bucket stats repaired from the surviving member.
      const [tasks] = await h.buckets.listBuckets("tenant-a", "user-1");
      assert.equal(tasks?.itemCount, 1);
      assert.deepEqual(tasks?.centroid, [0, 1]);

      // cap-2 untouched.
      assert.ok(await h.captures.getCapture("tenant-a", "user-1", "cap-2"));
      assert.equal(await h.audio.has("tenant-a", "user-1", "cap-2"), true);
    });
  });

  it("complete deletion is idempotent and never restores data (AC-3)", async () => {
    await withHarness(async (h) => {
      await seed(h);
      await h.lifecycle.deleteCapture("tenant-a", "user-1", "cap-1");
      await h.lifecycle.deleteCapture("tenant-a", "user-1", "cap-1");
      assert.equal(await h.captures.getCapture("tenant-a", "user-1", "cap-1"), undefined);
      const entries = await h.audit.list("tenant-a", "user-1");
      const deletes = entries.filter((e) => e.op === "capture.delete");
      assert.equal(deletes.length, 2);
      assert.ok(deletes.every((e) => e.result === "ok"));
      assert.equal(deletes[1]?.detail, "already-deleted");
    });
  });

  it("fails explicitly when a derived projection cannot be deleted (FR-4)", async () => {
    await withHarness(
      async (h) => {
        await seed(h);
        await assert.rejects(
          h.lifecycle.deleteCapture("tenant-a", "user-1", "cap-1"),
          (err: unknown) => {
            assert.ok(err instanceof CaptureDeletionError);
            assert.deepEqual(err.remaining, ["retrieval-index"]);
            return true;
          },
        );
        // The failure is recorded for audit.
        const entries = await h.audit.list("tenant-a", "user-1");
        const failed = entries.find((e) => e.op === "capture.delete");
        assert.equal(failed?.result, "error");
        assert.equal(failed?.detail, "remaining=retrieval-index");
      },
      { failingProjection: true },
    );
  });

  it("a deletion in one tenant never touches another tenant's records", async () => {
    await withHarness(async (h) => {
      await seed(h);
      // Same capture ID exists in tenant-b.
      await h.captures.saveCapture(captureRecord("tenant-b", "user-1", "cap-1"));
      await h.transcripts.saveTranscript(transcriptRecord("tenant-b", "user-1", "cap-1"));
      await h.audio.put("tenant-b", "user-1", "cap-1", Buffer.from([9]));

      await h.lifecycle.deleteCapture("tenant-a", "user-1", "cap-1");

      assert.ok(await h.captures.getCapture("tenant-b", "user-1", "cap-1"));
      assert.ok(await h.transcripts.getTranscript("tenant-b", "user-1", "cap-1"));
      assert.deepEqual(await h.audio.get("tenant-b", "user-1", "cap-1"), Buffer.from([9]));
    });
  });

  it("rejects traversal capture IDs on every operation (SR-3)", async () => {
    await withHarness(async (h) => {
      await seed(h);
      await assert.rejects(
        h.lifecycle.exportCapture("tenant-a", "user-1", "../cap-2"),
        /Invalid capture ID/,
      );
      await assert.rejects(
        h.lifecycle.deleteAudio("tenant-a", "user-1", "../../etc/passwd"),
        /Invalid capture ID/,
      );
      await assert.rejects(
        h.lifecycle.deleteCapture("tenant-a", "user-1", ".."),
        /Invalid capture ID/,
      );
    });
  });
});
