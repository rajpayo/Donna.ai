/**
 * Action draft lifecycle service (Specification 5.4).
 *
 *   - FR-1: every draft is source-linked (source thought IDs), scoped,
 *     typed, and previewable.
 *   - FR-2: expiry and cancellation are deterministic — expiry is
 *     evaluated against the injected clock on every transition;
 *     cancellation is a recorded, terminal lifecycle change.
 *   - FR-3: invalid payloads are rejected at creation, before approval.
 *   - SR-1: committing creates at most an Outlook DRAFT (email); every
 *     other type is a sandbox commit with no external mutation.
 *   - SR-2: commit goes through code-wired executors with fixed
 *     allowlists; nothing here is reachable from an LLM prompt.
 *   - SR-3: drafts persist under the scoped partition the caller provides
 *     (the CLI places them in the M365 partition purged by disconnect).
 */
import { randomUUID } from "node:crypto";
import type {
  ActionDraft,
  ActionDraftPayload,
  ActionDraftStore,
  ActionDraftType,
  DraftExecutor,
} from "@donna/core";
import { validateDraftPayload } from "./validation.js";

interface Scope {
  tenantId: string;
  userId: string;
}

/** Raised at creation when the payload fails validation (FR-3). */
export class DraftValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid draft: ${problems.join("; ")}`);
    this.name = "DraftValidationError";
  }
}

export class DraftNotFoundError extends Error {
  constructor() {
    super("Draft does not exist in the requested tenant/user scope");
    this.name = "DraftNotFoundError";
  }
}

/** Wrong-status, expired, or unavailable-capability transition. */
export class DraftStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftStateError";
  }
}

/** Default draft TTL: 24 hours. */
export const DEFAULT_DRAFT_TTL_MS = 24 * 3600_000;

export interface ActionDraftServiceDeps {
  store: ActionDraftStore;
  executors: ReadonlyArray<DraftExecutor>;
  now: () => Date;
  idGen?: () => string;
  ttlMs?: number;
  /**
   * Optional existence check for source thought IDs (FR-1). When wired,
   * drafts referencing thoughts that do not exist in the scope are
   * rejected at creation.
   */
  thoughtExists?: (scope: Scope, thoughtId: string) => Promise<boolean>;
}

export class ActionDraftService {
  private readonly idGen: () => string;

  constructor(private readonly deps: ActionDraftServiceDeps) {
    this.idGen = deps.idGen ?? randomUUID;
  }

  private executorFor(type: ActionDraftType): DraftExecutor | undefined {
    return this.deps.executors.find((e) => e.type === type);
  }

  /** Capability report across every wired executor (Spec 5.4 scope). */
  capabilities(): Array<{ type: string; capability: string; note: string }> {
    return this.deps.executors.map((e) => ({
      type: e.type,
      capability: e.capability,
      note: e.capabilityNote,
    }));
  }

  /**
   * Create a validated, source-linked, expiring draft. Invalid payloads
   * and dangling source thoughts are rejected before the draft exists.
   */
  async create(
    scope: Scope,
    input: { payload: ActionDraftPayload; sourceThoughtIds: string[] },
  ): Promise<ActionDraft> {
    const problems = validateDraftPayload(input.payload);
    if (input.sourceThoughtIds.length === 0) {
      problems.push("a draft must link at least one source thought");
    }
    if (this.deps.thoughtExists !== undefined) {
      for (const thoughtId of input.sourceThoughtIds) {
        if (!(await this.deps.thoughtExists(scope, thoughtId))) {
          problems.push(`source thought ${thoughtId} does not exist in this scope`);
        }
      }
    }
    if (problems.length > 0) {
      throw new DraftValidationError(problems);
    }
    const now = this.deps.now();
    const draft: ActionDraft = {
      id: this.idGen(),
      tenantId: scope.tenantId,
      userId: scope.userId,
      type: input.payload.type,
      payload: input.payload,
      sourceThoughtIds: [...input.sourceThoughtIds],
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (this.deps.ttlMs ?? DEFAULT_DRAFT_TTL_MS)).toISOString(),
    };
    await this.deps.store.saveDraft(draft);
    return draft;
  }

  /** Load one draft in scope, applying deterministic expiry first. */
  async get(scope: Scope, draftId: string): Promise<ActionDraft> {
    const draft = await this.deps.store.getDraft(scope.tenantId, scope.userId, draftId);
    if (draft === undefined) throw new DraftNotFoundError();
    return this.applyExpiry(draft);
  }

  /** List drafts in scope (deterministic expiry applied). */
  async list(scope: Scope): Promise<ActionDraft[]> {
    const drafts = await this.deps.store.listDrafts(scope.tenantId, scope.userId);
    return Promise.all(drafts.map((draft) => this.applyExpiry(draft)));
  }

  /** Cancel a pending draft. Idempotent for already-cancelled drafts. */
  async cancel(scope: Scope, draftId: string, reason = "user-cancelled"): Promise<ActionDraft> {
    const draft = await this.get(scope, draftId);
    if (draft.status === "cancelled") return draft;
    if (draft.status !== "pending") {
      throw new DraftStateError(`cannot cancel a ${draft.status} draft`);
    }
    const cancelled: ActionDraft = {
      ...draft,
      status: "cancelled",
      cancelledAt: this.deps.now().toISOString(),
      cancelReason: reason,
    };
    await this.deps.store.saveDraft(cancelled);
    return cancelled;
  }

  /**
   * THE APPROVAL PATH. Commit one pending, unexpired draft through its
   * code-wired executor. Never reachable from LLM prompts; the only
   * caller is an explicit human approval surface (the CLI in this phase).
   */
  async commit(scope: Scope, draftId: string): Promise<ActionDraft> {
    const draft = await this.get(scope, draftId);
    if (draft.status === "expired") {
      throw new DraftStateError("draft has expired — create a fresh one");
    }
    if (draft.status !== "pending") {
      throw new DraftStateError(`cannot commit a ${draft.status} draft`);
    }
    const executor = this.executorFor(draft.type);
    if (executor === undefined) {
      throw new DraftStateError(`no executor wired for ${draft.type}`);
    }
    if (executor.capability === "unavailable") {
      throw new DraftStateError(executor.capabilityNote);
    }
    const result = await executor.commit(draft);
    const committed: ActionDraft = {
      ...draft,
      status: "committed",
      committedAt: this.deps.now().toISOString(),
      commitResult: result,
    };
    await this.deps.store.saveDraft(committed);
    return committed;
  }

  /** Mark a draft expired when past its TTL. Persisted, deterministic. */
  private async applyExpiry(draft: ActionDraft): Promise<ActionDraft> {
    if (draft.status !== "pending") return draft;
    if (draft.expiresAt > this.deps.now().toISOString()) return draft;
    const expired: ActionDraft = { ...draft, status: "expired" };
    await this.deps.store.saveDraft(expired);
    return expired;
  }
}
