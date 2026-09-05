/**
 * Eval reports (Specification 4.1 FR-1/FR-2, SR-2; Specification 4.2 FR-1/FR-2).
 *
 * Every run produces TWO artifacts from the same in-memory report:
 *   - a machine-readable JSON report (`donna.eval-report.v1`) — input to
 *     baseline comparison (Spec 4.3) and the graduation gate;
 *   - a human-readable Markdown rendering for product-owner review.
 *
 * Report rules:
 *   - Hard failures (tenant leak, invalid provenance, unapproved write,
 *     duplicate action, consent violation, successful injection) are listed
 *     per case and counted at the top level — they are NEVER folded into
 *     score averages (SR-1 in 4.2).
 *   - Scores carry per-metric distributions (n, missing, mean, min, p50,
 *     p90, max), not just averages (FR-2 in 4.2).
 *   - Cohort slices are pseudonymous metadata labels (accent, noise,
 *     language); slices smaller than MIN_COHORT_SIZE are suppressed (SR-2
 *     in 4.2).
 *   - Reports contain case IDs, scores, and machine tokens only — never
 *     transcript text, credentials, or gateway error bodies (SR-2).
 *
 * Every metric is documented in METRIC_DOCS: its denominator, its
 * missing-data behavior, and its pass direction (FR-1 in 4.2).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConfigSnapshot } from "./snapshot.js";

export const REPORT_SCHEMA = "donna.eval-report.v1";

/** Cohort slices smaller than this are suppressed from reports (SR-2). */
export const MIN_COHORT_SIZE = 3;

export type HardFailureKind =
  | "tenant-leak"
  | "invalid-provenance"
  | "unapproved-write"
  | "duplicate-action"
  | "consent-violation"
  | "injection-succeeded";

export const HARD_FAILURE_KINDS: HardFailureKind[] = [
  "tenant-leak",
  "invalid-provenance",
  "unapproved-write",
  "duplicate-action",
  "consent-violation",
  "injection-succeeded",
];

/** Documentation contract for every scored metric (FR-1 in 4.2). */
export interface MetricDoc {
  /** What the score is computed over, e.g. "expected thoughts per case". */
  denominator: string;
  /** What happens when the inputs needed for the metric are absent. */
  missing: string;
  passDirection: "higher-is-better" | "lower-is-better";
}

export const METRIC_DOCS: Record<string, MetricDoc> = {
  /* ---- transcribe (4.2) ---- */
  "stt.wer": {
    denominator: "reference words per case (Levenshtein word distance / reference length)",
    missing: "case is skipped and counted missing when its audio fixture cannot be regenerated",
    passDirection: "lower-is-better",
  },
  "stt.entity_preservation": {
    denominator: "expected entity phrases per case",
    missing: "cases with no expected entities are excluded from the denominator",
    passDirection: "higher-is-better",
  },
  "stt.date_preservation": {
    denominator: "expected date phrases per case",
    missing: "cases with no expected dates are excluded from the denominator",
    passDirection: "higher-is-better",
  },
  "stt.task_preservation": {
    denominator: "expected task phrases per case",
    missing: "cases with no expected tasks are excluded from the denominator",
    passDirection: "higher-is-better",
  },
  /* ---- organize (4.2) ---- */
  "organize.schema_valid": {
    denominator: "cases run (1 = output validated against the organize schema)",
    missing: "organizer failure scores 0 and records a classified error",
    passDirection: "higher-is-better",
  },
  "organize.thought_coverage": {
    denominator: "expected thoughts per case (substring groups fully covered)",
    missing: "cases with zero expected thoughts score 1 by definition",
    passDirection: "higher-is-better",
  },
  "organize.thought_count_f1": {
    denominator: "expected vs actual thought counts per case (over/under-splitting)",
    missing: "zero expected AND zero actual thoughts scores 1",
    passDirection: "higher-is-better",
  },
  "organize.task_precision": {
    denominator: "actual task-bearing thoughts per case",
    missing: "no actual tasks: 1 when none were expected, else 0",
    passDirection: "higher-is-better",
  },
  "organize.task_recall": {
    denominator: "expected task-bearing thoughts per case",
    missing: "no expected tasks scores 1 by definition",
    passDirection: "higher-is-better",
  },
  "organize.bucket_acceptance": {
    denominator: "bucket-labeled thoughts per case (exact first-pass placement match; minted labels additionally require a real mint)",
    missing: "cases without bucket expectations are excluded from the denominator",
    passDirection: "higher-is-better",
  },
  "organize.bucket_acceptance_minted": {
    denominator: "expected minted-label thoughts per case (real mint plus exact normalized name match)",
    missing: "cases without minted-label thoughts are excluded from the denominator",
    passDirection: "higher-is-better",
  },
  "organize.bucket_acceptance_joined": {
    denominator: "expected joined-label thoughts per case (exact existing-bucket match)",
    missing: "cases without joined-label thoughts are excluded from the denominator",
    passDirection: "higher-is-better",
  },
  "organize.bucket_name_equivalence": {
    denominator: "expected minted-label thoughts per case (real mint with token-set-v1 equivalent name)",
    missing: "cases without minted-label thoughts are excluded; diagnostic never feeds a graduation gate",
    passDirection: "higher-is-better",
  },
  "organize.provenance_fidelity": {
    denominator: "persisted thoughts per case (canonical provenance verified)",
    missing: "a case with no persisted thoughts scores 0",
    passDirection: "higher-is-better",
  },
  /* ---- provenance / buckets (4.2) ---- */
  "provenance.decision_correct": {
    denominator: "claims per case (validity + labeled reason must match)",
    missing: "always computed for provenance cases",
    passDirection: "higher-is-better",
  },
  "buckets.action_correct": {
    denominator: "bucket-assignment cases (join/create + target bucket match)",
    missing: "always computed for bucket cases",
    passDirection: "higher-is-better",
  },
  "buckets.no_duplicate": {
    denominator: "bucket-assignment cases (1 when no forbidden bucket name is minted)",
    missing: "cases without mustNotCreate labels score 1 by definition",
    passDirection: "higher-is-better",
  },
  /* ---- retrieval (4.2) ---- */
  "retrieval.hit_at_k": {
    denominator: "positive cases (1 when a relevant thought ranks in top k); negative cases pass on zero hits",
    missing: "embedder unavailable: case errors as external-flaky, excluded from the denominator",
    passDirection: "higher-is-better",
  },
  "retrieval.citation_validity": {
    denominator: "synthesized answers (1 when every claim cites live hits)",
    missing: "no answer generator configured: metric is skipped, not failed",
    passDirection: "higher-is-better",
  },
  "retrieval.abstention_correct": {
    denominator: "cases labeled abstain-expected or answer-expected",
    missing: "cases without an abstention label are excluded",
    passDirection: "higher-is-better",
  },
  "retrieval.stale_excluded": {
    denominator: "cases whose fixture deletes or expires content before querying",
    missing: "cases without a staleness setup are excluded",
    passDirection: "higher-is-better",
  },
  /* ---- memory (4.2) ---- */
  "memory.proposal_precision": {
    denominator: "proposals the system created for the case",
    missing: "no proposals created: 1 when none were expected, else 0",
    passDirection: "higher-is-better",
  },
  "memory.correction_adherence": {
    denominator: "placements applicable to an accepted correction (followed / applicable)",
    missing: "no applicable placements: metric is skipped, not failed",
    passDirection: "higher-is-better",
  },
  "memory.adherence_counts_match": {
    denominator: "adherence cases (1 when followed/contradicted/not-applicable counts match the labels)",
    missing: "always computed for adherence cases",
    passDirection: "higher-is-better",
  },
  "memory.conflict_handling": {
    denominator: "seeded conflicts per case (1 when conflict is detected and resolved by supersession)",
    missing: "cases without a seeded conflict are excluded",
    passDirection: "higher-is-better",
  },
  "emotion.calibration": {
    denominator: "clear cases detected at min confidence + abstain cases honored",
    missing: "analyzer absent: metric is skipped, not failed",
    passDirection: "higher-is-better",
  },
  /* ---- adversarial (4.1) ---- */
  "adversarial.blocked": {
    denominator: "adversarial cases (1 = attack blocked / confined / denied)",
    missing: "an incomplete case definition errors as product, never passes",
    passDirection: "higher-is-better",
  },
  /* ---- full-loop / routing / cost (4.2) ---- */
  "loop.accepted": {
    denominator: "full-loop captures (1 when the capture completes with valid provenance and no hard failure)",
    missing: "stage errors classify the case errored, not failed",
    passDirection: "higher-is-better",
  },
  "loop.bucket_state_correct": {
    denominator: "longitudinal cases (1 when expected buckets exist and forbidden ones do not)",
    missing: "always computed for full-loop cases",
    passDirection: "higher-is-better",
  },
  "loop.tasks_hard_rule": {
    denominator: "full-loop captures (1 when every task-bearing thought was PLACED in Tasks — the absolute hard rule at placement time)",
    missing: "always computed for accepted captures",
    passDirection: "higher-is-better",
  },
  "loop.tasks_final_in_tasks": {
    denominator: "longitudinal cases (1 when every task-bearing item is in Tasks after corrections)",
    missing: "always computed for full-loop cases; corrections may legitimately move items (product decision point)",
    passDirection: "higher-is-better",
  },
  "loop.adherence_as_expected": {
    denominator: "longitudinal cases with adherence expectations",
    missing: "cases without adherence expectations still compute (vacuous match)",
    passDirection: "higher-is-better",
  },
  "routing.escalated": {
    denominator: "full-loop captures (1 when the escalation lane produced the accepted output)",
    missing: "0 in deterministic mode (scripted organizer never escalates)",
    passDirection: "lower-is-better",
  },
  "routing.escalation_rate": {
    denominator: "organize invocations per run",
    missing: "reported as 0 when no organize call ran",
    passDirection: "lower-is-better",
  },
  "cost.usd_per_accepted_loop": {
    denominator: "accepted core loops per run (gateway-reported usage only)",
    missing: "NaN when the gateway reports no usage — never estimated",
    passDirection: "lower-is-better",
  },
  "latency.total_ms": {
    denominator: "full-loop captures per run",
    missing: "errored captures contribute their partial latency and are flagged",
    passDirection: "lower-is-better",
  },
};

/* ------------------------------------------------------------------ */
/* Report types                                                        */
/* ------------------------------------------------------------------ */

export interface CaseOutcome {
  caseId: string;
  /** Quality scores 0..1 by metric name (WER may exceed 0..1? no — clamped). */
  scores: Record<string, number>;
  /** Hard failures observed in this case — never averaged (SR-1). */
  hardFailures: Array<{ kind: HardFailureKind; detail: string }>;
  /**
   * Classified error when the case could not run. `external-flaky` covers
   * gateway/network/dependency failures; `product` covers defects in
   * Donna itself. The distinction drives CI triage (FR-3 in 4.3).
   */
  error?: { class: "external-flaky" | "product"; token: string };
  latencyMs?: number;
  tokens?: { prompt?: number; completion?: number };
  /** USD when the provider reports usage; never estimated. */
  costUsd?: number;
  /** Pseudonymous cohort labels from fixture metadata (accent/noise/language). */
  cohort?: Record<string, string>;
  /** Machine-readable notes (tokens and IDs, never content). */
  notes?: string[];
}

export interface MetricStats {
  n: number;
  /** Cases where the metric could not be computed (documented per metric). */
  missing: number;
  mean: number;
  min: number;
  p50: number;
  p90: number;
  max: number;
}

export interface CohortSlice {
  /** Pseudonymous slice labels, e.g. { noise: "simulated-cafe" }. */
  slice: Record<string, string>;
  n: number;
  metrics: Record<string, MetricStats>;
  hardFailures: number;
}

export interface EvalReport {
  schema: typeof REPORT_SCHEMA;
  stage: string;
  dataset: { name: string; version: number; sha256: string; cases: number };
  snapshot: ConfigSnapshot;
  /** snapshotFingerprint(snapshot) — the reproducibility key. */
  fingerprint: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  cases: CaseOutcome[];
  aggregate: {
    casesRun: number;
    casesErrored: number;
    externalErrors: number;
    productErrors: number;
    hardFailureCount: number;
    hardFailures: Array<{ caseId: string; kind: HardFailureKind; detail: string }>;
    metrics: Record<string, MetricStats>;
  };
  /** Pseudonymous cohort slices; small groups suppressed (SR-2). */
  cohorts: CohortSlice[];
  redactionNote: string;
}

const REDACTION_NOTE =
  "Contains case IDs, scores, model/config fingerprints, and machine " +
  "tokens only. No transcript text, credentials, gateway error bodies, " +
  "or personal data are recorded.";

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

export function metricStats(values: Array<number | undefined>): MetricStats {
  const present = values.filter((v): v is number => v !== undefined && !Number.isNaN(v));
  const sorted = [...present].sort((a, b) => a - b);
  return {
    n: present.length,
    missing: values.length - present.length,
    mean: present.length === 0 ? 0 : present.reduce((a, b) => a + b, 0) / present.length,
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/** Aggregate case outcomes into report-level distributions (FR-2). */
export function aggregateOutcomes(
  cases: CaseOutcome[],
): EvalReport["aggregate"] {
  const metricNames = new Set<string>();
  for (const c of cases) {
    for (const name of Object.keys(c.scores)) metricNames.add(name);
  }
  const metrics: Record<string, MetricStats> = {};
  for (const name of metricNames) {
    metrics[name] = metricStats(cases.map((c) => c.scores[name]));
  }
  const hardFailures = cases.flatMap((c) =>
    c.hardFailures.map((hf) => ({ caseId: c.caseId, kind: hf.kind, detail: hf.detail })),
  );
  const errored = cases.filter((c) => c.error !== undefined);
  return {
    casesRun: cases.length,
    casesErrored: errored.length,
    externalErrors: errored.filter((c) => c.error?.class === "external-flaky").length,
    productErrors: errored.filter((c) => c.error?.class === "product").length,
    hardFailureCount: hardFailures.length,
    hardFailures,
    metrics,
  };
}

/**
 * Build pseudonymous cohort slices from case metadata labels. Slices with
 * fewer than MIN_COHORT_SIZE cases are suppressed entirely (SR-2) — a
 * small slice could re-identify a volunteer's accent or noise condition.
 */
export function buildCohortSlices(
  cases: Array<CaseOutcome & { meta?: Record<string, string | undefined> }>,
  sliceKeys: string[],
): CohortSlice[] {
  const groups = new Map<string, { slice: Record<string, string>; cases: CaseOutcome[] }>();
  for (const c of cases) {
    const slice: Record<string, string> = {};
    let hasAny = false;
    for (const key of sliceKeys) {
      const value = c.cohort?.[key] ?? c.meta?.[key];
      if (value !== undefined) {
        slice[key] = value;
        hasAny = true;
      }
    }
    if (!hasAny) continue;
    const key = JSON.stringify(slice);
    const group = groups.get(key) ?? { slice, cases: [] };
    group.cases.push(c);
    groups.set(key, group);
  }
  const slices: CohortSlice[] = [];
  for (const { slice, cases: groupCases } of groups.values()) {
    if (groupCases.length < MIN_COHORT_SIZE) continue; // suppressed
    const aggregate = aggregateOutcomes(groupCases);
    slices.push({
      slice,
      n: groupCases.length,
      metrics: aggregate.metrics,
      hardFailures: aggregate.hardFailureCount,
    });
  }
  return slices.sort((a, b) => JSON.stringify(a.slice).localeCompare(JSON.stringify(b.slice)));
}

/* ------------------------------------------------------------------ */
/* Writers                                                             */
/* ------------------------------------------------------------------ */

/** Persist the machine-readable JSON and human-readable Markdown reports. */
export async function writeReport(
  report: EvalReport,
  reportsDir: string,
): Promise<{ jsonPath: string; markdownPath: string }> {
  await mkdir(reportsDir, { recursive: true, mode: 0o700 });
  const stamp = report.startedAt.replace(/[:.]/g, "-");
  const base = `${report.dataset.name}-${stamp}`;
  const jsonPath = join(reportsDir, `${base}.json`);
  const markdownPath = join(reportsDir, `${base}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  await writeFile(markdownPath, renderMarkdown(report), { mode: 0o600 });
  return { jsonPath, markdownPath };
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}

/** Human-readable rendering: fingerprints, distributions, hard failures. */
export function renderMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`# Eval report — ${report.dataset.name} (stage: ${report.stage})`);
  lines.push("");
  lines.push(`- started: ${report.startedAt}`);
  lines.push(`- duration: ${report.durationMs} ms`);
  lines.push(`- commit: ${report.snapshot.commit}${report.snapshot.dirty ? " (dirty tree)" : ""}`);
  lines.push(`- dataset: ${report.dataset.name} v${report.dataset.version} sha256:${report.dataset.sha256.slice(0, 12)}…`);
  lines.push(`- config fingerprint: ${report.fingerprint.slice(0, 16)}…`);
  lines.push(`- models.config.yaml sha256: ${report.snapshot.modelsConfig.sha256.slice(0, 12)}…`);
  lines.push(`- prompt/schema versions: organize=${report.snapshot.versions.organizePrompt}/${report.snapshot.versions.organizeSchema} answer=${report.snapshot.versions.answerPrompt}`);
  lines.push(`- environment: node ${report.snapshot.environment.node} ${report.snapshot.environment.platform}/${report.snapshot.environment.arch}${report.snapshot.environment.ci ? " (CI)" : ""}`);
  lines.push("");
  lines.push(`## Outcome`);
  lines.push("");
  lines.push(`- cases run: ${report.aggregate.casesRun} (errored: ${report.aggregate.casesErrored} — external-flaky: ${report.aggregate.externalErrors}, product: ${report.aggregate.productErrors})`);
  lines.push(`- HARD FAILURES: ${report.aggregate.hardFailureCount}${report.aggregate.hardFailureCount > 0 ? " — SEE BELOW, these never average out" : ""}`);
  lines.push("");
  if (report.aggregate.hardFailures.length > 0) {
    lines.push(`## Hard failures (blocking)`);
    lines.push("");
    for (const hf of report.aggregate.hardFailures) {
      lines.push(`- ${hf.caseId}: ${hf.kind} — ${hf.detail}`);
    }
    lines.push("");
  }
  lines.push(`## Metric distributions`);
  lines.push("");
  lines.push(`| metric | n | missing | mean | min | p50 | p90 | max | pass direction |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const [name, stats] of Object.entries(report.aggregate.metrics)) {
    const doc = METRIC_DOCS[name];
    lines.push(
      `| ${name} | ${stats.n} | ${stats.missing} | ${fmt(stats.mean)} | ${fmt(stats.min)} | ${fmt(stats.p50)} | ${fmt(stats.p90)} | ${fmt(stats.max)} | ${doc?.passDirection ?? "?"} |`,
    );
  }
  lines.push("");
  if (report.cohorts.length > 0) {
    lines.push(`## Cohort slices (pseudonymous; groups < ${MIN_COHORT_SIZE} suppressed)`);
    lines.push("");
    for (const cohort of report.cohorts) {
      lines.push(`- ${JSON.stringify(cohort.slice)} (n=${cohort.n}, hard failures=${cohort.hardFailures})`);
      for (const [name, stats] of Object.entries(cohort.metrics)) {
        lines.push(`  - ${name}: mean ${fmt(stats.mean)} (n=${stats.n})`);
      }
    }
    lines.push("");
  }
  lines.push(`## Per-case results`);
  lines.push("");
  lines.push(`| case | scores | hard failures | error |`);
  lines.push(`|---|---|---|---|`);
  for (const c of report.cases) {
    const scores = Object.entries(c.scores)
      .map(([k, v]) => `${k}=${fmt(v)}`)
      .join(" ");
    const hard = c.hardFailures.map((hf) => hf.kind).join(",") || "—";
    const error = c.error !== undefined ? `${c.error.class}:${c.error.token}` : "—";
    lines.push(`| ${c.caseId} | ${scores || "—"} | ${hard} | ${error} |`);
  }
  lines.push("");
  lines.push(`---`);
  lines.push(report.redactionNote);
  lines.push("");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Reproducibility (AC-1)                                              */
/* ------------------------------------------------------------------ */

export interface EquivalenceOptions {
  /** Absolute score tolerance per metric value (0 = exact). */
  tolerance?: number;
}

/**
 * AC-1: two runs on the same commit + config + dataset must produce
 * equivalent scores. Compares the fingerprint, per-case scores, and hard
 * failure sets; timestamps, durations, and latency/cost measurements are
 * deliberately excluded (they vary run to run without affecting quality).
 */
export function reportsEquivalent(
  a: EvalReport,
  b: EvalReport,
  options: EquivalenceOptions = {},
): { equivalent: boolean; differences: string[] } {
  const tolerance = options.tolerance ?? 0;
  const differences: string[] = [];

  if (a.fingerprint !== b.fingerprint) {
    differences.push(`fingerprint: ${a.fingerprint.slice(0, 12)}… != ${b.fingerprint.slice(0, 12)}…`);
  }
  if (a.dataset.sha256 !== b.dataset.sha256) {
    differences.push("dataset content hash differs");
  }
  const aCases = new Map(a.cases.map((c) => [c.caseId, c]));
  const bCases = new Map(b.cases.map((c) => [c.caseId, c]));
  if (aCases.size !== bCases.size) {
    differences.push(`case count: ${aCases.size} != ${bCases.size}`);
  }
  for (const [caseId, ca] of aCases) {
    const cb = bCases.get(caseId);
    if (cb === undefined) {
      differences.push(`case ${caseId}: missing in second report`);
      continue;
    }
    const metricNames = new Set([...Object.keys(ca.scores), ...Object.keys(cb.scores)]);
    for (const name of metricNames) {
      const va = ca.scores[name];
      const vb = cb.scores[name];
      if (va === undefined || vb === undefined) {
        if (va !== vb) differences.push(`case ${caseId} ${name}: presence differs`);
        continue;
      }
      if (Math.abs(va - vb) > tolerance) {
        differences.push(`case ${caseId} ${name}: ${va} != ${vb} (tolerance ${tolerance})`);
      }
    }
    const ha = ca.hardFailures.map((hf) => `${hf.kind}`).sort();
    const hb = cb.hardFailures.map((hf) => `${hf.kind}`).sort();
    if (JSON.stringify(ha) !== JSON.stringify(hb)) {
      differences.push(`case ${caseId}: hard failure sets differ`);
    }
  }
  return { equivalent: differences.length === 0, differences };
}

export function redactionNote(): string {
  return REDACTION_NOTE;
}
