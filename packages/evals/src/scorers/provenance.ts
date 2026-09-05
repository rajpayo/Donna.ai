/**
 * Provenance stage scorer (Specification 4.2): the deterministic verifier
 * must accept valid claims and reject invalid ones with the expected
 * reason token. A false acceptance is an invalid-provenance HARD FAILURE
 * (SR-1); a false rejection is a quality miss.
 *
 * Metric:
 *   - provenance.decision_correct: per case, 1 when every claim's
 *     validity (and reason, when labeled) matches the expectation.
 */
import { hashTranscriptContent } from "@donna/core";
import { DeterministicProvenanceVerifier } from "@donna/pipeline";
import type { LoadedCase } from "../datasets.js";
import type { StageContext, StageScorer } from "../harness.js";
import type { CaseOutcome } from "../report.js";

interface ProvenancePayload {
  transcript: {
    text: string;
    segments: Array<{ id: string; text: string; startSec: number; endSec: number }>;
    language?: string;
  };
  claims: Array<{ segmentIds: string[]; expect: "valid" | "invalid"; reason?: string }>;
}

export function createProvenanceScorer(): StageScorer {
  const verifier = new DeterministicProvenanceVerifier();
  return {
    stage: "provenance",
    async score(testCase: LoadedCase, context: StageContext): Promise<CaseOutcome[]> {
      const payload = testCase.payload as unknown as ProvenancePayload;
      const base = {
        captureId: `eval-${testCase.id}`,
        tenantId: context.scope.tenantId,
        userId: context.scope.userId,
        text: payload.transcript.text,
        segments: payload.transcript.segments,
        ...(payload.transcript.language !== undefined
          ? { language: payload.transcript.language }
          : {}),
        model: "eval-fixture",
        createdAt: "2026-09-03T00:00:00.000Z",
      };
      const record = { ...base, contentHash: hashTranscriptContent(base) };

      const hardFailures: CaseOutcome["hardFailures"] = [];
      const notes: string[] = [];
      let allCorrect = true;
      for (const claim of payload.claims) {
        const result = verifier.verify(record, {
          captureId: record.captureId,
          segmentIds: claim.segmentIds,
        });
        if (claim.expect === "valid" && !result.ok) {
          allCorrect = false;
          notes.push(`false-rejection:${result.reason}`);
        }
        if (claim.expect === "invalid") {
          if (result.ok) {
            allCorrect = false;
            hardFailures.push({
              kind: "invalid-provenance",
              detail: `false claim accepted (segments: ${claim.segmentIds.join("+") || "none"})`,
            });
          } else if (claim.reason !== undefined && result.reason !== claim.reason) {
            allCorrect = false;
            notes.push(`reason-mismatch:${result.reason}!=${claim.reason}`);
          }
        }
      }

      return [{
        caseId: testCase.id,
        scores: { "provenance.decision_correct": allCorrect ? 1 : 0 },
        hardFailures,
        ...(notes.length > 0 ? { notes } : {}),
      }];
    },
  };
}
