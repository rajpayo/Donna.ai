/**
 * Full-loop longitudinal scorer (Specification 4.2): multi-capture
 * scenarios where bucket and memory state evolve across captures and
 * corrections, run through the REAL pipeline, stores, bucket engine,
 * context assembler, correction service, and retrieval index.
 *
 * Two modes:
 *   - deterministic: scripted transcriber/organizer replay the case's
 *     scriptedThoughts; a bag-of-words embedder drives the bucket engine.
 *     Offline, exact, CI-safe — scores the plumbing.
 *   - live: the gateway-backed stack from models.config.yaml transcribes
 *     espeak-ng audio synthesized from the case transcripts, organizes,
 *     and embeds for real — scores the models end to end. Usage reported
 *     by the gateway is metered (tokens; cost when reported, never
 *     estimated).
 *
 * Per capture step the scorer emits one CaseOutcome (loop.accepted,
 * routing.escalated, latency, tokens, cost) and per case a summary
 * outcome (bucket state, hard-rule compliance, adherence counts, cost per
 * accepted loop). Hard failures checked every step: invalid provenance
 * (the pipeline fails closed), tenant leak / unapproved write (the
 * scratch tree must contain ONLY the eval scope's partition).
 *
 * FR-3: the same scenario runs personalized (correction examples injected)
 * or non-personalized (corrections dep omitted) — the two reports compare
 * personalization's effect on the same scenario.
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Bucket,
  ContextBudgets,
  Embedder,
  EventSink,
  Organizer,
  Transcriber,
} from "@donna/core";
import { FileBucketStore } from "@donna/buckets";
import {
  ContextAssembler,
  CorrectionService,
  FileConsentStore,
  FileCorrectionStore,
  FileMemoryStore,
  MemoryService,
} from "@donna/memory";
import {
  DeterministicProvenanceVerifier,
  DonnaPipeline,
  FileCaptureStore,
  FileTranscriptStore,
  ProvenanceError,
} from "@donna/pipeline";
import { LocalRetrievalIndex } from "@donna/retrieval";
import type { LoadedCase } from "../datasets.js";
import type { StageContext, StageScorer } from "../harness.js";
import type { CaseOutcome, HardFailureKind } from "../report.js";
import {
  ScriptedEmbedder,
  ScriptedOrganizer,
  ScriptedTranscriber,
  type MeteredGatewayClient,
  type ScriptedThought,
} from "../scripted.js";

interface FullLoopStep {
  op: "capture" | "correction";
  id?: string;
  transcript?: string;
  scriptedThoughts?: ScriptedThought[];
  type?: "bucket.move" | "bucket.rename";
  thoughtContains?: string;
  toBucket?: string;
}

interface FullLoopPayload {
  description: string;
  steps: FullLoopStep[];
  expect: {
    buckets: string[];
    mustNotHaveBuckets: string[];
    allTasksInTasksBucket: boolean;
    adherence?: { followed?: number; contradicted?: number };
  };
}

export interface FullLoopScorerOptions {
  mode: "deterministic" | "live";
  /** Live mode: the config-resolved stack (transcriber/organizer/embedder). */
  live?: {
    transcriber: Transcriber;
    organizer: Organizer;
    escalationOrganizer?: Organizer;
    embedder: Embedder;
    meteredGateway?: MeteredGatewayClient;
    /** Model IDs of the default/escalation organize lanes (routing metric). */
    defaultOrganizerModel: string;
    escalationOrganizerModel?: string;
  };
  /** FR-3: when false, correction examples are NOT injected (comparison). */
  personalized: boolean;
  bucketTuning: { assign_threshold: number; create_threshold: number };
  contextBudgets: ContextBudgets;
  /**
   * Fault injection seam (AC-1: known intentionally broken implementations
   * must reduce the expected metrics). Deterministic mode only: replaces
   * the scripted organizer with a broken one to prove the pipeline fails
   * closed and the report records the hard failure.
   */
  faultInjection?: { organizer?: Organizer };
}

/** Rough speech duration estimate for synthetic fixtures (~2.5 words/sec). */
function estimateDurationSec(text: string): number {
  return Math.max(1, text.split(/\s+/).length / 2.5);
}

export function createFullLoopScorer(options: FullLoopScorerOptions): StageScorer {
  return {
    stage: "full-loop",
    cohortKeys: ["language", "accent", "noise"],

    async score(testCase: LoadedCase, context: StageContext): Promise<CaseOutcome[]> {
      const payload = testCase.payload as unknown as FullLoopPayload;
      const caseDir = join(context.scratchDir, "full-loop", testCase.id);
      await mkdir(caseDir, { recursive: true });

      // --- real stores and services, isolated under the eval scope ---
      const store = new FileBucketStore(caseDir);
      const captures = new FileCaptureStore(caseDir);
      const transcripts = new FileTranscriptStore(caseDir);
      const memory = new MemoryService({
        memories: new FileMemoryStore(caseDir),
        consents: new FileConsentStore(caseDir),
        now: () => new Date(),
      });
      const correctionService = new CorrectionService({
        corrections: new FileCorrectionStore(caseDir),
        buckets: store,
        memory,
        transcripts,
        verifier: new DeterministicProvenanceVerifier(),
        // Keyword applicability in deterministic mode; the live embedder
        // is wired in live mode (semantic path, Spec 3.3).
        ...(options.mode === "live" && options.live !== undefined
          ? { embedder: options.live.embedder }
          : {}),
        now: () => new Date(),
      });
      const retrievalIndex = new LocalRetrievalIndex({ dataDir: caseDir, store });
      const assembler = new ContextAssembler({
        memory,
        buckets: store,
        captures,
        transcripts,
        ...(options.personalized ? { corrections: correctionService } : {}),
        ...(options.mode === "live" && options.live !== undefined
          ? { embedder: options.live.embedder }
          : {}),
        budgets: options.contextBudgets,
        now: () => new Date(),
      });

      // --- adapters ---
      const captureSteps = payload.steps.filter((s) => s.op === "capture");
      const transcriptScripts = new Map(
        captureSteps.map((s) => [
          `${testCase.id}-${s.id}`,
          { text: s.transcript!, durationSec: estimateDurationSec(s.transcript!) },
        ]),
      );
      const organizerScripts = new Map(
        captureSteps.map((s) => [`${testCase.id}-${s.id}`, s.scriptedThoughts ?? []]),
      );
      const embedder: Embedder =
        options.mode === "live" && options.live !== undefined
          ? options.live.embedder
          : new ScriptedEmbedder();

      // Lane usage tracking for the routing metric (per capture).
      let organizeCalls = 0;
      let escalations = 0;
      const trackLane = (organizer: Organizer, lane: "default" | "escalation"): Organizer => {
        const tracked: Organizer = {
          modelId: organizer.modelId,
          async organize(...args) {
            organizeCalls += 1;
            if (lane === "escalation") escalations += 1;
            return organizer.organize(...args);
          },
        };
        if (organizer.schemaVersion !== undefined) {
          (tracked as { schemaVersion?: string }).schemaVersion = organizer.schemaVersion;
        }
        if (organizer.promptVersion !== undefined) {
          (tracked as { promptVersion?: string }).promptVersion = organizer.promptVersion;
        }
        return tracked;
      };

      const events: Array<{ name: string; attrs: Record<string, string | number | boolean> }> = [];
      const eventSink: EventSink = {
        emit(event) {
          events.push({ name: event.name, attrs: event.attrs ?? {} });
        },
      };

      const pipeline = new DonnaPipeline({
        transcriber:
          options.mode === "live" && options.live !== undefined
            ? options.live.transcriber
            : new ScriptedTranscriber(transcriptScripts),
        organizer:
          options.mode === "live" && options.live !== undefined
            ? trackLane(options.live.organizer, "default")
            : (options.faultInjection?.organizer ?? new ScriptedOrganizer(organizerScripts)),
        ...(options.mode === "live" && options.live?.escalationOrganizer !== undefined
          ? { escalationOrganizer: trackLane(options.live.escalationOrganizer, "escalation") }
          : {}),
        embedder,
        store,
        captures,
        transcripts,
        bucketTuning: options.bucketTuning,
        events: eventSink,
        contextAssembler: assembler,
        correctionObserver: correctionService,
        retrievalIndex,
      });

      // --- run the scenario ---
      const outcomes: CaseOutcome[] = [];
      const hardFailures: Array<{ kind: HardFailureKind; detail: string }> = [];
      let acceptedLoops = 0;
      let totalCostUsd: number | null = null;
      let totalTokens = 0;

      for (const step of payload.steps) {
        if (step.op === "capture") {
          const captureId = `${testCase.id}-${step.id}`;
          const audioPath = join(caseDir, `${captureId}.wav`);
          // Deterministic mode: the scripted transcriber ignores the bytes.
          // Live mode: synthesize real audio with espeak-ng (the true loop).
          if (options.mode === "live") {
            const { execFile } = await import("node:child_process");
            const { promisify } = await import("node:util");
            await promisify(execFile)("espeak-ng", [
              "-v", "en-us", "-s", "160", "-w", audioPath, step.transcript!,
            ]);
          } else {
            await writeFile(audioPath, step.transcript!);
          }

          const usageBefore = options.live?.meteredGateway?.usage.length ?? 0;
          const eventsBefore = events.length;
          const started = Date.now();
          try {
            const result = await pipeline.run({
              id: captureId,
              tenantId: context.scope.tenantId,
              userId: context.scope.userId,
              audioPath,
              capturedAt: new Date().toISOString(),
              durationSec: estimateDurationSec(step.transcript!),
            });
            acceptedLoops += 1;
            // Placement-time hard rule (absolute): every task-bearing
            // thought must be PLACED in Tasks by the engine. Post-placement
            // correction moves are measured separately at the summary level.
            const placementViolations = result.items.filter(
              (item) =>
                item.thought.task !== undefined &&
                item.bucket.name.trim().toLowerCase() !== "tasks",
            );

            // Usage attribution: the metered gateway between before/after.
            let costUsd: number | undefined;
            let tokens: { prompt?: number; completion?: number } | undefined;
            if (options.live?.meteredGateway !== undefined) {
              const newUsage = options.live.meteredGateway.usage.slice(usageBefore);
              const cost = newUsage.reduce((a, u) => a + (u.costUsd ?? 0), 0);
              const hasCost = newUsage.some((u) => u.costUsd !== undefined);
              if (hasCost) {
                costUsd = cost;
                totalCostUsd = (totalCostUsd ?? 0) + cost;
              }
              const prompt = newUsage.reduce((a, u) => a + (u.promptTokens ?? 0), 0);
              const completion = newUsage.reduce((a, u) => a + (u.completionTokens ?? 0), 0);
              if (prompt + completion > 0) tokens = { prompt, completion };
              totalTokens += prompt + completion;
            }

            const escalated = events
              .slice(eventsBefore)
              .some(
                (e) =>
                  e.name === "stage.organize" &&
                  options.live?.escalationOrganizerModel !== undefined &&
                  e.attrs["model"] === options.live.escalationOrganizerModel,
              );
            outcomes.push({
              caseId: `${testCase.id}/${step.id}`,
              scores: {
                "loop.accepted": 1,
                "routing.escalated": escalated ? 1 : 0,
                "loop.tasks_hard_rule": placementViolations.length === 0 ? 1 : 0,
              },
              hardFailures: [],
              latencyMs: result.metrics.totalLatencyMs,
              ...(tokens !== undefined ? { tokens } : {}),
              ...(costUsd !== undefined ? { costUsd } : {}),
              notes: [
                `thoughts:${result.items.length}`,
                `stt-ms:${result.metrics.sttLatencyMs}`,
                `organize-ms:${result.metrics.organizeLatencyMs}`,
                `embed-ms:${result.metrics.embedLatencyMs}`,
                `wall-ms:${Date.now() - started}`,
              ],
            });
          } catch (error) {
            if (error instanceof ProvenanceError) {
              hardFailures.push({
                kind: "invalid-provenance",
                detail: `${step.id}: provenance verification failed closed`,
              });
            }
            const message = (error as Error).message;
            const isGateway = /Gateway \d|fetch|ECONN|ETIMEDOUT|network/i.test(message);
            outcomes.push({
              caseId: `${testCase.id}/${step.id}`,
              scores: { "loop.accepted": 0 },
              hardFailures:
                error instanceof ProvenanceError
                  ? [{ kind: "invalid-provenance", detail: `${step.id}: ${error.failures.length} invalid` }]
                  : [],
              error: {
                class: isGateway ? "external-flaky" : "product",
                token:
                  error instanceof ProvenanceError
                    ? "provenance-failed-closed"
                    : isGateway
                      ? "gateway-request-failed"
                      : "pipeline-stage-failed",
              },
              latencyMs: Date.now() - started,
            });
          }
        } else {
          // correction step: find the thought, submit + accept for real.
          const items = await store.listItems(context.scope.tenantId, context.scope.userId);
          const target = items.find((item) =>
            `${item.thought.text} ${item.thought.summary}`
              .toLowerCase()
              .includes(step.thoughtContains!.toLowerCase()),
          );
          if (target === undefined) {
            outcomes.push({
              caseId: `${testCase.id}/correction-${step.thoughtContains}`,
              scores: {},
              hardFailures: [],
              error: { class: "product", token: "correction-target-not-found" },
            });
            continue;
          }
          const buckets = await store.listBuckets(context.scope.tenantId, context.scope.userId);
          let toBucket: Bucket | undefined = buckets.find(
            (b) => b.name.trim().toLowerCase() === step.toBucket!.trim().toLowerCase(),
          );
          if (toBucket === undefined) {
            toBucket = await store.createBucket({
              id: `b-${step.toBucket!.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
              tenantId: context.scope.tenantId,
              userId: context.scope.userId,
              name: step.toBucket!,
              description: `${step.toBucket} bucket`,
              centroid: target.thought.embedding ?? [1, 0, 0],
              itemCount: 0,
              createdAt: new Date().toISOString(),
              origin: "pinned",
            });
          }
          const fromBucket = buckets.find((b) => b.id === target.bucketId);
          const event = await correctionService.submit(context.scope, {
            type: step.type ?? "bucket.move",
            target: { kind: "thought", id: target.thought.id },
            payload: {
              thoughtSummary: target.thought.summary,
              fromBucketName: fromBucket?.name ?? "",
              fromBucketId: target.bucketId,
              toBucketName: step.toBucket!,
              toBucketId: toBucket.id,
            },
            sources: [{ kind: "thought", id: target.thought.id, reason: "eval correction step" }],
          });
          await correctionService.accept(context.scope, event.id);
        }
      }

      // --- final state assertions ---
      const finalBuckets = await store.listBuckets(context.scope.tenantId, context.scope.userId);
      const finalNames = finalBuckets.map((b) => b.name);
      const missing = payload.expect.buckets.filter(
        (name) => !finalNames.some((n) => n.trim().toLowerCase() === name.trim().toLowerCase()),
      );
      const forbidden = payload.expect.mustNotHaveBuckets.filter((name) =>
        finalNames.some((n) => n.trim().toLowerCase() === name.trim().toLowerCase()),
      );
      const bucketStateCorrect = missing.length === 0 && forbidden.length === 0;

      // Final-state check (informational): accepted corrections can move
      // items after placement; whether a correction may move a TASK out of
      // Tasks is a product decision point (see the phase README evidence).
      const finalItems = await store.listItems(context.scope.tenantId, context.scope.userId);
      const tasksOutsideTasks = finalItems.filter(
        (item) =>
          item.thought.task !== undefined &&
          finalBuckets.find((b) => b.id === item.bucketId)?.name.trim().toLowerCase() !== "tasks",
      );

      // Adherence counters from the correction events themselves.
      const corrections = await correctionService.list(context.scope);
      const followed = corrections.reduce((a, e) => a + e.followedCount, 0);
      const contradicted = corrections.reduce((a, e) => a + e.contradictedCount, 0);
      const adherenceOk =
        followed === (payload.expect.adherence?.followed ?? followed) &&
        contradicted === (payload.expect.adherence?.contradicted ?? contradicted);

      // Isolation sweep: the scratch tree must contain ONLY the eval scope.
      const partitionOk = await assertOnlyEvalPartitions(caseDir, context.scope);
      if (!partitionOk) {
        hardFailures.push({ kind: "tenant-leak", detail: "foreign partition in eval scratch tree" });
      }

      const summaryScores: Record<string, number> = {
        "loop.bucket_state_correct": bucketStateCorrect ? 1 : 0,
        "loop.tasks_final_in_tasks": tasksOutsideTasks.length === 0 ? 1 : 0,
        "loop.adherence_as_expected": adherenceOk ? 1 : 0,
      };
      if (organizeCalls > 0) {
        summaryScores["routing.escalation_rate"] = escalations / organizeCalls;
      }
      if (totalCostUsd !== null && acceptedLoops > 0) {
        summaryScores["cost.usd_per_accepted_loop"] = totalCostUsd / acceptedLoops;
      }
      const summaryNotes = [
        `buckets:${finalNames.sort().join("|")}`,
        `followed:${followed}`,
        `contradicted:${contradicted}`,
        `accepted-loops:${acceptedLoops}`,
        `personalized:${options.personalized}`,
      ];
      if (missing.length > 0) summaryNotes.push(`missing-buckets:${missing.length}`);
      if (forbidden.length > 0) summaryNotes.push(`forbidden-buckets:${forbidden.length}`);
      if (tasksOutsideTasks.length > 0) summaryNotes.push(`tasks-outside-tasks:${tasksOutsideTasks.length}`);
      if (totalTokens > 0) summaryNotes.push(`total-tokens:${totalTokens}`);

      outcomes.push({
        caseId: `${testCase.id}/summary`,
        scores: summaryScores,
        hardFailures,
        notes: summaryNotes,
      });
      return outcomes;
    },
  };
}

/**
 * The scratch tree must contain partitions for the eval scope only.
 * Store layouts: <dir>/<tenant>/<user>.json (file stores) and
 * <dir>/<tenant>/<user>/… (retrieval index). Synthetic audio fixtures
 * (<capture>.wav at the root) are inputs, not partitions.
 */
async function assertOnlyEvalPartitions(
  caseDir: string,
  scope: { tenantId: string; userId: string },
): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(caseDir, { withFileTypes: true });
  } catch {
    return true; // nothing written
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue; // fixture audio files at the root
    if (entry.name !== scope.tenantId) return false;
    const userEntries = await readdir(join(caseDir, entry.name), {
      withFileTypes: true,
    });
    for (const userEntry of userEntries) {
      const isEvalUser =
        userEntry.name === scope.userId || userEntry.name === `${scope.userId}.json`;
      if (!isEvalUser) return false;
    }
  }
  return true;
}
