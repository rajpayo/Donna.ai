/**
 * PostgreSQL memory, consent, and correction stores (Specification 3.2).
 *
 * Same contracts as the file adapters (Specifications 2.1/2.3): scoped
 * persistence only, no cross-user/cross-tenant listing anywhere (SR-1).
 * Memory and correction records upsert on their primary key (the
 * services update lifecycle fields in place); consent records and memory
 * events are append-only — the schema grants the app role INSERT/SELECT
 * only on those tables, so history cannot be rewritten through the app.
 */
import type pg from "pg";
import type {
  ConsentRecord,
  ConsentStore,
  CorrectionEvent,
  CorrectionStore,
  MemoryEvent,
  MemoryProposal,
  MemoryRecord,
  MemoryStore,
} from "@donna/core";
import { scoped } from "./client.js";
import {
  consentFromRow,
  correctionFromRow,
  memoryEventFromRow,
  memoryFromRow,
  proposalFromRow,
} from "./rows.js";

export class PostgresMemoryStore implements MemoryStore {
  constructor(private readonly pool: pg.Pool) {}

  async saveMemory(record: MemoryRecord): Promise<void> {
    await scoped(
      this.pool,
      { tenantId: record.tenantId, userId: record.userId },
      async (client) => {
        await client.query(
          `INSERT INTO memories
             (tenant_id, user_id, id, layer, status, origin, text, kind,
              subject, confidence, sources, created_at, updated_at,
              expires_at, session_id, superseded_by, superseded_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (tenant_id, user_id, id) DO UPDATE SET
             layer = EXCLUDED.layer,
             status = EXCLUDED.status,
             origin = EXCLUDED.origin,
             text = EXCLUDED.text,
             kind = EXCLUDED.kind,
             subject = EXCLUDED.subject,
             confidence = EXCLUDED.confidence,
             sources = EXCLUDED.sources,
             created_at = EXCLUDED.created_at,
             updated_at = EXCLUDED.updated_at,
             expires_at = EXCLUDED.expires_at,
             session_id = EXCLUDED.session_id,
             superseded_by = EXCLUDED.superseded_by,
             superseded_at = EXCLUDED.superseded_at`,
          [
            record.tenantId,
            record.userId,
            record.id,
            record.layer,
            record.status,
            record.origin,
            record.text,
            record.kind,
            record.subject,
            record.confidence,
            JSON.stringify(record.sources),
            record.createdAt,
            record.updatedAt,
            record.expiresAt ?? null,
            record.sessionId ?? null,
            record.supersededBy ?? null,
            record.supersededAt ?? null,
          ],
        );
      },
    );
  }

  async getMemory(
    tenantId: string,
    userId: string,
    memoryId: string,
  ): Promise<MemoryRecord | undefined> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      const result = await client.query(
        `SELECT * FROM memories
          WHERE tenant_id = $1 AND user_id = $2 AND id = $3`,
        [tenantId, userId, memoryId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : memoryFromRow(row);
    });
  }

  async listMemories(tenantId: string, userId: string): Promise<MemoryRecord[]> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      const result = await client.query(
        `SELECT * FROM memories
          WHERE tenant_id = $1 AND user_id = $2
          ORDER BY created_at, id`,
        [tenantId, userId],
      );
      return result.rows.map(memoryFromRow);
    });
  }

  async deleteMemory(
    tenantId: string,
    userId: string,
    memoryId: string,
  ): Promise<boolean> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      const result = await client.query(
        `DELETE FROM memories
          WHERE tenant_id = $1 AND user_id = $2 AND id = $3`,
        [tenantId, userId, memoryId],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async saveProposal(proposal: MemoryProposal): Promise<void> {
    await scoped(
      this.pool,
      { tenantId: proposal.tenantId, userId: proposal.userId },
      async (client) => {
        await client.query(
          `INSERT INTO memory_proposals
             (tenant_id, user_id, id, layer, text, kind, subject,
              confidence, sources, proposed_by, created_at, status,
              resolved_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (tenant_id, user_id, id) DO UPDATE SET
             status = EXCLUDED.status,
             resolved_at = EXCLUDED.resolved_at`,
          [
            proposal.tenantId,
            proposal.userId,
            proposal.id,
            proposal.layer,
            proposal.text,
            proposal.kind,
            proposal.subject,
            proposal.confidence,
            JSON.stringify(proposal.sources),
            JSON.stringify(proposal.proposedBy),
            proposal.createdAt,
            proposal.status,
            proposal.resolvedAt ?? null,
          ],
        );
      },
    );
  }

  async getProposal(
    tenantId: string,
    userId: string,
    proposalId: string,
  ): Promise<MemoryProposal | undefined> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      const result = await client.query(
        `SELECT * FROM memory_proposals
          WHERE tenant_id = $1 AND user_id = $2 AND id = $3`,
        [tenantId, userId, proposalId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : proposalFromRow(row);
    });
  }

  async listProposals(tenantId: string, userId: string): Promise<MemoryProposal[]> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      const result = await client.query(
        `SELECT * FROM memory_proposals
          WHERE tenant_id = $1 AND user_id = $2
          ORDER BY created_at, id`,
        [tenantId, userId],
      );
      return result.rows.map(proposalFromRow);
    });
  }

  async deleteProposal(
    tenantId: string,
    userId: string,
    proposalId: string,
  ): Promise<boolean> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      const result = await client.query(
        `DELETE FROM memory_proposals
          WHERE tenant_id = $1 AND user_id = $2 AND id = $3`,
        [tenantId, userId, proposalId],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async appendEvent(event: MemoryEvent): Promise<void> {
    await scoped(
      this.pool,
      { tenantId: event.tenantId, userId: event.userId },
      async (client) => {
        await client.query(
          `INSERT INTO memory_events
             (at, type, tenant_id, user_id, memory_id, proposal_id, detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            event.at,
            event.type,
            event.tenantId,
            event.userId,
            event.memoryId ?? null,
            event.proposalId ?? null,
            event.detail ?? null,
          ],
        );
      },
    );
  }

  async listEvents(tenantId: string, userId: string): Promise<MemoryEvent[]> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      const result = await client.query(
        `SELECT * FROM memory_events
          WHERE tenant_id = $1 AND user_id = $2
          ORDER BY seq`,
        [tenantId, userId],
      );
      return result.rows.map(memoryEventFromRow);
    });
  }
}

export class PostgresConsentStore implements ConsentStore {
  constructor(private readonly pool: pg.Pool) {}

  async recordConsent(record: ConsentRecord): Promise<void> {
    await scoped(
      this.pool,
      { tenantId: record.tenantId, userId: record.userId },
      async (client) => {
        // Append-only: a re-recorded ID is a no-op; new decisions get new
        // IDs, so history is never rewritten.
        await client.query(
          `INSERT INTO consents
             (id, tenant_id, user_id, purpose, granted, granted_at, channel)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (tenant_id, user_id, id) DO NOTHING`,
          [
            record.id,
            record.tenantId,
            record.userId,
            record.purpose,
            record.granted,
            record.grantedAt,
            record.channel,
          ],
        );
      },
    );
  }

  async listConsents(tenantId: string, userId: string): Promise<ConsentRecord[]> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      const result = await client.query(
        `SELECT * FROM consents
          WHERE tenant_id = $1 AND user_id = $2
          ORDER BY granted_at, id`,
        [tenantId, userId],
      );
      return result.rows.map(consentFromRow);
    });
  }
}

export class PostgresCorrectionStore implements CorrectionStore {
  constructor(private readonly pool: pg.Pool) {}

  async saveCorrection(event: CorrectionEvent): Promise<void> {
    await scoped(
      this.pool,
      { tenantId: event.tenantId, userId: event.userId },
      async (client) => {
        // Lifecycle fields update in place; payload and sources are
        // immutable by contract (FR-1) and are not re-written here.
        await client.query(
          `INSERT INTO corrections
             (id, tenant_id, user_id, type, created_at, target, payload,
              sources, status, resolved_at, applied_at, contradicted_by,
              shared_at, followed_count, contradicted_count)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (tenant_id, user_id, id) DO UPDATE SET
             status = EXCLUDED.status,
             resolved_at = EXCLUDED.resolved_at,
             applied_at = EXCLUDED.applied_at,
             contradicted_by = EXCLUDED.contradicted_by,
             shared_at = EXCLUDED.shared_at,
             followed_count = EXCLUDED.followed_count,
             contradicted_count = EXCLUDED.contradicted_count`,
          [
            event.id,
            event.tenantId,
            event.userId,
            event.type,
            event.createdAt,
            JSON.stringify(event.target),
            JSON.stringify(event.payload),
            JSON.stringify(event.sources),
            event.status,
            event.resolvedAt ?? null,
            event.appliedAt ?? null,
            event.contradictedBy ?? null,
            event.sharedAt ?? null,
            event.followedCount,
            event.contradictedCount,
          ],
        );
      },
    );
  }

  async getCorrection(
    tenantId: string,
    userId: string,
    correctionId: string,
  ): Promise<CorrectionEvent | undefined> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      const result = await client.query(
        `SELECT * FROM corrections
          WHERE tenant_id = $1 AND user_id = $2 AND id = $3`,
        [tenantId, userId, correctionId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : correctionFromRow(row);
    });
  }

  async listCorrections(tenantId: string, userId: string): Promise<CorrectionEvent[]> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      const result = await client.query(
        `SELECT * FROM corrections
          WHERE tenant_id = $1 AND user_id = $2
          ORDER BY created_at, id`,
        [tenantId, userId],
      );
      return result.rows.map(correctionFromRow);
    });
  }

  async deleteCorrection(
    tenantId: string,
    userId: string,
    correctionId: string,
  ): Promise<boolean> {
    return scoped(this.pool, { tenantId, userId }, async (client) => {
      const result = await client.query(
        `DELETE FROM corrections
          WHERE tenant_id = $1 AND user_id = $2 AND id = $3`,
        [tenantId, userId, correctionId],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}
