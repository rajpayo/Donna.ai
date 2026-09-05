/**
 * Emotion calibration stage scorer (Specification 4.2): calibration and
 * abstention of the deterministic session emotion heuristic, wired through
 * the 4.1 harness (the pre-Phase-4 flat runner stays for compatibility).
 *
 * Metric (documented in METRIC_DOCS):
 *   - emotion.calibration: per case, 1 when the expected label is detected
 *     at ≥ minConfidence, an abstain-expected case produces no labels, and
 *     no label exceeds the case's max confidence cap; else 0.
 */
import { analyzeTranscript } from "@donna/memory";
import type { LoadedCase } from "../datasets.js";
import type { StageContext, StageScorer } from "../harness.js";
import type { CaseOutcome } from "../report.js";

interface EmotionPayload {
  text: string;
  expect: {
    label?: string;
    minConfidence?: number;
    abstain?: boolean;
    maxConfidence?: number;
  };
}

export function createEmotionScorer(): StageScorer {
  return {
    stage: "emotion",
    async score(testCase: LoadedCase, _context: StageContext): Promise<CaseOutcome[]> {
      const payload = testCase.payload as unknown as EmotionPayload;
      const result = analyzeTranscript([
        { id: "seg-0", text: payload.text, startSec: 0, endSec: 5 },
      ]);
      const notes: string[] = [];
      let pass = true;

      if (payload.expect.abstain === true) {
        if (!result.abstained || result.labels.length > 0) {
          pass = false;
          notes.push("expected-abstention-got-labels");
        }
      }
      if (payload.expect.label !== undefined) {
        const found = result.labels.find((l) => l.label === payload.expect.label);
        const min = payload.expect.minConfidence ?? 0;
        if (found === undefined || found.confidence < min) {
          pass = false;
          notes.push("expected-label-not-detected");
        }
      }
      if (payload.expect.maxConfidence !== undefined) {
        for (const label of result.labels) {
          if (label.confidence > payload.expect.maxConfidence) {
            pass = false;
            notes.push("confidence-exceeds-cap");
          }
        }
      }

      return [{
        caseId: testCase.id,
        scores: { "emotion.calibration": pass ? 1 : 0 },
        hardFailures: [],
        ...(notes.length > 0 ? { notes } : {}),
      }];
    },
  };
}
