/**
 * Dynamic bucket engine — the assign-or-create decision.
 *
 * Buckets are the user's mental filing system and the future agents'
 * work queues (see docs/roadmap-agents.md). They are created ON DEMAND,
 * never from a fixed taxonomy:
 *
 *   1. The organizer LLM suggests a placement (existing name or a new
 *      bucket proposal) based on meaning.
 *   2. The engine verifies with embedding similarity against bucket
 *      centroids — the LLM proposes, geometry disposes.
 *   3. sim ≥ assignThreshold  → join that bucket.
 *      sim < createThreshold   → mint a new bucket, seeded with this
 *                                thought's embedding as its centroid.
 *      in between              → join best match, flag needsReview.
 *
 * Hard rule: a thought carrying a task ALWAYS lands in the "Tasks" bucket,
 * which is created on first use if it doesn't exist yet.
 */
import { randomUUID } from "node:crypto";
import type { Bucket, BucketStore, Thought } from "@donna/core";
import { cosineSimilarity, updatedCentroid } from "./similarity.js";

export interface BucketTuning {
  assign_threshold: number;
  create_threshold: number;
}

export const TASKS_BUCKET = {
  name: "Tasks",
  description:
    "Commitments and action items extracted from voice notes, awaiting agent pickup or user review.",
} as const;

export interface Placement {
  bucket: Bucket;
  created: boolean;
  needsReview: boolean;
  similarity: number;
}

export class BucketEngine {
  constructor(
    private readonly store: BucketStore,
    private readonly tuning: BucketTuning,
  ) {}

  async place(
    thought: Thought,
    suggestion: { suggestedBucket?: string; newBucketName?: string; newBucketDescription?: string },
    buckets: Bucket[],
  ): Promise<Placement> {
    const embedding = thought.embedding;
    if (!embedding) throw new Error("Thought must be embedded before placement");
    if (
      buckets.some(
        (bucket) =>
          bucket.tenantId !== thought.tenantId ||
          bucket.userId !== thought.userId,
      )
    ) {
      throw new Error("Bucket scope does not match thought scope");
    }

    // Rule 0: tasks always go to the Tasks bucket.
    if (thought.task) {
      const existing = this.findByName(buckets, TASKS_BUCKET.name);
      if (existing) {
        return this.joinBucket(existing, thought, false);
      }
      const created = await this.createBucket(thought, {
        name: TASKS_BUCKET.name,
        description: TASKS_BUCKET.description,
        origin: "seeded",
      });
      const placement = await this.joinBucket(created, thought, false);
      return { ...placement, created: true };
    }

    // Rank existing buckets by centroid similarity.
    const ranked = buckets
      .map((b) => ({ bucket: b, sim: cosineSimilarity(embedding, b.centroid) }))
      .sort((a, b) => b.sim - a.sim);
    const best = ranked[0];

    // The organizer's suggestion breaks ties toward a same-named bucket.
    const suggested = suggestion.suggestedBucket
      ? this.findByName(buckets, suggestion.suggestedBucket)
      : undefined;

    if (best && best.sim >= this.tuning.assign_threshold) {
      return this.joinBucket(best.bucket, thought, best.sim >= 0.9 ? false : !suggested);
    }
    if (suggested) {
      const sim = cosineSimilarity(embedding, suggested.centroid);
      if (sim >= this.tuning.create_threshold) {
        return this.joinBucket(suggested, thought, true);
      }
    }
    if (best && best.sim >= this.tuning.create_threshold) {
      return this.joinBucket(best.bucket, thought, true);
    }

    // Name-collision guard: if the organizer proposed a bucket name that
    // already exists, that is strong evidence of intent even when geometry
    // fell below the create threshold. Join it (flagged for review) instead
    // of minting a duplicate with the same name.
    //
    // Label-parroting defense: a proposal of the form "bucket:<id>" is the
    // model echoing a context source label, not a name. Resolve the ID
    // reference to the real bucket; never mint a bucket with that name.
    const proposedName = suggestion.newBucketName ?? suggestion.suggestedBucket;
    if (proposedName) {
      const idRef = /^bucket:([0-9a-f-]{36})$/i.exec(proposedName.trim());
      const referenced = idRef
        ? buckets.find((b) => b.id.toLowerCase() === idRef[1]!.toLowerCase())
        : undefined;
      const collision = referenced ?? this.findByName(buckets, proposedName);
      if (collision) {
        return this.joinBucket(collision, thought, true);
      }
      if (idRef) {
        // Reference to a bucket that no longer exists — treat as no
        // proposal rather than minting a bucket named after a raw ID.
        const fallback = await this.fallbackName(thought);
        const created = await this.createBucket(thought, {
          name: fallback,
          description: `Auto-created from: "${thought.summary}"`,
          origin: "auto",
        });
        const placement = await this.joinBucket(created, thought, false);
        return { ...placement, created: true };
      }
    }

    // Nothing fits — mint a new bucket at this moment, then join it so the
    // seeding thought is counted (the Tasks path above does the same).
    const name = proposedName ?? (await this.fallbackName(thought));
    const created = await this.createBucket(thought, {
      name,
      description:
        suggestion.newBucketDescription ?? `Auto-created from: "${thought.summary}"`,
      origin: "auto",
    });
    const placement = await this.joinBucket(created, thought, false);
    return { ...placement, created: true };
  }

  private findByName(buckets: Bucket[], name: string): Bucket | undefined {
    const wanted = name.trim().toLowerCase();
    return buckets.find((b) => b.name.trim().toLowerCase() === wanted);
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
  ): Promise<Placement> {
    if (
      bucket.tenantId !== thought.tenantId ||
      bucket.userId !== thought.userId
    ) {
      throw new Error("Bucket scope does not match thought scope");
    }
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
      bucket: { ...bucket, centroid, itemCount: bucket.itemCount + 1 },
      created: false,
      needsReview,
      similarity: cosineSimilarity(thought.embedding!, bucket.centroid),
    };
  }

  private async fallbackName(thought: Thought): Promise<string> {
    // Last resort: first few words of the summary, title-cased.
    return thought.summary
      .split(/\s+/)
      .slice(0, 3)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }
}
