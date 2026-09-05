/**
 * Baseline comparison (Specification 4.3): a candidate report is compared
 * against the ACCEPTED baseline for its stage, and the verdict is
 * merge-blocking or advisory by rule — never by vibes.
 *
 * Rules (statistically defensible for small deterministic suites):
 *   1. DATASET MISMATCH → invalid comparison (the baseline must be
 *      re-accepted for a changed dataset; comparisons across dataset
 *      versions are still reported but marked dataset-changed).
 *   2. ANY hard failure in the candidate → FAIL (SR-2: tenant leak,
 *      invalid provenance, unapproved mutation, duplicate action block
 *      regardless of averages).
 *   3. Product-classified case errors → FAIL (a defect, not a flake).
 *   4. Metric regressions: a metric materially regresses when
 *      (a) its mean drops by more than `tolerance` (absolute, default
 *      0.05) with at least one regressed case — the aggregate-drift rule
 *      for noisy live suites; OR
 *      (b) any previously-better case's score drops by more than
 *      `caseTolerance` (default 0) — the exact case-regression rule.
 *      Deterministic suites have zero run-to-run noise, so ANY case
 *      regression is material there (the 4.1 reproducibility contract);
 *      live-suite callers widen `caseTolerance` deliberately.
 *      Metrics that only exist in the baseline (dropped coverage) count
 *      as regressions; new metrics are noted, not failed.
 *   5. External-flaky errors never fail the comparison (FR-3) — but when
 *      they exceed MAX_EXTERNAL_ERROR_RATE the verdict is
 *      INCONCLUSIVE-EXTERNAL (the suite didn't measure the product), not
 *      a pass.
 *
 * The comparison identifies the EXACT regressed cases and metric changes
 * (FR-1) and never includes content — IDs and numbers only (SR-1).
 */
import { readFile } from "node:fs/promises";
import type { EvalReport } from "./report.js";

export const COMPARISON_SCHEMA = "donna.eval-comparison.v1";

/** Default absolute tolerance for metric-mean regressions. */
export const DEFAULT_TOLERANCE = 0.05;
/** Above this share of external-flaky errors the run measured nothing. */
export const MAX_EXTERNAL_ERROR_RATE = 0.34;

export type ComparisonStatus =
  | "pass"
  | "fail"
  | "inconclusive-external"
  | "invalid-dataset-mismatch";

export interface MetricDelta {
  metric: string;
  baseline: number;
  candidate: number;
  delta: number;
  /** Cases whose score dropped below their baseline score. */
  regressedCases: string[];
  /** Cases whose score improved. */
  improvedCases: string[];
}

export interface ComparisonResult {
  schema: typeof COMPARISON_SCHEMA;
  stage: string;
  dataset: { name: string; baselineSha256: string; candidateSha256: string; changed: boolean };
  baselineCommit: string;
  candidateCommit: string;
  status: ComparisonStatus;
  reasons: string[];
  hardFailures: EvalReport["aggregate"]["hardFailures"];
  metricDeltas: MetricDelta[];
  externalErrors: number;
  productErrors: number;
  comparedAt: string;
}

export interface CompareOptions {
  /** Aggregate mean-drop tolerance (default 0.05). */
  tolerance?: number;
  /**
   * Per-case score-drop tolerance (default 0 — deterministic suites are
   * exact; any case regression is material). Widen deliberately for live
   * suites with genuine model jitter.
   */
  caseTolerance?: number;
  now?: () => Date;
}

/** Load a report JSON from disk. */
export async function loadReport(path: string): Promise<EvalReport> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as EvalReport;
  if (parsed.schema !== "donna.eval-report.v1") {
    throw new Error(`Not an eval report: ${path}`);
  }
  return parsed;
}

/**
 * Compare a candidate report against the accepted baseline. Pure function
 * over the two reports — CI prints the result, the caller decides exit
 * codes.
 */
export function compareReports(
  baseline: EvalReport,
  candidate: EvalReport,
  options: CompareOptions = {},
): ComparisonResult {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const caseTolerance = options.caseTolerance ?? 0;
  const now = options.now ?? (() => new Date());
  const reasons: string[] = [];

  const datasetChanged = baseline.dataset.sha256 !== candidate.dataset.sha256;

  const base: Omit<ComparisonResult, "status" | "reasons"> = {
    schema: COMPARISON_SCHEMA,
    stage: candidate.stage,
    dataset: {
      name: candidate.dataset.name,
      baselineSha256: baseline.dataset.sha256,
      candidateSha256: candidate.dataset.sha256,
      changed: datasetChanged,
    },
    baselineCommit: baseline.snapshot.commit,
    candidateCommit: candidate.snapshot.commit,
    hardFailures: candidate.aggregate.hardFailures,
    metricDeltas: [],
    externalErrors: candidate.aggregate.externalErrors,
    productErrors: candidate.aggregate.productErrors,
    comparedAt: now().toISOString(),
  };

  // Rule 1: dataset identity.
  if (baseline.dataset.name !== candidate.dataset.name) {
    return {
      ...base,
      status: "invalid-dataset-mismatch",
      reasons: [`dataset name differs: ${baseline.dataset.name} vs ${candidate.dataset.name}`],
      metricDeltas: [],
    };
  }

  // Rule 2: hard failures block, always (SR-2).
  if (candidate.aggregate.hardFailureCount > 0) {
    reasons.push(
      ...candidate.aggregate.hardFailures.map(
        (hf) => `hard failure: ${hf.caseId} ${hf.kind} (${hf.detail})`,
      ),
    );
  }

  // Rule 3: product errors are regressions.
  if (candidate.aggregate.productErrors > 0) {
    const productCases = candidate.cases
      .filter((c) => c.error?.class === "product")
      .map((c) => `${c.caseId}:${c.error!.token}`);
    reasons.push(`product errors in: ${productCases.join(", ")}`);
  }

  // Rule 4: metric regressions with exact case identification (FR-1).
  const metricDeltas: MetricDelta[] = [];
  const baselineCases = new Map(baseline.cases.map((c) => [c.caseId, c]));
  const candidateMetrics = new Set(Object.keys(candidate.aggregate.metrics));
  for (const [metric, baselineStats] of Object.entries(baseline.aggregate.metrics)) {
    const candidateStats = candidate.aggregate.metrics[metric];
    if (candidateStats === undefined) {
      metricDeltas.push({
        metric,
        baseline: baselineStats.mean,
        candidate: 0,
        delta: -baselineStats.mean,
        regressedCases: ["(metric absent from candidate)"],
        improvedCases: [],
      });
      reasons.push(`metric ${metric} present in baseline but absent in candidate`);
      continue;
    }
    const delta = candidateStats.mean - baselineStats.mean;
    const regressedCases: string[] = [];
    const improvedCases: string[] = [];
    const materiallyRegressedCases: string[] = [];
    for (const candidateCase of candidate.cases) {
      const baselineCase = baselineCases.get(candidateCase.caseId);
      const before = baselineCase?.scores[metric];
      const after = candidateCase.scores[metric];
      if (before === undefined || after === undefined) continue;
      if (after < before - 1e-9) regressedCases.push(candidateCase.caseId);
      if (after < before - caseTolerance - 1e-9) {
        materiallyRegressedCases.push(candidateCase.caseId);
      }
      if (after > before + 1e-9) improvedCases.push(candidateCase.caseId);
    }
    metricDeltas.push({
      metric,
      baseline: baselineStats.mean,
      candidate: candidateStats.mean,
      delta,
      regressedCases,
      improvedCases,
    });
    const aggregateDrift = delta < -tolerance && regressedCases.length > 0;
    const caseRegression = materiallyRegressedCases.length > 0;
    if (aggregateDrift || caseRegression) {
      reasons.push(
        `metric ${metric} regressed ${baselineStats.mean.toFixed(4)} → ${candidateStats.mean.toFixed(4)} ` +
          `(${aggregateDrift ? `mean drop beyond tolerance ${tolerance}` : "case-level regression"}); ` +
          `cases: ${(caseRegression ? materiallyRegressedCases : regressedCases).join(", ")}`,
      );
    }
  }
  for (const metric of candidateMetrics) {
    if (baseline.aggregate.metrics[metric] === undefined) {
      reasons.push(`note: new metric ${metric} (not in baseline)`);
    }
  }

  // Rule 5: external-flaky errors never fail, but too many = inconclusive.
  const externalRate =
    candidate.aggregate.casesRun === 0
      ? 0
      : candidate.aggregate.externalErrors / candidate.aggregate.casesRun;

  const hasFailures = reasons.some(
    (r) =>
      r.startsWith("hard failure:") ||
      r.startsWith("product errors") ||
      r.startsWith("metric ") ||
      r.includes("absent in candidate"),
  );

  let status: ComparisonStatus;
  if (hasFailures) {
    status = "fail";
  } else if (externalRate > MAX_EXTERNAL_ERROR_RATE) {
    status = "inconclusive-external";
    reasons.push(
      `external-flaky error rate ${(externalRate * 100).toFixed(0)}% exceeds ${MAX_EXTERNAL_ERROR_RATE * 100}% — the suite measured the network, not the product`,
    );
  } else {
    status = "pass";
    if (datasetChanged) {
      reasons.push("note: dataset content changed since the baseline was accepted");
    }
    if (candidate.aggregate.externalErrors > 0) {
      reasons.push(
        `note: ${candidate.aggregate.externalErrors} external-flaky case error(s) tolerated (not product regressions)`,
      );
    }
  }

  return { ...base, status, reasons, metricDeltas };
}

/** Human-readable rendering for CI logs and review. */
export function renderComparisonMarkdown(result: ComparisonResult): string {
  const lines: string[] = [];
  lines.push(`# Eval comparison — ${result.dataset.name} (${result.stage})`);
  lines.push("");
  lines.push(`- status: **${result.status.toUpperCase()}**`);
  lines.push(`- baseline commit: ${result.baselineCommit}`);
  lines.push(`- candidate commit: ${result.candidateCommit}`);
  lines.push(`- dataset changed: ${result.dataset.changed ? "yes" : "no"}`);
  lines.push(`- errors: external-flaky ${result.externalErrors}, product ${result.productErrors}`);
  lines.push("");
  if (result.reasons.length > 0) {
    lines.push(`## Reasons`);
    lines.push("");
    for (const reason of result.reasons) lines.push(`- ${reason}`);
    lines.push("");
  }
  if (result.metricDeltas.length > 0) {
    lines.push(`## Metric deltas`);
    lines.push("");
    lines.push(`| metric | baseline | candidate | delta | regressed cases |`);
    lines.push(`|---|---|---|---|---|`);
    for (const delta of result.metricDeltas) {
      lines.push(
        `| ${delta.metric} | ${delta.baseline.toFixed(4)} | ${delta.candidate.toFixed(4)} | ${delta.delta >= 0 ? "+" : ""}${delta.delta.toFixed(4)} | ${delta.regressedCases.join(", ") || "—"} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
