import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptureRecord, TranscriptRecord } from "@donna/core";
import { hashTranscriptContent } from "@donna/core";
import { FileCaptureStore, FileTranscriptStore } from "./stores.file.js";

function captureRecord(
  tenantId: string,
  userId: string,
  id: string,
): CaptureRecord {
  return {
    id,
    tenantId,
    userId,
    contentHash: "a".repeat(64),
    capturedAt: "2026-09-02T10:00:00.000Z",
  };
}

function transcriptRecord(
  tenantId: string,
  userId: string,
  captureId: string,
): TranscriptRecord {
  const base = {
    captureId,
    tenantId,
    userId,
    text: "hello world",
    segments: [{ id: "seg-0", text: "hello world", startSec: 0, endSec: 1.5 }],
    model: "gpt-4o-transcribe",
  };
  return {
    ...base,
    contentHash: hashTranscriptContent(base),
    createdAt: "2026-09-02T10:00:05.000Z",
  };
}

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "donna-stores-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("FileCaptureStore / FileTranscriptStore", () => {
  it("round-trips records within their scope", async () => {
    await withTempDir(async (dir) => {
      const captures = new FileCaptureStore(dir);
      const transcripts = new FileTranscriptStore(dir);
      await captures.saveCapture(captureRecord("tenant-a", "user-1", "cap-1"));
      await transcripts.saveTranscript(
        transcriptRecord("tenant-a", "user-1", "cap-1"),
      );

      const c = await captures.getCapture("tenant-a", "user-1", "cap-1");
      const t = await transcripts.getTranscript("tenant-a", "user-1", "cap-1");
      assert.equal(c?.id, "cap-1");
      assert.equal(t?.segments[0]?.text, "hello world");
    });
  });

  it("returns undefined for a legitimately missing record", async () => {
    await withTempDir(async (dir) => {
      const captures = new FileCaptureStore(dir);
      const transcripts = new FileTranscriptStore(dir);
      assert.equal(
        await captures.getCapture("tenant-a", "user-1", "nope"),
        undefined,
      );
      assert.equal(
        await transcripts.getTranscript("tenant-a", "user-1", "nope"),
        undefined,
      );
      assert.deepEqual(await captures.listCaptures("tenant-a", "user-1"), []);
    });
  });

  it("isolates scopes: records are invisible across tenants and users", async () => {
    await withTempDir(async (dir) => {
      const captures = new FileCaptureStore(dir);
      const transcripts = new FileTranscriptStore(dir);
      await captures.saveCapture(captureRecord("tenant-a", "user-1", "cap-1"));
      await transcripts.saveTranscript(
        transcriptRecord("tenant-a", "user-1", "cap-1"),
      );

      assert.equal(
        await captures.getCapture("tenant-b", "user-1", "cap-1"),
        undefined,
      );
      assert.equal(
        await captures.getCapture("tenant-a", "user-2", "cap-1"),
        undefined,
      );
      assert.equal(
        await transcripts.getTranscript("tenant-b", "user-1", "cap-1"),
        undefined,
      );
      assert.deepEqual(await captures.listCaptures("tenant-b", "user-1"), []);
    });
  });

  it("rejects path traversal in tenant, user, and capture IDs", async () => {
    await withTempDir(async (dir) => {
      const captures = new FileCaptureStore(dir);
      const transcripts = new FileTranscriptStore(dir);
      await assert.rejects(
        captures.getCapture("../tenant-b", "user-1", "cap-1"),
        /Invalid tenant ID/,
      );
      await assert.rejects(
        captures.getCapture("tenant-a", "../user-2", "cap-1"),
        /Invalid user ID/,
      );
      await assert.rejects(
        captures.getCapture("tenant-a", "user-1", "../../etc/passwd"),
        /Invalid capture ID/,
      );
      await assert.rejects(
        transcripts.getTranscript("tenant-a", "user-1", "../cap-1"),
        /Invalid capture ID/,
      );
      await assert.rejects(
        captures.saveCapture(captureRecord("tenant-a", "user-1", "../evil")),
        /Invalid capture ID/,
      );
    });
  });

  it("fails closed when a stored record's scope does not match its partition", async () => {
    await withTempDir(async (dir) => {
      const captures = new FileCaptureStore(dir);
      // Write a record claiming tenant-b into tenant-a's partition.
      const forged = captureRecord("tenant-b", "user-1", "cap-1");
      const path = join(dir, "tenant-a", "user-1", "captures", "cap-1.json");
      await new FileCaptureStore(dir).saveCapture(
        captureRecord("tenant-a", "user-1", "cap-1"),
      );
      await writeFile(path, JSON.stringify(forged));
      await assert.rejects(
        captures.getCapture("tenant-a", "user-1", "cap-1"),
        /does not match its tenant\/user partition/,
      );
    });
  });

  it("detects transcript tampering via the content hash", async () => {
    await withTempDir(async (dir) => {
      const transcripts = new FileTranscriptStore(dir);
      await transcripts.saveTranscript(
        transcriptRecord("tenant-a", "user-1", "cap-1"),
      );
      const path = join(
        dir,
        "tenant-a",
        "user-1",
        "transcripts",
        "cap-1.json",
      );
      const stored = JSON.parse(await readFile(path, "utf8")) as TranscriptRecord;
      // Tamper: rewrite a segment's text without updating the hash.
      stored.segments[0]!.text = "forged words";
      await writeFile(path, JSON.stringify(stored));
      await assert.rejects(
        transcripts.getTranscript("tenant-a", "user-1", "cap-1"),
        /content-integrity check/,
      );
    });
  });

  it("lists captures in capture-time order within a scope", async () => {
    await withTempDir(async (dir) => {
      const captures = new FileCaptureStore(dir);
      const older = {
        ...captureRecord("tenant-a", "user-1", "cap-old"),
        capturedAt: "2026-08-30T09:00:00.000Z",
      };
      const newer = {
        ...captureRecord("tenant-a", "user-1", "cap-new"),
        capturedAt: "2026-09-02T09:00:00.000Z",
      };
      await captures.saveCapture(newer);
      await captures.saveCapture(older);
      const list = await captures.listCaptures("tenant-a", "user-1");
      assert.deepEqual(
        list.map((c) => c.id),
        ["cap-old", "cap-new"],
      );
    });
  });
});
