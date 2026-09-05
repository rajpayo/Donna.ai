import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalReport } from "./report.js";
import {
  RUBRIC_CRITERIA,
  RUBRIC_VERSION,
  aggregateCandidate,
  assertPlanBytesMatchLock,
  buildBlindedReviewPacket,
  canRetryFreshFinal,
  rubricHash,
  selectionPolicyHash,
  selectCandidate,
  validateContentFreeReview,
  validatePrivateDiagnosticEvidence,
  validateFreshEnvelope,
  validateTariffCandidateSet,
  type CandidateAggregate,
  type CandidateManifest,
  type ContentFreeReview,
  type ExperimentPlan,
} from "./organize-experiment.js";

const here = dirname(fileURLToPath(import.meta.url));

function manifest(id: CandidateManifest["id"]): CandidateManifest {
  return {
    id,
    provider: id === "C" ? "anthropic" : "openai-compatible",
    model: id === "C" ? "claude-sonnet-5" : "gpt-5-mini",
    promptVersion:
      id === "B" || id === "C"
        ? "donna.organize-prompt.v3-quality"
        : "donna.organize-prompt.v2",
    temperature: id === "A" ? 0.2 : 0,
    configPath: `${id}.yaml`,
    configSha256: "1".repeat(64),
    promptSha256: "2".repeat(64),
    replicates: 3,
  };
}

function plan(ids: CandidateManifest["id"][], tariff: "not-available" | "verified"): ExperimentPlan {
  const result: ExperimentPlan = {
    schema: "donna.organize-experiment-plan.v1",
    spec: "6.6",
    status: "locked",
    lockedAt: "2026-09-05T00:00:00.000Z",
    tariff: {
      status: tariff,
      candidateC: tariff === "verified" ? "admitted" : "excluded",
      reason: tariff,
      ...(tariff === "verified" ? { evidenceSha256: "f".repeat(64) } : {}),
    },
    datasets: {
      dev: { path: "dev.json", name: "organize.dev.v1", version: 60, cases: 28, sha256: "d".repeat(64) },
      validationV3: {
        path: "validation.json",
        name: "organize.heldout.v1",
        version: 3,
        cases: 32,
        sha256: "v".repeat(64),
        purpose: "regression-only-not-graduation",
        lockPath: "validation.lock.json",
        lockSha256: "l".repeat(64),
      },
    },
    candidates: ids.map(manifest),
    comparisons: [
      { left: "A", right: "A0", isolates: "temperature" },
      { left: "A0", right: "B", isolates: "prompt" },
      ...(ids.includes("C") ? [{ left: "B" as const, right: "C" as const, isolates: "model" as const }] : []),
    ],
    selectionPolicySha256: "",
    aggregation: {
      metricMeans: "arithmetic-mean-of-three-run-means",
      latencyP90: "all-successful-case-latencies",
      bestOfThree: false,
    },
    eligibility: {
      thoughtCoverage: 0.97,
      bucketOverall: 0.9,
      bucketJoined: 0.9,
      bucketMinted: 0.8,
      taskRecall: 0.95,
      taskRecallAtLeastA: true,
      taskPrecisionAtLeastA: true,
      provenance: 1,
      schema: 1,
      hardFailures: 0,
      productErrors: 0,
      latencyP90Ms: 20000,
    },
    tieBreaks: [],
    costPolicy: {
      sameProviderModelComparableWithoutMoney: true,
      absentGatewayMoney: "not-reported",
      tokenProxyIsNotMoney: true,
      candidateCPremiumRule: "approved",
    },
    retryPolicy: {
      dev: "none",
      final: "one-external-only-with-zero-product-errors-and-hard-failures",
    },
    rubric: {
      version: RUBRIC_VERSION,
      path: "rubric.json",
      criteria: RUBRIC_CRITERIA,
      sha256: rubricHash(),
      expectedLabelBlind: true,
      candidateBlind: true,
      diagnosticOnly: true,
    },
    freshBlind: {
      classes: ["meetings", "tasks", "ideas", "follow-ups", "decisions", "people", "projects", "mixed-emotional", "multi-capture"],
      minimumCases: 20,
      minimumPerClass: 2,
      freezeBeforeResult: true,
      winnerRuns: 1,
    },
  };
  result.selectionPolicySha256 = selectionPolicyHash(result);
  return result;
}

function aggregate(
  candidate: CandidateManifest["id"],
  overrides: Partial<Record<string, number>> = {},
): CandidateAggregate {
  const metrics = {
    "organize.thought_coverage": 1,
    "organize.bucket_acceptance": 1,
    "organize.bucket_acceptance_joined": 1,
    "organize.bucket_acceptance_minted": 1,
    "organize.task_recall": 1,
    "organize.task_precision": 1,
    "organize.provenance_fidelity": 1,
    "organize.schema_valid": 1,
    ...overrides,
  };
  return {
    candidate,
    reports: [],
    metrics,
    metricCounts: {},
    latencyMs: { n: 84, mean: 100, min: 50, p50: 100, p90: 200, max: 300 },
    gatewayCost: { status: "not-reported", totalUsd: null, perSuccessfulCaseUsd: null },
    tokens: { prompt: 1, completion: 1, total: 2 },
    cases: { successful: 84, errored: 0, externalErrors: 0, productErrors: 0 },
    hardFailures: 0,
  };
}

function review(itemIds: string[], values = true): ContentFreeReview {
  return {
    schema: "donna.minted-name-review.v1",
    rubricVersion: RUBRIC_VERSION,
    rubricSha256: rubricHash(),
    packetSha256: "a".repeat(64),
    randomizationSha256: "b".repeat(64),
    reviewer: "product-owner",
    reviewedAt: "2026-09-05T00:00:00.000Z",
    decisions: itemIds.map((itemId) => ({
      itemId,
      decisions: Object.fromEntries(
        RUBRIC_CRITERIA.map((criterion) => [criterion, values]),
      ) as Record<(typeof RUBRIC_CRITERIA)[number], boolean>,
    })),
  };
}

describe("Spec 6.6 experiment policy", () => {
  it("enforces the nine-run no-tariff path and excludes C", () => {
    assert.equal(validateTariffCandidateSet(plan(["A", "A0", "B"], "not-available")), 9);
    assert.throws(
      () => validateTariffCandidateSet(plan(["A", "A0", "B", "C"], "not-available")),
      /must not appear/,
    );
  });

  it("supports the tariff-gated 12-run path without making a model call", () => {
    assert.equal(validateTariffCandidateSet(plan(["A", "A0", "B", "C"], "verified")), 12);
  });

  it("fails hard when a locked plan is mutated", () => {
    const raw = '{"status":"locked"}\n';
    const lock = {
      schema: "donna.organize-experiment-lock.v1" as const,
      planSha256: "0".repeat(64),
      lockedAt: "2026-09-05T00:00:00.000Z",
      mutationAfterResults: "forbidden" as const,
    };
    assert.throws(() => assertPlanBytesMatchLock(raw, lock), /PLAN MUTATION DETECTED/);
  });

  it("produces candidate/label-blind randomized packets", () => {
    const prepared = buildBlindedReviewPacket({
      planSha256: "p".repeat(64),
      sources: [
        {
          candidate: "B",
          replicate: 1,
          caseId: "case-private",
          thought: "Prepare roadmap",
          mintedBucketName: "Roadmap",
          existingBucketNames: ["Tasks"],
        },
      ],
    });
    const serialized = JSON.stringify(prepared.packet);
    assert.ok(!serialized.includes('"candidate"'));
    assert.ok(!serialized.includes('"expected"'));
    assert.ok(!serialized.includes("gpt-5-mini"));
    assert.equal(prepared.map.items[0]!.candidate, "B");
  });

  it("keeps rubric diagnostic and stops a sole minted mismatch", () => {
    const currentPlan = plan(["A", "A0", "B"], "not-available");
    const itemIds = ["1".repeat(24), "2".repeat(24), "3".repeat(24)];
    const productReview = review(itemIds);
    validateContentFreeReview(productReview);
    const selection = selectCandidate({
      plan: currentPlan,
      planSha256: "p".repeat(64),
      aggregates: [
        aggregate("A"),
        aggregate("A0", { "organize.bucket_acceptance_minted": 0.77 }),
        aggregate("B"),
      ],
      review: productReview,
      reviewSha256: "r".repeat(64),
      reviewMap: {
        schema: "donna.minted-name-review-map.v1",
        planSha256: "p".repeat(64),
        items: [
          { itemId: itemIds[0]!, candidate: "A" },
          { itemId: itemIds[1]!, candidate: "A0" },
          { itemId: itemIds[2]!, candidate: "B" },
        ],
      },
      now: () => new Date("2026-09-05T00:00:00.000Z"),
    });
    assert.equal(selection.outcome.kind, "naming-measurement-mismatch");
    assert.equal(selection.reports[1]!.metrics["organize.bucket_acceptance_minted"], 0.77);
  });

  it("rejects private diagnostic context or identity fields", () => {
    const valid = {
      schema: "donna.organize-private-diagnostic.v1",
      createdAt: "2026-09-05T00:00:00.000Z",
      consentCurrent: true,
      participantInvoked: true,
      views: { bucketListOnly: { score: 1, count: 2 } },
      caseIds: ["abc"],
      categoryTokens: ["joined"],
      configSha256: "a".repeat(64),
      selectionSha256: "b".repeat(64),
      reportHashes: [],
    };
    assert.doesNotThrow(() => validatePrivateDiagnosticEvidence(valid));
    assert.throws(
      () => validatePrivateDiagnosticEvidence({ ...valid, participantId: "P-00" }),
      /forbidden/,
    );
  });

  it("allows only the strict external-only fresh retry", () => {
    const base = {
      aggregate: {
        casesErrored: 2,
        externalErrors: 2,
        productErrors: 0,
        hardFailureCount: 0,
      },
    } as EvalReport;
    assert.equal(canRetryFreshFinal(base), true);
    assert.equal(
      canRetryFreshFinal({
        ...base,
        aggregate: { ...base.aggregate, productErrors: 1 },
      }),
      false,
    );
  });

  it("validates all nine fresh classes, minimum counts, minted slice, and overlap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "donna-fresh-"));
    try {
      const classes = [
        "meetings",
        "tasks",
        "ideas",
        "follow-ups",
        "decisions",
        "people",
        "projects",
        "mixed-emotional",
        "multi-capture",
      ];
      const cases = Array.from({ length: 20 }, (_, index) => {
        const klass = classes[index % classes.length]!;
        const word = `freshword${index}`;
        return {
          id: `fresh-case-${index}`,
          meta: { notes: `scenario-class:${klass}` },
          transcript: `Fresh graduation ${word}`,
          existingBuckets: [],
          expected: {
            thoughts: [
              {
                kind: "note",
                bucket: `Fresh Topic ${index}`,
                bucketOrigin: "minted",
                contains: [word],
              },
            ],
          },
        };
      });
      const freshPath = join(dir, "organize.graduation-blind.v1.json");
      await writeFile(
        freshPath,
        JSON.stringify({
          schema: "donna.eval-dataset.v1",
          name: "organize.graduation-blind.v1",
          stage: "organize",
          version: 1,
          description: "synthetic fresh-envelope guard test",
          defaultMeta: {
            provenance: "synthetic",
            labeler: "labeler:test",
            adjudicator: "labeler:test-owner",
            consent: "not-required-synthetic",
            sensitivity: "none",
            language: "en",
          },
          cases,
          adjudications: [],
        }),
      );
      const summary = await validateFreshEnvelope({
        freshPath,
        devPath: resolve(
          here,
          "../datasets/golden/organize/organize.dev.v1.json",
        ),
        validationPath: resolve(
          here,
          "../datasets/golden/organize/organize.heldout.v1.json",
        ),
      });
      assert.equal(summary.total, 20);
      assert.equal(summary.mintedCases, 20);
      assert.equal(summary.zeroContentOverlap, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("candidate aggregation", () => {
  it("uses arithmetic run means, all successful latencies, and no best-of-three", () => {
    const reports = [0.6, 0.9, 1].map((mean, index) => {
      const report = {
        aggregate: {
          metrics: { "organize.bucket_acceptance": { mean } },
          casesErrored: 0,
          externalErrors: 0,
          productErrors: 0,
          hardFailureCount: 0,
        },
        cases: [
          {
            caseId: `c-${index}`,
            scores: { "organize.bucket_acceptance": mean },
            hardFailures: [],
            latencyMs: 100 + index,
          },
        ],
      } as unknown as EvalReport;
      return { path: `r-${index}`, sha256: String(index), report };
    });
    const result = aggregateCandidate("A", reports);
    assert.equal(result.metrics["organize.bucket_acceptance"], (0.6 + 0.9 + 1) / 3);
    assert.equal(result.latencyMs.n, 3);
  });
});
