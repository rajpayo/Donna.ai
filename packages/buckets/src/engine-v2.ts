/**
 * Structured bucket engine (Specification 6.7) — the deterministic
 * decision policy for versioned placement proposals.
 *
 * The product-owner-selected policy (geometry veto, agreement auto-files):
 *
 *   1. Tasks first: a task-bearing thought ALWAYS routes to the scoped
 *      Tasks bucket regardless of the proposal (conflict is diagnostic).
 *   2. Allowlist validation: an existing-mode ID not in the exact scoped
 *      request list fails closed with zero side effects (pending
 *      `unknown-id`).
 *   3. Geometry ranking over scoped buckets only; the existing
 *      assign/create thresholds are unchanged.
 *   4. Auto-file ONLY when the model's allowlisted ID equals the top
 *      geometric bucket AND that bucket clears assign_threshold.
 *   5. Middle band [create, assign): pending; the proposal is a
 *      recommendation/tie signal only.
 *   6. Model/geometry mismatch: pending with both human names.
 *   7. Mint eligibility: mode "new" is considered only when no existing
 *      bucket clears create_threshold; exact/lexical/semantic duplicates
 *      become `possible-existing-match` review; a valid, distinct name
 *      creates and files immediately.
 *   8. Semantic similarity alone NEVER silently joins or creates.
 *
 * The engine is deterministic: the single permitted naming retry is a
 * pipeline concern (the model-backed BucketNamer port); the engine only
 * validates and decides.
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  Bucket,
  BucketStore,
  Embedder,
  PlacementCandidate,
  PlacementOutcome,
  PlacementProposal,
  Thought,
} from "@donna/core";
import {
  bucketDescriptor,
  canonicalDisplayName,
  canonicalNameKey,
  lexicallyContained,
  validateBucketDescription,
  validateBucketName,
} from "./canonical.js";
import { TASKS_BUCKET, type BucketTuning } from "./engine.js";
import { cosineSimilarity, updatedCentroid } from "./similarity.js";

export interface StructuredEngineOptions {
  /**
   * Separate locked near-duplicate descriptor threshold (Spec 6.7
   * resolution 8): initial candidate 0.90, calibrated on synthetic
   * fixtures and frozen before live dev results. NEVER the assignment
   * threshold.
   */
  nearDuplicateThreshold: number;
  /**
   * Embedder for semantic near-duplicate comparison of bucket
   * descriptors. When absent, semantic checking degrades to exact/lexical
   * only and the outcome records `semantic-check-unavailable`.
   */
  embedder?: Embedder;
}

/** SHA-256 of the exact request allowlist (order-stable), for pending records. */
export function allowlistHash(
  options: Array<{ id: string; name: string; description: string }>,
): string {
  const canonical = options
    .map((o) => `${o.id}${o.name}${o.description}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

export class StructuredBucketEngine {
  constructor(
    private readonly store: BucketStore,
    private readonly tuning: BucketTuning,
    private readonly options: StructuredEngineOptions,
  ) {}

  /**
   * Decide the placement of one embedded thought. `proposal` is null when
   * the organizer output stayed invalid after the single escalation (the
   * verified extraction still persists pending — never silent
   * continuation). `namingRetried` marks the re-submission after the one
   * isolated naming retry; a second naming failure persists pending.
   */
  async place(
    thought: Thought,
    proposal: PlacementProposal | null,
    buckets: Bucket[],
    opts: { namingRetried?: boolean } = {},
  ): Promise<PlacementOutcome> {
    const embedding = thought.embedding;
    if (!embedding) throw new Error("Thought must be embedded before placement");
    this.assertScope(thought, buckets);

    // Rule 1: Tasks is absolute — before any proposal or semantic decision.
    if (thought.task) {
      const conflict =
        proposal !== null && !this.proposalIsTasks(proposal, buckets);
      const existing = this.findByName(buckets, TASKS_BUCKET.name);
      const target =
        existing ??
        (await this.createBucket(thought, {
          name: TASKS_BUCKET.name,
          description: TASKS_BUCKET.description,
          origin: "seeded",
        }));
      const placement = await this.joinBucket(target, thought, false);
      return {
        ...placement,
        created: existing === undefined,
        ...(conflict ? { proposalConflict: "tasks-override" as const } : {}),
      };
    }

    // Rule 2: invalid routing after the single escalation — pending with
    // an optional geometry recommendation, zero placement side effects.
    if (proposal === null) {
      return {
        kind: "pending",
        reason: "invalid-route",
        candidates: this.topCandidates(thought, buckets),
        ...(this.topCandidate(thought, buckets) !== undefined
          ? { recommendedBucketId: this.topCandidate(thought, buckets)!.bucket.id }
          : {}),
      };
    }

    const ranked = this.rank(thought, buckets);
    const best = ranked[0];

    if (proposal.mode === "existing") {
      // Rule 3 (engine/store boundary revalidation): unknown, stale,
      // cross-scope, or malformed IDs fail closed with zero side effects.
      const selected = buckets.find((b) => b.id === proposal.bucketId);
      if (selected === undefined) {
        return {
          kind: "pending",
          reason: "unknown-id",
          candidates: this.candidatesFromRanked(ranked),
          ...(best !== undefined ? { recommendedBucketId: best.bucket.id } : {}),
        };
      }
      // Rule 4: agreement auto-files at or above assign_threshold.
      if (
        best !== undefined &&
        best.bucket.id === selected.id &&
        best.sim >= this.tuning.assign_threshold
      ) {
        return this.joinBucket(best.bucket, thought, false);
      }
      // Rule 6: mismatch — the model's ID is not the top geometry.
      if (best !== undefined && best.bucket.id !== selected.id) {
        return {
          kind: "pending",
          reason: "model-geometry-mismatch",
          candidates: this.candidatesFromRanked(ranked, selected),
        };
      }
      // Same bucket, but geometry is below assign_threshold.
      if (best !== undefined && best.sim >= this.tuning.create_threshold) {
        // Rule 5: middle band — recommendation only, stays pending.
        return {
          kind: "pending",
          reason: "middle-band",
          candidates: this.candidatesFromRanked(ranked),
          recommendedBucketId: best.bucket.id,
        };
      }
      // Below create_threshold: geometry finds no fit for the model's
      // existing choice — never silently join.
      return {
        kind: "pending",
        reason: "model-geometry-mismatch",
        candidates: this.candidatesFromRanked(ranked, selected),
      };
    }

    // proposal.mode === "new"
    // Rule 7: mint is considered only when no existing bucket clears
    // create_threshold; otherwise new-versus-existing review.
    if (best !== undefined && best.sim >= this.tuning.create_threshold) {
      return {
        kind: "pending",
        reason: "new-vs-existing",
        candidates: this.candidatesFromRanked(ranked),
        recommendedBucketId: best.bucket.id,
      };
    }

    // Canonical validation of the proposed display name/description.
    const nameFailures = validateBucketName(proposal.name);
    const descriptionFailures = validateBucketDescription(proposal.description);
    const failures = [
      ...nameFailures,
      ...descriptionFailures.map((f) => `description-${f}`),
    ];
    if (failures.length > 0) {
      if (opts.namingRetried === true) {
        return {
          kind: "pending",
          reason: "naming-invalid",
          namingFailures: failures,
          candidates: [],
        };
      }
      return { kind: "naming-failed", reasons: failures };
    }

    // Duplicate protection: exact canonical-key collision, lexical
    // containment, then semantic near-duplication over descriptors.
    const duplicate = await this.findDuplicate(thought, proposal, buckets);
    if (duplicate !== undefined) {
      return {
        kind: "pending",
        reason: "possible-existing-match",
        candidates: this.candidatesFromRanked(ranked, duplicate),
        recommendedBucketId: duplicate.id,
      };
    }

    // Validated-immediate mint: create and file in one scoped write.
    const display = canonicalDisplayName(proposal.name)!;
    const created = await this.createBucket(thought, {
      name: display,
      description: proposal.description.normalize("NFKC").replace(/\s+/g, " ").trim(),
      origin: "auto",
    });
    const placement = await this.joinBucket(created, thought, false);
    return { ...placement, created: true };
  }

  /**
   * Atomic revalidation + finalization for a pending confirmation/edit
   * (FR-7/SR-10): re-run exact and semantic duplicate checks against
   * CURRENT scoped state. A race becomes a conflict outcome, never a
   * duplicate bucket. Returns the colliding bucket when one now exists.
   */
  async revalidateMint(
    thought: Thought,
    name: string,
    description: string,
  ): Promise<
    | { ok: true; name: string; description: string }
    | { ok: false; failures?: string[]; conflict?: Bucket }
  > {
    const failures = [
      ...validateBucketName(name),
      ...validateBucketDescription(description).map((f) => `description-${f}`),
    ];
    if (failures.length > 0) return { ok: false, failures };
    const buckets = await this.store.listBuckets(thought.tenantId, thought.userId);
    const duplicate = await this.findDuplicate(
      thought,
      { mode: "new", name, description },
      buckets,
    );
    if (duplicate !== undefined) return { ok: false, conflict: duplicate };
    return {
      ok: true,
      name: canonicalDisplayName(name)!,
      description: description.normalize("NFKC").replace(/\s+/g, " ").trim(),
    };
  }

  /** Create the validated bucket and file the thought (one scoped write). */
  async mintAndFile(
    thought: Thought,
    name: string,
    description: string,
  ): Promise<{ bucket: Bucket }> {
    const created = await this.createBucket(thought, {
      name,
      description,
      origin: "auto",
    });
    await this.joinBucket(created, thought, false);
    return { bucket: created };
  }

  /** File a thought into an existing scoped bucket (review resolution). */
  async fileExisting(thought: Thought, bucket: Bucket): Promise<void> {
    this.assertScope(thought, [bucket]);
    await this.joinBucket(bucket, thought, false);
  }

  /**
   * Exact / lexical / semantic duplicate scan over scoped buckets.
   * Semantic comparison embeds name+description descriptors with the
   * configured embedder and the separate locked threshold; it never
   * accepts model-supplied scope or vectors.
   */
  private async findDuplicate(
    thought: Thought,
    proposal: { mode: "new"; name: string; description: string },
    buckets: Bucket[],
  ): Promise<Bucket | undefined> {
    const key = canonicalNameKey(proposal.name);
    for (const bucket of buckets) {
      if (canonicalNameKey(bucket.name) === key) return bucket;
    }
    for (const bucket of buckets) {
      if (lexicallyContained(proposal.name, bucket.name)) return bucket;
    }
    const embedder = this.options.embedder;
    if (embedder !== undefined && buckets.length > 0) {
      const descriptors = [
        bucketDescriptor(proposal.name, proposal.description),
        ...buckets.map((b) => bucketDescriptor(b.name, b.description)),
      ];
      const embeddings = await embedder.embed(descriptors);
      const proposed = embeddings[0]!;
      let bestMatch: Bucket | undefined;
      let bestSim = 0;
      buckets.forEach((bucket, index) => {
        const sim = cosineSimilarity(proposed, embeddings[index + 1]!);
        if (sim > bestSim) {
          bestSim = sim;
          bestMatch = bucket;
        }
      });
      if (
        bestMatch !== undefined &&
        bestSim >= this.options.nearDuplicateThreshold
      ) {
        return bestMatch;
      }
    }
    return undefined;
  }

  private rank(
    thought: Thought,
    buckets: Bucket[],
  ): Array<{ bucket: Bucket; sim: number }> {
    return buckets
      .map((bucket) => ({
        bucket,
        sim: cosineSimilarity(thought.embedding!, bucket.centroid),
      }))
      .sort((a, b) => b.sim - a.sim);
  }

  private topCandidate(
    thought: Thought,
    buckets: Bucket[],
  ): { bucket: Bucket; sim: number } | undefined {
    return this.rank(thought, buckets)[0];
  }

  private topCandidates(thought: Thought, buckets: Bucket[]): PlacementCandidate[] {
    return this.candidatesFromRanked(this.rank(thought, buckets));
  }

  private candidatesFromRanked(
    ranked: Array<{ bucket: Bucket; sim: number }>,
    extra?: Bucket,
  ): PlacementCandidate[] {
    const candidates = ranked.slice(0, 3).map(({ bucket, sim }) => ({
      bucketId: bucket.id,
      name: bucket.name,
      similarity: sim,
    }));
    if (
      extra !== undefined &&
      !candidates.some((candidate) => candidate.bucketId === extra.id)
    ) {
      candidates.push({
        bucketId: extra.id,
        name: extra.name,
        similarity: 0,
      });
    }
    return candidates;
  }

  private proposalIsTasks(
    proposal: PlacementProposal,
    buckets: Bucket[],
  ): boolean {
    if (proposal.mode === "new") {
      return canonicalNameKey(proposal.name) === canonicalNameKey(TASKS_BUCKET.name);
    }
    const bucket = buckets.find((b) => b.id === proposal.bucketId);
    return (
      bucket !== undefined &&
      canonicalNameKey(bucket.name) === canonicalNameKey(TASKS_BUCKET.name)
    );
  }

  private assertScope(thought: Thought, buckets: Bucket[]): void {
    if (
      buckets.some(
        (bucket) =>
          bucket.tenantId !== thought.tenantId ||
          bucket.userId !== thought.userId,
      )
    ) {
      throw new Error("Bucket scope does not match thought scope");
    }
  }

  private findByName(buckets: Bucket[], name: string): Bucket | undefined {
    const wanted = canonicalNameKey(name);
    return buckets.find((b) => canonicalNameKey(b.name) === wanted);
  }

  private async createBucket(
    thought: Thought,
    init: { name: string; description: string; origin: Bucket["origin"] },
  ): Promise<Bucket> {
    const bucket: Bucket = {
      id: randomUUID(),
      tenantId: thought.tenantId,
      userId: thought.userId,
      name: init.name,
      description: init.description,
      centroid: thought.embedding!,
      itemCount: 0,
      createdAt: new Date().toISOString(),
      origin: init.origin,
    };
    return this.store.createBucket(bucket);
  }

  private async joinBucket(
    bucket: Bucket,
    thought: Thought,
    needsReview: boolean,
  ): Promise<{
    kind: "filed";
    bucket: Bucket;
    created: boolean;
    needsReview: boolean;
    similarity: number;
  }> {
    this.assertScope(thought, [bucket]);
    const centroid = updatedCentroid(
      bucket.centroid,
      bucket.itemCount,
      thought.embedding!,
    );
    await this.store.updateBucketStats(
      thought.tenantId,
      thought.userId,
      bucket.id,
      centroid,
      bucket.itemCount + 1,
    );
    return {
      kind: "filed",
      bucket: { ...bucket, centroid, itemCount: bucket.itemCount + 1 },
      created: false,
      needsReview,
      similarity: cosineSimilarity(thought.embedding!, bucket.centroid),
    };
  }
}
