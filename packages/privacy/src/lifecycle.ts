/**
 * User data controls (Spec 1.3): scoped export, early audio deletion, and
 * complete capture deletion.
 *
 * Deletion propagates through every derived record that exists today:
 * encrypted audio, the capture record, the transcript, and all bucket
 * items (thoughts + embeddings) derived from the capture, with bucket
 * stats repaired by the store. Each deletion step is idempotent, so a
 * failed run can be retried; any step that cannot complete is reported
 * explicitly via CaptureDeletionError instead of being silently skipped
 * (FR-4). Every operation appends a non-content audit entry.
 */
import type {
  AudioStore,
  AuditLog,
  BucketStore,
  CaptureRecord,
  CaptureStore,
  Thought,
  TranscriptRecord,
  TranscriptStore,
} from "@donna/core";
import { assertCaptureId, assertPartitionId } from "./audio-store.file.js";

export interface LifecycleDeps {
  audio: AudioStore;
  captures: CaptureStore;
  transcripts: TranscriptStore;
  buckets: BucketStore;
  audit?: AuditLog;
  /** Injectable clock. */
  now: () => Date;
  /**
   * Additional derived projections that must be deleted with a capture
   * (e.g. future retrieval indexes or agent drafts). Each projection runs
   * as its own deletion step; a throwing projection fails the deletion
   * explicitly and retryably.
   */
  extraProjections?: Array<{
    name: string;
    deleteForCapture(
      tenantId: string,
      userId: string,
      captureId: string,
    ): Promise<void>;
  }>;
}

export interface CaptureExport {
  schema: "donna.capture-export.v1";
  exportedAt: string;
  capture: CaptureRecord;
  transcript: TranscriptRecord | null;
  thoughts: Array<{
    thought: Thought;
    bucketId: string;
    bucketName: string | null;
  }>;
  audioAvailable: boolean;
}

export class CaptureNotFoundError extends Error {
  constructor() {
    super("Capture does not exist in the requested tenant/user scope");
    this.name = "CaptureNotFoundError";
  }
}

/** Complete deletion left these targets un-deleted; safe to retry. */
export class CaptureDeletionError extends Error {
  constructor(readonly remaining: string[]) {
    super(
      `Capture deletion incomplete; retry after resolving: ${remaining.join(", ")}`,
    );
    this.name = "CaptureDeletionError";
  }
}

export class CaptureLifecycleService {
  constructor(private readonly deps: LifecycleDeps) {}

  private async audit(
    entry: Omit<Parameters<AuditLog["append"]>[0], "at">,
  ): Promise<void> {
    await this.deps.audit?.append({
      ...entry,
      at: this.deps.now().toISOString(),
    });
  }

  private async requireCapture(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<CaptureRecord> {
    const capture = await this.deps.captures.getCapture(
      tenantId,
      userId,
      captureId,
    );
    if (capture === undefined) throw new CaptureNotFoundError();
    return capture;
  }

  /** Scoped export: the requesting partition's data only (AC-4). */
  async exportCapture(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<CaptureExport> {
    const capture = await this.requireCapture(tenantId, userId, captureId);
    const transcript =
      (await this.deps.transcripts.getTranscript(tenantId, userId, captureId)) ??
      null;
    const [items, buckets] = await Promise.all([
      this.deps.buckets.listItems(tenantId, userId),
      this.deps.buckets.listBuckets(tenantId, userId),
    ]);
    const bucketNames = new Map(buckets.map((b) => [b.id, b.name]));
    const thoughts = items
      .filter((item) => item.thought.provenance.captureId === captureId)
      .map((item) => ({
        thought: item.thought,
        bucketId: item.bucketId,
        bucketName: bucketNames.get(item.bucketId) ?? null,
      }));
    const audioAvailable =
      capture.audioDeletedAt === undefined &&
      (await this.deps.audio.has(tenantId, userId, captureId));
    await this.audit({
      op: "capture.export",
      tenantId,
      userId,
      captureId,
      result: "ok",
      detail: `thoughts=${thoughts.length}`,
    });
    return {
      schema: "donna.capture-export.v1",
      exportedAt: this.deps.now().toISOString(),
      capture,
      transcript,
      thoughts,
      audioAvailable,
    };
  }

  /** Early audio deletion: transcript and thoughts remain (AC-5). */
  async deleteAudio(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<void> {
    await this.requireCapture(tenantId, userId, captureId);
    const removed = await this.deps.audio.delete(tenantId, userId, captureId);
    await this.deps.captures.markAudioDeleted(
      tenantId,
      userId,
      captureId,
      this.deps.now().toISOString(),
    );
    await this.audit({
      op: "audio.delete",
      tenantId,
      userId,
      captureId,
      result: "ok",
      detail: removed ? "deleted" : "already-deleted",
    });
  }

  /**
   * Complete capture deletion across every derived record. Idempotent
   * (AC-3): replaying after success reports "already-deleted" and never
   * restores data; replaying after a partial failure finishes the job.
   * Throws CaptureDeletionError naming anything that could not be deleted.
   */
  async deleteCapture(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<void> {
    // Fail fast on hostile identifiers before any deletion step runs.
    assertPartitionId("tenant", tenantId);
    assertPartitionId("user", userId);
    assertCaptureId(captureId);

    const [capture, audioPresent, transcript, items] = await Promise.all([
      this.deps.captures.getCapture(tenantId, userId, captureId),
      this.deps.audio.has(tenantId, userId, captureId),
      this.deps.transcripts.getTranscript(tenantId, userId, captureId),
      this.deps.buckets.listItems(tenantId, userId),
    ]);
    const anythingExisted =
      capture !== undefined ||
      audioPresent ||
      transcript !== undefined ||
      items.some((item) => item.thought.provenance.captureId === captureId);

    const steps: Array<{ name: string; run: () => Promise<void> }> = [
      {
        name: "audio",
        run: async () => {
          await this.deps.audio.delete(tenantId, userId, captureId);
        },
      },
      {
        name: "thoughts-and-embeddings",
        run: async () => {
          await this.deps.buckets.deleteItemsForCapture(
            tenantId,
            userId,
            captureId,
          );
        },
      },
      {
        name: "transcript",
        run: async () => {
          await this.deps.transcripts.deleteTranscript(
            tenantId,
            userId,
            captureId,
          );
        },
      },
      {
        name: "capture-record",
        run: async () => {
          await this.deps.captures.deleteCapture(tenantId, userId, captureId);
        },
      },
      ...(this.deps.extraProjections ?? []).map((projection) => ({
        name: projection.name,
        run: () => projection.deleteForCapture(tenantId, userId, captureId),
      })),
    ];

    const remaining: string[] = [];
    for (const step of steps) {
      try {
        await step.run();
      } catch {
        remaining.push(step.name);
      }
    }
    if (remaining.length > 0) {
      await this.audit({
        op: "capture.delete",
        tenantId,
        userId,
        captureId,
        result: "error",
        detail: `remaining=${remaining.join(",")}`,
      });
      throw new CaptureDeletionError(remaining);
    }
    await this.audit({
      op: "capture.delete",
      tenantId,
      userId,
      captureId,
      result: "ok",
      detail: anythingExisted ? "deleted" : "already-deleted",
    });
  }
}
