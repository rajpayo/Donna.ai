/**
 * Graduation gate tests (Specification 4.3: AC-1, AC-2, AC-3, AC-4, AC-5)
 * and the measured graduation decision runner (Specification 6.3).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildGraduationReport, buildGraduationReportV2, renderGraduationMarkdownV2 } from "./graduation.js";
import type { CaseOutcome, EvalReport } from "./report.js";
import type { ConfigSnapshot } from "./snapshot.js";

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

/* ------------------------------------------------------------------ */
/* Specification 6.3 — measured graduation decision runner             */
/* ------------------------------------------------------------------ */

const SNAPSHOT: ConfigSnapshot = {
  schema: "donna.config-snapshot.v1",
  commit: "d".repeat(40),
  branch: "pilot",
  dirty: false,
  modelsConfig: { path: "models.config.yaml", sha256: "e".repeat(64) },
  dataset: { name: "x", version: 1, sha256: "a".repeat(64) },
  versions: { organizePrompt: "p1", organizeSchema: "s1", answerPrompt: "a1", emotionAnalyzer: "e1" },
  ranking: { rankingVersion: "v", weights: {}, recencyHalfLifeDays: 30, candidateLimit: 100, minScore: 0.2 },
  memoryPolicy: { contextBudgets: {}, adherenceSemanticThreshold: 0.5 },
  bucketTuning: { assignThreshold: 0.82, createThreshold: 0.65 },
  environment: { node: "v22", platform: "linux", arch: "x64", ci: true },
  capturedAt: "2026-09-03T00:00:00.000Z",
};

const FIXED_NOW = () => new Date("2026-09-04T00:00:00.000Z");

function makeFullLoopEvidence(): { path: string; report: EvalReport } {
  const base = makeEvidence({
    stage: "full-loop",
    metrics: { "latency.total_ms": 42000 },
  });
  base.report.cases = [
    { caseId: "c1", scores: {}, hardFailures: [], tokens: { prompt: 100, completion: 40 } },
    { caseId: "c2", scores: {}, hardFailures: [], tokens: { prompt: 120, completion: 60 } },
  ];
  return base;
}

describe("graduation runner v2 (Spec 6.3)", () => {
  it("eligible-for-signoff only when every gate passes and no blocker exists", () => {
    const report = buildGraduationReportV2(
      [...PASSING_EVIDENCE.map(makeEvidence), makeFullLoopEvidence()],
      { snapshot: SNAPSHOT, now: FIXED_NOW },
    );
    assert.equal(report.decision.verdict, "eligible-for-signoff");
    assert.deepEqual(report.decision.reasons, []);
    assert.equal(report.decision.productOwnerSignOff, "pending");
    assert.equal(report.allGatesPassed, true);
  });

  it("the freeze records commit, config hash, prompt versions, datasets, cohort window", () => {
    const report = buildGraduationReportV2(PASSING_EVIDENCE.map(makeEvidence), {
      snapshot: SNAPSHOT,
      cohortWindow: { start: "2026-09-07", end: "2026-09-18" },
      now: FIXED_NOW,
    });
    assert.equal(report.freeze.commit, "d".repeat(40));
    assert.equal(report.freeze.modelsConfigSha256, "e".repeat(64));
    assert.equal(report.freeze.promptVersions.organizePrompt, "p1");
    assert.equal(report.freeze.datasets.length, 3);
    assert.deepEqual(report.freeze.cohortWindow, { start: "2026-09-07", end: "2026-09-18" });
    assert.equal(report.generatedAt, "2026-09-04T00:00:00.000Z");
  });

  it("failing gates force rejection with named reasons", () => {
    const regressed = PASSING_EVIDENCE.map((e) =>
      e.stage === "organize"
        ? { ...e, metrics: { ...e.metrics, "organize.thought_coverage": 0.88 } }
        : e,
    );
    const report = buildGraduationReportV2(regressed.map(makeEvidence), { snapshot: SNAPSHOT, now: FIXED_NOW });
    assert.equal(report.decision.verdict, "rejected");
    assert.ok(report.decision.reasons.some((r) => r.includes("coverage") && r.includes("0.88")));
  });

  it("SR-1: hard failures force rejection even with perfect metrics", () => {
    const evidence = [
      ...PASSING_EVIDENCE,
      { stage: "adversarial", metrics: { "adversarial.blocked": 1 }, hardFailures: [{ kind: "unapproved-write" as const, detail: "seeded" }] },
    ];
    const report = buildGraduationReportV2(evidence.map(makeEvidence), { snapshot: SNAPSHOT, now: FIXED_NOW });
    assert.equal(report.decision.verdict, "rejected");
    assert.ok(report.decision.reasons.some((r) => r.includes("unapproved-write")));
  });

  it("pilot extras blockers force rejection: misfire blockers, privacy incidents, retention violations", () => {
    const withBlocker = buildGraduationReportV2(PASSING_EVIDENCE.map(makeEvidence), {
      snapshot: SNAPSHOT,
      now: FIXED_NOW,
      extras: { misfireBoard: { total: 3, byCategory: {}, byDisposition: {}, unresolved: 1, blocksGraduation: 1, promotedGoldenCases: 0 } },
    });
    assert.equal(withBlocker.decision.verdict, "rejected");
    assert.ok(withBlocker.decision.reasons.some((r) => r.includes("blocks") || r.includes("blocking")));

    const withIncident = buildGraduationReportV2(PASSING_EVIDENCE.map(makeEvidence), {
      snapshot: SNAPSHOT,
      now: FIXED_NOW,
      extras: { privacyIncidents: { count: 1, notes: ["possible cross-scope read"] } },
    });
    assert.equal(withIncident.decision.verdict, "rejected");
    assert.ok(withIncident.decision.reasons.some((r) => r.includes("privacy")));

    const withRetentionViolation = buildGraduationReportV2(PASSING_EVIDENCE.map(makeEvidence), {
      snapshot: SNAPSHOT,
      now: FIXED_NOW,
      extras: { retention: { verifiedAt: "2026-09-04", scopes: 1, capturesScanned: 5, audioRetained: 2, transcriptOnly: 3, policyViolations: 1 } },
    });
    assert.equal(withRetentionViolation.decision.verdict, "rejected");
    assert.ok(withRetentionViolation.decision.reasons.some((r) => r.includes("retention")));
  });

  it("quality distributions, cohorts, latency/cost, and limitations are carried into the report", () => {
    const evidence = [...PASSING_EVIDENCE.map(makeEvidence), makeFullLoopEvidence()];
    const report = buildGraduationReportV2(evidence, {
      snapshot: SNAPSHOT,
      now: FIXED_NOW,
      extras: {
        limitations: ["STT timestamps are chunk-window approximations — affects provenance review for all pilot users"],
        correctionTrends: { scopes: 1, total: 4, pending: 1, accepted: 2, rejected: 1, followed: 3, contradicted: 1, adherenceRate: 0.75 },
      },
    });
    assert.ok(report.quality["organize"]?.["organize.thought_coverage"] !== undefined);
    assert.equal(report.latencyCost.latencyTotalMs?.mean, 42000);
    assert.deepEqual(report.latencyCost.totalTokens, { prompt: 220, completion: 100 });
    assert.equal(report.extras.limitations?.length, 1);
    assert.equal(report.extras.correctionTrends?.adherenceRate, 0.75);
  });

  it("placement-decision extras (Spec 6.4 FR-2) carry into the report and markdown", () => {
    const report = buildGraduationReportV2(PASSING_EVIDENCE.map(makeEvidence), {
      snapshot: SNAPSHOT,
      now: FIXED_NOW,
      extras: {
        placementDecisions: {
          scopes: 2,
          accepts: 7,
          moves: 3,
          firstPassAcceptanceRate: 0.7,
          perScope: [
            { participantId: "P-01", accepts: 5, moves: 1, firstPassAcceptanceRate: 5 / 6 },
            { participantId: "P-02", accepts: 2, moves: 2, firstPassAcceptanceRate: 0.5 },
          ],
        },
      },
    });
    assert.equal(report.extras.placementDecisions?.accepts, 7);
    assert.equal(report.extras.placementDecisions?.moves, 3);
    assert.equal(report.extras.placementDecisions?.firstPassAcceptanceRate, 0.7);
    const md = renderGraduationMarkdownV2(report);
    assert.match(md, /placement decisions \(2 scope\(s\)\): 7 first-pass accept\(s\), 3 move\(s\)/);
    assert.match(md, /first-pass acceptance 70\.0%/);
    assert.match(md, /P-01: 5 accept \/ 1 move/);
  });

  it("latency falls back to the per-case latencyMs distribution when no aggregate metric exists", () => {
    const fullLoop = makeFullLoopEvidence();
    fullLoop.report.aggregate.metrics = {}; // no latency.total_ms aggregate
    fullLoop.report.cases = [
      { caseId: "c1", scores: {}, hardFailures: [], latencyMs: 1000 },
      { caseId: "c2", scores: {}, hardFailures: [], latencyMs: 3000 },
      { caseId: "c3", scores: {}, hardFailures: [] },
    ];
    const report = buildGraduationReportV2(
      [...PASSING_EVIDENCE.map(makeEvidence), fullLoop],
      { snapshot: SNAPSHOT, now: FIXED_NOW },
    );
    assert.equal(report.latencyCost.latencyTotalMs?.n, 2);
    assert.equal(report.latencyCost.latencyTotalMs?.mean, 2000);
    assert.equal(report.latencyCost.latencyTotalMs?.max, 3000);
  });

  it("the report hash is stable for identical content and changes with content", () => {
    const inputs = { snapshot: SNAPSHOT, now: FIXED_NOW };
    const a = buildGraduationReportV2(PASSING_EVIDENCE.map(makeEvidence), inputs);
    // makeEvidence increments a counter, changing paths/fingerprints — so
    // re-use the SAME evidence entries for the stability check.
    const sameEvidence = PASSING_EVIDENCE.map(makeEvidence);
    const b = buildGraduationReportV2(sameEvidence, inputs);
    const b2 = buildGraduationReportV2(sameEvidence, inputs);
    assert.match(a.reportHash, /^[0-9a-f]{64}$/);
    assert.equal(b.reportHash, b2.reportHash);
    const c = buildGraduationReportV2(sameEvidence, {
      snapshot: { ...SNAPSHOT, commit: "f".repeat(40) },
      now: FIXED_NOW,
    });
    assert.notEqual(b.reportHash, c.reportHash);
  });

  it("the markdown rendering links evidence, states reasons, and keeps sign-off manual", () => {
    const regressed = PASSING_EVIDENCE.map((e) =>
      e.stage === "organize"
        ? { ...e, metrics: { ...e.metrics, "organize.bucket_acceptance": 0.8 } }
        : e,
    );
    const report = buildGraduationReportV2(regressed.map(makeEvidence), { snapshot: SNAPSHOT, now: FIXED_NOW });
    const md = renderGraduationMarkdownV2(report);
    assert.match(md, /NOT ALL PASS/);
    assert.match(md, /REJECTED/);
    assert.match(md, /bucket acceptance/);
    assert.match(md, /PENDING/);
    assert.match(md, /reports\/organize\//);
    assert.match(md, /held-out/);
  });
});
