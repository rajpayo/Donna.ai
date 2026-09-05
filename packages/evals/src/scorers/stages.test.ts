/**
 * Deterministic stage scorer tests (Specification 4.2): provenance,
 * buckets, memory, retrieval, and emotion run through the harness against
 * the shipped datasets — offline, no gateway.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { loadModelsConfig } from "@donna/providers";
import { runEval } from "../harness.js";
import { createProvenanceScorer } from "./provenance.js";
import { createBucketsScorer } from "./buckets.js";
import { createMemoryScorer } from "./memory.js";
import { createRetrievalScorer } from "./retrieval.js";
import { createEmotionScorer } from "./emotion.js";

const here = dirname(fileURLToPath(import.meta.url));
const evalsDir = resolve(here, "../..");
const repoRoot = resolve(here, "../../../..");
const configPath = resolve(repoRoot, "models.config.yaml");

let reportsDir: string;
before(async () => {
  reportsDir = await mkdtemp(join(tmpdir(), "donna-stages-test-"));
});
after(async () => {
  await rm(reportsDir, { recursive: true, force: true });
});

async function runStage(stage: string, scorer: Parameters<typeof runEval>[0]["scorer"]) {
  const datasetPath = resolve(
    evalsDir,
    stage === "adversarial"
      ? "datasets/adversarial/adversarial.v1.json"
      : `datasets/golden/${stage}/${stage}.v1.json`,
  );
  return runEval({ datasetPath, configPath, repoRoot, evalsDir, reportsDir, scorer });
}

describe("provenance stage", () => {
  it("all verifier decisions are correct, zero hard failures", async () => {
    const { report } = await runStage("provenance", createProvenanceScorer());
    assert.equal(report.aggregate.hardFailureCount, 0);
    assert.equal(report.aggregate.metrics["provenance.decision_correct"]?.mean, 1);
    assert.equal(report.aggregate.casesRun, 5);
  });
});

describe("buckets stage", () => {
  it("the seeded misfire cases now place correctly with no duplicates", async () => {
    const config = await loadModelsConfig(configPath);
    const { report } = await runStage("buckets", createBucketsScorer({ tuning: config.buckets }));
    assert.equal(report.aggregate.metrics["buckets.action_correct"]?.mean, 1);
    assert.equal(report.aggregate.metrics["buckets.no_duplicate"]?.mean, 1);
  });
});

describe("memory stage", () => {
  it("proposal screening, adherence, and conflict handling score as labeled", async () => {
    const { report } = await runStage("memory", createMemoryScorer());
    assert.equal(report.aggregate.hardFailureCount, 0);
    assert.equal(report.aggregate.metrics["memory.proposal_precision"]?.mean, 1);
    assert.equal(report.aggregate.metrics["memory.adherence_counts_match"]?.mean, 1);
    assert.equal(report.aggregate.metrics["memory.conflict_handling"]?.mean, 1);
    // The labeled case has 1 followed + 1 contradicted of 2 applicable.
    assert.equal(report.aggregate.metrics["memory.correction_adherence"]?.mean, 0.5);
  });
});

describe("retrieval stage", () => {
  it("24 cases: hit@3 at 100%, stale exclusions hold, abstentions correct (offline)", async () => {
    const config = await loadModelsConfig(configPath);
    const { report } = await runStage(
      "retrieval",
      createRetrievalScorer({
        ranking: {
          version: config.retrieval.rankingVersion,
          weights: config.retrieval.weights,
          recencyHalfLifeDays: config.retrieval.recencyHalfLifeDays,
          candidateLimit: config.retrieval.candidateLimit,
          minScore: config.retrieval.minScore,
        },
      }),
    );
    assert.equal(report.aggregate.casesRun, 24);
    assert.equal(report.aggregate.metrics["retrieval.hit_at_k"]?.mean, 1);
    assert.equal(report.aggregate.metrics["retrieval.stale_excluded"]?.mean, 1);
    assert.equal(report.aggregate.metrics["retrieval.abstention_correct"]?.mean, 1);
    // Offline: no answer generator → citation validity is skipped, not failed.
    assert.equal(report.aggregate.metrics["retrieval.citation_validity"], undefined);
  });
});

describe("emotion stage", () => {
  it("calibration and abstention all pass", async () => {
    const { report } = await runStage("emotion", createEmotionScorer());
    assert.equal(report.aggregate.metrics["emotion.calibration"]?.mean, 1);
    assert.equal(report.aggregate.casesRun, 8);
  });
});
