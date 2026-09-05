import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptureRecord } from "@donna/core";
import { FileCaptureStore } from "@donna/pipeline";
import { EncryptedFileAudioStore } from "./audio-store.file.js";
import { FileAuditLog } from "./audit.js";
import { RetentionService, RETENTION_MS } from "./retention.js";

const KEY = randomBytes(32);
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-02T12:00:00.000Z");

function captureAt(id: string, capturedAt: Date): CaptureRecord {
  return {
    id,
    tenantId: "tenant-a",
    userId: "user-1",
    contentHash: "b".repeat(64),
    capturedAt: capturedAt.toISOString(),
  };
}

async function withHarness(
  fn: (ctx: {
    retention: RetentionService;
    audio: EncryptedFileAudioStore;
    captures: FileCaptureStore;
    audit: FileAuditLog;
    dir: string;
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "donna-retention-"));
  try {
    const audio = new EncryptedFileAudioStore(dir, KEY);
    const captures = new FileCaptureStore(dir);
    const audit = new FileAuditLog(dir);
    const retention = new RetentionService({
      audio,
      captures,
      audit,
      now: () => NOW,
    });
    await fn({ retention, audio, captures, audit, dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("RetentionService (Spec 1.3, injectable clock)", () => {
  it("retains audio before expiry and deletes it at seven days", async () => {
    await withHarness(async ({ retention, audio, captures }) => {
      const fresh = captureAt("cap-fresh", new Date(NOW.getTime() - 6 * DAY_MS));
      const old = captureAt("cap-old", new Date(NOW.getTime() - 8 * DAY_MS));
      await captures.saveCapture(fresh);
      await captures.saveCapture(old);
      await audio.put("tenant-a", "user-1", "cap-fresh", Buffer.from([1]));
      await audio.put("tenant-a", "user-1", "cap-old", Buffer.from([2]));

      const result = await retention.cleanup("tenant-a", "user-1");
      assert.deepEqual(result, {
        scanned: 2,
        expired: 1,
        deleted: 1,
        alreadyDeleted: 0,
      });
      assert.equal(await audio.has("tenant-a", "user-1", "cap-fresh"), true);
      assert.equal(await audio.has("tenant-a", "user-1", "cap-old"), false);

      const oldRecord = await captures.getCapture("tenant-a", "user-1", "cap-old");
      assert.equal(oldRecord?.audioDeletedAt, NOW.toISOString());
      const freshRecord = await captures.getCapture(
        "tenant-a",
        "user-1",
        "cap-fresh",
      );
      assert.equal(freshRecord?.audioDeletedAt, undefined);
    });
  });

  it("treats audio exactly seven days old as expired", async () => {
    await withHarness(async ({ retention, audio, captures }) => {
      const boundary = captureAt(
        "cap-boundary",
        new Date(NOW.getTime() - RETENTION_MS),
      );
      await captures.saveCapture(boundary);
      await audio.put("tenant-a", "user-1", "cap-boundary", Buffer.from([3]));
      const result = await retention.cleanup("tenant-a", "user-1");
      assert.equal(result.deleted, 1);
      assert.equal(await audio.has("tenant-a", "user-1", "cap-boundary"), false);
    });
  });

  it("cleanup is idempotent: replay deletes nothing and restores nothing", async () => {
    await withHarness(async ({ retention, audio, captures }) => {
      const old = captureAt("cap-old", new Date(NOW.getTime() - 10 * DAY_MS));
      await captures.saveCapture(old);
      await audio.put("tenant-a", "user-1", "cap-old", Buffer.from([2]));

      await retention.cleanup("tenant-a", "user-1");
      const replay = await retention.cleanup("tenant-a", "user-1");
      assert.deepEqual(replay, {
        scanned: 1,
        expired: 1,
        deleted: 0,
        alreadyDeleted: 1,
      });
      assert.equal(await audio.has("tenant-a", "user-1", "cap-old"), false);
    });
  });

  it("reports transcript-only status after expiry (AC-5)", async () => {
    await withHarness(async ({ retention, audio, captures }) => {
      const old = captureAt("cap-old", new Date(NOW.getTime() - 8 * DAY_MS));
      await captures.saveCapture(old);
      await audio.put("tenant-a", "user-1", "cap-old", Buffer.from([2]));

      const before = await retention.status("tenant-a", "user-1", "cap-old");
      assert.equal(before?.audioAvailable, true);
      assert.equal(before?.transcriptOnly, false);
      assert.equal(
        before?.expiresAt,
        new Date(Date.parse(old.capturedAt) + RETENTION_MS).toISOString(),
      );

      await retention.cleanup("tenant-a", "user-1");
      const after = await retention.status("tenant-a", "user-1", "cap-old");
      assert.equal(after?.audioAvailable, false);
      assert.equal(after?.transcriptOnly, true);
      assert.equal(after?.audioDeletedAt, NOW.toISOString());
    });
  });

  it("appends a non-content audit entry per expiry", async () => {
    await withHarness(async ({ retention, audio, captures, audit }) => {
      const old = captureAt("cap-old", new Date(NOW.getTime() - 8 * DAY_MS));
      await captures.saveCapture(old);
      await audio.put("tenant-a", "user-1", "cap-old", Buffer.from([2]));
      await retention.cleanup("tenant-a", "user-1");

      const entries = await audit.list("tenant-a", "user-1");
      assert.equal(entries.length, 1);
      assert.deepEqual(entries[0], {
        at: NOW.toISOString(),
        op: "audio.expire",
        tenantId: "tenant-a",
        userId: "user-1",
        captureId: "cap-old",
        result: "ok",
        detail: "retention-expired",
      });
    });
  });

  it("never touches another tenant's audio", async () => {
    await withHarness(async ({ retention, audio, captures }) => {
      const oldA = captureAt("cap-old", new Date(NOW.getTime() - 8 * DAY_MS));
      const oldB: CaptureRecord = { ...oldA, tenantId: "tenant-b" };
      await captures.saveCapture(oldA);
      await captures.saveCapture(oldB);
      await audio.put("tenant-a", "user-1", "cap-old", Buffer.from([1]));
      await audio.put("tenant-b", "user-1", "cap-old", Buffer.from([2]));

      await retention.cleanup("tenant-a", "user-1");
      assert.equal(await audio.has("tenant-a", "user-1", "cap-old"), false);
      assert.equal(await audio.has("tenant-b", "user-1", "cap-old"), true);
    });
  });
});
