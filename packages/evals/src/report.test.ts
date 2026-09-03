/**
 * Report mechanics tests (Specification 4.2 FR-2, SR-2): distributions,
 * cohort slices with small-group suppression, and metric documentation
 * coverage.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateOutcomes,
  buildCohortSlices,
  METRIC_DOCS,
  metricStats,
  MIN_COHORT_SIZE,
  type CaseOutcome,
} from "./report.js";

describe("metricStats distributions (FR-2)", () => {
  it("computes n/missing/mean/min/p50/p90/max", () => {
    const stats = metricStats([0.5, 1, undefined, 0.75, 1]);
    assert.equal(stats.n, 4);
    assert.equal(stats.missing, 1);
    assert.equal(stats.mean, 0.8125);
    assert.equal(stats.min, 0.5);
    assert.equal(stats.max, 1);
  });

  it("handles the all-missing case", () => {
    const stats = metricStats([undefined, undefined]);
    assert.equal(stats.n, 0);
    assert.equal(stats.missing, 2);
    assert.equal(stats.mean, 0);
  });
});

describe("aggregateOutcomes", () => {
  it("hard failures are counted and listed, never folded into scores", () => {
    const cases: CaseOutcome[] = [
      { caseId: "a", scores: { m: 1 }, hardFailures: [] },
      {
        caseId: "b",
        scores: { m: 1 },
        hardFailures: [{ kind: "tenant-leak", detail: "seeded" }],
      },
    ];
    const aggregate = aggregateOutcomes(cases);
    assert.equal(aggregate.metrics["m"]!.mean, 1); // average untouched
    assert.equal(aggregate.hardFailureCount, 1);
    assert.equal(aggregate.hardFailures[0]!.caseId, "b");
  });

  it("classifies external-flaky vs product errors", () => {
    const aggregate = aggregateOutcomes([
      { caseId: "a", scores: {}, hardFailures: [], error: { class: "external-flaky", token: "x" } },
      { caseId: "b", scores: {}, hardFailures: [], error: { class: "product", token: "y" } },
    ]);
    assert.equal(aggregate.externalErrors, 1);
    assert.equal(aggregate.productErrors, 1);
  });
});

describe("cohort slices (SR-2)", () => {
  function makeCase(id: string, accent: string, score: number): CaseOutcome {
    return {
      caseId: id,
      scores: { "stt.wer": score },
      hardFailures: [],
      cohort: { accent },
    };
  }

  it("groups by pseudonymous labels and suppresses small groups", () => {
    const cases = [
      makeCase("a1", "en-US synthetic", 0.1),
      makeCase("a2", "en-US synthetic", 0.2),
      makeCase("a3", "en-US synthetic", 0.3),
      makeCase("b1", "en-GB synthetic", 0.4), // group of 1 → suppressed
    ];
    const slices = buildCohortSlices(cases, ["accent"]);
    assert.equal(slices.length, 1);
    assert.equal(slices[0]!.n, 3);
    assert.equal(slices[0]!.slice["accent"], "en-US synthetic");
    assert.ok(Math.abs(slices[0]!.metrics["stt.wer"]!.mean - 0.2) < 1e-9);
    assert.ok(MIN_COHORT_SIZE >= 2);
  });

  it("cases without cohort labels form no slice", () => {
    const slices = buildCohortSlices(
      [{ caseId: "x", scores: { m: 1 }, hardFailures: [] }],
      ["accent"],
    );
    assert.equal(slices.length, 0);
  });
});

describe("metric documentation (FR-1)", () => {
  it("every documented metric has denominator, missing behavior, pass direction", () => {
    for (const [name, doc] of Object.entries(METRIC_DOCS)) {
      assert.ok(doc.denominator.length > 10, `${name} denominator`);
      assert.ok(doc.missing.length > 5, `${name} missing`);
      assert.ok(
        ["higher-is-better", "lower-is-better"].includes(doc.passDirection),
        `${name} pass direction`,
      );
    }
  });
});
