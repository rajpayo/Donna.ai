/**
 * Scoped file adapters for capture and transcript records
 * (Specification 1.2).
 *
 * Layout under DONNA_DATA_DIR:
 *   <tenant>/<user>/captures/<captureId>.json
 *   <tenant>/<user>/transcripts/<captureId>.json
 *
 * Isolation rules (SR-1/SR-2): every method takes an explicit tenant/user
 * scope; identifiers are validated so a malicious ID cannot traverse the
 * tree; a stored record whose scope or ID does not match its partition
 * fails closed with an error instead of falling back to an empty file; and
 * transcript reads re-verify the content hash so tampering is detected.
 */
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  hashTranscriptContent,
  type CaptureRecord,
  type CaptureStore,
  type TranscriptRecord,
  type TranscriptStore,
} from "@donna/core";
import { writePrivateFile } from "@donna/file-security";

const PARTITION_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const CAPTURE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertPartitionId(kind: "tenant" | "user", value: string): void {
  if (!PARTITION_ID.test(value)) {
    throw new Error(`Invalid ${kind} ID for file-backed storage`);
  }
}

export function assertCaptureId(value: string): void {
  if (!CAPTURE_ID.test(value)) {
    throw new Error("Invalid capture ID for file-backed storage");
  }
}

function assertScope(
  record: { tenantId: string; userId: string },
  tenantId: string,
  userId: string,
): void {
  if (record.tenantId !== tenantId || record.userId !== userId) {
    throw new Error("Stored record does not match its tenant/user partition");
  }
}

async function writeJson0600(
  path: string,
  value: unknown,
): Promise<void> {
  await writePrivateFile(path, JSON.stringify(value, null, 2));
}

async function readJsonIfPresent(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** Idempotent delete: a missing file is not an error. */
async function removeIfPresent(path: string): Promise<void> {
  await rm(path, { force: true });
}

export class FileCaptureStore implements CaptureStore {
  constructor(private readonly dataDir: string) {}

  private fileFor(tenantId: string, userId: string, captureId: string): string {
    assertPartitionId("tenant", tenantId);
    assertPartitionId("user", userId);
    assertCaptureId(captureId);
    return join(this.dataDir, tenantId, userId, "captures", `${captureId}.json`);
  }

  async saveCapture(record: CaptureRecord): Promise<void> {
    await writeJson0600(
      this.fileFor(record.tenantId, record.userId, record.id),
      record,
    );
  }

  async getCapture(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<CaptureRecord | undefined> {
    const raw = await readJsonIfPresent(
      this.fileFor(tenantId, userId, captureId),
    );
    if (raw === undefined) return undefined;
    const record = raw as CaptureRecord;
    assertScope(record, tenantId, userId);
    if (record.id !== captureId) {
      throw new Error("Stored record does not match its capture partition");
    }
    return record;
  }

  async listCaptures(
    tenantId: string,
    userId: string,
  ): Promise<CaptureRecord[]> {
    assertPartitionId("tenant", tenantId);
    assertPartitionId("user", userId);
    const dir = join(this.dataDir, tenantId, userId, "captures");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const records: CaptureRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const captureId = name.slice(0, -".json".length);
      const record = await this.getCapture(tenantId, userId, captureId);
      if (record !== undefined) records.push(record);
    }
    return records.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }

  async markAudioDeleted(
    tenantId: string,
    userId: string,
    captureId: string,
    deletedAt: string,
  ): Promise<void> {
    const record = await this.getCapture(tenantId, userId, captureId);
    if (record === undefined) {
      throw new Error("Capture does not exist in the requested tenant/user scope");
    }
    if (record.audioDeletedAt !== undefined) return; // idempotent
    record.audioDeletedAt = deletedAt;
    await this.saveCapture(record);
  }

  async deleteCapture(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<void> {
    await removeIfPresent(this.fileFor(tenantId, userId, captureId));
  }
}

export class FileTranscriptStore implements TranscriptStore {
  constructor(private readonly dataDir: string) {}

  private fileFor(tenantId: string, userId: string, captureId: string): string {
    assertPartitionId("tenant", tenantId);
    assertPartitionId("user", userId);
    assertCaptureId(captureId);
    return join(
      this.dataDir,
      tenantId,
      userId,
      "transcripts",
      `${captureId}.json`,
    );
  }

  async saveTranscript(record: TranscriptRecord): Promise<void> {
    await writeJson0600(
      this.fileFor(record.tenantId, record.userId, record.captureId),
      record,
    );
  }

  async getTranscript(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<TranscriptRecord | undefined> {
    const raw = await readJsonIfPresent(
      this.fileFor(tenantId, userId, captureId),
    );
    if (raw === undefined) return undefined;
    const record = raw as TranscriptRecord;
    assertScope(record, tenantId, userId);
    if (record.captureId !== captureId) {
      throw new Error("Stored record does not match its capture partition");
    }
    const recomputed = hashTranscriptContent({
      captureId: record.captureId,
      tenantId: record.tenantId,
      userId: record.userId,
      text: record.text,
      segments: record.segments,
      ...(record.language !== undefined ? { language: record.language } : {}),
      model: record.model,
    });
    if (recomputed !== record.contentHash) {
      throw new Error(
        "Stored transcript failed its content-integrity check",
      );
    }
    return record;
  }

  async deleteTranscript(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<void> {
    await removeIfPresent(this.fileFor(tenantId, userId, captureId));
  }
}
