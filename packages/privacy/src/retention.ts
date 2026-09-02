/**
 * Seven-day audio retention (Spec 1.3).
 *
 * Retention is calculated from the capture's recorded capture time. The
 * clock is injectable so expiry behavior is deterministically testable.
 * Cleanup is idempotent and retry-safe: expired audio is deleted, the
 * capture record is marked `audioDeletedAt`, and every operation appends a
 * non-content audit entry. Transcripts and thoughts are never touched —
 * provenance becomes transcript-only after audio expiry.
 */
import type {
  AudioStore,
  AuditLog,
  CaptureStore,
} from "@donna/core";

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface RetentionDeps {
  audio: AudioStore;
  captures: CaptureStore;
  audit?: AuditLog;
  /** Injectable clock. */
  now: () => Date;
  /** Override for tests; defaults to seven days. */
  retentionMs?: number;
}

export interface RetentionStatus {
  captureId: string;
  capturedAt: string;
  /** When the audio expires/expired. */
  expiresAt: string;
  audioAvailable: boolean;
  /** True once audio is gone but the transcript/thoughts remain. */
  transcriptOnly: boolean;
  audioDeletedAt?: string;
}

export interface CleanupResult {
  scanned: number;
  expired: number;
  deleted: number;
  alreadyDeleted: number;
}

export class RetentionService {
  private readonly retentionMs: number;

  constructor(private readonly deps: RetentionDeps) {
    this.retentionMs = deps.retentionMs ?? RETENTION_MS;
  }

  expiresAt(capturedAt: string): Date {
    return new Date(Date.parse(capturedAt) + this.retentionMs);
  }

  async status(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<RetentionStatus | undefined> {
    const capture = await this.deps.captures.getCapture(
      tenantId,
      userId,
      captureId,
    );
    if (capture === undefined) return undefined;
    const audioAvailable =
      capture.audioDeletedAt === undefined &&
      (await this.deps.audio.has(tenantId, userId, captureId));
    return {
      captureId,
      capturedAt: capture.capturedAt,
      expiresAt: this.expiresAt(capture.capturedAt).toISOString(),
      audioAvailable,
      transcriptOnly: !audioAvailable,
      ...(capture.audioDeletedAt !== undefined
        ? { audioDeletedAt: capture.audioDeletedAt }
        : {}),
    };
  }

  async statusAll(
    tenantId: string,
    userId: string,
  ): Promise<RetentionStatus[]> {
    const captures = await this.deps.captures.listCaptures(tenantId, userId);
    const statuses: RetentionStatus[] = [];
    for (const capture of captures) {
      const s = await this.status(tenantId, userId, capture.id);
      if (s !== undefined) statuses.push(s);
    }
    return statuses;
  }

  /** Idempotent: safe to run repeatedly and after partial failures. */
  async cleanup(tenantId: string, userId: string): Promise<CleanupResult> {
    const now = this.deps.now();
    const captures = await this.deps.captures.listCaptures(tenantId, userId);
    const result: CleanupResult = {
      scanned: captures.length,
      expired: 0,
      deleted: 0,
      alreadyDeleted: 0,
    };
    for (const capture of captures) {
      if (this.expiresAt(capture.capturedAt) > now) continue;
      result.expired += 1;
      if (capture.audioDeletedAt !== undefined) {
        result.alreadyDeleted += 1;
        continue;
      }
      await this.deps.audio.delete(tenantId, userId, capture.id);
      await this.deps.captures.markAudioDeleted(
        tenantId,
        userId,
        capture.id,
        now.toISOString(),
      );
      result.deleted += 1;
      await this.deps.audit?.append({
        at: now.toISOString(),
        op: "audio.expire",
        tenantId,
        userId,
        captureId: capture.id,
        result: "ok",
        detail: "retention-expired",
      });
    }
    return result;
  }
}
