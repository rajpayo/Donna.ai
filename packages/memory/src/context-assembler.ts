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
import type {
  BucketStore,
  CaptureStore,
  ContextBudgets,
  ContextElement,
  ContextPacket,
  ContextAssembler as ContextAssemblerPort,
  TranscriptStore,
} from "@donna/core";
import { MemoryService, type Scope } from "./service.js";

export interface ContextAssemblerDeps {
  memory: Pick<MemoryService, "listConfirmed">;
  buckets: BucketStore;
  captures: CaptureStore;
  transcripts: TranscriptStore;
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
}
