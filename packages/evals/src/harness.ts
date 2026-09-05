/**
 * The reproducible eval harness (Specification 4.1).
 *
 * One generic flow for every stage:
 *
 *   loadDataset (validated, metadata-resolved)
 *     → assertEvalScope + assertEvalDataDir (FR-4 isolation)
 *     → captureSnapshot (commit + config + dataset fingerprint, FR-1)
 *     → run each case through the stage scorer
 *     → aggregate distributions + hard failures (never averaged)
 *     → write machine-readable JSON + human-readable Markdown
 *
 * A stage scorer receives the loaded case and a context carrying the
 * asserted eval scope and scratch dir; it returns a CaseOutcome. Scorers
 * must classify errors as `external-flaky` (gateway/network/dependency)
 * or `product` (a Donna defect) — the distinction drives CI triage in
 * Specification 4.3.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadDataset,
  type LoadedCase,
  type LoadedDataset,
} from "./datasets.js";
import {
  assertEvalDataDir,
  assertEvalScope,
  EVAL_SCOPE,
} from "./isolation.js";
import {
  aggregateOutcomes,
  buildCohortSlices,
  redactionNote,
  REPORT_SCHEMA,
  writeReport,
  type CaseOutcome,
  type EvalReport,
} from "./report.js";
import {
  captureSnapshot,
  snapshotFingerprint,
  type ConfigSnapshot,
} from "./snapshot.js";

export interface StageContext {
  /** The asserted eval scope (eval-tenant/eval-user or eval-* variants). */
  scope: { tenantId: string; userId: string };
  /** Isolated scratch directory for this run (temp dir; never user data). */
  scratchDir: string;
  /** The full configuration snapshot for this run. */
  snapshot: ConfigSnapshot;
}

/**
 * A stage scorer. The case payload is `unknown` at this boundary — the
 * dataset loader has already validated it against the stage's case schema,
 * so scorers narrow with a local cast.
 */
export interface StageScorer {
  /** Stage name recorded in the report, e.g. "transcribe". */
  stage: string;
  /** Cohort slice keys to report (pseudonymous metadata labels only). */
  cohortKeys?: string[];
  /**
   * Optional per-run setup over the whole loaded dataset (e.g. build the
   * retrieval index from fixtures once). Runs inside the isolated scratch
   * dir, after isolation assertions.
   */
  setup?(context: StageContext, dataset: LoadedDataset): Promise<void>;
  /**
   * Score one case. Most stages return a single outcome; longitudinal
   * stages may return one outcome per capture step plus a case summary
   * (per-capture latency/cost distributions come from this).
   */
  score: (testCase: LoadedCase, context: StageContext) => Promise<CaseOutcome[]>;
  /** Optional per-run teardown (release stores, delete scratch state). */
  teardown?(context: StageContext): Promise<void>;
}

export interface RunEvalOptions {
  /** Path to the dataset envelope JSON. */
  datasetPath: string;
  /** Path to models.config.yaml. */
  configPath: string;
  repoRoot: string;
  /** evals package dir (scratch + reports live under it). */
  evalsDir: string;
  /** Directory reports are written into (must pass isolation checks). */
  reportsDir: string;
  scorer: StageScorer;
  /** Override the eval scope (must still be eval-* prefixed). */
  scope?: { tenantId: string; userId: string };
  now?: () => Date;
}

export interface RunEvalResult {
  report: EvalReport;
  jsonPath: string;
  markdownPath: string;
}

/**
 * Run one stage eval end-to-end and persist both report artifacts.
 * Isolation is asserted before any scorer code runs (FR-4).
 */
export async function runEval(options: RunEvalOptions): Promise<RunEvalResult> {
  const now = options.now ?? (() => new Date());
  const scope = options.scope ?? EVAL_SCOPE;
  assertEvalScope(scope);
  assertEvalDataDir(options.reportsDir, {
    repoRoot: options.repoRoot,
    evalsDir: options.evalsDir,
  });

  const dataset = await loadDataset(options.datasetPath);
  const snapshot = await captureSnapshot({
    repoRoot: options.repoRoot,
    configPath: options.configPath,
    dataset: { name: dataset.name, version: dataset.version, sha256: dataset.sha256 },
    now,
  });

  const scratchDir = await mkdtemp(join(tmpdir(), "donna-eval-"));
  assertEvalDataDir(scratchDir, {
    repoRoot: options.repoRoot,
    evalsDir: options.evalsDir,
  });

  const startedAt = now();
  const context: StageContext = { scope, scratchDir, snapshot };
  const cases: CaseOutcome[] = [];
  await options.scorer.setup?.(context, dataset);
  try {
    for (const testCase of dataset.cases) {
      const outcomes = await options.scorer.score(testCase, context);
      // Cohort labels come from fixture metadata only — pseudonymous by
      // construction (accent/noise/language notes, never identity).
      const cohort: Record<string, string> = {};
      for (const key of options.scorer.cohortKeys ?? []) {
        const value = testCase.meta[key as keyof typeof testCase.meta];
        if (typeof value === "string") cohort[key] = value;
      }
      for (const outcome of outcomes) {
        cases.push(
          Object.keys(cohort).length > 0 ? { ...outcome, cohort } : outcome,
        );
      }
    }
  } finally {
    await options.scorer.teardown?.(context);
  }
  const finishedAt = now();

  const report: EvalReport = {
    schema: REPORT_SCHEMA,
    stage: options.scorer.stage,
    dataset: {
      name: dataset.name,
      version: dataset.version,
      sha256: dataset.sha256,
      cases: dataset.cases.length,
    },
    snapshot,
    fingerprint: snapshotFingerprint(snapshot),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    cases,
    aggregate: aggregateOutcomes(cases),
    cohorts: buildCohortSlices(cases, options.scorer.cohortKeys ?? []),
    redactionNote: redactionNote(),
  };

  const { jsonPath, markdownPath } = await writeReport(report, options.reportsDir);
  return { report, jsonPath, markdownPath };
}

/**
 * Reproducibility proof helper (AC-1): run the same scorer twice over the
 * same dataset/config and compare. Used by tests and the review-gate demo.
 */
export async function runEvalTwice(
  options: RunEvalOptions,
): Promise<{ first: RunEvalResult; second: RunEvalResult }> {
  const first = await runEval(options);
  const second = await runEval(options);
  return { first, second };
}

export type { LoadedDataset };
