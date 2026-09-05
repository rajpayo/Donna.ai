/**
 * Reranker port (Specification 3.3).
 *
 * Deterministic hybrid ranking is the default and sufficient path. A
 * configuration-selected LLM reranker may be added later via the
 * `retrieval.rerank` lane in models.config.yaml — but a reranker may
 * only REORDER the candidate hits, never add or remove any: ACL and
 * tenant filtering have already happened upstream (SR-2), and a
 * reranker that hallucinates a hit would break provenance. `applyReranker`
 * enforces the permutation contract and fails closed to the
 * deterministic order.
 */
import type { HybridHit } from "./hybrid-search.js";

export interface Reranker {
  readonly modelId: string;
  rerank(question: string, hits: HybridHit[]): Promise<HybridHit[]>;
}

/** The default: deterministic hybrid order passes through unchanged. */
export class DeterministicReranker implements Reranker {
  readonly modelId = "none";
  async rerank(_question: string, hits: HybridHit[]): Promise<HybridHit[]> {
    return hits;
  }
}

/**
 * Apply a reranker under the permutation contract. A reranked list that
 * is not exactly a permutation of the input (added, dropped, or
 * duplicated hits) is rejected and the deterministic order stands —
 * fail closed.
 */
export async function applyReranker(
  reranker: Reranker,
  question: string,
  hits: HybridHit[],
): Promise<{ hits: HybridHit[]; reranked: boolean }> {
  let reranked: HybridHit[];
  try {
    reranked = await reranker.rerank(question, hits);
  } catch {
    return { hits, reranked: false };
  }
  const inputIds = hits.map((hit) => hit.thought.id).sort();
  const outputIds = reranked.map((hit) => hit.thought.id).sort();
  const isPermutation =
    inputIds.length === outputIds.length &&
    inputIds.every((id, index) => id === outputIds[index]);
  if (!isPermutation) {
    return { hits, reranked: false };
  }
  return { hits: reranked, reranked: true };
}
