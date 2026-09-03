/**
 * Correction-driven personalization (Specification 2.3).
 *
 * A correction is something the user changed by hand. Corrections are
 * immutable, source-linked events (FR-1) captured into a review queue;
 * only accepted corrections influence later decisions (FR-3); application
 * is idempotent (SR-3); replaying the accepted event log reproduces the
 * derived procedural-preference projection (FR-2). Personal examples stay
 * inside the owner partition (FR-4); promotion to a shared golden case is
 * a separate consented path (see packages/evals).
 *
 * Application effects per type:
 *   - bucket.move / bucket.merge / bucket.rename: applied to the bucket
 *     store with exact centroid recomputation; a move also derives a
 *     procedural preference memory sourced from the correction.
 *   - thought.edit: re-embeds (embedder required) and updates the item,
 *     then recomputes the bucket centroid exactly.
 *   - task.add / task.remove: sets/clears the task candidate; task.add
 *     also routes the item to the Tasks bucket (the loop's hard rule).
 *   - provenance.correct: re-verifies the proposed segments against the
 *     stored transcript and canonicalizes — invalid corrections fail.
 *   - memory.decision: applies approve/reject/forget via the memory
 *     service.
 *   - thought.split / thought.merge / retrieval.relevance: captured and
 *     reviewable; state application is deferred (documented limitation).
 */
import { randomUUID } from "node:crypto";
import { canonicalJson } from "@donna/core";
import { cosineSimilarity } from "@donna/buckets";
import type {
  BucketStore,
  CorrectionEvent,
  CorrectionObserver,
  CorrectionStore,
  CorrectionType,
  Embedder,
  MemorySource,
  ProvenanceVerifier,
  TranscriptStore,
} from "@donna/core";
import { DurableMemoryDisabledError, MemoryService, type Scope } from "./service.js";
import { relevanceScore } from "./context-assembler.js";

export interface CorrectionInput {
  type: CorrectionType;
  target: CorrectionEvent["target"];
  payload: Record<string, string>;
  sources: MemorySource[];
}

export interface CorrectionServiceDeps {
  corrections: CorrectionStore;
  buckets: BucketStore;
  memory: MemoryService;
  transcripts: TranscriptStore;
  verifier: ProvenanceVerifier;
  /**
   * Required for thought.edit (re-embedding) and task.add
   * re-embedding-free moves. Also enables the semantic adherence
   * applicability path (Spec 3.3).
   */
  embedder?: Embedder;
  /**
   * Spec 3.3: cosine similarity at or above this threshold marks a
   * correction example applicable to a placement. Default 0.5
   * (models.config.yaml: corrections.adherence_semantic_threshold).
   * When no embedder is available, applicability falls back to
   * deterministic keyword overlap.
   */
  adherenceThreshold?: number;
  /**
   * Spec 3.3: the retrieval read model. Accepted corrections mutate
   * source records (moves, renames, merges, edits), so the projection is
   * rebuilt after application — search never serves stale bucket/text
   * state (SR-3). A rebuild failure throws after the correction is
   * durably applied; `rebuild` (CLI: donna reindex) heals the projection.
   */
  retrievalIndex?: { rebuild(tenantId: string, userId: string): Promise<unknown> };
  now: () => Date;
  idGen?: () => string;
}

export class CorrectionNotFoundError extends Error {
  constructor() {
    super("Correction does not exist in the requested tenant/user scope");
    this.name = "CorrectionNotFoundError";
  }
}

/** Deferred-application types: captured and reviewable, no state change yet. */
const RECORD_ONLY_TYPES: ReadonlySet<CorrectionType> = new Set([
  "thought.split",
  "thought.merge",
  "retrieval.relevance",
]);

const TASKS_BUCKET_NAME = "Tasks";

/**
 * Default cosine threshold for semantic adherence applicability
 * (Spec 3.3). Configured via models.config.yaml
 * (corrections.adherence_semantic_threshold). Calibrated
 * 2026-09-03 against live text-embedding-3-large@1024: the
 * product-owner-witnessed paraphrase pair scores ~0.55, unrelated
 * text ~0.16 — 0.5 sits in the gap.
 */
export const DEFAULT_ADHERENCE_THRESHOLD = 0.5;

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export class CorrectionService implements CorrectionObserver {
  private readonly idGen: () => string;

  constructor(private readonly deps: CorrectionServiceDeps) {
    this.idGen = deps.idGen ?? randomUUID;
  }

  /* ----------------------------- capture ------------------------------ */

  /**
   * Capture a correction into the review queue. Exact duplicate pending
   * submissions (same type, target, and payload) return the existing
   * event instead of double-recording.
   */
  async submit(scope: Scope, input: CorrectionInput): Promise<CorrectionEvent> {
    if (input.sources.length === 0) {
      throw new Error("Every correction requires at least one source");
    }
    const pending = await this.reviewQueue(scope);
    const duplicate = pending.find(
      (candidate) =>
        candidate.type === input.type &&
        candidate.target.kind === input.target.kind &&
        candidate.target.id === input.target.id &&
        canonicalJson(candidate.payload) === canonicalJson(input.payload),
    );
    if (duplicate) return duplicate;

    const event: CorrectionEvent = {
      id: this.idGen(),
      tenantId: scope.tenantId,
      userId: scope.userId,
      type: input.type,
      createdAt: this.deps.now().toISOString(),
      target: input.target,
      payload: input.payload,
      sources: input.sources,
      status: "pending",
      followedCount: 0,
      contradictedCount: 0,
    };
    await this.deps.corrections.saveCorrection(event);
    return event;
  }

  async reviewQueue(scope: Scope): Promise<CorrectionEvent[]> {
    const all = await this.deps.corrections.listCorrections(
      scope.tenantId,
      scope.userId,
    );
    return all.filter((event) => event.status === "pending");
  }

  async list(scope: Scope): Promise<CorrectionEvent[]> {
    return this.deps.corrections.listCorrections(scope.tenantId, scope.userId);
  }

  /** Accepted corrections — the personalized-example source (FR-4). */
  async listAccepted(scope: Scope): Promise<CorrectionEvent[]> {
    const all = await this.deps.corrections.listCorrections(
      scope.tenantId,
      scope.userId,
    );
    return all.filter(
      (event) => event.status === "accepted" && event.contradictedBy === undefined,
    );
  }

  /* ------------------------------ review ------------------------------ */

  /**
   * Accept a correction and apply its effects. Idempotent (SR-3):
   * accepting an already-applied correction changes nothing.
   */
  async accept(scope: Scope, correctionId: string): Promise<CorrectionEvent> {
    const event = await this.require(scope, correctionId);
    if (event.status === "rejected") {
      throw new Error("Correction already rejected");
    }
    if (event.status === "accepted" && event.appliedAt !== undefined) {
      return event; // idempotent replay of acceptance
    }
    await this.apply(scope, event);
    const now = this.deps.now().toISOString();
    const applied: CorrectionEvent = {
      ...event,
      status: "accepted",
      resolvedAt: event.resolvedAt ?? now,
      appliedAt: now,
    };
    await this.deps.corrections.saveCorrection(applied);
    if (event.type === "bucket.move") {
      await this.derivePreference(scope, applied);
      await this.markContradicted(scope, applied);
    }
    // Keep the retrieval projection in step with the mutated source
    // records (Spec 3.3 SR-3). Record-only types change no state.
    if (!RECORD_ONLY_TYPES.has(event.type)) {
      await this.deps.retrievalIndex?.rebuild(scope.tenantId, scope.userId);
    }
    return applied;
  }

  async reject(scope: Scope, correctionId: string): Promise<void> {
    const event = await this.require(scope, correctionId);
    if (event.status !== "pending") {
      throw new Error(`Correction already ${event.status}`);
    }
    await this.deps.corrections.saveCorrection({
      ...event,
      status: "rejected",
      resolvedAt: this.deps.now().toISOString(),
    });
  }

  /**
   * Delete a correction event (user data control) and rebuild the
   * derived projection so its preference stops influencing decisions.
   */
  async deleteCorrection(scope: Scope, correctionId: string): Promise<void> {
    await this.deps.corrections.deleteCorrection(
      scope.tenantId,
      scope.userId,
      correctionId,
    );
    await this.replay(scope);
  }

  /* ------------------------------ replay ------------------------------ */

  /**
   * FR-2: rebuild the derived procedural-preference projection from the
   * accepted event log. Deterministic: same event log → same projection
   * (modulo generated memory IDs).
   */
  async replay(scope: Scope): Promise<{ derived: number }> {
    const memories = await this.deps.memory.listAll(scope);
    for (const record of memories) {
      if (record.sources.some((s) => s.kind === "correction")) {
        await this.deps.memory.forget(scope, record.id);
      }
    }
    const accepted = (await this.deps.corrections.listCorrections(
      scope.tenantId,
      scope.userId,
    ))
      .filter(
        (event) =>
          event.status === "accepted" &&
          event.appliedAt !== undefined &&
          event.type === "bucket.move" &&
          event.contradictedBy === undefined,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    for (const event of accepted) {
      await this.derivePreference(scope, event);
    }
    return { derived: accepted.length };
  }

  /* ---------------------------- adherence ----------------------------- */

  /**
   * Pipeline hook: for each injected correction example relevant to the
   * placed thought, record whether placement followed or contradicted the
   * learned correction.
   *
   * Applicability (Spec 3.3, product-owner-witnessed fix): when an
   * embedder is configured, applicability is SEMANTIC — cosine
   * similarity between the placed thought and the correction's canonical
   * thought summary at or above the configured threshold (default 0.5,
   * calibrated against live embeddings — see models.config.yaml) — so a
   * paraphrased follow-up (e.g. a correction about "test removing email
   * verification" and a later placement of "try one-click signup") is
   * counted even with zero shared keywords. When no embedder is
   * available (or embedding fails), the deterministic keyword-overlap
   * path is the fallback.
   */
  async observePlacement(
    scope: Scope,
    observation: {
      thoughtText: string;
      placedBucketId: string;
      examples: Array<{ correctionId: string; preferredBucketId: string; text: string }>;
    },
  ): Promise<{ followed: number; contradicted: number }> {
    let followed = 0;
    let contradicted = 0;
    for (const example of observation.examples) {
      const event = await this.deps.corrections.getCorrection(
        scope.tenantId,
        scope.userId,
        example.correctionId,
      );
      if (event === undefined || event.status !== "accepted") continue;
      // Compare against the canonical correction summary, not the
      // rendered example template (the template text dilutes the
      // embedding).
      const exampleText = event.payload["thoughtSummary"] ?? example.text;
      if (!(await this.isApplicable(observation.thoughtText, exampleText))) {
        continue;
      }
      if (observation.placedBucketId === example.preferredBucketId) {
        event.followedCount += 1;
        followed += 1;
      } else {
        event.contradictedCount += 1;
        contradicted += 1;
      }
      await this.deps.corrections.saveCorrection(event);
    }
    return { followed, contradicted };
  }

  /**
   * Semantic-first applicability with deterministic fallback. Exported
   * for the context assembler's example selection (the same rule decides
   * which examples are injected and which observations are counted).
   */
  async isApplicable(thoughtText: string, exampleText: string): Promise<boolean> {
    if (this.deps.embedder !== undefined) {
      try {
        const [a, b] = await this.deps.embedder.embed([thoughtText, exampleText]);
        if (a !== undefined && b !== undefined) {
          return (
            cosineSimilarity(a, b) >=
            (this.deps.adherenceThreshold ?? DEFAULT_ADHERENCE_THRESHOLD)
          );
        }
      } catch {
        // Embedding failure degrades to the deterministic keyword path.
      }
    }
    return relevanceScore(thoughtText, exampleText) >= 1;
  }

  /** AC-2: correction rate and adherence, per scoped (pseudonymous) user. */
  async stats(scope: Scope): Promise<{
    total: number;
    pending: number;
    accepted: number;
    rejected: number;
    followed: number;
    contradicted: number;
    adherenceRate: number | null;
  }> {
    const all = await this.deps.corrections.listCorrections(
      scope.tenantId,
      scope.userId,
    );
    const followed = all.reduce((sum, e) => sum + e.followedCount, 0);
    const contradicted = all.reduce((sum, e) => sum + e.contradictedCount, 0);
    const outcomes = followed + contradicted;
    return {
      total: all.length,
      pending: all.filter((e) => e.status === "pending").length,
      accepted: all.filter((e) => e.status === "accepted").length,
      rejected: all.filter((e) => e.status === "rejected").length,
      followed,
      contradicted,
      adherenceRate: outcomes === 0 ? null : followed / outcomes,
    };
  }

  /* --------------------------- application ---------------------------- */

  private async apply(scope: Scope, event: CorrectionEvent): Promise<void> {
    if (RECORD_ONLY_TYPES.has(event.type)) return;
    const { tenantId, userId } = scope;
    switch (event.type) {
      case "bucket.move": {
        const toBucketId = event.payload["toBucketId"];
        if (toBucketId === undefined) throw new Error("bucket.move requires toBucketId");
        await this.deps.buckets.moveItem(tenantId, userId, event.target.id, toBucketId);
        // Product-owner decision (2026-09-03): the user is ground truth, so a
        // direct move is always allowed — but Tasks membership and the task
        // field must never disagree. Moving a task-bearing thought OUT of
        // Tasks clears the task candidate; moving a thought INTO Tasks adds
        // one from its summary. The autonomous-placement hard rule in the
        // bucket engine is untouched.
        const buckets = await this.deps.buckets.listBuckets(tenantId, userId);
        const target = buckets.find((b) => b.id === toBucketId);
        const targetIsTasks =
          target !== undefined &&
          target.name.trim().toLowerCase() === TASKS_BUCKET_NAME.toLowerCase();
        const items = await this.deps.buckets.listItems(tenantId, userId);
        const moved = items.find((candidate) => candidate.thought.id === event.target.id);
        if (moved !== undefined) {
          if (!targetIsTasks && moved.thought.task !== undefined) {
            await this.deps.buckets.updateItem(tenantId, userId, event.target.id, {
              task: null,
            });
          } else if (targetIsTasks && moved.thought.task === undefined) {
            await this.deps.buckets.updateItem(tenantId, userId, event.target.id, {
              task: { title: moved.thought.summary },
            });
          }
        }
        return;
      }
      case "bucket.rename": {
        const newName = event.payload["newName"];
        if (newName === undefined) throw new Error("bucket.rename requires newName");
        await this.deps.buckets.renameBucket(tenantId, userId, event.target.id, newName);
        return;
      }
      case "bucket.merge": {
        const intoBucketId = event.payload["intoBucketId"];
        if (intoBucketId === undefined) throw new Error("bucket.merge requires intoBucketId");
        await this.deps.buckets.mergeBuckets(tenantId, userId, event.target.id, intoBucketId);
        return;
      }
      case "thought.edit": {
        const text = event.payload["text"];
        const summary = event.payload["summary"];
        if (text === undefined && summary === undefined) {
          throw new Error("thought.edit requires text or summary");
        }
        if (this.deps.embedder === undefined) {
          throw new Error("thought.edit requires an embedder to re-embed safely");
        }
        const items = await this.deps.buckets.listItems(tenantId, userId);
        const item = items.find((candidate) => candidate.thought.id === event.target.id);
        if (item === undefined) {
          throw new Error("Thought does not exist in the requested tenant/user scope");
        }
        const newText = text ?? item.thought.text;
        const [embedding] = await this.deps.embedder.embed([newText]);
        await this.deps.buckets.updateItem(tenantId, userId, event.target.id, {
          ...(text !== undefined ? { text } : {}),
          ...(summary !== undefined ? { summary } : {}),
          ...(embedding !== undefined ? { embedding } : {}),
        });
        await this.recomputeBucketStats(scope, item.bucketId);
        return;
      }
      case "task.add": {
        const title = event.payload["title"];
        if (title === undefined) throw new Error("task.add requires title");
        await this.deps.buckets.updateItem(tenantId, userId, event.target.id, {
          task: {
            title,
            ...(event.payload["assigneeHint"] !== undefined
              ? { assigneeHint: event.payload["assigneeHint"] }
              : {}),
            ...(event.payload["dueHint"] !== undefined
              ? { dueHint: event.payload["dueHint"] }
              : {}),
          },
        });
        // The loop's hard rule: tasks live in the Tasks bucket.
        const buckets = await this.deps.buckets.listBuckets(tenantId, userId);
        const tasks = buckets.find(
          (b) => b.name.trim().toLowerCase() === TASKS_BUCKET_NAME.toLowerCase(),
        );
        if (tasks !== undefined) {
          await this.deps.buckets.moveItem(tenantId, userId, event.target.id, tasks.id);
        }
        return;
      }
      case "task.remove": {
        await this.deps.buckets.updateItem(tenantId, userId, event.target.id, {
          task: null,
        });
        return;
      }
      case "provenance.correct": {
        const segmentIds = (event.payload["segmentIds"] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (segmentIds.length === 0) {
          throw new Error("provenance.correct requires segmentIds");
        }
        const items = await this.deps.buckets.listItems(tenantId, userId);
        const item = items.find((candidate) => candidate.thought.id === event.target.id);
        if (item === undefined) {
          throw new Error("Thought does not exist in the requested tenant/user scope");
        }
        const transcript = await this.deps.transcripts.getTranscript(
          tenantId,
          userId,
          item.thought.provenance.captureId,
        );
        if (transcript === undefined) {
          throw new Error("Source transcript is unavailable for re-verification");
        }
        const verification = this.deps.verifier.verify(transcript, {
          captureId: transcript.captureId,
          segmentIds,
        });
        if (!verification.ok) {
          throw new Error(`Corrected provenance failed verification: ${verification.reason}`);
        }
        await this.deps.buckets.updateItem(tenantId, userId, event.target.id, {
          provenance: verification.provenance,
        });
        return;
      }
      case "memory.decision": {
        const decision = event.payload["decision"];
        if (event.target.kind === "proposal" && decision === "approve") {
          await this.deps.memory.approve(scope, event.target.id);
        } else if (event.target.kind === "proposal" && decision === "reject") {
          await this.deps.memory.reject(scope, event.target.id);
        } else if (event.target.kind === "memory" && decision === "forget") {
          await this.deps.memory.forget(scope, event.target.id);
        } else {
          throw new Error(`Unsupported memory decision: ${decision ?? "none"}`);
        }
        return;
      }
      default:
        return;
    }
  }

  /** Derive the procedural preference memory for an accepted bucket.move. */
  private async derivePreference(scope: Scope, event: CorrectionEvent): Promise<void> {
    const summary = event.payload["thoughtSummary"] ?? event.target.id;
    const bucketName = event.payload["toBucketName"] ?? event.payload["toBucketId"] ?? "unknown";
    try {
      await this.deps.memory.stateExplicit(scope, {
      layer: "procedural",
      kind: "organization-preference",
      subject: `correction:${event.id}`,
      text: `Thoughts like "${summary}" belong in "${bucketName}"`,
      sources: [
        {
          kind: "correction",
          id: event.id,
          reason: "user moved a thought to this bucket",
        },
      ],
      });
    } catch (error) {
      // Spec 6.1: when the scope's pilot profile has durable memory off,
      // the correction still applies (the user's ground-truth move is
      // never blocked) — only the derived durable preference is skipped.
      if (error instanceof DurableMemoryDisabledError) return;
      throw error;
    }
  }

  /**
   * A newly accepted move contradicts an earlier accepted move when both
   * concern the same normalized thought summary but name different target
   * buckets. The earlier correction is marked, never rewritten.
   */
  private async markContradicted(scope: Scope, event: CorrectionEvent): Promise<void> {
    const summary = event.payload["thoughtSummary"];
    const toBucketId = event.payload["toBucketId"];
    if (summary === undefined || toBucketId === undefined) return;
    const all = await this.deps.corrections.listCorrections(
      scope.tenantId,
      scope.userId,
    );
    for (const candidate of all) {
      if (
        candidate.id !== event.id &&
        candidate.type === "bucket.move" &&
        candidate.status === "accepted" &&
        candidate.contradictedBy === undefined &&
        candidate.payload["thoughtSummary"] !== undefined &&
        normalize(candidate.payload["thoughtSummary"]) === normalize(summary) &&
        candidate.payload["toBucketId"] !== toBucketId
      ) {
        await this.deps.corrections.saveCorrection({
          ...candidate,
          contradictedBy: event.id,
        });
      }
    }
  }

  /** Exact centroid/count repair for one bucket after an embedding change. */
  private async recomputeBucketStats(scope: Scope, bucketId: string): Promise<void> {
    const [buckets, items] = await Promise.all([
      this.deps.buckets.listBuckets(scope.tenantId, scope.userId),
      this.deps.buckets.listItems(scope.tenantId, scope.userId),
    ]);
    const bucket = buckets.find((candidate) => candidate.id === bucketId);
    if (bucket === undefined) return;
    const members = items.filter((item) => item.bucketId === bucketId);
    const embeddings = members
      .map((item) => item.thought.embedding)
      .filter((e): e is number[] => e !== undefined);
    const centroid =
      embeddings.length === 0
        ? []
        : Array.from({ length: embeddings[0]!.length }, (_, i) =>
            embeddings.reduce((sum, e) => sum + (e[i] ?? 0), 0) / embeddings.length,
          );
    await this.deps.buckets.updateBucketStats(
      scope.tenantId,
      scope.userId,
      bucketId,
      centroid,
      members.length,
    );
  }

  private async require(scope: Scope, correctionId: string): Promise<CorrectionEvent> {
    const event = await this.deps.corrections.getCorrection(
      scope.tenantId,
      scope.userId,
      correctionId,
    );
    if (event === undefined) throw new CorrectionNotFoundError();
    return event;
  }
}
