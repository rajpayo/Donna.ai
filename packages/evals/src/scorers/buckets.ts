/**
 * Buckets stage scorer (Specification 4.2): bucket agreement/acceptance
 * for the assignment cases seeded from real demo misfires.
 *
 * Each case replays the observed scenario through the REAL BucketEngine:
 * existing buckets + a new thought + the organizer's proposal (the cases
 * were misfires where the organizer proposed the labeled name — the
 * suggestion is part of the replayed scenario). The deterministic
 * ScriptedEmbedder drives embeddings; the engine's thresholds, hard rule,
 * and name-collision guard decide placement exactly as in production.
 *
 * Metrics:
 *   - buckets.action_correct: join vs create matches the label.
 *   - buckets.no_duplicate: no bucket minted with a name the case forbids
 *     (the 2026-09-02 duplicate-onboarding misfire class).
 */
import { randomUUID } from "node:crypto";
import type { Bucket, Thought } from "@donna/core";
import { BucketEngine, FileBucketStore } from "@donna/buckets";
import { join } from "node:path";
import type { LoadedCase } from "../datasets.js";
import type { StageContext, StageScorer } from "../harness.js";
import type { CaseOutcome } from "../report.js";
import { ScriptedEmbedder } from "../scripted.js";

interface BucketsPayload {
  existingBuckets: Array<{ name: string; description: string }>;
  thought: { summary: string; text: string; isTask: boolean };
  expected: { action: "join" | "create"; bucket: string; mustNotCreate: string[] };
}

export interface BucketsScorerOptions {
  tuning: { assign_threshold: number; create_threshold: number };
}

export function createBucketsScorer(options: BucketsScorerOptions): StageScorer {
  return {
    stage: "buckets",
    async score(testCase: LoadedCase, context: StageContext): Promise<CaseOutcome[]> {
      const payload = testCase.payload as unknown as BucketsPayload;
      const store = new FileBucketStore(join(context.scratchDir, "buckets", testCase.id));
      const embedder = new ScriptedEmbedder();
      const engine = new BucketEngine(store, options.tuning);

      const buckets: Bucket[] = [];
      for (const existing of payload.existingBuckets) {
        const [embedding] = await embedder.embed([`${existing.name} ${existing.description}`]);
        const bucket: Bucket = {
          id: `b-${existing.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          tenantId: context.scope.tenantId,
          userId: context.scope.userId,
          name: existing.name,
          description: existing.description,
          centroid: embedding!,
          itemCount: 1,
          createdAt: "2026-08-01T00:00:00.000Z",
          origin: "auto",
        };
        await store.createBucket(bucket);
        buckets.push(bucket);
      }

      const [thoughtEmbedding] = await embedder.embed([payload.thought.text]);
      const thought: Thought = {
        id: randomUUID(),
        tenantId: context.scope.tenantId,
        userId: context.scope.userId,
        summary: payload.thought.summary,
        text: payload.thought.text,
        confidence: 0.9,
        ...(payload.thought.isTask
          ? { task: { title: payload.thought.summary } }
          : {}),
        provenance: {
          captureId: `eval-${testCase.id}`,
          segmentIds: ["seg-0"],
          sourceText: payload.thought.text,
          startSec: 0,
          endSec: 1,
        },
        versions: { organizerModel: "eval", organizeSchemaVersion: "s", organizePromptVersion: "p" },
        embedding: thoughtEmbedding,
        createdAt: "2026-09-03T00:00:00.000Z",
      };

      // The replayed scenario: the organizer proposed the labeled bucket
      // name (per the misfire notes); the engine decides.
      const suggestion = payload.thought.isTask
        ? {}
        : { suggestedBucket: payload.expected.bucket };
      const placement = await engine.place(thought, suggestion, buckets);

      const actionCorrect =
        payload.expected.action === "join"
          ? !placement.created && placement.bucket.name === payload.expected.bucket
          : placement.created && placement.bucket.name === payload.expected.bucket;
      const allBuckets = await store.listBuckets(context.scope.tenantId, context.scope.userId);
      const duplicates = payload.expected.mustNotCreate.filter((name) =>
        allBuckets.some((b) => b.name.trim().toLowerCase() === name.trim().toLowerCase()),
      );
      // A forbidden name that PRE-EXISTED is not a duplicate mint.
      const preExisting = new Set(payload.existingBuckets.map((b) => b.name.toLowerCase()));
      const minted = duplicates.filter((name) => !preExisting.has(name.toLowerCase()));

      return [{
        caseId: testCase.id,
        scores: {
          "buckets.action_correct": actionCorrect ? 1 : 0,
          "buckets.no_duplicate": minted.length === 0 ? 1 : 0,
        },
        hardFailures: [],
        notes: [
          `placed:${placement.bucket.name}`,
          `created:${placement.created}`,
          `needs-review:${placement.needsReview}`,
        ],
      }];
    },
  };
}
