/**
 * Baseline comparison tests (Specification 4.3: FR-1, FR-3, SR-2).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compareReports,
  MAX_EXTERNAL_ERROR_RATE,
} from "./compare.js";
import type { CaseOutcome, EvalReport } from "./report.js";

function makeReport(overrides: {
  stage?: string;
  datasetName?: string;
  datasetSha?: string;
  commit?: string;
  cases: CaseOutcome[];
}): EvalReport {
  const cases = overrides.cases;
  const metricNames = new Set<string>();
  for (const c of cases) for (const m of Object.keys(c.scores)) metricNames.add(m);
  const metrics: EvalReport["aggregate"]["metrics"] = {};
  for (const name of metricNames) {
    const values = cases.map((c) => c.scores[name]).filter((v): v is number => v !== undefined);
    const sorted = [...values].sort((a, b) => a - b);
    metrics[name] = {
      n: values.length,
      missing: cases.length - values.length,
      mean: values.reduce((a, b) => a + b, 0) / values.length,
      min: sorted[0]!,
      p50: sorted[Math.floor(sorted.length / 2)]!,
      p90: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!,
      max: sorted[sorted.length - 1]!,
    };
  }
  const hardFailures = cases.flatMap((c) =>
    c.hardFailures.map((hf) => ({ caseId: c.caseId, kind: hf.kind, detail: hf.detail })),
  );
  const errored = cases.filter((c) => c.error !== undefined);
  return {
    schema: "donna.eval-report.v1",
    stage: overrides.stage ?? "organize",
    dataset: {
      name: overrides.datasetName ?? "organize.v1",
      version: 1,
      sha256: overrides.datasetSha ?? "a".repeat(64),
      cases: cases.length,
    },
    snapshot: {
      schema: "donna.config-snapshot.v1",
      commit: overrides.commit ?? "0".repeat(40),
      branch: "test",
      dirty: false,
      modelsConfig: { path: "models.config.yaml", sha256: "b".repeat(64) },
      dataset: { name: "organize.v1", version: 1, sha256: "a".repeat(64) },
      versions: {
        organizePrompt: "p",
        organizeSchema: "s",
        answerPrompt: "a",
        emotionAnalyzer: "e",
      },
      ranking: {
        rankingVersion: "v",
        weights: {},
        recencyHalfLifeDays: 30,
        candidateLimit: 100,
        minScore: 0.2,
      },
      memoryPolicy: { contextBudgets: {}, adherenceSemanticThreshold: 0.5 },
      bucketTuning: { assignThreshold: 0.82, createThreshold: 0.65 },
      environment: { node: "v22", platform: "linux", arch: "x64", ci: true },
      capturedAt: "2026-09-03T00:00:00.000Z",
    },
    fingerprint: "f".repeat(64),
    startedAt: "2026-09-03T00:00:00.000Z",
    finishedAt: "2026-09-03T00:00:01.000Z",
    durationMs: 1000,
    cases,
    aggregate: {
      casesRun: cases.length,
      casesErrored: errored.length,
      externalErrors: errored.filter((c) => c.error?.class === "external-flaky").length,
      productErrors: errored.filter((c) => c.error?.class === "product").length,
      hardFailureCount: hardFailures.length,
      hardFailures,
      metrics,
    },
    cohorts: [],
    redactionNote: "test",
  };
}

const BASELINE_CASES: CaseOutcome[] = [
  { caseId: "c1", scores: { "organize.thought_coverage": 1, "organize.task_recall": 1 }, hardFailures: [] },
  { caseId: "c2", scores: { "organize.thought_coverage": 1, "organize.task_recall": 1 }, hardFailures: [] },
  { caseId: "c3", scores: { "organize.thought_coverage": 0.9, "organize.task_recall": 1 }, hardFailures: [] },
];

describe("compareReports", () => {
  it("passes an identical run", () => {
    const baseline = makeReport({ cases: BASELINE_CASES });
    const candidate = makeReport({ cases: BASELINE_CASES });
    const result = compareReports(baseline, candidate);
    assert.equal(result.status, "pass");
  });

  it("AC-1: a seeded quality regression fails and names the exact cases (FR-1)", () => {
    const baseline = makeReport({ cases: BASELINE_CASES });
    const candidate = makeReport({
      cases: [
        { caseId: "c1", scores: { "organize.thought_coverage": 0.4, "organize.task_recall": 1 }, hardFailures: [] },
        { caseId: "c2", scores: { "organize.thought_coverage": 1, "organize.task_recall": 1 }, hardFailures: [] },
        { caseId: "c3", scores: { "organize.thought_coverage": 0.9, "organize.task_recall": 1 }, hardFailures: [] },
      ],
    });
    const result = compareReports(baseline, candidate);
    assert.equal(result.status, "fail");
    const coverageDelta = result.metricDeltas.find((d) => d.metric === "organize.thought_coverage");
    assert.deepEqual(coverageDelta?.regressedCases, ["c1"]);
    assert.ok(result.reasons.some((r) => r.includes("organize.thought_coverage")));
  });

  it("deterministic contract: any case regression is material (zero-noise)", () => {
    const baseline = makeReport({ cases: BASELINE_CASES });
    const candidate = makeReport({
      cases: [
        { caseId: "c1", scores: { "organize.thought_coverage": 0.99, "organize.task_recall": 1 }, hardFailures: [] },
        { caseId: "c2", scores: { "organize.thought_coverage": 1, "organize.task_recall": 1 }, hardFailures: [] },
        { caseId: "c3", scores: { "organize.thought_coverage": 0.9, "organize.task_recall": 1 }, hardFailures: [] },
      ],
    });
    // Default (deterministic) tolerances: a 0.01 case drop fails.
    assert.equal(compareReports(baseline, candidate).status, "fail");
    // A live-suite caller may deliberately widen the case tolerance.
    assert.equal(
      compareReports(baseline, candidate, { caseTolerance: 0.02, tolerance: 0.05 }).status,
      "pass",
    );
  });

  it("SR-2: any hard failure fails regardless of averages", () => {
    const baseline = makeReport({ cases: BASELINE_CASES });
    const candidate = makeReport({
      cases: [
        ...BASELINE_CASES.slice(0, 2),
        {
          caseId: "c3",
          scores: { "organize.thought_coverage": 1, "organize.task_recall": 1 },
          hardFailures: [{ kind: "tenant-leak", detail: "seeded" }],
        },
      ],
    });
    const result = compareReports(baseline, candidate);
    assert.equal(result.status, "fail");
    assert.ok(result.reasons.some((r) => r.includes("tenant-leak")));
  });

  it("product errors fail; external-flaky errors are tolerated then inconclusive (FR-3)", () => {
    const baseline = makeReport({ cases: BASELINE_CASES });

    const withProductError = makeReport({
      cases: [
        ...BASELINE_CASES.slice(0, 2),
        { caseId: "c3", scores: {}, hardFailures: [], error: { class: "product", token: "boom" } },
      ],
    });
    assert.equal(compareReports(baseline, withProductError).status, "fail");

    const withOneExternal = makeReport({
      cases: [
        ...BASELINE_CASES.slice(0, 2),
        { caseId: "c3", scores: {}, hardFailures: [], error: { class: "external-flaky", token: "gateway-timeout" } },
      ],
    });
    const tolerated = compareReports(baseline, withOneExternal);
    assert.equal(tolerated.status, "pass");
    assert.ok(tolerated.reasons.some((r) => r.includes("external-flaky")));

    // More than MAX_EXTERNAL_ERROR_RATE of cases external-errored → inconclusive.
    const mostlyExternal = makeReport({
      cases: BASELINE_CASES.map((c, i) =>
        i === 0
          ? c
          : { caseId: c.caseId, scores: {}, hardFailures: [], error: { class: "external-flaky" as const, token: "gateway-timeout" } },
      ),
    });
    const inconclusive = compareReports(baseline, mostlyExternal);
    assert.equal(inconclusive.status, "inconclusive-external");
    assert.ok(mostlyExternal.aggregate.externalErrors / mostlyExternal.aggregate.casesRun > MAX_EXTERNAL_ERROR_RATE);
  });

  it("rejects cross-dataset comparisons", () => {
    const baseline = makeReport({ cases: BASELINE_CASES, datasetName: "organize.v1" });
    const candidate = makeReport({ cases: BASELINE_CASES, datasetName: "other.v1" });
    assert.equal(compareReports(baseline, candidate).status, "invalid-dataset-mismatch");
  });

  it("a metric dropped from the candidate is a regression", () => {
    const baseline = makeReport({ cases: BASELINE_CASES });
    const candidate = makeReport({
      cases: BASELINE_CASES.map((c) => ({
        caseId: c.caseId,
        scores: { "organize.thought_coverage": c.scores["organize.thought_coverage"]! },
        hardFailures: [],
      })),
    });
    const result = compareReports(baseline, candidate);
    assert.equal(result.status, "fail");
    assert.ok(result.reasons.some((r) => r.includes("absent in candidate")));
  });
});
