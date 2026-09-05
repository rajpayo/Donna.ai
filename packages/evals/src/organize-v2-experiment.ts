/**
 * Specification 6.7 structured-routing dev experiment.
 *
 * One approved structured-routing implementation (not a candidate
 * tournament), a frozen dev envelope, three fixed live replicates, common
 * aggregation, no best-of-three, and a mechanical stop on any floor
 * failure. The plan/lock immutability, blinded minted-name review, and
 * private-evidence rules mirror the rejected 6.6 experiment's machinery;
 * validation-v3, fresh P-00, held-out, and graduation runs are unreachable
 * from this module.
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  loadModelsConfig,
  organizeSystemRules,
  ORGANIZE_STRUCTURED_PROMPT_VERSION,
} from "@donna/providers";
import type { EvalReport } from "./report.js";
import { loadDataset } from "./datasets.js";
import { rubricHash, sha256 } from "./organize-experiment.js";

export const V2_PLAN_SCHEMA = "donna.organize-v2-plan.v1";
export const V2_LOCK_SCHEMA = "donna.organize-v2-plan-lock.v1";
export const V2_ELIGIBILITY_SCHEMA = "donna.organize-v2-eligibility.v1";

/** Binding dev floors (product owner, 2026-09-05). None may be weakened. */
export const V2_FLOORS = {
  thoughtCoverage: 0.97,
  taskRecall: 0.95,
  /** No regression below Spec 6.6 candidate A's aggregate baseline. */
  taskPrecisionBaseline: 0.8214285714,
  provenance: 1,
  schema: 1,
  tasksHardRule: 1,
  joinIdAccuracy: 0.9,
  modeAccuracy: 0.9,
  validatorPass: 0.9,
  blindedUsefulness: 0.85,
  finalPlacementAcceptance: 0.9,
  latencyP90Ms: 20000,
} as const;

export interface V2ExperimentPlan {
  schema: typeof V2_PLAN_SCHEMA;
  spec: "6.7";
  status: "locked";
  lockedAt: string;
  implementation: {
    id: "S";
    provider: "openai-compatible";
    model: "gpt-5-mini";
    contract: "donna.organize.v2";
    promptVersion: typeof ORGANIZE_STRUCTURED_PROMPT_VERSION;
    promptSha256: string;
    configPath: string;
    configSha256: string;
    /** Frozen after synthetic-fixture calibration (calibration.json). */
    nearDuplicateThreshold: number;
    replicates: 3;
  };
  datasets: {
    dev: { path: string; name: string; version: number; cases: number; sha256: string };
    validationV3: {
      path: string;
      sha256: string;
      lockPath: string;
      lockSha256: string;
      purpose: "preserved-history-not-run";
    };
  };
  aggregation: {
    metricMeans: "arithmetic-mean-of-three-run-means";
    latencyP90: "all-successful-case-latencies";
    bestOfThree: false;
    stopOnAnyFloorFailure: true;
  };
  floors: typeof V2_FLOORS;
  safetyInvariants: {
    crossTenantOrForgedIdSuccesses: 0;
    duplicateBucketCreationUnderReplay: 0;
    productErrors: 0;
    hardFailures: 0;
    securityPrivacyFailures: 0;
    deterministicSuitesMustPass: true;
    eachReplicateIndependently: true;
  };
  gateMigration: {
    state: "dual-evidence-first";
    futureGate: "GATE v2: FINAL PLACEMENT >= 0.85";
    thresholdUnchanged: 0.85;
    diagnosticsRetained: string[];
    requiresProductOwnerApproval: true;
  };
  rubric: {
    version: "donna.minted-name-rubric.v1";
    sha256: string;
    diagnosticOnly: true;
    blindedReviewer: "product-owner";
  };
}

export interface V2ExperimentLock {
  schema: typeof V2_LOCK_SCHEMA;
  planSha256: string;
  lockedAt: string;
  mutationAfterResults: "forbidden";
}

export interface V2EligibilityRecord {
  schema: typeof V2_ELIGIBILITY_SCHEMA;
  spec: "6.7";
  planSha256: string;
  evaluatedAt: string;
  reports: Array<{ path: string; sha256: string }>;
  metrics: Record<string, number>;
  metricCounts: Record<string, { passed: number; n: number }>;
  latencyMs: { n: number; p50: number; p90: number; max: number };
  floors: Array<{
    floor: string;
    threshold: number | string;
    actual: number | string;
    pass: boolean;
  }>;
  replicateSafety: Array<{ replicate: number; pass: boolean; failures: string[] }>;
  blindedUsefulness: {
    state: "evaluated" | "awaiting-product-owner-review";
    allFivePassRate?: number;
    reviewSha256?: string;
  };
  deterministicSuites: {
    decisionTable: boolean;
    concurrencyReplay: boolean;
    security: boolean;
    filePostgresParity: boolean;
  };
  outcome: "ELIGIBLE FOR VALIDATION REVIEW" | "STOP — STRUCTURED ROUTING FAILED" | "BLOCKED — AWAITING BLINDED REVIEW";
  mintSpecificFailure: boolean;
}

/* ------------------------------------------------------------------ */
/* Blinded minted-name usefulness review (product owner, diagnostic     */
/* floor at 0.85). Reuses the immutable 6.6 rubric; item IDs are opaque */
/* and the packet carries no model/config/expected-label fields.        */
/* ------------------------------------------------------------------ */

export interface V2ReviewSource {
  replicate: number;
  caseId: string;
  thought: string;
  mintedBucketName: string;
  existingBucketNames: string[];
}

export interface V2ReviewPacket {
  schema: "donna.organize-v2-review-packet.v1";
  rubricVersion: "donna.minted-name-rubric.v1";
  rubricSha256: string;
  items: Array<{
    itemId: string;
    thought: string;
    mintedBucketName: string;
    existingBucketNames: string[];
    decisions: Record<string, null>;
  }>;
}

export function buildV2ReviewPacket(
  planSha256: string,
  sources: V2ReviewSource[],
): V2ReviewPacket {
  const withIds = sources.map((source) => ({
    source,
    itemId: sha256(`${planSha256}\0S\0${source.replicate}\0${source.caseId}`).slice(0, 24),
  }));
  expect(
    new Set(withIds.map((item) => item.itemId)).size === withIds.length,
    "Blinded review item IDs collided",
  );
  withIds.sort((left, right) =>
    sha256(`${planSha256}\0review-order\0${left.itemId}`).localeCompare(
      sha256(`${planSha256}\0review-order\0${right.itemId}`),
    ),
  );
  return {
    schema: "donna.organize-v2-review-packet.v1",
    rubricVersion: "donna.minted-name-rubric.v1",
    rubricSha256: rubricHash(),
    items: withIds.map(({ source, itemId }) => ({
      itemId,
      thought: source.thought,
      mintedBucketName: source.mintedBucketName,
      existingBucketNames: [...source.existingBucketNames],
      decisions: {
        concise: null,
        reusable: null,
        correctTopic: null,
        distinctFromExisting: null,
        avoidsDatesAndOneOffActionWording: null,
      },
    })),
  };
}

/**
 * Summarize a completed content-free review: the fraction of items passing
 * ALL five rubric criteria. The review file contains item IDs and boolean
 * decisions only — never content.
 */
export function summarizeV2Review(review: {
  decisions: Array<{ itemId: string; decisions: Record<string, boolean> }>;
}): { allFivePassRate: number; items: number } {
  expect(review.decisions.length > 0, "Review has no decisions");
  const passed = review.decisions.filter((item) =>
    ["concise", "reusable", "correctTopic", "distinctFromExisting", "avoidsDatesAndOneOffActionWording"]
      .every((criterion) => item.decisions[criterion] === true),
  ).length;
  return { allFivePassRate: passed / review.decisions.length, items: review.decisions.length };
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function fileSha256(path: string): Promise<string> {
  return sha256(await readFile(path));
}

export function promptHashV2(): string {
  return sha256(organizeSystemRules(ORGANIZE_STRUCTURED_PROMPT_VERSION));
}

/** Validate the locked 6.7 plan byte-for-byte and semantically. */
export async function validateLockedV2Plan(options: {
  planPath: string;
  repoRoot: string;
}): Promise<{ plan: V2ExperimentPlan; lock: V2ExperimentLock; planSha256: string }> {
  const planPath = resolve(options.planPath);
  const lockPath = resolve(dirname(planPath), "plan.lock.json");
  const [planRaw, lockRaw] = await Promise.all([
    readFile(planPath, "utf8"),
    readFile(lockPath, "utf8"),
  ]);
  const plan = JSON.parse(planRaw) as V2ExperimentPlan;
  const lock = JSON.parse(lockRaw) as V2ExperimentLock;
  expect(lock.schema === V2_LOCK_SCHEMA, "Unsupported 6.7 lock schema");
  const planSha256 = sha256(planRaw);
  expect(lock.planSha256 === planSha256, "PLAN MUTATION DETECTED: 6.7 plan hash differs from immutable lock");
  expect(plan.schema === V2_PLAN_SCHEMA, "Unsupported 6.7 plan schema");
  expect(plan.spec === "6.7" && plan.status === "locked", "Plan is not a locked Spec 6.7 plan");
  expect(plan.aggregation.bestOfThree === false, "Best-of-three is forbidden");
  expect(plan.aggregation.stopOnAnyFloorFailure === true, "Mechanical stop is mandatory");
  expect(plan.implementation.replicates === 3, "Exactly three fixed replicates");
  expect(plan.implementation.model === "gpt-5-mini", "6.7 runs gpt-5-mini only");
  expect(plan.implementation.contract === "donna.organize.v2", "6.7 runs the v2 contract only");
  expect(plan.implementation.promptVersion === ORGANIZE_STRUCTURED_PROMPT_VERSION, "6.7 prompt version drift");
  expect(
    promptHashV2() === plan.implementation.promptSha256,
    "Structured prompt bytes drifted from the locked plan",
  );
  expect(plan.rubric.sha256 === rubricHash(), "Rubric hash drift");
  expect(plan.gateMigration.thresholdUnchanged === 0.85, "Graduation threshold must stay 0.85");
  expect(plan.floors === undefined || plan.floors.joinIdAccuracy === V2_FLOORS.joinIdAccuracy, "Floor drift");

  const configAbsolute = resolve(options.repoRoot, plan.implementation.configPath);
  expect(
    (await fileSha256(configAbsolute)) === plan.implementation.configSha256,
    "Implementation config snapshot hash drift",
  );
  const config = await loadModelsConfig(configAbsolute);
  const lane = config.stages.organize.default;
  expect(lane.model === "gpt-5-mini", "Config model drift");
  expect(lane.contract === "donna.organize.v2", "Config contract drift");
  expect(
    config.buckets.near_duplicate_threshold === plan.implementation.nearDuplicateThreshold,
    "Near-duplicate threshold drift (frozen at the calibrated 0.90 candidate)",
  );
  const escalation = config.stages.organize.escalation;
  expect(
    escalation !== undefined && escalation.model === "gpt-5-mini",
    "The 6.7 escalation lane must also be gpt-5-mini (no Sonnet)",
  );

  const dev = await loadDataset(resolve(options.repoRoot, plan.datasets.dev.path));
  expect(dev.name === plan.datasets.dev.name, "Frozen dev dataset name drift");
  expect(dev.version === plan.datasets.dev.version, "Frozen dev dataset version drift");
  expect(dev.cases.length === plan.datasets.dev.cases, "Frozen dev case-count drift");
  expect(dev.sha256 === plan.datasets.dev.sha256, "Frozen dev byte hash drift");

  // Validation-v3 is preserved history: verify bytes/lock, never run it.
  const validation = await loadDataset(resolve(options.repoRoot, plan.datasets.validationV3.path));
  expect(validation.sha256 === plan.datasets.validationV3.sha256, "Validation-v3 byte hash drift");
  expect(
    (await fileSha256(resolve(options.repoRoot, plan.datasets.validationV3.lockPath))) ===
      plan.datasets.validationV3.lockSha256,
    "Validation-v3 lock byte hash drift",
  );
  return { plan, lock, planSha256 };
}

function reportMetric(report: EvalReport, name: string): number {
  return report.aggregate.metrics[name]?.mean ?? 0;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

/** Load exactly the three fixed replicate reports (no missing/extra). */
export async function loadV2Reports(options: {
  reportsRoot: string;
  plan: V2ExperimentPlan;
}): Promise<Array<{ path: string; sha256: string; report: EvalReport }>> {
  const dir = resolve(options.reportsRoot, "S");
  const names = (await readdir(dir)).filter((name) => /^replicate-\d+\.json$/.test(name)).sort();
  expect(
    names.join(",") === "replicate-1.json,replicate-2.json,replicate-3.json",
    "Expected exactly replicate-1..3.json — no missing, extra, or excluded runs",
  );
  const reports = [];
  for (const name of names) {
    const path = resolve(dir, name);
    const raw = await readFile(path, "utf8");
    const report = JSON.parse(raw) as EvalReport;
    expect(report.dataset.sha256 === options.plan.datasets.dev.sha256, `${name}: dev hash mismatch`);
    expect(
      report.snapshot.modelsConfig.sha256 === options.plan.implementation.configSha256,
      `${name}: config hash mismatch`,
    );
    reports.push({ path: `S/${name}`, sha256: sha256(raw), report });
  }
  return reports;
}

const METRIC_FOR_FLOOR: Array<{ floor: string; metric: string; threshold: number }> = [
  { floor: "thought-coverage", metric: "organize.thought_coverage", threshold: V2_FLOORS.thoughtCoverage },
  { floor: "task-recall", metric: "organize.task_recall", threshold: V2_FLOORS.taskRecall },
  { floor: "task-precision-no-regression", metric: "organize.task_precision", threshold: V2_FLOORS.taskPrecisionBaseline },
  { floor: "provenance", metric: "organize.provenance_fidelity", threshold: V2_FLOORS.provenance },
  { floor: "schema", metric: "organize.schema_valid", threshold: V2_FLOORS.schema },
  { floor: "tasks-hard-rule", metric: "tasks.hard_rule", threshold: V2_FLOORS.tasksHardRule },
  { floor: "join-by-id-accuracy", metric: "route.join_id_accuracy", threshold: V2_FLOORS.joinIdAccuracy },
  { floor: "join-vs-mint-decision", metric: "route.mode_accuracy", threshold: V2_FLOORS.modeAccuracy },
  { floor: "canonical-validator-pass", metric: "mint.validator_pass", threshold: V2_FLOORS.validatorPass },
  { floor: "final-placement-acceptance", metric: "final.placement_acceptance", threshold: V2_FLOORS.finalPlacementAcceptance },
];

/** Aggregate the three replicates and evaluate every binding floor. */
export function evaluateV2Eligibility(options: {
  plan: V2ExperimentPlan;
  planSha256: string;
  reports: Array<{ path: string; sha256: string; report: EvalReport }>;
  blinded: { state: "evaluated"; allFivePassRate: number; reviewSha256: string } | { state: "awaiting-product-owner-review" };
  deterministicSuites: V2EligibilityRecord["deterministicSuites"];
  now?: () => Date;
}): V2EligibilityRecord {
  const { reports } = options;
  const metricNames = new Set(
    reports.flatMap(({ report }) => Object.keys(report.aggregate.metrics)),
  );
  const metrics: Record<string, number> = {};
  const metricCounts: Record<string, { passed: number; n: number }> = {};
  for (const metric of metricNames) {
    metrics[metric] =
      reports.reduce((sum, item) => sum + reportMetric(item.report, metric), 0) / 3;
    const values = reports.flatMap(({ report }) =>
      report.cases.map((item) => item.scores[metric]).filter((value): value is number => value !== undefined),
    );
    metricCounts[metric] = { passed: values.filter((value) => value === 1).length, n: values.length };
  }
  const latencies = reports
    .flatMap(({ report }) => report.cases)
    .filter((item) => item.error === undefined)
    .map((item) => item.latencyMs)
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b);

  const floors: V2EligibilityRecord["floors"] = [];
  for (const { floor, metric, threshold } of METRIC_FOR_FLOOR) {
    const actual = metrics[metric] ?? 0;
    floors.push({ floor, threshold, actual, pass: actual >= threshold });
  }
  const p90 = percentile(latencies, 90);
  floors.push({ floor: "latency-p90-ms", threshold: V2_FLOORS.latencyP90Ms, actual: p90, pass: p90 <= V2_FLOORS.latencyP90Ms });

  const totalProductErrors = reports.reduce((sum, item) => sum + item.report.aggregate.productErrors, 0);
  const totalExternalErrors = reports.reduce((sum, item) => sum + item.report.aggregate.externalErrors, 0);
  const totalHardFailures = reports.reduce((sum, item) => sum + item.report.aggregate.hardFailureCount, 0);
  floors.push({ floor: "product-errors", threshold: 0, actual: totalProductErrors, pass: totalProductErrors === 0 });
  floors.push({ floor: "incomplete-external-runs", threshold: 0, actual: totalExternalErrors, pass: totalExternalErrors === 0 });
  floors.push({ floor: "hard-failures", threshold: 0, actual: totalHardFailures, pass: totalHardFailures === 0 });

  // Every replicate must independently pass the blocking safety invariants.
  const replicateSafety = reports.map((item, index) => {
    const failures: string[] = [];
    if (item.report.aggregate.hardFailureCount !== 0) failures.push("hard-failures");
    if (item.report.aggregate.productErrors !== 0) failures.push("product-errors");
    if (reportMetric(item.report, "organize.provenance_fidelity") !== 1) failures.push("provenance");
    if (reportMetric(item.report, "organize.schema_valid") !== 1) failures.push("schema");
    const tasksHardRule = item.report.aggregate.metrics["tasks.hard_rule"];
    if (tasksHardRule !== undefined && tasksHardRule.mean !== 1) failures.push("tasks-hard-rule");
    return { replicate: index + 1, pass: failures.length === 0, failures };
  });
  const safetyPass = replicateSafety.every((item) => item.pass);
  floors.push({
    floor: "replicate-safety-invariants",
    threshold: "all-3-pass",
    actual: safetyPass ? "all-3-pass" : "failed",
    pass: safetyPass,
  });

  const suites = options.deterministicSuites;
  const suitesPass =
    suites.decisionTable && suites.concurrencyReplay && suites.security && suites.filePostgresParity;
  floors.push({
    floor: "deterministic-suites",
    threshold: "all-pass",
    actual: suitesPass ? "all-pass" : JSON.stringify(suites),
    pass: suitesPass,
  });

  let blindedPass = false;
  let blinded: V2EligibilityRecord["blindedUsefulness"];
  if (options.blinded.state === "evaluated") {
    blindedPass = options.blinded.allFivePassRate >= V2_FLOORS.blindedUsefulness;
    blinded = {
      state: "evaluated",
      allFivePassRate: options.blinded.allFivePassRate,
      reviewSha256: options.blinded.reviewSha256,
    };
    floors.push({
      floor: "blinded-usefulness",
      threshold: V2_FLOORS.blindedUsefulness,
      actual: options.blinded.allFivePassRate,
      pass: blindedPass,
    });
  } else {
    blinded = { state: "awaiting-product-owner-review" };
  }

  const failedFloors = floors.filter((floor) => !floor.pass);
  const routingFloors = new Set([
    "join-by-id-accuracy",
    "join-vs-mint-decision",
    "final-placement-acceptance",
  ]);
  const mintFloors = new Set(["canonical-validator-pass", "blinded-usefulness"]);
  const routingFailed = failedFloors.some((floor) => routingFloors.has(floor.floor));
  // Narrow mint-only evidence: routing/join floors pass while a mint
  // quality floor fails — the recorded justification for a future
  // mint-focused follow-up spec (never a broadened retry inside 6.7).
  const mintSpecificFailure =
    !routingFailed &&
    failedFloors.length > 0 &&
    failedFloors.every((floor) => mintFloors.has(floor.floor));

  const outcome: V2EligibilityRecord["outcome"] =
    failedFloors.length === 0 && options.blinded.state === "evaluated"
      ? "ELIGIBLE FOR VALIDATION REVIEW"
      : options.blinded.state !== "evaluated" && failedFloors.length === 0
        ? "BLOCKED — AWAITING BLINDED REVIEW"
        : "STOP — STRUCTURED ROUTING FAILED";

  return {
    schema: V2_ELIGIBILITY_SCHEMA,
    spec: "6.7",
    planSha256: options.planSha256,
    evaluatedAt: (options.now ?? (() => new Date()))().toISOString(),
    reports: reports.map(({ path, sha256: reportSha }) => ({ path, sha256: reportSha })),
    metrics,
    metricCounts,
    latencyMs: {
      n: latencies.length,
      p50: percentile(latencies, 50),
      p90,
      max: latencies.at(-1) ?? 0,
    },
    floors,
    replicateSafety,
    blindedUsefulness: blinded,
    deterministicSuites: suites,
    outcome,
    mintSpecificFailure,
  };
}
