/**
 * PostgreSQL pending-placement store (Specification 6.7 FR-8/FR-9, SR-5).
 *
 * Parity with the file store: every method runs in ONE scoped transaction
 * (RLS pinned), every query is parameterized, and resolution is
 * idempotent — markResolved applies the pending→resolved transition with
 * a status-guarded UPDATE; an identical replay returns the stored record,
 * a conflicting replay fails closed.
 */
import type pg from "pg";
import type {
  PendingPlacement,
  PendingPlacementResolution,
  PendingPlacementStore,
  Thought,
} from "@donna/core";
import { isoString, scoped } from "./client.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

function pendingFromRow(row: any): PendingPlacement {
  const resolvedAt = isoString(row.resolved_at);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    thought: row.thought as Thought,
    proposal: row.proposal ?? null,
    reason: row.reason,
    ...(row.naming_failures !== null && row.naming_failures !== undefined
      ? { namingFailures: row.naming_failures }
      : {}),
    candidates: row.candidates,
    ...(row.recommended_bucket_id !== null &&
    row.recommended_bucket_id !== undefined
      ? { recommendedBucketId: row.recommended_bucket_id }
      : {}),
    allowlistHash: row.allowlist_hash,
    createdAt: isoString(row.created_at)!,
    status: row.status,
    ...(row.resolution !== null && row.resolution !== undefined
      ? { resolution: row.resolution }
      : {}),
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
  };
}

export class PostgresPendingPlacementStore implements PendingPlacementStore {
  constructor(private readonly pool: pg.Pool) {}

  async save(record: PendingPlacement): Promise<void> {
    await scoped(
      this.pool,
      { tenantId: record.tenantId, userId: record.userId },
      async (client) => {
        await client.query(
          `INSERT INTO pending_placements
             (tenant_id, user_id, id, thought, proposal, reason,
              naming_failures, candidates, recommended_bucket_id,
              allowlist_hash, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            record.tenantId,
            record.userId,
            record.id,
            JSON.stringify(record.thought),
            record.proposal === null ? null : JSON.stringify(record.proposal),
            record.reason,
            record.namingFailures === undefined
              ? null
              : JSON.stringify(record.namingFailures),
            JSON.stringify(record.candidates),
            record.recommendedBucketId ?? null,
            record.allowlistHash,
            record.status,
            record.createdAt,
          ],
        );
      },
    );
  }

  async get(
    tenantId: string,
    userId: string,
    id: string,
  ): Promise<PendingPlacement | undefined> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      const result = await client.query(
        `SELECT * FROM pending_placements
          WHERE tenant_id = $1 AND user_id = $2 AND id = $3`,
        [tenantId, userId, id],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : pendingFromRow(row);
    });
  }

  async list(
    tenantId: string,
    userId: string,
    status?: "pending" | "resolved",
  ): Promise<PendingPlacement[]> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      const result = await client.query(
        `SELECT * FROM pending_placements
          WHERE tenant_id = $1 AND user_id = $2
            AND ($3::text IS NULL OR status = $3)
          ORDER BY created_at, id`,
        [tenantId, userId, status ?? null],
      );
      return result.rows.map(pendingFromRow);
    });
  }

  async markResolved(
    tenantId: string,
    userId: string,
    id: string,
    resolution: PendingPlacementResolution,
    resolvedAt: string,
  ): Promise<PendingPlacement> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      // Atomic status-guarded transition: only a still-pending row moves.
      const updated = await client.query(
        `UPDATE pending_placements
            SET status = 'resolved', resolution = $4, resolved_at = $5
          WHERE tenant_id = $1 AND user_id = $2 AND id = $3
            AND status = 'pending'`,
        [tenantId, userId, id, JSON.stringify(resolution), resolvedAt],
      );
      const current = await client.query(
        `SELECT * FROM pending_placements
          WHERE tenant_id = $1 AND user_id = $2 AND id = $3`,
        [tenantId, userId, id],
      );
      const row = current.rows[0];
      if (row === undefined) {
        throw new Error("Pending placement does not exist in the requested tenant/user scope");
      }
      const record = pendingFromRow(row);
      if ((updated.rowCount ?? 0) === 0) {
        // Idempotent replay: identical resolution is a no-op; a
        // conflicting replay fails closed (never a double write).
        const existing = record.resolution;
        const same =
          existing?.action === resolution.action &&
          existing?.bucketId === resolution.bucketId &&
          existing?.name === resolution.name;
        if (same) return record;
        throw new Error("Pending placement already resolved with a different action");
      }
      return record;
    });
  }

  async deleteAll(
    tenantId: string,
    userId: string,
  ): Promise<{ removed: number }> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      const deleted = await client.query(
        `DELETE FROM pending_placements
          WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId],
      );
      return { removed: deleted.rowCount ?? 0 };
    });
  }

  async deleteForCapture(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<{ removed: number }> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      const deleted = await client.query(
        `DELETE FROM pending_placements
          WHERE tenant_id = $1 AND user_id = $2
            AND thought -> 'provenance' ->> 'captureId' = $3`,
        [tenantId, userId, captureId],
      );
      return { removed: deleted.rowCount ?? 0 };
    });
  }
}
