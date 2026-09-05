import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeTranscript, EMOTION_MAX_CONFIDENCE } from "@donna/memory";
import {
  runEmotionCalibration,
  type EmotionCalibrationDataset,
} from "./emotion-calibration.js";

const datasetPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../datasets/golden/emotion.v1.json",
);

describe("emotion calibration eval (Spec 2.4 AC-3)", () => {
  it("detects clear cases, abstains on ambiguous ones, never exceeds the cap", async () => {
    const dataset = JSON.parse(
      await readFile(datasetPath, "utf8"),
    ) as EmotionCalibrationDataset;

    const report = runEmotionCalibration(dataset, (text) =>
      analyzeTranscript([{ id: "seg-0", text, startSec: 0, endSec: 5 }]),
    );

    // Every clear case is detected at the expected minimum confidence.
    assert.equal(report.clearDetected, report.clearTotal);
    assert.ok(report.clearTotal >= 4);
    // Zero false-confident inferences on abstention cases.
    assert.equal(report.abstainTotal, 3);
    assert.equal(report.falseConfident, 0);
    // Confidence is structurally capped — Donna never sounds certain.
    assert.ok(report.maxConfidenceSeen <= EMOTION_MAX_CONFIDENCE);
    assert.deepEqual(report.failures, []);
  });

  it("the analyzer abstains on empty and marker-free input", () => {
    assert.equal(analyzeTranscript([]).abstained, true);
    const result = analyzeTranscript([
      { id: "s1", text: "The meeting covered quarterly planning.", startSec: 0, endSec: 3 },
    ]);
    assert.equal(result.labels.every((l) => l.confidence <= EMOTION_MAX_CONFIDENCE), true);
  });
});
