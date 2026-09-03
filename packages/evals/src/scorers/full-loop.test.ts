/**
 * Full-loop longitudinal scorer tests (Specification 4.2): deterministic
 * mode over the shipped scenarios, the personalization comparison (FR-3),
 * and the seeded hard-failure proof (SR-1).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { loadModelsConfig } from "@donna/providers";
import { runEval } from "../harness.js";
import { createFullLoopScorer } from "./full-loop.js";

const here = dirname(fileURLToPath(import.meta.url));
const evalsDir = resolve(here, "../..");
const repoRoot = resolve(here, "../../../..");
const configPath = resolve(repoRoot, "models.config.yaml");
const DATASET = resolve(evalsDir, "datasets/golden/full-loop/full-loop.v1.json");

let reportsDir: string;
before(async () => {
  reportsDir = await mkdtemp(join(tmpdir(), "donna-fulloop-test-"));
});
after(async () => {
  await rm(reportsDir, { recursive: true, force: true });
});

async function runFullLoop(personalized: boolean) {
  const config = await loadModelsConfig(configPath);
  return runEval({
    datasetPath: DATASET,
    configPath,
    repoRoot,
    evalsDir,
    reportsDir,
    scorer: createFullLoopScorer({
      mode: "deterministic",
      personalized,
      bucketTuning: config.buckets,
      contextBudgets: config.context,
    }),
  });
}

describe("full-loop deterministic mode", () => {
  it("both longitudinal scenarios pass with state evolving as expected", async () => {
    const { report } = await runFullLoop(true);
    assert.equal(report.aggregate.hardFailureCount, 0);
    assert.equal(report.aggregate.casesErrored, 0);
    assert.equal(report.aggregate.metrics["loop.accepted"]?.mean, 1);
    assert.equal(report.aggregate.metrics["loop.bucket_state_correct"]?.mean, 1);
    assert.equal(report.aggregate.metrics["loop.tasks_hard_rule"]?.mean, 1);
    assert.equal(report.aggregate.metrics["loop.adherence_as_expected"]?.mean, 1);
    // Per-capture outcomes exist alongside the case summaries.
    const captureOutcomes = report.cases.filter((c) => !c.caseId.endsWith("/summary"));
    assert.equal(captureOutcomes.length, 5);
    for (const outcome of captureOutcomes) {
      assert.ok(outcome.latencyMs !== undefined);
    }
  });

  it("FR-3: non-personalized runs do not observe correction adherence", async () => {
    const personalized = await runFullLoop(true);
    const unpersonalized = await runFullLoop(false);
    assert.equal(
      personalized.report.aggregate.metrics["loop.adherence_as_expected"]?.mean,
      1,
    );
    assert.equal(
      unpersonalized.report.aggregate.metrics["loop.adherence_as_expected"]?.mean,
      0,
    );
  });

  it("SR-1: a seeded provenance failure fails closed as a hard failure, never averaged", async () => {
    const config = await loadModelsConfig(configPath);
    // Fault injection (AC-1): an organizer whose provenance cites a
    // segment that does not exist. The real pipeline must refuse it.
    const brokenOrganizer: import("@donna/core").Organizer = {
      modelId: "broken-organizer",
      async organize(transcript) {
        return {
          thoughts: [
            {
              summary: "Fabricated thought",
              text: "Fabricated thought.",
              confidence: 0.9,
              provenance: {
                segmentIds: ["seg-does-not-exist"],
                sourceText: transcript.text,
                startSec: 0,
                endSec: 1,
              },
            },
          ],
        };
      },
    };
    const { report } = await runEval({
      datasetPath: DATASET,
      configPath,
      repoRoot,
      evalsDir,
      reportsDir,
      scorer: createFullLoopScorer({
        mode: "deterministic",
        personalized: true,
        bucketTuning: config.buckets,
        contextBudgets: config.context,
        faultInjection: { organizer: brokenOrganizer },
      }),
    });
    // Every capture failed closed with an invalid-provenance hard failure.
    // (Correction-step outcomes are excluded — they find no target when
    // every capture failed, which is correct behavior.)
    const captures = report.cases.filter((c) => /\/c\d+$/.test(c.caseId));
    assert.ok(captures.length > 0);
    for (const capture of captures) {
      assert.equal(capture.scores["loop.accepted"], 0);
      assert.equal(capture.error?.token, "provenance-failed-closed");
      assert.ok(capture.hardFailures.some((hf) => hf.kind === "invalid-provenance"));
    }
    assert.ok(report.aggregate.hardFailureCount >= captures.length);
  });
});
