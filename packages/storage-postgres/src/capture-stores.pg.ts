/**
 * PostgreSQL capture and transcript stores (Specification 3.2).
 *
 * Same contracts as the file adapters (Specification 1.2): scoped reads
 * and writes, idempotent deletes, transcript reads re-verify the content
 * hash and fail closed on tampering. All statements are parameterized
 * (SR-4) and run inside scoped transactions (SR-1).
 */
import type pg from "pg";
import {
  hashTranscriptContent,
  type CaptureRecord,
  type CaptureStore,
  type TranscriptRecord,
  type TranscriptStore,
} from "@donna/core";
import { scoped } from "./client.js";
import { captureFromRow, transcriptFromRow } from "./rows.js";

export class PostgresCaptureStore implements CaptureStore {
  constructor(private readonly pool: pg.Pool) {}

  async saveCapture(record: CaptureRecord): Promise<void> {
    await scoped(
      this.pool,
      { tenantId: record.tenantId, userId: record.userId },
      async (client) => {
        // Idempotent create: re-saving the same capture changes nothing.
        await client.query(
          `INSERT INTO captures
             (tenant_id, user_id, id, content_hash, captured_at,
              duration_sec, audio_deleted_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (tenant_id, user_id, id) DO NOTHING`,
          [
            record.tenantId,
            record.userId,
            record.id,
            record.contentHash,
            record.capturedAt,
            record.durationSec ?? null,
            record.audioDeletedAt ?? null,
          ],
        );
      },
    );
  }

  async getCapture(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<CaptureRecord | undefined> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      const result = await client.query(
        `SELECT * FROM captures
          WHERE tenant_id = $1 AND user_id = $2 AND id = $3`,
        [tenantId, userId, captureId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : captureFromRow(row);
    });
  }

  async listCaptures(tenantId: string, userId: string): Promise<CaptureRecord[]> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      const result = await client.query(
        `SELECT * FROM captures
          WHERE tenant_id = $1 AND user_id = $2
          ORDER BY captured_at, id`,
        [tenantId, userId],
      );
      return result.rows.map(captureFromRow);
    });
  }

  async markAudioDeleted(
    tenantId: string,
    userId: string,
    captureId: string,
    deletedAt: string,
  ): Promise<void> {
    await scoped(this.pool, { tenantId, userId }, async (client) => {
      const updated = await client.query(
        `UPDATE captures SET audio_deleted_at = $4
          WHERE tenant_id = $1 AND user_id = $2 AND id = $3
            AND audio_deleted_at IS NULL`,
        [tenantId, userId, captureId, deletedAt],
      );
      if (updated.rowCount === 1) return;
      // Idempotent: already marked. Missing capture: fail closed.
      const exists = await client.query(
        `SELECT 1 FROM captures
          WHERE tenant_id = $1 AND user_id = $2 AND id = $3`,
        [tenantId, userId, captureId],
      );
      if (exists.rows.length === 0) {
        throw new Error("Capture does not exist in the requested tenant/user scope");
      }
    });
  }

  async deleteCapture(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<void> {
    await scoped(this.pool, { tenantId, userId }, async (client) => {
      // Idempotent: deleting an absent capture is not an error. The
      // transcript cascades; items are removed by the bucket store.
      await client.query(
        `DELETE FROM captures
          WHERE tenant_id = $1 AND user_id = $2 AND id = $3`,
        [tenantId, userId, captureId],
      );
    });
  }
}

export class PostgresTranscriptStore implements TranscriptStore {
  constructor(private readonly pool: pg.Pool) {}

  async saveTranscript(record: TranscriptRecord): Promise<void> {
    await scoped(
      this.pool,
      { tenantId: record.tenantId, userId: record.userId },
      async (client) => {
        await client.query(
          `INSERT INTO transcripts
             (tenant_id, user_id, capture_id, text, segments, language,
              model, content_hash, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (tenant_id, user_id, capture_id) DO NOTHING`,
          [
            record.tenantId,
            record.userId,
            record.captureId,
            record.text,
            JSON.stringify(record.segments),
            record.language ?? null,
            record.model,
            record.contentHash,
            record.createdAt,
          ],
        );
      },
    );
  }

  async getTranscript(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<TranscriptRecord | undefined> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      const result = await client.query(
        `SELECT * FROM transcripts
          WHERE tenant_id = $1 AND user_id = $2 AND capture_id = $3`,
        [tenantId, userId, captureId],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      const record = transcriptFromRow(row);
      // Same tamper-evidence contract as the file store: re-verify the
      // content hash on every read and fail closed on mismatch.
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
        throw new Error("Stored transcript failed its content-integrity check");
      }
      return record;
    });
  }

  async deleteTranscript(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<void> {
    await scoped(this.pool, { tenantId, userId }, async (client) => {
      await client.query(
        `DELETE FROM transcripts
          WHERE tenant_id = $1 AND user_id = $2 AND capture_id = $3`,
        [tenantId, userId, captureId],
      );
    });
  }
}
