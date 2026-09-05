/**
 * File-backed pending-placement store (Specification 6.7 FR-8/FR-9).
 *
 * One JSON file per user under DONNA_DATA_DIR, sibling to the bucket
 * store, with the same partition validation and private permissions.
 * Records survive CLI restarts, are never read by retrieval, and are
 * covered by export/deletion flows. Resolution is idempotent: replaying
 * the same resolution returns the stored record; a conflicting replay
 * fails closed.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  PendingPlacement,
  PendingPlacementResolution,
  PendingPlacementStore,
} from "@donna/core";
import { writePrivateFile } from "@donna/file-security";

interface PendingFile {
  pendingPlacements: PendingPlacement[];
}

const EMPTY: PendingFile = { pendingPlacements: [] };
const PARTITION_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

function assertPartitionId(kind: "tenant" | "user", value: string): void {
  if (!PARTITION_ID.test(value)) {
    throw new Error(`Invalid ${kind} ID for file-backed storage`);
  }
}

export class FilePendingPlacementStore implements PendingPlacementStore {
  /** In-process per-file serialization, same rationale as FileBucketStore. */
  private static locks = new Map<string, Promise<void>>();

  constructor(private readonly dataDir: string) {}

  private async withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
    const prior = FilePendingPlacementStore.locks.get(file) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((res) => {
      release = res;
    });
    FilePendingPlacementStore.locks.set(file, prior.then(() => current));
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private fileFor(tenantId: string, userId: string): string {
    assertPartitionId("tenant", tenantId);
    assertPartitionId("user", userId);
    return join(this.dataDir, tenantId, `${userId}.pending.json`);
  }

  private async load(tenantId: string, userId: string): Promise<PendingFile> {
    let raw: string;
    try {
      raw = await readFile(this.fileFor(tenantId, userId), "utf8");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return structuredClone(EMPTY);
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as Partial<PendingFile>;
    if (!Array.isArray(parsed.pendingPlacements)) {
      throw new Error("Invalid file-backed pending-placement data");
    }
    if (
      parsed.pendingPlacements.some(
        (record) =>
          record.tenantId !== tenantId ||
          record.userId !== userId ||
          record.thought.tenantId !== tenantId ||
          record.thought.userId !== userId,
      )
    ) {
      throw new Error("Stored data does not match its tenant/user partition");
    }
    return parsed as PendingFile;
  }

  private async write(
    tenantId: string,
    userId: string,
    data: PendingFile,
  ): Promise<void> {
    await writePrivateFile(
      this.fileFor(tenantId, userId),
      JSON.stringify(data, null, 2),
    );
  }

  async save(record: PendingPlacement): Promise<void> {
    return this.withLock(this.fileFor(record.tenantId, record.userId), async () => {
      const data = await this.load(record.tenantId, record.userId);
      if (data.pendingPlacements.some((existing) => existing.id === record.id)) {
        throw new Error("Pending placement ID already exists in this scope");
      }
      data.pendingPlacements.push(record);
      await this.write(record.tenantId, record.userId, data);
    });
  }

  async get(
    tenantId: string,
    userId: string,
    id: string,
  ): Promise<PendingPlacement | undefined> {
    return (await this.load(tenantId, userId)).pendingPlacements.find(
      (record) => record.id === id,
    );
  }

  async list(
    tenantId: string,
    userId: string,
    status?: "pending" | "resolved",
  ): Promise<PendingPlacement[]> {
    const records = (await this.load(tenantId, userId)).pendingPlacements;
    return status === undefined
      ? records
      : records.filter((record) => record.status === status);
  }

  async markResolved(
    tenantId: string,
    userId: string,
    id: string,
    resolution: PendingPlacementResolution,
    resolvedAt: string,
  ): Promise<PendingPlacement> {
    return this.withLock(this.fileFor(tenantId, userId), async () => {
    const data = await this.load(tenantId, userId);
    const record = data.pendingPlacements.find((existing) => existing.id === id);
    if (record === undefined) {
      throw new Error("Pending placement does not exist in the requested tenant/user scope");
    }
    if (record.status === "resolved") {
      // Idempotent replay: an identical resolution is a no-op; a
      // conflicting one fails closed (never a double write).
      const same =
        record.resolution?.action === resolution.action &&
        record.resolution?.bucketId === resolution.bucketId &&
        record.resolution?.name === resolution.name;
      if (same) return record;
      throw new Error("Pending placement already resolved with a different action");
    }
    record.status = "resolved";
    record.resolution = resolution;
    record.resolvedAt = resolvedAt;
    await this.write(tenantId, userId, data);
    return record;
    });
  }

  async deleteAll(
    tenantId: string,
    userId: string,
  ): Promise<{ removed: number }> {
    return this.withLock(this.fileFor(tenantId, userId), async () => {
    const data = await this.load(tenantId, userId);
    const removed = data.pendingPlacements.length;
    if (removed === 0) return { removed: 0 };
    data.pendingPlacements = [];
    await this.write(tenantId, userId, data);
    return { removed };
    });
  }

  async deleteForCapture(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<{ removed: number }> {
    return this.withLock(this.fileFor(tenantId, userId), async () => {
    const data = await this.load(tenantId, userId);
    const kept = data.pendingPlacements.filter(
      (record) => record.thought.provenance.captureId !== captureId,
    );
    const removed = data.pendingPlacements.length - kept.length;
    if (removed === 0) return { removed: 0 };
    data.pendingPlacements = kept;
    await this.write(tenantId, userId, data);
    return { removed };
    });
  }
}
