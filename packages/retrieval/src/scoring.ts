/**
 * Deterministic retrieval scoring (Specification 3.1).
 *
 * Versioned so a scoring change is an explicit, reviewable event:
 * every hit carries the version that produced its scores.
 *
 * `donna.local-retrieval.v1` signals:
 *   - text:     normalized token overlap |Q ∩ T| / |Q| over the thought's
 *               summary + text (0 when the query has no text). Tokens are
 *               lowercase alphanumerics of 3+ characters — the same
 *               normalization the memory context assembler uses.
 *   - semantic: cosine similarity between the query embedding and the
 *               thought's stored embedding, clamped to [0, 1] (0 when
 *               either side is missing).
 *   - combined: 0.5·text + 0.5·semantic when both signals are present;
 *               the single present signal otherwise; 0 in browse mode
 *               (no text and no embedding — recency-ordered listing).
 *
 * Ranking is fully deterministic: combined desc, then createdAt desc,
 * then thoughtId asc.
 */
import { cosineSimilarity } from "@donna/buckets";

export const LOCAL_SCORE_VERSION = "donna.local-retrieval.v1";

export const LOCAL_SCORE_WEIGHTS = { text: 0.5, semantic: 0.5 } as const;

/** Normalized token set: lowercase alphanumerics, 3+ characters. */
export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3),
  );
}

/** Normalized full-text overlap: fraction of query tokens present. */
export function textScore(queryTokens: ReadonlySet<string>, entryTokens: ReadonlySet<string>): number {
  if (queryTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of queryTokens) {
    if (entryTokens.has(token)) overlap += 1;
  }
  return overlap / queryTokens.size;
}

/** Cosine similarity clamped to [0, 1]; 0 when either embedding is absent. */
export function semanticScore(
  queryEmbedding: number[] | undefined,
  entryEmbedding: number[] | undefined,
): number {
  if (queryEmbedding === undefined || entryEmbedding === undefined) return 0;
  return Math.max(0, cosineSimilarity(queryEmbedding, entryEmbedding));
}

/** Combine the signals per the versioned weights. */
export function combinedScore(
  hasText: boolean,
  hasSemantic: boolean,
  text: number,
  semantic: number,
): number {
  if (hasText && hasSemantic) {
    return (
      LOCAL_SCORE_WEIGHTS.text * text + LOCAL_SCORE_WEIGHTS.semantic * semantic
    );
  }
  if (hasText) return text;
  if (hasSemantic) return semantic;
  return 0;
}
