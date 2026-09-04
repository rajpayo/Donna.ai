/**
 * Organize stage scorer (Specification 4.2).
 *
 * Extends the pre-Phase-4 scoreCase metrics with bucket acceptance and
 * provenance fidelity, and classifies provenance violations as HARD
 * FAILURES (SR-1 — they never average out):
 *
 *   - organize.schema_valid: output parsed the organize schema.
 *   - organize.thought_coverage: expected substring groups fully covered
 *     by at least one actual thought (denominator: expected thoughts).
 *   - organize.thought_count_f1: over/under-splitting (harmonic mean of
 *     expected vs actual thought counts).
 *   - organize.task_precision / organize.task_recall: against the labeled
 *     task-bearing thoughts.
 *   - organize.bucket_acceptance: for labeled thoughts with a bucket
 *     expectation, the actual thought's proposed bucket matches
 *     (denominator: expected thoughts with non-null bucket; thoughts
 *     labeled null = "any sensible new bucket" are excluded).
 *   - organize.provenance_fidelity: model-proposed provenance verified
 *     against the transcript fixture (denominator: actual thoughts).
 *     Any invalid claim is an invalid-provenance HARD FAILURE.
 *
 * This stage needs the live gateway. Without an organizer every case
 * errors as external-flaky — never a fake pass.
 */
import type { Organizer, Transcript, TranscriptRecord } from "@donna/core";
import { hashTranscriptContent } from "@donna/core";
import { DeterministicProvenanceVerifier } from "@donna/pipeline";
import type { LoadedCase } from "../datasets.js";
import type { StageContext, StageScorer } from "../harness.js";
import type { CaseOutcome } from "../report.js";

interface OrganizePayload {
  transcript: string;
  existingBuckets?: Array<{ name: string; description: string }>;
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

/** The gate's existing exact-match normalization; deliberately not fuzzy. */
export function normalizeBucketExact(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Non-gate diagnostic v1 (Specification 6.5 FR-4/SR-2): punctuation and
 * whitespace are folded, then unique token sets are compared without
 * regard to order. This must never feed organize.bucket_acceptance.
 */
export const BUCKET_NAME_EQUIVALENCE_RULE = "token-set-v1";
export function bucketNamesEquivalent(left: string, right: string): boolean {
  const tokens = (value: string): string[] => [
    ...new Set(
      value
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[\p{P}\p{S}]+/gu, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean),
    ),
  ].sort();
  const a = tokens(left);
  const b = tokens(right);
  return a.length > 0 && a.length === b.length && a.every((token, i) => token === b[i]);
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

export interface OrganizeScorerOptions {
  organizer?: Organizer;
}

export function createOrganizeScorer(options: OrganizeScorerOptions): StageScorer {
  const verifier = new DeterministicProvenanceVerifier();
  return {
    stage: "organize",
    // Spec 6.4 (FR-12/SR-4): promoted pilot cases carry cohort metadata
    // (language/accent/noise) through the case-meta fields; slices smaller
    // than MIN_COHORT_SIZE stay suppressed in reports.
    cohortKeys: ["language", "accent", "noise"],
    async score(testCase: LoadedCase, _context: StageContext): Promise<CaseOutcome[]> {
      const payload = testCase.payload as unknown as OrganizePayload;
      if (options.organizer === undefined) {
        return [{
          caseId: testCase.id,
          scores: {},
          hardFailures: [],
          error: { class: "external-flaky", token: "gateway-credentials-absent" },
        }];
      }

      const record = transcriptFixture(testCase.id, payload.transcript);
      const transcript: Transcript = {
        captureId: record.captureId,
        text: record.text,
        segments: record.segments,
        model: record.model,
      };
      const started = Date.now();
      const existingBuckets = (payload.existingBuckets ?? []).map((bucket) => ({
        name: bucket.name,
        description: bucket.description,
      }));

      let output;
      try {
        output = await options.organizer.organize(transcript, existingBuckets);
      } catch (error) {
        const message = (error as Error).message;
        const isGateway = /Gateway \d|fetch|ECONN|ETIMEDOUT|network/i.test(message);
        return [{
          caseId: testCase.id,
          scores: { "organize.schema_valid": 0 },
          hardFailures: [],
          error: {
            class: isGateway ? "external-flaky" : "product",
            token: isGateway ? "gateway-request-failed" : "organizer-output-invalid",
          },
          latencyMs: Date.now() - started,
        }];
      }

      // --- provenance fidelity + hard failures ---
      const hardFailures: CaseOutcome["hardFailures"] = [];
      let provenanceValid = 0;
      output.thoughts.forEach((thought, index) => {
        const result = verifier.verify(record, {
          captureId: record.captureId,
          segmentIds: thought.provenance.segmentIds,
        });
        if (result.ok) {
          provenanceValid += 1;
        } else {
          hardFailures.push({
            kind: "invalid-provenance",
            detail: `thought ${index}: ${result.reason}`,
          });
        }
      });
      const provenanceFidelity =
        output.thoughts.length === 0 ? 0 : provenanceValid / output.thoughts.length;

      // --- coverage / over-under-splitting (same rules as scoreCase) ---
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

      // --- task precision/recall ---
      // Strict definition for the graduation gate: an expected task counts
      // only when a TASK-BEARING actual thought covers it (content present
      // but not marked as a task is a recall miss).
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

      // --- bucket acceptance (first-pass agreement with the labels) ---
      const bucketExpected = expected.filter((t) => t.bucket !== null);
      let bucketAgreed = 0;
      let mintedExpected = 0;
      let mintedAgreed = 0;
      let mintedEquivalent = 0;
      let joinedExpected = 0;
      let joinedAgreed = 0;
      for (const exp of bucketExpected) {
        const actual = output.thoughts.find((t) =>
          exp.contains.every((c) =>
            `${t.text} ${t.summary}`.toLowerCase().includes(c.toLowerCase()),
          ),
        );
        const label = normalizeBucketExact(exp.bucket!);
        const proposed = normalizeBucketExact(
          actual?.suggestedBucket ?? actual?.newBucketName ?? "",
        );
        const exactMatch =
          exp.bucketOrigin === "minted"
            ? actual?.newBucketName !== undefined &&
              actual.newBucketName.trim().length > 0 &&
              normalizeBucketExact(actual.newBucketName) === label
            : actual !== undefined && proposed === label;
        if (exactMatch) {
          bucketAgreed += 1;
        }
        if (exp.bucketOrigin === "minted") {
          mintedExpected += 1;
          if (exactMatch) mintedAgreed += 1;
          if (
            actual?.newBucketName !== undefined &&
            actual.newBucketName.trim().length > 0 &&
            bucketNamesEquivalent(actual.newBucketName, exp.bucket!)
          ) {
            mintedEquivalent += 1;
          }
        } else if (exp.bucketOrigin === "joined") {
          joinedExpected += 1;
          if (exactMatch) joinedAgreed += 1;
        }
      }
      const scores: Record<string, number> = {
        "organize.schema_valid": 1,
        "organize.thought_coverage": coverage,
        "organize.thought_count_f1": thoughtCountF1,
        "organize.task_precision": taskPrecision,
        "organize.task_recall": taskRecall,
        "organize.provenance_fidelity": provenanceFidelity,
      };
      if (bucketExpected.length > 0) {
        scores["organize.bucket_acceptance"] = bucketAgreed / bucketExpected.length;
      }
      if (mintedExpected > 0) {
        scores["organize.bucket_acceptance_minted"] = mintedAgreed / mintedExpected;
        scores["organize.bucket_name_equivalence"] =
          mintedEquivalent / mintedExpected;
      }
      if (joinedExpected > 0) {
        scores["organize.bucket_acceptance_joined"] = joinedAgreed / joinedExpected;
      }

      return [{
        caseId: testCase.id,
        scores,
        hardFailures,
        latencyMs: Date.now() - started,
        ...(mintedExpected + joinedExpected > 0
          ? {
              notes: [
                `bucket-origin-minted:${mintedExpected}`,
                `bucket-origin-joined:${joinedExpected}`,
                `bucket-equivalence-rule:${BUCKET_NAME_EQUIVALENCE_RULE}`,
                `bucket-equivalence-only:${Math.max(0, mintedEquivalent - mintedAgreed)}`,
              ],
            }
          : {}),
      }];
    },
  };
}
