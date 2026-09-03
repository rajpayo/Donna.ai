/**
 * Hybrid natural-language retrieval (Specification 3.3).
 *
 * Ranking combines six deterministic signals into one explainable score:
 *
 *   text            normalized token overlap (from the underlying index)
 *   semantic        cosine(query embedding, thought embedding)
 *   bucketAffinity  cosine(query embedding, bucket centroid)
 *   recency         0.5^(ageDays / halfLifeDays) over thought createdAt
 *   personalization an accepted bucket.move correction whose summary is
 *                   similar to the hit (semantic when an embedder is
 *                   available, keyword overlap otherwise) and whose
 *                   preferred bucket IS the hit's bucket
 *   taskMatch       the query shows task intent and the hit carries a task
 *
 * Features and weights are versioned (`donna.hybrid-ranking.v1`) and
 * configurable in models.config.yaml; every hit carries its feature
 * vector and the weights so the ranking is fully reportable (FR-3).
 *
 * Ordering rules (SR-2): the underlying index applies tenant/user scope
 * and every filter BEFORE any feature is computed — ranking only ever
 * re-orders the caller's own, filter-eligible records. There is no
 * cache: every query reads through the index, so deleted or expired
 * content cannot reappear (SR-3).
 */
import type {
  Bucket,
  BucketStore,
  CorrectionEvent,
  Embedder,
  RetrievalFilters,
  RetrievalHit,
  RetrievalIndex,
} from "@donna/core";
import { cosineSimilarity } from "@donna/buckets";

export const HYBRID_RANKING_VERSION = "donna.hybrid-ranking.v1";

export interface HybridRankingWeights {
  text: number;
  semantic: number;
  bucketAffinity: number;
  recency: number;
  personalization: number;
  taskMatch: number;
}

export interface HybridRankingConfig {
  version: string;
  weights: HybridRankingWeights;
  recencyHalfLifeDays: number;
  /** Candidates re-ranked per query (already scope/filter-limited). */
  candidateLimit: number;
  /**
   * Relevance floor: hits below this combined score are dropped, so
   * weak-signal noise (e.g. low cosine on an out-of-domain query) never
   * surfaces as a result. Reportable like every other knob (FR-3).
   */
  minScore: number;
}

export const DEFAULT_HYBRID_CONFIG: HybridRankingConfig = {
  version: HYBRID_RANKING_VERSION,
  weights: {
    text: 0.3,
    semantic: 0.3,
    bucketAffinity: 0.1,
    recency: 0.1,
    personalization: 0.15,
    taskMatch: 0.05,
  },
  recencyHalfLifeDays: 30,
  candidateLimit: 100,
  minScore: 0.2,
};

/** Deterministic task-intent tokens for the taskMatch feature. */
const TASK_INTENT_TOKENS = new Set([
  "task",
  "tasks",
  "todo",
  "remind",
  "reminder",
  "commitment",
  "action",
  "deadline",
  "due",
]);

/** Feature vector computed for one candidate hit. */
export interface RankingFeatures {
  text: number;
  semantic: number;
  bucketAffinity: number;
  recency: number;
  personalization: number;
  taskMatch: number;
}

/**
 * A hybrid hit: the underlying retrieval hit plus its full feature
 * vector and the weights that combined them (FR-3 — explainable).
 */
export interface HybridHit extends RetrievalHit {
  features: RankingFeatures;
  weights: HybridRankingWeights;
  rankingVersion: string;
}

export interface HybridQuery {
  text: string;
  filters?: RetrievalFilters;
  limit?: number;
  /** Precomputed query embedding (the embedder is used when omitted). */
  embedding?: number[];
  /**
   * Follow-up support: prior query texts from the session's working
   * memory. When the raw question finds nothing, the query is retried
   * once with the recent session queries appended (bounded, most recent
   * first) — deterministic pronoun-free expansion.
   */
  sessionContext?: string[];
}

export interface HybridRetrieverDeps {
  index: RetrievalIndex;
  buckets: BucketStore;
  /** Accepted corrections for the personalization signal (Spec 2.3). */
  corrections?: {
    listAccepted(scope: {
      tenantId: string;
      userId: string;
    }): Promise<CorrectionEvent[]>;
  };
  /** Query embedder; without it the semantic/affinity features are 0. */
  embedder?: Embedder;
  config?: HybridRankingConfig;
  now: () => Date;
}

/** Bound on how many prior session queries expand a follow-up. */
const SESSION_CONTEXT_LIMIT = 3;

export class HybridRetriever {
  private readonly config: HybridRankingConfig;

  constructor(private readonly deps: HybridRetrieverDeps) {
    this.config = deps.config ?? DEFAULT_HYBRID_CONFIG;
  }

  /** The active ranking version and weights (FR-3 reporting). */
  describeRanking(): { version: string; weights: HybridRankingWeights } {
    return {
      version: this.config.version,
      weights: { ...this.config.weights },
    };
  }

  async search(
    scope: { tenantId: string; userId: string },
    query: HybridQuery,
  ): Promise<HybridHit[]> {
    const hits = await this.searchOnce(scope, query.text, query);
    if (
      hits.length === 0 &&
      query.sessionContext !== undefined &&
      query.sessionContext.length > 0
    ) {
      // Follow-up fallback: expand with recent session queries and retry
      // once. Deterministic; the expansion is bounded.
      const expanded = [
        query.text,
        ...query.sessionContext.slice(0, SESSION_CONTEXT_LIMIT),
      ].join(" ");
      return this.searchOnce(scope, expanded, query);
    }
    return hits;
  }

  private async searchOnce(
    scope: { tenantId: string; userId: string },
    text: string,
    query: HybridQuery,
  ): Promise<HybridHit[]> {
    const embedding = await this.queryEmbedding(text, query.embedding);

    // SR-2: scope + ACL filters are applied by the index BEFORE any
    // ranking feature is computed.
    const candidates = await this.deps.index.search({
      tenantId: scope.tenantId,
      userId: scope.userId,
      text,
      ...(embedding !== undefined ? { embedding } : {}),
      ...(query.filters !== undefined ? { filters: query.filters } : {}),
      limit: this.config.candidateLimit,
    });
    if (candidates.length === 0) return [];

    const [buckets, corrections] = await Promise.all([
      this.deps.buckets.listBuckets(scope.tenantId, scope.userId),
      this.deps.corrections?.listAccepted(scope) ?? Promise.resolve(undefined),
    ]);
    const bucketsById = new Map(buckets.map((bucket) => [bucket.id, bucket]));

    const nowMs = this.deps.now().getTime();
    const hits: HybridHit[] = [];
    for (const hit of candidates) {
      const features = await this.computeFeatures(
        hit,
        text,
        embedding,
        bucketsById,
        corrections,
        nowMs,
      );
      const combined = this.combine(features);
      hits.push({
        ...hit,
        scores: { ...hit.scores, combined },
        features,
        weights: { ...this.config.weights },
        rankingVersion: this.config.version,
      });
    }

    return hits
      .filter((hit) => hit.scores.combined >= this.config.minScore)
      .sort(
        (a, b) =>
          b.scores.combined - a.scores.combined ||
          (b.thought.createdAt ?? "").localeCompare(a.thought.createdAt ?? "") ||
          a.thought.id.localeCompare(b.thought.id),
      )
      .slice(0, query.limit ?? 20);
  }

  private async queryEmbedding(
    text: string,
    provided: number[] | undefined,
  ): Promise<number[] | undefined> {
    if (provided !== undefined) return provided;
    if (this.deps.embedder === undefined || text.trim().length === 0) {
      return undefined;
    }
    const [embedding] = await this.deps.embedder.embed([text]);
    return embedding;
  }

  private async computeFeatures(
    hit: RetrievalHit,
    queryText: string,
    queryEmbedding: number[] | undefined,
    bucketsById: Map<string, Bucket>,
    corrections: CorrectionEvent[] | undefined,
    nowMs: number,
  ): Promise<RankingFeatures> {
    const bucket = bucketsById.get(hit.bucketId);

    const bucketAffinity =
      queryEmbedding !== undefined && bucket !== undefined
        ? Math.max(0, cosineSimilarity(queryEmbedding, bucket.centroid))
        : 0;

    let recency = 0;
    if (hit.thought.createdAt !== undefined) {
      const ageMs = Math.max(0, nowMs - Date.parse(hit.thought.createdAt));
      const ageDays = ageMs / (24 * 3600 * 1000);
      recency = Math.pow(0.5, ageDays / this.config.recencyHalfLifeDays);
    }

    const queryTokens = new Set(
      queryText
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 0),
    );
    const taskMatch =
      hit.thought.task !== undefined &&
      [...TASK_INTENT_TOKENS].some((token) => queryTokens.has(token))
        ? 1
        : 0;

    const personalization = await this.personalization(hit, corrections);

    return {
      text: hit.scores.text,
      semantic: hit.scores.semantic,
      bucketAffinity,
      recency,
      personalization,
      taskMatch,
    };
  }

  /**
   * Accepted-correction affinity: 1 when an accepted, uncontradicted
   * bucket.move correction whose thought summary is similar to this hit
   * names the hit's bucket as its target. Similarity is semantic when an
   * embedder is available (the Spec 3.3 adherence fix), deterministic
   * keyword overlap otherwise.
   */
  private async personalization(
    hit: RetrievalHit,
    corrections: CorrectionEvent[] | undefined,
  ): Promise<number> {
    if (corrections === undefined || corrections.length === 0) return 0;
    const relevant = corrections.filter(
      (event) =>
        event.type === "bucket.move" &&
        event.payload["toBucketId"] === hit.bucketId &&
        event.payload["thoughtSummary"] !== undefined,
    );
    if (relevant.length === 0) return 0;

    if (this.deps.embedder !== undefined) {
      try {
        const summaries = relevant.map((event) => event.payload["thoughtSummary"]!);
        const embeddings = await this.deps.embedder.embed([
          hit.thought.text,
          ...summaries,
        ]);
        const hitEmbedding = embeddings[0];
        if (hitEmbedding !== undefined) {
          for (let i = 1; i < embeddings.length; i++) {
            const candidate = embeddings[i];
            if (
              candidate !== undefined &&
              cosineSimilarity(hitEmbedding, candidate) >=
                SEMANTIC_PERSONALIZATION_THRESHOLD
            ) {
              return 1;
            }
          }
          return 0;
        }
      } catch {
        // Fall through to the deterministic keyword path.
      }
    }

    const hitTokens = tokenSet(hit.thought.text);
    for (const event of relevant) {
      const summaryTokens = tokenSet(event.payload["thoughtSummary"]!);
      let overlap = 0;
      for (const token of summaryTokens) {
        if (hitTokens.has(token)) overlap += 1;
      }
      if (overlap > 0) return 1;
    }
    return 0;
  }

  /** Weighted combination — the exact arithmetic explain-ranking shows. */
  private combine(features: RankingFeatures): number {
    const w = this.config.weights;
    return (
      w.text * features.text +
      w.semantic * features.semantic +
      w.bucketAffinity * features.bucketAffinity +
      w.recency * features.recency +
      w.personalization * features.personalization +
      w.taskMatch * features.taskMatch
    );
  }
}

/**
 * Cosine threshold for the semantic personalization path (documented
 * default, calibrated against live text-embedding-3-large@1024 — see
 * models.config.yaml). The corrections service uses the configured
 * `corrections.adherence_semantic_threshold`.
 */
export const SEMANTIC_PERSONALIZATION_THRESHOLD = 0.5;

function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3),
  );
}
