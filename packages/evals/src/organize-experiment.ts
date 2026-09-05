/**
 * Specification 6.6 organizer-quality experiment.
 *
 * This module owns the immutable-plan, fixed-replicate, blinded-review,
 * mechanical-selection, private-evidence, and fresh-envelope guards. It does
 * not choose models in code: every binding candidate points at a complete
 * models.config.yaml snapshot and the normal provider registry resolves it.
 */
import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  loadModelsConfig,
  organizeSystemRules,
  type OrganizePromptVersion,
} from "@donna/providers";
import type { EvalReport, MetricStats } from "./report.js";
import { loadDataset } from "./datasets.js";

export const EXPERIMENT_SCHEMA = "donna.organize-experiment-plan.v1";
export const EXPERIMENT_LOCK_SCHEMA = "donna.organize-experiment-lock.v1";
export const SELECTION_SCHEMA = "donna.organize-experiment-selection.v1";
export const RUBRIC_VERSION = "donna.minted-name-rubric.v1";
export const FRESH_LOCK_SCHEMA = "donna.organize-fresh-lock.v1";
export const PRIVATE_DIAGNOSTIC_SCHEMA =
  "donna.organize-private-diagnostic.v1";

export const RUBRIC_CRITERIA = [
  "concise",
  "reusable",
  "correctTopic",
  "distinctFromExisting",
  "avoidsDatesAndOneOffActionWording",
] as const;
export type RubricCriterion = (typeof RUBRIC_CRITERIA)[number];

export interface CandidateManifest {
  id: "A" | "A0" | "B" | "C";
  provider: "openai-compatible" | "anthropic";
  model: string;
  promptVersion: OrganizePromptVersion;
  temperature: number | null;
  configPath: string;
  configSha256: string;
  promptSha256: string;
  replicates: 3;
}

export interface ExperimentPlan {
  schema: typeof EXPERIMENT_SCHEMA;
  spec: "6.6";
  status: "locked";
  lockedAt: string;
  tariff: {
    status: "verified" | "not-available";
    candidateC: "admitted" | "excluded";
    reason: string;
    evidenceSha256?: string;
  };
  datasets: {
    dev: { path: string; name: string; version: 60; cases: 28; sha256: string };
    validationV3: {
      path: string;
      name: string;
      version: 3;
      cases: 32;
      sha256: string;
      purpose: "regression-only-not-graduation";
      lockPath: string;
      lockSha256: string;
    };
  };
  candidates: CandidateManifest[];
  comparisons: Array<{
    left: CandidateManifest["id"];
    right: CandidateManifest["id"];
    isolates: "temperature" | "prompt" | "model";
  }>;
  selectionPolicySha256: string;
  aggregation: {
    metricMeans: "arithmetic-mean-of-three-run-means";
    latencyP90: "all-successful-case-latencies";
    bestOfThree: false;
  };
  eligibility: {
    thoughtCoverage: 0.97;
    bucketOverall: 0.9;
    bucketJoined: 0.9;
    bucketMinted: 0.8;
    taskRecall: 0.95;
    taskRecallAtLeastA: true;
    taskPrecisionAtLeastA: true;
    provenance: 1;
    schema: 1;
    hardFailures: 0;
    productErrors: 0;
    latencyP90Ms: 20000;
  };
  tieBreaks: string[];
  costPolicy: {
    sameProviderModelComparableWithoutMoney: true;
    absentGatewayMoney: "not-reported";
    tokenProxyIsNotMoney: true;
    candidateCPremiumRule: string;
  };
  retryPolicy: {
    dev: "none";
    final: "one-external-only-with-zero-product-errors-and-hard-failures";
  };
  rubric: {
    version: typeof RUBRIC_VERSION;
    path: string;
    criteria: readonly RubricCriterion[];
    sha256: string;
    expectedLabelBlind: true;
    candidateBlind: true;
    diagnosticOnly: true;
  };
  freshBlind: {
    classes: string[];
    minimumCases: 20;
    minimumPerClass: 2;
    freezeBeforeResult: true;
    winnerRuns: 1;
  };
}

export interface ExperimentLock {
  schema: typeof EXPERIMENT_LOCK_SCHEMA;
  planSha256: string;
  lockedAt: string;
  mutationAfterResults: "forbidden";
}

export interface CandidateAggregate {
  candidate: CandidateManifest["id"];
  reports: Array<{ path: string; sha256: string }>;
  metrics: Record<string, number>;
  metricCounts: Record<string, { passed: number; n: number }>;
  latencyMs: {
    n: number;
    mean: number;
    min: number;
    p50: number;
    p90: number;
    max: number;
  };
  gatewayCost: {
    status: "complete" | "not-reported";
    totalUsd: number | null;
    perSuccessfulCaseUsd: number | null;
  };
  tokens: { prompt: number; completion: number; total: number };
  cases: { successful: number; errored: number; externalErrors: number; productErrors: number };
  hardFailures: number;
}

export interface RubricDecision {
  itemId: string;
  decisions: Record<RubricCriterion, boolean>;
}

export interface ContentFreeReview {
  schema: "donna.minted-name-review.v1";
  rubricVersion: typeof RUBRIC_VERSION;
  rubricSha256: string;
  packetSha256: string;
  randomizationSha256: string;
  reviewer: "product-owner";
  reviewedAt: string;
  decisions: RubricDecision[];
}

export interface PrivateReviewMap {
  schema: "donna.minted-name-review-map.v1";
  planSha256: string;
  items: Array<{ itemId: string; candidate: CandidateManifest["id"] }>;
}

export interface PrivateMintedReviewSource {
  candidate: CandidateManifest["id"];
  replicate: number;
  caseId: string;
  thought: string;
  mintedBucketName: string;
  existingBucketNames: string[];
}

export interface BlindedReviewPacket {
  schema: "donna.minted-name-review-packet.v1";
  rubricVersion: typeof RUBRIC_VERSION;
  rubricSha256: string;
  instructions: string;
  items: Array<{
    itemId: string;
    thought: string;
    mintedBucketName: string;
    existingBucketNames: string[];
    decisions: Record<RubricCriterion, null>;
  }>;
}

export interface EligibilityTrace {
  candidate: CandidateManifest["id"];
  eligible: boolean;
  failures: string[];
  passesAllExceptMinted: boolean;
  rubricPass: boolean;
}

export interface SelectionRecord {
  schema: typeof SELECTION_SCHEMA;
  spec: "6.6";
  planSha256: string;
  selectedAt: string;
  tariffOutcome: "C-excluded-no-authoritative-tariff" | "C-admitted";
  reports: CandidateAggregate[];
  comparisons: Array<{
    label: string;
    metricDeltas: Record<string, number>;
    latencyP90DeltaMs: number;
  }>;
  eligibility: EligibilityTrace[];
  outcome:
    | { kind: "winner"; candidate: CandidateManifest["id"] }
    | { kind: "none" }
    | { kind: "naming-measurement-mismatch" };
  review: {
    rubricSha256: string;
    packetSha256: string;
    reviewSha256: string;
    diagnosticOnly: true;
  };
}

export interface FreshEnvelopeSummary {
  total: number;
  byClass: Record<string, number>;
  mintedCases: number;
  zeroIdOverlap: boolean;
  zeroContentOverlap: boolean;
}

export interface FreshLock {
  schema: typeof FRESH_LOCK_SCHEMA;
  dataset: { name: string; version: number; sha256: string; cases: number };
  selectionSha256: string;
  winnerCommit: string;
  frozenAt: string;
  classes: Record<string, number>;
  mintedCases: number;
  overlap: { caseIds: 0; contentHashes: 0 };
  resultState: "NO RESULTS YET";
}

const REQUIRED_CLASSES = [
  "meetings",
  "tasks",
  "ideas",
  "follow-ups",
  "decisions",
  "people",
  "projects",
  "mixed-emotional",
  "multi-capture",
] as const;

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function stableHash(value: unknown): string {
  return sha256(stable(value));
}

export function rubricDocument(): Record<string, unknown> {
  return {
    schema: "donna.minted-name-rubric.v1",
    version: RUBRIC_VERSION,
    immutableBeforeResults: true,
    candidateBlind: true,
    expectedLabelBlind: true,
    diagnosticOnly: true,
    criteria: RUBRIC_CRITERIA,
    instructions: {
      concise: "short bucket label rather than a sentence",
      reusable: "useful for later related thoughts rather than this occurrence",
      correctTopic: "represents the thought's durable subject",
      distinctFromExisting: "not a synonym or near-duplicate of an existing bucket",
      avoidsDatesAndOneOffActionWording:
        "contains no transient date, deadline, imperative, or episode title",
    },
    stopRule:
      "If a candidate fails only minted exact-name eligibility while all of its reviewed minted outputs pass this rubric, stop as naming-measurement-mismatch. Never override, relabel, or retry.",
  };
}

export function rubricHash(): string {
  return sha256(JSON.stringify(rubricDocument(), null, 2) + "\n");
}

export function promptHash(version: OrganizePromptVersion): string {
  return sha256(organizeSystemRules(version));
}

export function selectionPolicyHash(
  plan: Pick<
    ExperimentPlan,
    "aggregation" | "eligibility" | "tieBreaks" | "costPolicy" | "retryPolicy" | "freshBlind"
  >,
): string {
  return stableHash({
    aggregation: plan.aggregation,
    eligibility: plan.eligibility,
    tieBreaks: plan.tieBreaks,
    costPolicy: plan.costPolicy,
    retryPolicy: plan.retryPolicy,
    freshBlind: plan.freshBlind,
  });
}

async function fileSha256(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function candidateIds(plan: ExperimentPlan): string[] {
  return plan.candidates.map((candidate) => candidate.id);
}

/** Pure preflight used before any live request; covers 9-run and 12-run plans. */
export function validateTariffCandidateSet(plan: ExperimentPlan): number {
  const ids = candidateIds(plan);
  expect(new Set(ids).size === ids.length, "Candidate IDs must be unique");
  if (plan.tariff.status === "not-available") {
    expect(plan.tariff.candidateC === "excluded", "C must be excluded without tariff evidence");
    expect(!ids.includes("C"), "C must not appear in the binding plan without tariff evidence");
    expect(ids.join(",") === "A,A0,B", "No-tariff binding order must be exactly A,A0,B");
  } else {
    expect(plan.tariff.candidateC === "admitted", "Verified tariff must explicitly admit C");
    expect(ids.join(",") === "A,A0,B,C", "Tariff-admitted binding order must be A,A0,B,C");
    expect(plan.tariff.evidenceSha256?.length === 64, "Admitted C requires a tariff evidence hash");
  }
  for (const candidate of plan.candidates) {
    expect(candidate.replicates === 3, `${candidate.id}: exactly three replicates are required`);
  }
  return plan.candidates.length * 3;
}

export function assertPlanBytesMatchLock(
  planRaw: string,
  lock: ExperimentLock,
): string {
  expect(lock.schema === EXPERIMENT_LOCK_SCHEMA, "Unsupported experiment lock schema");
  const actual = sha256(planRaw);
  expect(
    lock.planSha256 === actual,
    "PLAN MUTATION DETECTED: plan hash differs from immutable lock",
  );
  return actual;
}

export async function validateLockedPlan(options: {
  planPath: string;
  repoRoot: string;
}): Promise<{ plan: ExperimentPlan; lock: ExperimentLock; planSha256: string }> {
  const planPath = resolve(options.planPath);
  const lockPath = resolve(dirname(planPath), "plan.lock.json");
  const [planRaw, lockRaw] = await Promise.all([
    readFile(planPath, "utf8"),
    readFile(lockPath, "utf8"),
  ]);
  const plan = JSON.parse(planRaw) as ExperimentPlan;
  const lock = JSON.parse(lockRaw) as ExperimentLock;
  const actualPlanSha = assertPlanBytesMatchLock(planRaw, lock);
  expect(plan.schema === EXPERIMENT_SCHEMA, "Unsupported organize experiment plan schema");
  expect(plan.spec === "6.6" && plan.status === "locked", "Plan is not a locked Spec 6.6 plan");
  expect(plan.rubric.sha256 === rubricHash(), "Plan rubric hash differs from the compiled immutable rubric");
  expect(
    (await fileSha256(resolve(options.repoRoot, plan.rubric.path))) === plan.rubric.sha256,
    "Plan rubric artifact hash drift",
  );
  expect(
    plan.selectionPolicySha256 === selectionPolicyHash(plan),
    "Plan selection-policy hash differs from its locked rules",
  );
  expect(plan.rubric.diagnosticOnly, "Minted-name rubric must remain diagnostic-only");
  expect(plan.aggregation.bestOfThree === false, "Best-of-three is forbidden");
  expect(plan.retryPolicy.dev === "none", "Dev retries are forbidden");
  expect(plan.retryPolicy.final.includes("external-only"), "Final retry must be external-only");

  validateTariffCandidateSet(plan);
  for (const candidate of plan.candidates) {
    const configAbsolute = resolve(options.repoRoot, candidate.configPath);
    expect(
      (await fileSha256(configAbsolute)) === candidate.configSha256,
      `${candidate.id}: config snapshot hash drift`,
    );
    expect(
      promptHash(candidate.promptVersion) === candidate.promptSha256,
      `${candidate.id}: prompt hash drift`,
    );
    const config = await loadModelsConfig(configAbsolute);
    const lane = config.stages.organize.default;
    expect(lane.provider === candidate.provider, `${candidate.id}: provider differs from config`);
    expect(lane.model === candidate.model, `${candidate.id}: model differs from config`);
    expect(lane.prompt === candidate.promptVersion, `${candidate.id}: prompt differs from config`);
    const actualTemperature =
      typeof lane.params.temperature === "number" ? lane.params.temperature : null;
    expect(
      actualTemperature === candidate.temperature,
      `${candidate.id}: temperature differs from config`,
    );
  }
  const dev = await loadDataset(resolve(options.repoRoot, plan.datasets.dev.path));
  expect(dev.name === plan.datasets.dev.name, "Frozen dev dataset name drift");
  expect(dev.version === plan.datasets.dev.version, "Frozen dev dataset version drift");
  expect(dev.cases.length === plan.datasets.dev.cases, "Frozen dev case-count drift");
  expect(dev.sha256 === plan.datasets.dev.sha256, "Frozen dev byte hash drift");
  const validation = await loadDataset(
    resolve(options.repoRoot, plan.datasets.validationV3.path),
  );
  expect(validation.name === plan.datasets.validationV3.name, "Validation-v3 name drift");
  expect(validation.version === plan.datasets.validationV3.version, "Validation-v3 version drift");
  expect(validation.cases.length === plan.datasets.validationV3.cases, "Validation-v3 count drift");
  expect(validation.sha256 === plan.datasets.validationV3.sha256, "Validation-v3 byte hash drift");
  expect(
    (await fileSha256(resolve(options.repoRoot, plan.datasets.validationV3.lockPath))) ===
      plan.datasets.validationV3.lockSha256,
    "Validation-v3 lock byte hash drift",
  );
  return { plan, lock, planSha256: actualPlanSha };
}

function reportMetric(report: EvalReport, name: string): number {
  return report.aggregate.metrics[name]?.mean ?? 0;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

export function aggregateCandidate(
  candidate: CandidateManifest["id"],
  reports: Array<{ path: string; sha256: string; report: EvalReport }>,
): CandidateAggregate {
  expect(reports.length === 3, `${candidate}: exactly three reports are required`);
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
  const successfulCases = reports.flatMap(({ report }) =>
    report.cases.filter((item) => item.error === undefined),
  );
  const latencies = successfulCases
    .map((item) => item.latencyMs)
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b);
  const completeCost =
    successfulCases.length > 0 && successfulCases.every((item) => item.costUsd !== undefined);
  const totalUsd = completeCost
    ? successfulCases.reduce((sum, item) => sum + item.costUsd!, 0)
    : null;
  const prompt = successfulCases.reduce((sum, item) => sum + (item.tokens?.prompt ?? 0), 0);
  const completion = successfulCases.reduce(
    (sum, item) => sum + (item.tokens?.completion ?? 0),
    0,
  );
  return {
    candidate,
    reports: reports.map(({ path, sha256: reportSha }) => ({ path, sha256: reportSha })),
    metrics,
    metricCounts,
    latencyMs: {
      n: latencies.length,
      mean: latencies.length === 0 ? 0 : latencies.reduce((a, b) => a + b, 0) / latencies.length,
      min: latencies[0] ?? 0,
      p50: percentile(latencies, 50),
      p90: percentile(latencies, 90),
      max: latencies.at(-1) ?? 0,
    },
    gatewayCost: {
      status: completeCost ? "complete" : "not-reported",
      totalUsd,
      perSuccessfulCaseUsd:
        totalUsd === null || successfulCases.length === 0
          ? null
          : totalUsd / successfulCases.length,
    },
    tokens: { prompt, completion, total: prompt + completion },
    cases: {
      successful: successfulCases.length,
      errored: reports.reduce((sum, item) => sum + item.report.aggregate.casesErrored, 0),
      externalErrors: reports.reduce((sum, item) => sum + item.report.aggregate.externalErrors, 0),
      productErrors: reports.reduce((sum, item) => sum + item.report.aggregate.productErrors, 0),
    },
    hardFailures: reports.reduce(
      (sum, item) => sum + item.report.aggregate.hardFailureCount,
      0,
    ),
  };
}

export async function loadCandidateReports(options: {
  reportsRoot: string;
  plan: ExperimentPlan;
}): Promise<CandidateAggregate[]> {
  const result: CandidateAggregate[] = [];
  for (const candidate of options.plan.candidates) {
    const candidateDir = resolve(options.reportsRoot, candidate.id);
    const names = (await readdir(candidateDir)).filter((name) => /^replicate-\d+\.json$/.test(name)).sort();
    expect(
      names.join(",") === "replicate-1.json,replicate-2.json,replicate-3.json",
      `${candidate.id}: expected exactly replicate-1..3.json with no missing or extra binding reports`,
    );
    const reports = [];
    for (const name of names) {
      const path = resolve(candidateDir, name);
      const raw = await readFile(path, "utf8");
      const report = JSON.parse(raw) as EvalReport;
      expect(report.dataset.sha256 === options.plan.datasets.dev.sha256, `${candidate.id}: dev hash mismatch`);
      expect(report.snapshot.modelsConfig.sha256 === candidate.configSha256, `${candidate.id}: config hash mismatch`);
      expect(report.snapshot.versions.organizePrompt === candidate.promptVersion, `${candidate.id}: prompt mismatch`);
      reports.push({
        path: `${candidate.id}/${name}`.replaceAll("\\", "/"),
        sha256: sha256(raw),
        report,
      });
    }
    result.push(aggregateCandidate(candidate.id, reports));
  }
  return result;
}

function metric(aggregate: CandidateAggregate, name: string): number {
  return aggregate.metrics[name] ?? 0;
}

function rubricPassByCandidate(
  plan: ExperimentPlan,
  review: ContentFreeReview,
  map: PrivateReviewMap,
): Map<CandidateManifest["id"], boolean> {
  expect(review.rubricSha256 === plan.rubric.sha256, "Review rubric hash mismatch");
  const decisions = new Map(review.decisions.map((item) => [item.itemId, item]));
  expect(decisions.size === review.decisions.length, "Duplicate rubric item decisions");
  const result = new Map<CandidateManifest["id"], boolean>();
  for (const candidate of plan.candidates) {
    const items = map.items.filter((item) => item.candidate === candidate.id);
    expect(items.length > 0, `${candidate.id}: no blinded minted items in review map`);
    result.set(
      candidate.id,
      items.every((item) => {
        const decision = decisions.get(item.itemId);
        expect(decision !== undefined, `Missing rubric decision for ${item.itemId}`);
        return RUBRIC_CRITERIA.every((criterion) => decision.decisions[criterion] === true);
      }),
    );
  }
  return result;
}

function eligibility(
  plan: ExperimentPlan,
  aggregates: CandidateAggregate[],
  review: ContentFreeReview,
  map: PrivateReviewMap,
): EligibilityTrace[] {
  const baseline = aggregates.find((item) => item.candidate === "A");
  expect(baseline !== undefined, "Candidate A baseline is required");
  const rubricPasses = rubricPassByCandidate(plan, review, map);
  return aggregates.map((candidate) => {
    const failures: string[] = [];
    if (metric(candidate, "organize.thought_coverage") < plan.eligibility.thoughtCoverage) failures.push("thought-coverage");
    if (metric(candidate, "organize.bucket_acceptance") < plan.eligibility.bucketOverall) failures.push("bucket-overall");
    if (metric(candidate, "organize.bucket_acceptance_joined") < plan.eligibility.bucketJoined) failures.push("bucket-joined");
    if (metric(candidate, "organize.bucket_acceptance_minted") < plan.eligibility.bucketMinted) failures.push("bucket-minted");
    if (metric(candidate, "organize.task_recall") < plan.eligibility.taskRecall) failures.push("task-recall-floor");
    if (metric(candidate, "organize.task_recall") < metric(baseline, "organize.task_recall")) failures.push("task-recall-below-A");
    if (metric(candidate, "organize.task_precision") < metric(baseline, "organize.task_precision")) failures.push("task-precision-below-A");
    if (metric(candidate, "organize.provenance_fidelity") !== 1) failures.push("provenance");
    if (metric(candidate, "organize.schema_valid") !== 1) failures.push("schema");
    if (candidate.hardFailures !== 0) failures.push("hard-failures");
    if (candidate.cases.productErrors !== 0) failures.push("product-errors");
    if (candidate.cases.externalErrors !== 0) failures.push("incomplete-external-runs");
    if (candidate.latencyMs.p90 > plan.eligibility.latencyP90Ms) failures.push("latency-p90");
    return {
      candidate: candidate.candidate,
      eligible: failures.length === 0,
      failures,
      passesAllExceptMinted:
        failures.length === 1 && failures[0] === "bucket-minted",
      rubricPass: rubricPasses.get(candidate.candidate) ?? false,
    };
  });
}

const QUALITY_TIE_BREAKS = [
  "organize.bucket_acceptance",
  "organize.bucket_acceptance_joined",
  "organize.bucket_acceptance_minted",
  "organize.thought_coverage",
  "organize.task_recall",
  "organize.task_precision",
] as const;
const ID_ORDER: CandidateManifest["id"][] = ["A", "A0", "B", "C"];

function winner(aggregates: CandidateAggregate[], traces: EligibilityTrace[]): CandidateAggregate | undefined {
  const eligibleIds = new Set(traces.filter((item) => item.eligible).map((item) => item.candidate));
  return aggregates
    .filter((item) => eligibleIds.has(item.candidate))
    .sort((left, right) => {
      for (const name of QUALITY_TIE_BREAKS) {
        const delta = metric(right, name) - metric(left, name);
        if (delta !== 0) return delta;
      }
      const latency = left.latencyMs.p90 - right.latencyMs.p90;
      if (latency !== 0) return latency;
      if (
        left.gatewayCost.perSuccessfulCaseUsd !== null &&
        right.gatewayCost.perSuccessfulCaseUsd !== null
      ) {
        const cost =
          left.gatewayCost.perSuccessfulCaseUsd - right.gatewayCost.perSuccessfulCaseUsd;
        if (cost !== 0) return cost;
      }
      return ID_ORDER.indexOf(left.candidate) - ID_ORDER.indexOf(right.candidate);
    })[0];
}

function delta(
  label: string,
  left: CandidateAggregate,
  right: CandidateAggregate,
): SelectionRecord["comparisons"][number] {
  const metricNames = new Set([...Object.keys(left.metrics), ...Object.keys(right.metrics)]);
  return {
    label,
    metricDeltas: Object.fromEntries(
      [...metricNames].sort().map((name) => [name, metric(right, name) - metric(left, name)]),
    ),
    latencyP90DeltaMs: right.latencyMs.p90 - left.latencyMs.p90,
  };
}

export function selectCandidate(options: {
  plan: ExperimentPlan;
  planSha256: string;
  aggregates: CandidateAggregate[];
  review: ContentFreeReview;
  reviewSha256: string;
  reviewMap: PrivateReviewMap;
  now?: () => Date;
}): SelectionRecord {
  expect(options.aggregates.length === options.plan.candidates.length, "Aggregate candidate count mismatch");
  const traces = eligibility(options.plan, options.aggregates, options.review, options.reviewMap);
  const mismatch = traces.some((item) => item.passesAllExceptMinted && item.rubricPass);
  const selected = mismatch ? undefined : winner(options.aggregates, traces);
  const byId = new Map(options.aggregates.map((item) => [item.candidate, item]));
  const comparisons = options.plan.comparisons.map((comparison) =>
    delta(
      `${comparison.left}-vs-${comparison.right}:${comparison.isolates}`,
      byId.get(comparison.left)!,
      byId.get(comparison.right)!,
    ),
  );
  return {
    schema: SELECTION_SCHEMA,
    spec: "6.6",
    planSha256: options.planSha256,
    selectedAt: (options.now ?? (() => new Date()))().toISOString(),
    tariffOutcome:
      options.plan.tariff.candidateC === "excluded"
        ? "C-excluded-no-authoritative-tariff"
        : "C-admitted",
    reports: options.aggregates,
    comparisons,
    eligibility: traces,
    outcome: mismatch
      ? { kind: "naming-measurement-mismatch" }
      : selected === undefined
        ? { kind: "none" }
        : { kind: "winner", candidate: selected.candidate },
    review: {
      rubricSha256: options.plan.rubric.sha256,
      packetSha256: options.review.packetSha256,
      reviewSha256: options.reviewSha256,
      diagnosticOnly: true,
    },
  };
}

export function validateContentFreeReview(review: ContentFreeReview): void {
  const keys = Object.keys(review).sort();
  expect(
    keys.join(",") ===
      "decisions,packetSha256,randomizationSha256,reviewedAt,reviewer,rubricSha256,rubricVersion,schema",
    "Committed review contains non-allowlisted fields",
  );
  for (const item of review.decisions) {
    expect(
      Object.keys(item).sort().join(",") === "decisions,itemId",
      "Review decision contains non-allowlisted fields",
    );
    expect(/^[a-f0-9]{24}$/.test(item.itemId), "Review item ID must be opaque");
    expect(
      Object.keys(item.decisions).sort().join(",") === [...RUBRIC_CRITERIA].sort().join(","),
      "Review decision criteria differ from immutable rubric",
    );
  }
}

export function buildBlindedReviewPacket(options: {
  planSha256: string;
  sources: PrivateMintedReviewSource[];
}): { packet: BlindedReviewPacket; map: PrivateReviewMap; randomizationSha256: string } {
  const withIds = options.sources.map((source) => ({
    source,
    itemId: sha256(
      `${options.planSha256}\0${source.candidate}\0${source.replicate}\0${source.caseId}`,
    ).slice(0, 24),
  }));
  expect(
    new Set(withIds.map((item) => item.itemId)).size === withIds.length,
    "Blinded review item IDs collided",
  );
  withIds.sort((left, right) =>
    sha256(`${options.planSha256}\0review-order\0${left.itemId}`).localeCompare(
      sha256(`${options.planSha256}\0review-order\0${right.itemId}`),
    ),
  );
  const emptyDecisions = (): Record<RubricCriterion, null> =>
    Object.fromEntries(RUBRIC_CRITERIA.map((criterion) => [criterion, null])) as Record<
      RubricCriterion,
      null
    >;
  return {
    packet: {
      schema: "donna.minted-name-review-packet.v1",
      rubricVersion: RUBRIC_VERSION,
      rubricSha256: rubricHash(),
      instructions:
        "For every randomized item, mark all five rubric decisions true or false. " +
        "Candidate, model, prompt, temperature, and expected labels are intentionally hidden. " +
        "This review is diagnostic and cannot change automatic scores.",
      items: withIds.map(({ source, itemId }) => ({
        itemId,
        thought: source.thought,
        mintedBucketName: source.mintedBucketName,
        existingBucketNames: [...source.existingBucketNames],
        decisions: emptyDecisions(),
      })),
    },
    map: {
      schema: "donna.minted-name-review-map.v1",
      planSha256: options.planSha256,
      items: withIds.map(({ source, itemId }) => ({
        itemId,
        candidate: source.candidate,
      })),
    },
    randomizationSha256: stableHash(withIds.map((item) => item.itemId)),
  };
}

export function validatePrivateDiagnosticEvidence(value: unknown): void {
  expect(value !== null && typeof value === "object", "Private diagnostic must be an object");
  const record = value as Record<string, unknown>;
  const allowed = [
    "schema",
    "createdAt",
    "consentCurrent",
    "participantInvoked",
    "views",
    "caseIds",
    "categoryTokens",
    "configSha256",
    "selectionSha256",
    "reportHashes",
  ];
  expect(
    Object.keys(record).every((key) => allowed.includes(key)),
    "Private diagnostic contains a forbidden top-level field",
  );
  expect(record.schema === PRIVATE_DIAGNOSTIC_SCHEMA, "Private diagnostic schema mismatch");
  expect(record.consentCurrent === true, "Private diagnostic requires current consent");
  expect(record.participantInvoked === true, "Private diagnostic requires participant invocation");
  const serialized = JSON.stringify(value);
  for (const forbidden of ["tenantId", "userId", "participantId", "transcript", "context", "sourceText", "bucketDescription"]) {
    expect(!serialized.includes(`"${forbidden}"`), `Private diagnostic contains forbidden field ${forbidden}`);
  }
}

function scenarioClass(meta: Record<string, unknown>): string | undefined {
  const notes = typeof meta.notes === "string" ? meta.notes : "";
  return notes.match(/(?:^|[;\s])scenario-class:([a-z-]+)/)?.[1];
}

function normalizedContentHash(payload: unknown): string {
  const record = payload as { transcript?: unknown };
  const transcript =
    typeof record.transcript === "string"
      ? record.transcript.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()
      : stable(payload);
  return sha256(transcript);
}

export async function validateFreshEnvelope(options: {
  freshPath: string;
  devPath: string;
  validationPath: string;
}): Promise<FreshEnvelopeSummary> {
  const [fresh, dev, validation] = await Promise.all([
    loadDataset(options.freshPath),
    loadDataset(options.devPath),
    loadDataset(options.validationPath),
  ]);
  const priorIds = new Set([...dev.cases, ...validation.cases].map((item) => item.id));
  const priorContent = new Set(
    [...dev.cases, ...validation.cases].map((item) => normalizedContentHash(item.payload)),
  );
  const byClass: Record<string, number> = {};
  let mintedCases = 0;
  for (const item of fresh.cases) {
    const klass = scenarioClass(item.meta as unknown as Record<string, unknown>);
    expect(klass !== undefined, `${item.id}: fresh case lacks scenario-class metadata`);
    byClass[klass] = (byClass[klass] ?? 0) + 1;
    const payload = item.payload as unknown as {
      expected?: { thoughts?: Array<{ bucketOrigin?: string }> };
    };
    if (payload.expected?.thoughts?.some((thought) => thought.bucketOrigin === "minted")) {
      mintedCases += 1;
    }
  }
  expect(fresh.cases.length >= 20, "Fresh envelope requires at least 20 cases");
  for (const klass of REQUIRED_CLASSES) {
    expect((byClass[klass] ?? 0) >= 2, `Fresh envelope requires at least 2 cases for ${klass}`);
  }
  expect(mintedCases > 0, "Fresh envelope requires a non-empty minted slice");
  const idOverlap = fresh.cases.some((item) => priorIds.has(item.id));
  const contentOverlap = fresh.cases.some((item) => priorContent.has(normalizedContentHash(item.payload)));
  expect(!idOverlap, "Fresh envelope case-ID overlap detected");
  expect(!contentOverlap, "Fresh envelope content overlap detected");
  return {
    total: fresh.cases.length,
    byClass,
    mintedCases,
    zeroIdOverlap: true,
    zeroContentOverlap: true,
  };
}

export async function assertNoFreshResults(resultsDir: string): Promise<void> {
  try {
    const entries = await readdir(resultsDir);
    expect(entries.length === 0, "Fresh envelope cannot freeze after a model result exists");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}

export function canRetryFreshFinal(report: EvalReport): boolean {
  return (
    report.aggregate.casesErrored > 0 &&
    report.aggregate.externalErrors === report.aggregate.casesErrored &&
    report.aggregate.productErrors === 0 &&
    report.aggregate.hardFailureCount === 0
  );
}

export async function assertOwnerOnly(path: string): Promise<void> {
  const details = await stat(path);
  if (process.platform !== "win32") {
    expect((details.mode & 0o077) === 0, "Private artifact is not owner-only");
  }
  await access(path);
}

export function metricMean(stats: MetricStats | undefined): number {
  return stats?.mean ?? 0;
}

export { REQUIRED_CLASSES };
