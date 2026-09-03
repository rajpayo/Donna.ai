import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModelsConfig } from "@donna/providers";
import type { HybridRankingConfig } from "@donna/retrieval";
import { runRetrievalEval } from "./retrieval.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function productionRanking(): Promise<HybridRankingConfig> {
  const config = await loadModelsConfig(
    resolve(repoRoot, "models.config.yaml"),
  );
  return {
    version: config.retrieval.rankingVersion,
    weights: config.retrieval.weights,
    recencyHalfLifeDays: config.retrieval.recencyHalfLifeDays,
    candidateLimit: config.retrieval.candidateLimit,
    minScore: config.retrieval.minScore,
  };
}

describe("golden retrieval set (Spec 3.3 AC-1)", () => {
  it("reaches at least 80% hit@3 under the production ranking config", async () => {
    const report = await runRetrievalEval({
      datasetPath: resolve(
        repoRoot,
        "packages/evals/datasets/golden/retrieval.v1.json",
      ),
      ranking: await productionRanking(),
      reportsDir: resolve(repoRoot, "packages/evals/reports/retrieval"),
    });
    // Honest reporting: log the rate either way.
    console.log(
      `retrieval.v1: ${report.passed}/${report.total} = ${(report.successRate * 100).toFixed(1)}% (bar ${report.successBar * 100}%)`,
    );
    if (!report.barMet) {
      console.log(
        `failing cases: ${report.cases.filter((c) => !c.passed).map((c) => c.id).join(", ")}`,
      );
    }
    assert.ok(
      report.barMet,
      `success rate ${(report.successRate * 100).toFixed(1)}% below the ${report.successBar * 100}% bar`,
    );
  });

  it("is deterministic: two runs produce identical outcomes", async () => {
    const ranking = await productionRanking();
    const datasetPath = resolve(
      repoRoot,
      "packages/evals/datasets/golden/retrieval.v1.json",
    );
    const first = await runRetrievalEval({ datasetPath, ranking });
    const second = await runRetrievalEval({ datasetPath, ranking });
    assert.deepEqual(
      first.cases.map((c) => [c.id, c.passed, c.hitIds]),
      second.cases.map((c) => [c.id, c.passed, c.hitIds]),
    );
  });
});
