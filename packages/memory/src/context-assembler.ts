/**
 * Context assembler (Specification 2.2).
 *
 * Before organization, Donna builds a bounded context packet containing
 * only the most relevant private memories and current-session context:
 *
 *   - FR-1: selection is query/capture-specific. Approved (inferred)
 *     memories must share keyword overlap with the capture; explicit user
 *     settings are always candidates; bucket summaries are always
 *     candidates (the organizer must see the filing system to reuse it)
 *     but are ranked by overlap and capped; recent captures contribute
 *     short excerpts.
 *   - FR-2: token/item budgets produce deterministic truncation with
 *     source priority — trusted user settings first, then bucket
 *     summaries, then approved memories by relevance, then captures by
 *     recency. Budgets come from models.config.yaml, never code.
 *   - FR-3: confirmed explicit preferences outrank inferred memory.
 *   - SR-2/SR-4: every read goes through the scoped stores; there is no
 *     cache, so a deleted or expired record cannot reappear.
 *   - Degraded mode: each source is gathered independently; a failing
 *     store is recorded in `degradedReasons` and contributes nothing, so
 *     organization still works when memory retrieval is unavailable.
 */
import { randomUUID } from "node:crypto";
import { cosineSimilarity } from "@donna/buckets";
import type {
  BucketStore,
  CaptureStore,
  ContextBudgets,
  ContextElement,
  ContextPacket,
  ContextAssembler as ContextAssemblerPort,
  CorrectionEvent,
  Embedder,
  TranscriptStore,
} from "@donna/core";
import { MemoryService, type Scope } from "./service.js";

export interface ContextAssemblerDeps {
  memory: Pick<MemoryService, "listConfirmed">;
  buckets: BucketStore;
  captures: CaptureStore;
  transcripts: TranscriptStore;
  /**
   * Spec 2.3: accepted corrections for this scope, injected as a bounded
   * set of relevant personalized examples. Optional — omitting it simply
   * produces packets without correction examples.
   */
  corrections?: { listAccepted(scope: Scope): Promise<CorrectionEvent[]> };
  /**
   * Spec 3.3: when present, correction-example relevance is SEMANTIC
   * (cosine similarity ≥ similarityThreshold), so paraphrased captures
   * still surface the user's correction. Without an embedder, the
   * deterministic keyword-overlap path is the fallback.
   */
  embedder?: Embedder;
  /** Cosine threshold for semantic example selection (default 0.75). */
  similarityThreshold?: number;
  budgets: ContextBudgets;
  now: () => Date;
  idGen?: () => string;
}

/** Rough deterministic token estimate: 1 token ≈ 4 characters. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const CAPTURE_EXCERPT_CHARS = 240;

/** Word-overlap relevance: normalized tokens of 3+ characters. */
export function relevanceScore(query: string, candidate: string): number {
  const tokenize = (text: string) =>
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 3),
    );
  const q = tokenize(query);
  let score = 0;
  for (const token of tokenize(candidate)) {
    if (q.has(token)) score += 1;
  }
  return score;
}

interface Candidate extends ContextElement {
  priorityClass: number;
  score: number;
}

/**
 * Default cosine threshold for semantic correction-example selection
 * (Spec 3.3). Matches the calibrated adherence default (0.5) in
 * corrections.ts — see models.config.yaml for the calibration notes.
 */
export const DEFAULT_EXAMPLE_SIMILARITY_THRESHOLD = 0.5;

export class ContextAssembler implements ContextAssemblerPort {
  private readonly idGen: () => string;

  constructor(private readonly deps: ContextAssemblerDeps) {
    this.idGen = deps.idGen ?? randomUUID;
  }

  async assemble(
    scope: Scope,
    query: { text: string; excludeCaptureId?: string },
  ): Promise<ContextPacket> {
    const degradedReasons: string[] = [];
    const candidates: Candidate[] = [];

    // --- confirmed memories (trusted settings + inferred memory) ---
    let memoryCount = 0;
    try {
      const confirmed = await this.deps.memory.listConfirmed(scope);
      const ranked = confirmed
        .map((record) => {
          const explicit = record.origin === "explicit";
          return {
            record,
            explicit,
            score: explicit
              ? Number.MAX_SAFE_INTEGER
              : relevanceScore(
                  query.text,
                  `${record.subject} ${record.kind} ${record.text}`,
                ),
          };
        })
        // FR-1: inferred memory must be relevant to THIS capture.
        .filter((entry) => entry.explicit || entry.score > 0)
        .sort(
          (a, b) =>
            b.score - a.score ||
            b.record.updatedAt.localeCompare(a.record.updatedAt) ||
            a.record.id.localeCompare(b.record.id),
        );
      for (const { record, explicit, score } of ranked) {
        if (memoryCount >= this.deps.budgets.maxMemories) break;
        memoryCount += 1;
        candidates.push({
          sourceId: record.id,
          sourceKind: "memory",
          trust: explicit ? "trusted-user-settings" : "untrusted-retrieved",
          text: record.text,
          asOf: record.updatedAt,
          tokens: estimateTokens(record.text),
          priorityClass: explicit ? 0 : 2,
          score,
        });
      }
    } catch {
      degradedReasons.push("memories-unavailable");
    }

    // --- bucket summaries (the filing system; ranked by overlap) ---
    try {
      const buckets = await this.deps.buckets.listBuckets(
        scope.tenantId,
        scope.userId,
      );
      const ranked = buckets
        .map((bucket) => ({
          bucket,
          score: relevanceScore(
            query.text,
            `${bucket.name} ${bucket.description}`,
          ),
        }))
        .sort(
          (a, b) =>
            b.score - a.score ||
            b.bucket.createdAt.localeCompare(a.bucket.createdAt) ||
            a.bucket.id.localeCompare(b.bucket.id),
        )
        .slice(0, this.deps.budgets.maxBucketSummaries);
      for (const { bucket, score } of ranked) {
        const text = `"${bucket.name}": ${bucket.description} (${bucket.itemCount} items)`;
        candidates.push({
          sourceId: bucket.id,
          sourceKind: "bucket",
          trust: "untrusted-retrieved",
          text,
          asOf: bucket.createdAt,
          tokens: estimateTokens(text),
          priorityClass: 1,
          score,
        });
      }
    } catch {
      degradedReasons.push("buckets-unavailable");
    }

    // --- personalized correction examples (Spec 2.3, bounded) ---
    if (this.deps.corrections !== undefined) {
      try {
        const accepted = await this.deps.corrections.listAccepted(scope);
        const eligible = accepted.filter(
          (event) =>
            event.type === "bucket.move" &&
            event.payload["toBucketId"] !== undefined &&
            event.payload["thoughtSummary"] !== undefined,
        );
        // Spec 3.3: semantic relevance when an embedder is configured
        // (paraphrases still surface the correction), deterministic
        // keyword overlap otherwise. scoreCorrectionExamples returns
        // only applicable examples (thresholded).
        const scored = await this.scoreCorrectionExamples(query.text, eligible);
        const ranked = scored
          .sort(
            (a, b) =>
              b.score - a.score ||
              b.event.createdAt.localeCompare(a.event.createdAt) ||
              a.event.id.localeCompare(b.event.id),
          )
          .slice(0, this.deps.budgets.maxCorrectionExamples);
        for (const { event, score } of ranked) {
          const text = `The user corrected: "${event.payload["thoughtSummary"]}" belongs in "${event.payload["toBucketName"] ?? event.payload["toBucketId"]}"`;
          candidates.push({
            sourceId: event.id,
            sourceKind: "correction",
            trust: "untrusted-retrieved",
            text,
            asOf: event.createdAt,
            tokens: estimateTokens(text),
            priorityClass: 2,
            score,
            correction: {
              correctionId: event.id,
              preferredBucketId: event.payload["toBucketId"]!,
            },
          });
        }
      } catch {
        degradedReasons.push("corrections-unavailable");
      }
    }

    // --- recent capture excerpts (recency is the relevance) ---
    try {
      const captures = (
        await this.deps.captures.listCaptures(scope.tenantId, scope.userId)
      )
        .filter((c) => c.id !== query.excludeCaptureId)
        .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt) || a.id.localeCompare(b.id))
        .slice(0, this.deps.budgets.recentCaptures);
      for (const capture of captures) {
        const transcript = await this.deps.transcripts.getTranscript(
          scope.tenantId,
          scope.userId,
          capture.id,
        );
        if (transcript === undefined) continue;
        const excerpt =
          transcript.text.length > CAPTURE_EXCERPT_CHARS
            ? `${transcript.text.slice(0, CAPTURE_EXCERPT_CHARS)}…`
            : transcript.text;
        const text = `Earlier capture: "${excerpt}"`;
        candidates.push({
          sourceId: capture.id,
          sourceKind: "capture",
          trust: "untrusted-retrieved",
          text,
          asOf: capture.capturedAt,
          tokens: estimateTokens(text),
          priorityClass: 3,
          score: 0,
        });
      }
    } catch {
      degradedReasons.push("captures-unavailable");
    }

    // --- deterministic budget truncation with source priority (FR-2) ---
    const ordered = [...candidates].sort(
      (a, b) =>
        a.priorityClass - b.priorityClass ||
        b.score - a.score ||
        b.asOf.localeCompare(a.asOf) ||
        a.sourceId.localeCompare(b.sourceId),
    );
    const elements: ContextElement[] = [];
    let tokens = 0;
    let truncated = 0;
    for (const candidate of ordered) {
      const fits =
        elements.length < this.deps.budgets.maxItems &&
        tokens + candidate.tokens <= this.deps.budgets.maxTokens;
      if (!fits) {
        truncated += 1;
        continue;
      }
      tokens += candidate.tokens;
      elements.push({
        sourceId: candidate.sourceId,
        sourceKind: candidate.sourceKind,
        trust: candidate.trust,
        text: candidate.text,
        asOf: candidate.asOf,
        tokens: candidate.tokens,
        ...(candidate.correction !== undefined
          ? { correction: candidate.correction }
          : {}),
      });
    }

    return {
      id: this.idGen(),
      tenantId: scope.tenantId,
      userId: scope.userId,
      createdAt: this.deps.now().toISOString(),
      degraded: degradedReasons.length > 0,
      degradedReasons,
      elements,
      budgets: this.deps.budgets,
      totals: { tokens, items: elements.length, truncated },
    };
  }

  /**
   * Spec 3.3: score correction examples for relevance to this capture.
   * Semantic path (embedder configured): cosine similarity between the
   * capture and each example's summary+bucket text, thresholded at the
   * configured similarity threshold. Fallback (no embedder, or embedding
   * fails): deterministic keyword overlap, score > 0. Only applicable
   * examples are returned.
   */
  private async scoreCorrectionExamples(
    queryText: string,
    eligible: CorrectionEvent[],
  ): Promise<Array<{ event: CorrectionEvent; score: number }>> {
    if (eligible.length === 0) return [];
    const textOf = (event: CorrectionEvent): string =>
      `${event.payload["thoughtSummary"]} ${event.payload["toBucketName"] ?? ""}`;

    if (this.deps.embedder !== undefined) {
      try {
        const embeddings = await this.deps.embedder.embed([
          queryText,
          ...eligible.map(textOf),
        ]);
        const queryEmbedding = embeddings[0];
        if (queryEmbedding !== undefined) {
          const threshold =
            this.deps.similarityThreshold ?? DEFAULT_EXAMPLE_SIMILARITY_THRESHOLD;
          const scored: Array<{ event: CorrectionEvent; score: number }> = [];
          eligible.forEach((event, index) => {
            const candidate = embeddings[index + 1];
            if (candidate === undefined) return;
            const score = cosineSimilarity(queryEmbedding, candidate);
            if (score >= threshold) scored.push({ event, score });
          });
          return scored;
        }
      } catch {
        // Embedding failure degrades to the deterministic keyword path.
      }
    }

    return eligible
      .map((event) => ({
        event,
        score: relevanceScore(queryText, textOf(event)),
      }))
      .filter((entry) => entry.score > 0);
  }
}
