/**
 * Graduation gate tests (Specification 4.3: AC-1, AC-2, AC-3, AC-4, AC-5).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildGraduationReport } from "./graduation.js";
import type { CaseOutcome, EvalReport } from "./report.js";

interface EvidenceSpec {
  stage: string;
  metrics: Record<string, number>;
  hardFailures?: CaseOutcome["hardFailures"];
}

let counter = 0;
function makeEvidence(overrides: EvidenceSpec): { path: string; report: EvalReport } {
  counter += 1;
  const metrics: EvalReport["aggregate"]["metrics"] = {};
  for (const [name, mean] of Object.entries(overrides.metrics)) {
    metrics[name] = { n: 3, missing: 0, mean, min: mean, p50: mean, p90: mean, max: mean };
  }
  const hardFailures = (overrides.hardFailures ?? []).map((hf) => ({
    caseId: "seeded-case",
    kind: hf.kind,
    detail: hf.detail,
  }));
  const report: EvalReport = {
    schema: "donna.eval-report.v1",
    stage: overrides.stage,
    dataset: { name: `${overrides.stage}.v1`, version: 1, sha256: "a".repeat(64), cases: 3 },
    snapshot: {
      schema: "donna.config-snapshot.v1",
      commit: "c".repeat(40),
      branch: "test",
      dirty: false,
      modelsConfig: { path: "models.config.yaml", sha256: "b".repeat(64) },
      dataset: { name: "x", version: 1, sha256: "a".repeat(64) },
      versions: { organizePrompt: "p", organizeSchema: "s", answerPrompt: "a", emotionAnalyzer: "e" },
      ranking: { rankingVersion: "v", weights: {}, recencyHalfLifeDays: 30, candidateLimit: 100, minScore: 0.2 },
      memoryPolicy: { contextBudgets: {}, adherenceSemanticThreshold: 0.5 },
      bucketTuning: { assignThreshold: 0.82, createThreshold: 0.65 },
      environment: { node: "v22", platform: "linux", arch: "x64", ci: true },
      capturedAt: "2026-09-03T00:00:00.000Z",
    },
    fingerprint: counter.toString(16).padStart(64, "0"),
    startedAt: "2026-09-03T00:00:00.000Z",
    finishedAt: "2026-09-03T00:00:01.000Z",
    durationMs: 1000,
    cases: [],
    aggregate: {
      casesRun: 3,
      casesErrored: 0,
      externalErrors: 0,
      productErrors: 0,
      hardFailureCount: hardFailures.length,
      hardFailures,
      metrics,
    },
    cohorts: [],
    redactionNote: "test",
  };
  return { path: `reports/${overrides.stage}/evidence-${counter}.json`, report };
}

const PASSING_EVIDENCE: EvidenceSpec[] = [
  {
    stage: "organize",
    metrics: {
      "organize.thought_coverage": 0.97,
      "organize.task_recall": 0.96,
      "organize.bucket_acceptance": 0.9,
      "organize.provenance_fidelity": 1,
    },
  },
  { stage: "retrieval", metrics: { "retrieval.hit_at_k": 0.85 } },
  { stage: "adversarial", metrics: { "adversarial.blocked": 1 } },
];

describe("graduation gates (AC-3, AC-4)", () => {
  it("all gates pass on passing evidence; sign-off stays pending (AC-5)", () => {
    const report = buildGraduationReport(PASSING_EVIDENCE.map(makeEvidence));
    assert.equal(report.allGatesPassed, true);
    assert.equal(report.gates.length, 7);
    assert.ok(report.gates.every((g) => g.passed));
    // Never auto-graduates.
    assert.equal(report.productOwnerSignOff, "pending");
    // Evidence is linked with fingerprints.
    assert.equal(report.evidenceReports.length, 3);
    assert.ok(report.evidenceReports.every((e) => e.fingerprint.length === 64));
  });

  it("AC-1: a seeded quality regression fails the check", () => {
    const regressed = PASSING_EVIDENCE.map((e) =>
      e.stage === "organize"
        ? { ...e, metrics: { ...e.metrics, "organize.thought_coverage": 0.8 } }
        : e,
    );
    const report = buildGraduationReport(regressed.map(makeEvidence));
    assert.equal(report.allGatesPassed, false);
    const gate = report.gates.find((g) => g.gate.includes("coverage"));
    assert.equal(gate?.passed, false);
    assert.equal(gate?.measured, 0.8);
  });

  it("AC-2: a seeded tenant leak always fails, even with perfect metrics", () => {
    const evidence = [
      ...PASSING_EVIDENCE,
      {
        stage: "adversarial",
        metrics: { "adversarial.blocked": 1 },
        hardFailures: [{ kind: "tenant-leak" as const, detail: "seeded" }],
      },
    ];
    const report = buildGraduationReport(evidence.map(makeEvidence));
    assert.equal(report.allGatesPassed, false);
    const gate = report.gates.find((g) => g.gate.includes("tenant"));
    assert.equal(gate?.passed, false);
    assert.equal(report.hardFailures["tenant-leak"], 1);
  });

  it("AC-2: a seeded invalid-provenance failure always fails", () => {
    const evidence = PASSING_EVIDENCE.map((e) =>
      e.stage === "organize"
        ? {
            ...e,
            hardFailures: [{ kind: "invalid-provenance" as const, detail: "seeded" }],
          }
        : e,
    );
    const report = buildGraduationReport(evidence.map(makeEvidence));
    assert.equal(report.allGatesPassed, false);
    assert.equal(report.gates.find((g) => g.gate.includes("provenance"))?.passed, false);
  });

  it("missing evidence fails the affected gates (fail closed)", () => {
    const report = buildGraduationReport([makeEvidence(PASSING_EVIDENCE[2]!)]);
    assert.equal(report.allGatesPassed, false);
    assert.equal(report.gates.find((g) => g.gate.includes("coverage"))?.measured, null);
    assert.equal(report.gates.find((g) => g.gate.includes("retrieval"))?.passed, false);
  });

  it("gate thresholds are exactly the locked values", () => {
    const atBoundary: EvidenceSpec[] = [
      {
        stage: "organize",
        metrics: {
          "organize.thought_coverage": 0.95,
          "organize.task_recall": 0.95,
          "organize.bucket_acceptance": 0.85,
          "organize.provenance_fidelity": 1,
        },
      },
      { stage: "retrieval", metrics: { "retrieval.hit_at_k": 0.8 } },
    ];
    const report = buildGraduationReport(atBoundary.map(makeEvidence));
    assert.equal(report.allGatesPassed, true);

    const justBelow: EvidenceSpec[] = [
      {
        stage: "organize",
        metrics: {
          "organize.thought_coverage": 0.95,
          "organize.task_recall": 0.9499,
          "organize.bucket_acceptance": 0.85,
          "organize.provenance_fidelity": 1,
        },
      },
      { stage: "retrieval", metrics: { "retrieval.hit_at_k": 0.8 } },
    ];
    assert.equal(buildGraduationReport(justBelow.map(makeEvidence)).allGatesPassed, false);
  });
});
