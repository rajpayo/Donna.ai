/**
 * Structured-routing scorer (Specification 6.7 FR-14).
 *
 * Unlike the v1 organize scorer (proposal-name matching only), this scorer
 * runs each case through the REAL pipeline: scripted transcriber replaying
 * the fixture transcript, the live v2 organizer/namer/embedder, the real
 * file bucket store seeded with the case's fixture buckets (opaque eval
 * IDs), the StructuredBucketEngine decision table, and the durable pending
 * store. It reports SEPARATE metric families so the product owner can see
 * which layer fails:
 *
 *   MODEL PROPOSAL     route.mode_accuracy (join-vs-mint decision),
 *                      route.join_id_accuracy (stable-ID routing),
 *                      mint.precision / mint.recall (decision quality)
 *   DETERMINISTIC FINAL final.placement_acceptance (the user-facing final
 *                      bucket), route.joined_conflict_rate,
 *                      review.pending_rate
 *   MINT QUALITY       mint.validator_pass (canonical validators),
 *                      mint.exact_name (reproducibility diagnostic only)
 *   TASK/PROVENANCE    thought coverage/F1, task precision/recall,
 *                      tasks.hard_rule, provenance, schema
 *
 * Expected labels/IDs are scorer-only and never enter prompts (SR-8).
 * Provenance violations remain HARD FAILURES. Without a live organizer the
 * case errors as external-flaky — never a fake pass.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  hashTranscriptContent,
  type Bucket,
  type Embedder,
  type OrganizeOutputV2,
  type OrganizerV2,
  type BucketNamer,
  type Transcript,
  type TranscriptRecord,
} from "@donna/core";
import {
  bucketDescriptor,
  FileBucketStore,
  FilePendingPlacementStore,
  validateBucketName,
} from "@donna/buckets";
import {
  DeterministicProvenanceVerifier,
  DonnaPipeline,
  FileCaptureStore,
  FileTranscriptStore,
  ProvenanceError,
} from "@donna/pipeline";
import type { LoadedCase } from "../datasets.js";
import type { StageContext, StageScorer } from "../harness.js";
import type { CaseOutcome } from "../report.js";
import type { MeteredGatewayClient } from "../scripted.js";
import { ScriptedTranscriber } from "../scripted.js";
import { normalizeBucketExact } from "./organize.js";

interface OrganizeV2Payload {
  transcript: string;
  existingBuckets?: Array<{ id?: string; name: string; description: string }>;
  expected: {
    thoughts: Array<{
      kind: "idea" | "task" | "note";
      bucket: string | null;
      bucketOrigin?: "minted" | "joined";
      contains: string[];
      task?: { assigneeHint?: string; dueHint?: string };
    }>;
  };
}

export interface OrganizeV2ScorerOptions {
  organizerV2?: OrganizerV2;
  escalationOrganizerV2?: OrganizerV2;
  namer?: BucketNamer;
  embedder?: Embedder;
  meteredGateway?: MeteredGatewayClient;
  bucketTuning: {
    assign_threshold: number;
    create_threshold: number;
    near_duplicate_threshold: number;
  };
  /** Private, owner-only blinded-review source; never copied into reports. */
  onMintedReviewItem?: (item: {
    caseId: string;
    thought: string;
    mintedBucketName: string;
    existingBucketNames: string[];
  }) => void;
}

function transcriptFixture(caseId: string, text: string): TranscriptRecord {
  const base = {
    captureId: `eval-${caseId}`,
    tenantId: "eval-tenant",
    userId: "eval-user",
    text,
    segments: [{ id: "seg-0", text, startSec: 0, endSec: 60 }],
    model: "eval-harness",
    createdAt: "2026-09-03T00:00:00.000Z",
  };
  return { ...base, contentHash: hashTranscriptContent(base) };
}

/** Rough speech duration estimate (~2.5 words/sec), matching full-loop. */
function estimateDurationSec(text: string): number {
  return Math.max(1, text.split(/\s+/).length / 2.5);
}

export function createOrganizeV2Scorer(options: OrganizeV2ScorerOptions): StageScorer {
  const verifier = new DeterministicProvenanceVerifier();
  return {
    stage: "organize",
    cohortKeys: ["language", "accent", "noise"],
    async score(testCase: LoadedCase, context: StageContext): Promise<CaseOutcome[]> {
      const payload = testCase.payload as unknown as OrganizeV2Payload;
      if (options.organizerV2 === undefined || options.embedder === undefined) {
        return [{
          caseId: testCase.id,
          scores: {},
          hardFailures: [],
          error: { class: "external-flaky", token: "gateway-credentials-absent" },
        }];
      }

      const started = Date.now();
      const record = transcriptFixture(testCase.id, payload.transcript);
      const transcript: Transcript = {
        captureId: record.captureId,
        text: record.text,
        segments: record.segments,
        model: record.model,
      };
      const fixtureBuckets = payload.existingBuckets ?? [];

      // --- seed the real scoped store with the fixture buckets ---------
      // Centroids are descriptor embeddings (name + description) — the
      // standard eval approximation of member-thought centroids.
      const caseDir = join(context.scratchDir, "organize-v2", testCase.id);
      await mkdir(caseDir, { recursive: true });
      const store = new FileBucketStore(caseDir);
      const pendingStore = new FilePendingPlacementStore(caseDir);
      const descriptorEmbeddings =
        fixtureBuckets.length > 0
          ? await options.embedder.embed(
              fixtureBuckets.map((b) => bucketDescriptor(b.name, b.description)),
            )
          : [];
      const seeded: Bucket[] = [];
      for (const [index, fixture] of fixtureBuckets.entries()) {
        const bucket: Bucket = {
          // SR-8: fixture IDs are de-identified per-case eval handles.
          id: fixture.id ?? `eval-b-missing-${index}`,
          tenantId: context.scope.tenantId,
          userId: context.scope.userId,
          name: fixture.name,
          description: fixture.description,
          centroid: descriptorEmbeddings[index] ?? [],
          itemCount: 0,
          createdAt: "2026-09-03T00:00:00.000Z",
          origin: "pinned",
        };
        await store.createBucket(bucket);
        seeded.push(bucket);
      }

      // --- run the real pipeline with the live v2 lane ------------------
      // The tracking wrapper records the raw model proposals (route
      // metrics) without changing adapter behavior.
      let trackedOutput: OrganizeOutputV2 | undefined;
      const trackingOrganizer: OrganizerV2 = {
        modelId: options.organizerV2.modelId,
        schemaVersion: options.organizerV2.schemaVersion,
        promptVersion: options.organizerV2.promptVersion,
        async organizeV2(...args) {
          const output = await options.organizerV2!.organizeV2(...args);
          trackedOutput = output;
          return output;
        },
      };

      const captureId = `eval-${testCase.id}`;
      const audioPath = join(caseDir, `${captureId}.wav`);
      await writeFile(audioPath, payload.transcript);

      const pipeline = new DonnaPipeline({
        transcriber: new ScriptedTranscriber(
          new Map([
            [captureId, { text: payload.transcript, durationSec: estimateDurationSec(payload.transcript) }],
          ]),
        ),
        organizer: {
          modelId: "unused-v1-lane",
          async organize(): Promise<never> {
            throw new Error("v1 lane must not run in the v2 scorer");
          },
        },
        organizerV2: trackingOrganizer,
        ...(options.escalationOrganizerV2 !== undefined
          ? { escalationOrganizerV2: options.escalationOrganizerV2 }
          : {}),
        ...(options.namer !== undefined ? { namer: options.namer } : {}),
        pendingPlacements: pendingStore,
        nearDuplicateThreshold: options.bucketTuning.near_duplicate_threshold,
        embedder: options.embedder,
        store,
        captures: new FileCaptureStore(caseDir),
        transcripts: new FileTranscriptStore(caseDir),
        bucketTuning: options.bucketTuning,
      });

      const usageBefore = options.meteredGateway?.usage.length ?? 0;
      let result;
      try {
        result = await pipeline.run({
          id: captureId,
          tenantId: context.scope.tenantId,
          userId: context.scope.userId,
          audioPath,
          capturedAt: new Date().toISOString(),
          durationSec: estimateDurationSec(payload.transcript),
        });
      } catch (error) {
        const message = (error as Error).message;
        const isGateway = /Gateway \d|fetch|ECONN|ETIMEDOUT|network/i.test(message);
        const isProvenance = error instanceof ProvenanceError;
        return [{
          caseId: testCase.id,
          scores: { "organize.schema_valid": isProvenance ? 1 : 0 },
          hardFailures: isProvenance
            ? [{ kind: "invalid-provenance", detail: "pipeline failed closed on provenance" }]
            : [],
          error: {
            class: isGateway ? "external-flaky" : "product",
            token: isProvenance
              ? "provenance-failed-closed"
              : isGateway
                ? "gateway-request-failed"
                : "organizer-output-invalid",
          },
          latencyMs: Date.now() - started,
        }];
      }

      const output = trackedOutput;
      const hardFailures: CaseOutcome["hardFailures"] = [];
      if (output === undefined) {
        return [{
          caseId: testCase.id,
          scores: { "organize.schema_valid": 0 },
          hardFailures: [],
          error: { class: "product", token: "organizer-output-untracked" },
          latencyMs: Date.now() - started,
        }];
      }

      // --- provenance fidelity + hard failures (model-proposed claims) --
      let provenanceValid = 0;
      output.thoughts.forEach((thought, index) => {
        const verified = verifier.verify(record, {
          captureId: record.captureId,
          segmentIds: thought.provenance.segmentIds,
        });
        if (verified.ok) {
          provenanceValid += 1;
        } else {
          hardFailures.push({
            kind: "invalid-provenance",
            detail: `thought ${index}: ${verified.reason}`,
          });
        }
      });
      const provenanceFidelity =
        output.thoughts.length === 0 ? 0 : provenanceValid / output.thoughts.length;

      // --- coverage / over-under-splitting (same rules as the v1 scorer) -
      const expected = payload.expected.thoughts;
      let covered = 0;
      const matchedActual = new Set<number>();
      for (const exp of expected) {
        const hitIndex = output.thoughts.findIndex((t, i) =>
          !matchedActual.has(i) &&
          exp.contains.every((c) =>
            `${t.text} ${t.summary}`.toLowerCase().includes(c.toLowerCase()),
          ),
        );
        if (hitIndex >= 0) {
          covered += 1;
          matchedActual.add(hitIndex);
        }
      }
      const coverage = expected.length === 0 ? 1 : covered / expected.length;
      const thoughtCountF1 =
        expected.length === 0 && output.thoughts.length === 0
          ? 1
          : (2 * Math.min(expected.length, output.thoughts.length)) /
            (expected.length + output.thoughts.length);

      // --- task precision/recall (strict gate definition) ---------------
      const expectedTasks = expected.filter((t) => t.kind === "task");
      const actualTasks = output.thoughts.filter((t) => t.task !== undefined);
      const truePositives = expectedTasks.filter((exp) =>
        actualTasks.some((a) =>
          exp.contains.some((c) =>
            `${a.text} ${a.summary}`.toLowerCase().includes(c.toLowerCase()),
          ),
        ),
      ).length;
      const taskPrecision =
        actualTasks.length === 0
          ? expectedTasks.length === 0 ? 1 : 0
          : truePositives / actualTasks.length;
      const taskRecall =
        expectedTasks.length === 0 ? 1 : truePositives / expectedTasks.length;

      // --- route + final-placement metrics ------------------------------
      // Match each expected thought to an actual thought and to its final
      // pipeline outcome (filed bucket or pending record) by content.
      const pending = result.pendingPlacements ?? [];
      const expectedWithOrigin = expected.filter(
        (t) => t.bucket !== null && t.bucketOrigin !== undefined,
      );
      let modeCorrect = 0;
      let joinIdExpected = 0;
      let joinIdCorrect = 0;
      let joinedConflicts = 0;
      let finalAccepted = 0;
      let mintedExpected = 0;
      let mintedExact = 0;
      let modelSaidNew = 0;
      let modelNewCorrect = 0;
      let newProposals = 0;
      let newValidNames = 0;
      let tasksCorrect = 0;
      let tasksExpected = 0;

      for (const exp of expectedWithOrigin) {
        const actualIndex = output.thoughts.findIndex((t, i) =>
          exp.contains.every((c) =>
            `${t.text} ${t.summary}`.toLowerCase().includes(c.toLowerCase()),
          ),
        );
        const actual = actualIndex >= 0 ? output.thoughts[actualIndex]! : undefined;
        const expectedMode = exp.bucketOrigin === "joined" ? "existing" : "new";
        const expectedFixture = fixtureBuckets.find(
          (b) => normalizeBucketExact(b.name) === normalizeBucketExact(exp.bucket!),
        );

        // Final pipeline outcome for this expected thought.
        const finalItem = result.items.find((item) =>
          exp.contains.every((c) =>
            `${item.thought.text} ${item.thought.summary}`
              .toLowerCase()
              .includes(c.toLowerCase()),
          ),
        );
        const pendingRecord = pending.find((record) =>
          exp.contains.every((c) =>
            `${record.thought.text} ${record.thought.summary}`
              .toLowerCase()
              .includes(c.toLowerCase()),
          ),
        );

        const isTaskCase = exp.kind === "task" || exp.bucket === "Tasks";
        if (isTaskCase) {
          tasksExpected += 1;
          if (
            finalItem !== undefined &&
            finalItem.bucket.name.trim().toLowerCase() === "tasks"
          ) {
            tasksCorrect += 1;
          }
        }

        if (actual === undefined) continue; // coverage miss; counted above

        // Join-vs-mint decision + stable-ID routing (model proposal).
        if (actual.placement.mode === expectedMode) modeCorrect += 1;
        if (actual.placement.mode === "new") {
          modelSaidNew += 1;
          if (expectedMode === "new") modelNewCorrect += 1;
        }
        if (expectedMode === "existing") {
          joinIdExpected += 1;
          if (
            actual.placement.mode === "existing" &&
            expectedFixture !== undefined &&
            actual.placement.bucketId === expectedFixture.id
          ) {
            joinIdCorrect += 1;
          }
          if (
            pendingRecord !== undefined &&
            (pendingRecord.reason === "model-geometry-mismatch" ||
              pendingRecord.reason === "middle-band")
          ) {
            joinedConflicts += 1;
          }
        }

        // Mint quality (proposal side).
        if (expectedMode === "new") {
          mintedExpected += 1;
          const proposedName =
            actual.placement.mode === "new" ? actual.placement.name : "";
          options.onMintedReviewItem?.({
            caseId: testCase.id,
            thought: actual.summary,
            mintedBucketName: proposedName.trim(),
            existingBucketNames: fixtureBuckets.map((b) => b.name),
          });
          if (
            proposedName.trim().length > 0 &&
            normalizeBucketExact(proposedName) === normalizeBucketExact(exp.bucket!)
          ) {
            mintedExact += 1;
          }
        }

        // Deterministic final placement acceptance (user-facing truth).
        if (expectedMode === "existing") {
          if (
            finalItem !== undefined &&
            expectedFixture !== undefined &&
            finalItem.bucket.id === expectedFixture.id
          ) {
            finalAccepted += 1;
          }
        } else {
          // Minted expectation: accepted when the pipeline auto-created a
          // valid distinct bucket (pending review is NOT final acceptance).
          if (
            finalItem !== undefined &&
            result.bucketsCreated.some((b) => b.id === finalItem.bucket.id)
          ) {
            finalAccepted += 1;
          }
        }
      }

      // Canonical validator pass over every actual new-mode proposal.
      for (const thought of output.thoughts) {
        if (thought.placement.mode === "new") {
          newProposals += 1;
          if (validateBucketName(thought.placement.name).length === 0) {
            newValidNames += 1;
          }
        }
      }

      const n = expectedWithOrigin.length;
      const scores: Record<string, number> = {
        "organize.schema_valid": 1,
        "organize.thought_coverage": coverage,
        "organize.thought_count_f1": thoughtCountF1,
        "organize.task_precision": taskPrecision,
        "organize.task_recall": taskRecall,
        "organize.provenance_fidelity": provenanceFidelity,
      };
      if (n > 0) {
        scores["route.mode_accuracy"] = modeCorrect / n;
        scores["final.placement_acceptance"] = finalAccepted / n;
        scores["review.pending_rate"] = pending.length / Math.max(1, output.thoughts.length);
      }
      if (joinIdExpected > 0) {
        scores["route.join_id_accuracy"] = joinIdCorrect / joinIdExpected;
        scores["route.joined_conflict_rate"] = joinedConflicts / joinIdExpected;
      }
      // Mint decision precision/recall (decision, not naming).
      if (modelSaidNew > 0) {
        scores["mint.precision"] = modelNewCorrect / modelSaidNew;
      }
      if (mintedExpected > 0) {
        scores["mint.recall"] = modelNewCorrect / mintedExpected;
        scores["mint.exact_name"] = mintedExact / mintedExpected;
      }
      if (newProposals > 0) {
        scores["mint.validator_pass"] = newValidNames / newProposals;
      }
      if (tasksExpected > 0) {
        scores["tasks.hard_rule"] = tasksCorrect / tasksExpected;
      }

      const newUsage = options.meteredGateway?.usage.slice(usageBefore) ?? [];
      const promptTokens = newUsage.reduce((sum, usage) => sum + (usage.promptTokens ?? 0), 0);
      const completionTokens = newUsage.reduce(
        (sum, usage) => sum + (usage.completionTokens ?? 0),
        0,
      );
      const hasCost = newUsage.some((usage) => usage.costUsd !== undefined);
      const costUsd = newUsage.reduce((sum, usage) => sum + (usage.costUsd ?? 0), 0);

      return [{
        caseId: testCase.id,
        scores,
        hardFailures,
        latencyMs: Date.now() - started,
        ...(promptTokens > 0 || completionTokens > 0
          ? { tokens: { prompt: promptTokens, completion: completionTokens } }
          : {}),
        ...(hasCost ? { costUsd } : {}),
        notes: [
          `expected-with-origin:${n}`,
          `mode-correct:${modeCorrect}`,
          `join-id:${joinIdCorrect}/${joinIdExpected}`,
          `final-accepted:${finalAccepted}/${n}`,
          `mint-decision:${modelNewCorrect}/${modelSaidNew}-said/${mintedExpected}-needed`,
          `validator:${newValidNames}/${newProposals}`,
          `pending:${pending.length}`,
        ],
      }];
    },
  };
}
