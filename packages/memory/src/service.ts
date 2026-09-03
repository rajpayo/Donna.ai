/**
 * Memory lifecycle service (Specification 2.1).
 *
 * All policy lives here; the stores are plain persistence. The rules:
 *
 *   - FR-1: durable memory exists only via an explicit user statement
 *     (`stateExplicit`) or visible approval of a quarantined proposal
 *     (`approve`). Proposals never influence context while pending, and a
 *     rejected proposal is permanently out of consideration (AC-3).
 *   - FR-2: every memory carries at least one source link and the reason
 *     it exists; a memory whose last source is deleted is removed.
 *   - FR-3: conflicting memory is never silently overwritten. Stating or
 *     approving text that conflicts with an existing confirmed memory
 *     records a `conflict` event; resolution is an explicit `supersede`
 *     that retires the old record.
 *   - FR-4: working memory is bound to a session and always carries an
 *     expiry; `expireSession`/`sweepExpired` remove it deterministically.
 *   - SR-4: model-generated proposals are screened for secrets,
 *     credentials, and regulated identifiers before they are persisted.
 */
import { randomUUID } from "node:crypto";
import type {
  ConsentRecord,
  ConsentStore,
  MemoryEvent,
  MemoryLayer,
  MemoryProposal,
  MemoryRecord,
  MemorySource,
  MemoryStore,
} from "@donna/core";
import { screenSensitiveContent, SensitiveContentError } from "./screening.js";

export { SensitiveContentError };

export interface Scope {
  tenantId: string;
  userId: string;
}

export interface MemoryServiceDeps {
  memories: MemoryStore;
  consents: ConsentStore;
  /** Injectable clock for deterministic TTL/expiry tests. */
  now: () => Date;
  /** Injectable ID generator for deterministic tests. */
  idGen?: () => string;
}

export interface MemoryInput {
  layer: MemoryLayer;
  kind: string;
  subject: string;
  text: string;
  sources: MemorySource[];
  confidence?: number;
  /** ISO expiry; required for working memory, optional otherwise. */
  expiresAt?: string;
  sessionId?: string;
}

export interface MemoryExport {
  schema: "donna.memory-export.v1";
  exportedAt: string;
  tenantId: string;
  userId: string;
  memories: MemoryRecord[];
  proposals: MemoryProposal[];
  events: MemoryEvent[];
  consents: ConsentRecord[];
}

export class MemoryNotFoundError extends Error {
  constructor() {
    super("Memory does not exist in the requested tenant/user scope");
    this.name = "MemoryNotFoundError";
  }
}

export class ProposalNotFoundError extends Error {
  constructor() {
    super("Proposal does not exist in the requested tenant/user scope");
    this.name = "ProposalNotFoundError";
  }
}

function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export class MemoryService {
  private readonly idGen: () => string;

  constructor(private readonly deps: MemoryServiceDeps) {
    this.idGen = deps.idGen ?? randomUUID;
  }

  /* ----------------------------- consent ----------------------------- */

  async grantConsent(
    scope: Scope,
    purpose: string,
    channel: string,
  ): Promise<ConsentRecord> {
    const record: ConsentRecord = {
      id: this.idGen(),
      tenantId: scope.tenantId,
      userId: scope.userId,
      purpose,
      granted: true,
      grantedAt: this.deps.now().toISOString(),
      channel,
    };
    await this.deps.consents.recordConsent(record);
    return record;
  }

  /**
   * Revoke the active grant for a purpose, if any. Idempotent. Revocation
   * is itself an append-only record: "as of grantedAt, consent is not
   * granted" — history is never rewritten.
   */
  async revokeConsent(scope: Scope, purpose: string, channel = "unknown"): Promise<void> {
    const active = await this.activeConsent(scope, purpose);
    if (active === undefined) return;
    await this.deps.consents.recordConsent({
      id: this.idGen(),
      tenantId: scope.tenantId,
      userId: scope.userId,
      purpose,
      granted: false,
      grantedAt: this.deps.now().toISOString(),
      channel,
    });
  }

  /**
   * The currently active grant for a purpose, if one exists. The store is
   * append-only, so the latest record for the purpose decides: a grant is
   * active only while no later revocation exists.
   */
  async activeConsent(
    scope: Scope,
    purpose: string,
  ): Promise<ConsentRecord | undefined> {
    const records = await this.deps.consents.listConsents(
      scope.tenantId,
      scope.userId,
    );
    const forPurpose = records.filter((r) => r.purpose === purpose);
    const latest = forPurpose[forPurpose.length - 1];
    if (latest === undefined || !latest.granted) {
      return undefined;
    }
    return latest;
  }

  async hasConsent(scope: Scope, purpose: string): Promise<boolean> {
    return (await this.activeConsent(scope, purpose)) !== undefined;
  }

  async listConsents(scope: Scope): Promise<ConsentRecord[]> {
    return this.deps.consents.listConsents(scope.tenantId, scope.userId);
  }

  /* --------------------------- explicit memory ------------------------ */

  /**
   * FR-1 path 1: the user explicitly states a durable memory. Conflicts
   * with existing confirmed memory are recorded, never silently merged.
   */
  async stateExplicit(scope: Scope, input: MemoryInput): Promise<MemoryRecord> {
    this.validateInput(input);
    const now = this.deps.now().toISOString();
    const record: MemoryRecord = {
      id: this.idGen(),
      tenantId: scope.tenantId,
      userId: scope.userId,
      layer: input.layer,
      status: "confirmed",
      origin: "explicit",
      text: input.text,
      kind: input.kind,
      subject: input.subject,
      confidence: input.confidence ?? 1,
      sources: input.sources,
      createdAt: now,
      updatedAt: now,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    };
    await this.deps.memories.saveMemory(record);
    await this.event(scope, "stated", { memoryId: record.id });
    await this.recordConflicts(scope, record);
    return record;
  }

  /* ------------------------------ proposals --------------------------- */

  /**
   * FR-1 path 2, quarantined: a model-inferred candidate. Screened for
   * sensitive content (SR-4) and never served as context while pending.
   */
  async propose(
    scope: Scope,
    input: MemoryInput,
    proposedBy: { model: string; version: string },
  ): Promise<MemoryProposal> {
    this.validateInput(input);
    const hits = screenSensitiveContent(input.text);
    if (hits.length > 0) {
      throw new SensitiveContentError(hits.map((h) => h.category));
    }
    const proposal: MemoryProposal = {
      id: this.idGen(),
      tenantId: scope.tenantId,
      userId: scope.userId,
      layer: input.layer,
      text: input.text,
      kind: input.kind,
      subject: input.subject,
      confidence: input.confidence ?? 0.5,
      sources: input.sources,
      proposedBy,
      createdAt: this.deps.now().toISOString(),
      status: "pending",
    };
    await this.deps.memories.saveProposal(proposal);
    await this.event(scope, "proposed", { proposalId: proposal.id });
    return proposal;
  }

  /** Visible approval: a pending proposal becomes confirmed memory. */
  async approve(scope: Scope, proposalId: string): Promise<MemoryRecord> {
    const proposal = await this.requireProposal(scope, proposalId);
    if (proposal.status !== "pending") {
      throw new Error(`Proposal already ${proposal.status}`);
    }
    const now = this.deps.now().toISOString();
    const record: MemoryRecord = {
      id: this.idGen(),
      tenantId: scope.tenantId,
      userId: scope.userId,
      layer: proposal.layer,
      status: "confirmed",
      origin: "approved",
      text: proposal.text,
      kind: proposal.kind,
      subject: proposal.subject,
      confidence: proposal.confidence,
      sources: proposal.sources,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.memories.saveMemory(record);
    await this.deps.memories.saveProposal({
      ...proposal,
      status: "approved",
      resolvedAt: now,
    });
    await this.event(scope, "approved", {
      memoryId: record.id,
      proposalId: proposal.id,
    });
    await this.recordConflicts(scope, record);
    return record;
  }

  /** AC-3: a rejected proposal can never influence later context. */
  async reject(scope: Scope, proposalId: string): Promise<void> {
    const proposal = await this.requireProposal(scope, proposalId);
    if (proposal.status !== "pending") {
      throw new Error(`Proposal already ${proposal.status}`);
    }
    await this.deps.memories.saveProposal({
      ...proposal,
      status: "rejected",
      resolvedAt: this.deps.now().toISOString(),
    });
    await this.event(scope, "rejected", { proposalId: proposal.id });
  }

  /* ------------------------- conflict / supersede --------------------- */

  /**
   * Confirmed memories with the same layer/kind/subject but different
   * text. Deterministic — no embeddings involved.
   */
  async findConflicts(scope: Scope, record: MemoryRecord): Promise<MemoryRecord[]> {
    const all = await this.deps.memories.listMemories(scope.tenantId, scope.userId);
    return all.filter(
      (candidate) =>
        candidate.id !== record.id &&
        candidate.status === "confirmed" &&
        !this.isExpired(candidate) &&
        candidate.layer === record.layer &&
        candidate.kind === record.kind &&
        candidate.subject === record.subject &&
        normalizeText(candidate.text) !== normalizeText(record.text),
    );
  }

  /**
   * FR-3: explicit supersession. The old record is retired (status
   * `superseded`, never served again) and the replacement is confirmed;
   * both sides of the event are recorded.
   */
  async supersede(
    scope: Scope,
    memoryId: string,
    replacement: { text: string; confidence?: number; sources?: MemorySource[] },
  ): Promise<MemoryRecord> {
    const old = await this.requireMemory(scope, memoryId);
    if (old.status !== "confirmed") {
      throw new Error(`Cannot supersede a ${old.status} memory`);
    }
    const now = this.deps.now().toISOString();
    const next: MemoryRecord = {
      ...old,
      id: this.idGen(),
      status: "confirmed",
      text: replacement.text,
      confidence: replacement.confidence ?? old.confidence,
      sources: replacement.sources ?? old.sources,
      createdAt: now,
      updatedAt: now,
      supersededBy: undefined,
      supersededAt: undefined,
    };
    await this.deps.memories.saveMemory(next);
    await this.deps.memories.saveMemory({
      ...old,
      status: "superseded",
      supersededBy: next.id,
      supersededAt: now,
      updatedAt: now,
    });
    await this.event(scope, "superseded", {
      memoryId: old.id,
      detail: `by=${next.id}`,
    });
    return next;
  }

  /* --------------------------- working memory ------------------------- */

  /** FR-4: working memory is bound to a session and always has an expiry. */
  async addWorking(
    scope: Scope,
    sessionId: string,
    expiresAt: string,
    input: Omit<MemoryInput, "layer" | "expiresAt" | "sessionId">,
  ): Promise<MemoryRecord> {
    return this.stateExplicit(scope, {
      ...input,
      layer: "working",
      expiresAt,
      sessionId,
    });
  }

  /** FR-4: session end removes its working memory. Returns the count. */
  async expireSession(scope: Scope, sessionId: string): Promise<{ removed: number }> {
    const all = await this.deps.memories.listMemories(scope.tenantId, scope.userId);
    let removed = 0;
    for (const record of all) {
      if (record.layer === "working" && record.sessionId === sessionId) {
        await this.deps.memories.deleteMemory(scope.tenantId, scope.userId, record.id);
        await this.event(scope, "expired", {
          memoryId: record.id,
          detail: "session-ended",
        });
        removed += 1;
      }
    }
    return { removed };
  }

  /**
   * TTL sweep: expired working memories are removed; expired durable
   * memories are marked `expired` and never served again. Idempotent.
   */
  async sweepExpired(scope: Scope): Promise<{ removed: number; expired: number }> {
    const all = await this.deps.memories.listMemories(scope.tenantId, scope.userId);
    let removed = 0;
    let expired = 0;
    for (const record of all) {
      if (!this.isExpired(record)) continue;
      if (record.layer === "working") {
        await this.deps.memories.deleteMemory(scope.tenantId, scope.userId, record.id);
        removed += 1;
      } else if (record.status === "confirmed") {
        await this.deps.memories.saveMemory({
          ...record,
          status: "expired",
          updatedAt: this.deps.now().toISOString(),
        });
        expired += 1;
      } else {
        continue;
      }
      await this.event(scope, "expired", { memoryId: record.id });
    }
    return { removed, expired };
  }

  /* ----------------------- inspection / deletion ---------------------- */

  /**
   * The serving view: confirmed, unexpired memories only. Proposals,
   * superseded, and expired records are never served as context.
   */
  async listConfirmed(scope: Scope, layer?: MemoryLayer): Promise<MemoryRecord[]> {
    const all = await this.deps.memories.listMemories(scope.tenantId, scope.userId);
    return all.filter(
      (record) =>
        record.status === "confirmed" &&
        !this.isExpired(record) &&
        (layer === undefined || record.layer === layer),
    );
  }

  /** The inspection view (AC-2): every record, any status, with sources. */
  async listAll(scope: Scope): Promise<MemoryRecord[]> {
    return this.deps.memories.listMemories(scope.tenantId, scope.userId);
  }

  async listPendingProposals(scope: Scope): Promise<MemoryProposal[]> {
    const proposals = await this.deps.memories.listProposals(
      scope.tenantId,
      scope.userId,
    );
    return proposals.filter((p) => p.status === "pending");
  }

  /** SR-3: the owning employee can forget any memory. Idempotent. */
  async forget(scope: Scope, memoryId: string): Promise<void> {
    const removed = await this.deps.memories.deleteMemory(
      scope.tenantId,
      scope.userId,
      memoryId,
    );
    await this.event(scope, "forgotten", {
      memoryId,
      detail: removed ? "deleted" : "already-deleted",
    });
  }

  /** SR-3: scoped export of everything the memory system holds. */
  async exportAll(scope: Scope): Promise<MemoryExport> {
    const [memories, proposals, events, consents] = await Promise.all([
      this.deps.memories.listMemories(scope.tenantId, scope.userId),
      this.deps.memories.listProposals(scope.tenantId, scope.userId),
      this.deps.memories.listEvents(scope.tenantId, scope.userId),
      this.deps.consents.listConsents(scope.tenantId, scope.userId),
    ]);
    return {
      schema: "donna.memory-export.v1",
      exportedAt: this.deps.now().toISOString(),
      tenantId: scope.tenantId,
      userId: scope.userId,
      memories,
      proposals,
      events,
      consents,
    };
  }

  /**
   * AC-4: a source record was deleted — remove or invalidate everything
   * derived from it. A memory whose last source is gone is removed (FR-2);
   * a memory with surviving sources keeps them and records the unlink.
   * Pending proposals referencing the deleted source are removed outright.
   */
  async removeSource(
    scope: Scope,
    source: { kind: MemorySource["kind"]; id: string; captureId?: string },
  ): Promise<{ memoriesRemoved: number; sourcesUnlinked: number; proposalsRemoved: number }> {
    const matches = (candidate: MemorySource): boolean =>
      (candidate.kind === source.kind && candidate.id === source.id) ||
      (source.captureId !== undefined && candidate.captureId === source.captureId);

    let memoriesRemoved = 0;
    let sourcesUnlinked = 0;
    const memories = await this.deps.memories.listMemories(scope.tenantId, scope.userId);
    for (const record of memories) {
      if (!record.sources.some(matches)) continue;
      const surviving = record.sources.filter((candidate) => !matches(candidate));
      if (surviving.length === 0) {
        await this.deps.memories.deleteMemory(scope.tenantId, scope.userId, record.id);
        await this.event(scope, "source-removed", {
          memoryId: record.id,
          detail: "memory-deleted",
        });
        memoriesRemoved += 1;
      } else {
        await this.deps.memories.saveMemory({
          ...record,
          sources: surviving,
          updatedAt: this.deps.now().toISOString(),
        });
        await this.event(scope, "source-removed", {
          memoryId: record.id,
          detail: "source-unlinked",
        });
        sourcesUnlinked += 1;
      }
    }

    let proposalsRemoved = 0;
    const proposals = await this.deps.memories.listProposals(scope.tenantId, scope.userId);
    for (const proposal of proposals) {
      if (proposal.status !== "pending") continue;
      if (!proposal.sources.some(matches)) continue;
      await this.deps.memories.deleteProposal(scope.tenantId, scope.userId, proposal.id);
      await this.event(scope, "source-removed", {
        proposalId: proposal.id,
        detail: "proposal-deleted",
      });
      proposalsRemoved += 1;
    }

    return { memoriesRemoved, sourcesUnlinked, proposalsRemoved };
  }

  /* ------------------------------ internals --------------------------- */

  private isExpired(record: MemoryRecord): boolean {
    return (
      record.expiresAt !== undefined &&
      record.expiresAt <= this.deps.now().toISOString()
    );
  }

  private validateInput(input: MemoryInput): void {
    if (input.text.trim().length === 0) {
      throw new Error("Memory text must not be empty");
    }
    if (input.sources.length === 0) {
      throw new Error("Every memory requires at least one source (FR-2)");
    }
    if (input.layer === "working" && input.expiresAt === undefined) {
      throw new Error("Working memory requires an expiry (FR-4)");
    }
  }

  private async recordConflicts(scope: Scope, record: MemoryRecord): Promise<void> {
    const conflicts = await this.findConflicts(scope, record);
    for (const other of conflicts) {
      await this.event(scope, "conflict", {
        memoryId: record.id,
        detail: `with=${other.id}`,
      });
    }
  }

  private async requireMemory(scope: Scope, memoryId: string): Promise<MemoryRecord> {
    const record = await this.deps.memories.getMemory(
      scope.tenantId,
      scope.userId,
      memoryId,
    );
    if (record === undefined) throw new MemoryNotFoundError();
    return record;
  }

  private async requireProposal(
    scope: Scope,
    proposalId: string,
  ): Promise<MemoryProposal> {
    const proposal = await this.deps.memories.getProposal(
      scope.tenantId,
      scope.userId,
      proposalId,
    );
    if (proposal === undefined) throw new ProposalNotFoundError();
    return proposal;
  }

  private async event(
    scope: Scope,
    type: MemoryEvent["type"],
    rest: { memoryId?: string; proposalId?: string; detail?: string },
  ): Promise<void> {
    await this.deps.memories.appendEvent({
      at: this.deps.now().toISOString(),
      type,
      tenantId: scope.tenantId,
      userId: scope.userId,
      ...(rest.memoryId !== undefined ? { memoryId: rest.memoryId } : {}),
      ...(rest.proposalId !== undefined ? { proposalId: rest.proposalId } : {}),
      ...(rest.detail !== undefined ? { detail: rest.detail } : {}),
    });
  }
}
