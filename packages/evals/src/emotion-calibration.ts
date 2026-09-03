/**
 * Calibration eval for session emotion/intent inference (Spec 2.4 AC-3).
 *
 * Measures the two failure modes the product cares about:
 *   - false-confident inference: labeling a case that should abstain;
 *   - missed abstention: failing to decline when evidence is insufficient;
 * plus a hard cap check: no inference may exceed the analyzer's confidence
 * cap, so the product can never sound certain about feelings.
 */
import type { EmotionLabel } from "@donna/core";

export interface EmotionCalibrationCase {
  id: string;
  text: string;
  expect: {
    label?: EmotionLabel;
    minConfidence?: number;
    abstain?: boolean;
    maxConfidence?: number;
  };
}

export interface EmotionCalibrationDataset {
  name: string;
  cases: EmotionCalibrationCase[];
}

export interface EmotionCalibrationReport {
  dataset: string;
  total: number;
  /** Clear cases where the expected label was found at ≥ minConfidence. */
  clearDetected: number;
  clearTotal: number;
  /** Abstain-expected cases where a label was inferred anyway. */
  falseConfident: number;
  abstainTotal: number;
  /** Highest confidence produced across all cases. */
  maxConfidenceSeen: number;
  /** Per-case failure notes (IDs only, never content). */
  failures: string[];
}

export interface AnalyzerResult {
  labels: Array<{ label: EmotionLabel; confidence: number }>;
  abstained: boolean;
}

export function runEmotionCalibration(
  dataset: EmotionCalibrationDataset,
  analyze: (text: string) => AnalyzerResult,
): EmotionCalibrationReport {
  const failures: string[] = [];
  let clearDetected = 0;
  let clearTotal = 0;
  let falseConfident = 0;
  let abstainTotal = 0;
  let maxConfidenceSeen = 0;

  for (const testCase of dataset.cases) {
    const result = analyze(testCase.text);
    for (const label of result.labels) {
      maxConfidenceSeen = Math.max(maxConfidenceSeen, label.confidence);
    }

    if (testCase.expect.abstain === true) {
      abstainTotal += 1;
      if (!result.abstained || result.labels.length > 0) {
        falseConfident += 1;
        failures.push(`${testCase.id}: expected abstention, got labels`);
      }
      continue;
    }

    if (testCase.expect.label !== undefined) {
      clearTotal += 1;
      const found = result.labels.find((l) => l.label === testCase.expect.label);
      const min = testCase.expect.minConfidence ?? 0;
      if (found === undefined || found.confidence < min) {
        failures.push(`${testCase.id}: expected label not detected at min confidence`);
      } else {
        clearDetected += 1;
      }
    }

    if (testCase.expect.maxConfidence !== undefined) {
      for (const label of result.labels) {
        if (label.confidence > testCase.expect.maxConfidence) {
          failures.push(`${testCase.id}: confidence exceeds cap`);
        }
      }
    }
  }

  return {
    dataset: dataset.name,
    total: dataset.cases.length,
    clearDetected,
    clearTotal,
    falseConfident,
    abstainTotal,
    maxConfidenceSeen,
    failures,
  };
}
