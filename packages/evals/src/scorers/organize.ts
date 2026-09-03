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
  expected: {
    thoughts: Array<{
      kind: "idea" | "task" | "note";
      bucket: string | null;
      contains: string[];
      task?: { assigneeHint?: string; dueHint?: string };
    }>;
  };
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

      let output;
      try {
        output = await options.organizer.organize(transcript, []);
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
      for (const exp of bucketExpected) {
        const actual = output.thoughts.find((t) =>
          exp.contains.every((c) =>
            `${t.text} ${t.summary}`.toLowerCase().includes(c.toLowerCase()),
          ),
        );
        const proposed = (actual?.suggestedBucket ?? actual?.newBucketName ?? "")
          .trim()
          .toLowerCase();
        if (actual !== undefined && proposed === exp.bucket!.trim().toLowerCase()) {
          bucketAgreed += 1;
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

      return [{
        caseId: testCase.id,
        scores,
        hardFailures,
        latencyMs: Date.now() - started,
      }];
    },
  };
}
