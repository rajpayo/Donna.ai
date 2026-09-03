/**
 * Graduation report (Specification 4.3): the locked CLI-pilot gates from
 * DECISIONS.md, checked against a set of eval reports, producing an
 * explicit, reviewable decision document.
 *
 * The locked gates:
 *   - atomic-thought coverage ≥ 95%      (organize.thought_coverage)
 *   - task recall ≥ 95%                  (organize.task_recall)
 *   - first-pass bucket acceptance ≥ 85% (organize.bucket_acceptance)
 *   - valid provenance 100%              (organize.provenance_fidelity = 1
 *                                         AND zero invalid-provenance
 *                                         hard failures anywhere)
 *   - retrieval success ≥ 80%            (retrieval.hit_at_k)
 *   - zero tenant-isolation failures     (tenant-leak hard failures = 0)
 *   - zero duplicate external actions    (duplicate-action hard failures = 0)
 *
 * The report LINKS its evidence (report file paths + fingerprints) and
 * records the product owner's decision as PENDING — metrics never
 * auto-graduate the pilot (the sign-off is manual by design).
 */
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadReport } from "./compare.js";
import {
  MIN_COHORT_SIZE,
  type EvalReport,
  type HardFailureKind,
  type MetricStats,
} from "./report.js";
import type { ConfigSnapshot } from "./snapshot.js";

export const GRADUATION_SCHEMA = "donna.graduation-gate.v1";

export interface GateCheck {
  gate: string;
  threshold: string;
  /** Measured value (1 = 100%); null when the required evidence is absent. */
  measured: number | null;
  passed: boolean;
  /** Report paths whose metrics/hard-failure lists fed this gate. */
  evidence: string[];
  note?: string;
}

export interface GraduationReport {
  schema: typeof GRADUATION_SCHEMA;
  generatedAt: string;
  /** Every gate passed — the metrics side only. Sign-off stays manual. */
  allGatesPassed: boolean;
  gates: GateCheck[];
  /** Hard failures seen across all evidence, by kind. */
  hardFailures: Record<HardFailureKind, number>;
  /** Fingerprints of the evidence reports (reproducibility links). */
  evidenceReports: Array<{
    path: string;
    stage: string;
    dataset: string;
    fingerprint: string;
    commit: string;
  }>;
  /** Always "pending" — the product owner accepts or rejects by hand. */
  productOwnerSignOff: "pending";
  signOffNote: string;
}

const SIGN_OFF_NOTE =
  "Metrics never auto-graduate the CLI pilot. The product owner reviews " +
  "this report and its linked evidence, then records accept/reject by hand " +
  "(Phase 6 unlocks only on explicit acceptance).";

function metricMean(report: EvalReport, metric: string): number | null {
  const stats = report.aggregate.metrics[metric];
  return stats === undefined || stats.n === 0 ? null : stats.mean;
}

function hardFailureCount(
  reports: EvalReport[],
  kind: HardFailureKind,
): number {
  return reports.reduce(
    (sum, r) => sum + r.aggregate.hardFailures.filter((hf) => hf.kind === kind).length,
    0,
  );
}

/**
 * Build the graduation report from a set of eval reports. `evidence` maps
 * report file paths to their parsed reports (paths are recorded as the
 * reviewable links).
 */
export function buildGraduationReport(
  evidence: Array<{ path: string; report: EvalReport }>,
  now: () => Date = () => new Date(),
): GraduationReport {
  const byStage = new Map<string, Array<{ path: string; report: EvalReport }>>();
  for (const entry of evidence) {
    const list = byStage.get(entry.report.stage) ?? [];
    list.push(entry);
    byStage.set(entry.report.stage, list);
  }
  const reports = evidence.map((e) => e.report);

  /** Best (most recent) value for a metric across a stage's reports. */
  function stageMetric(stage: string, metric: string): { value: number | null; paths: string[] } {
    const stageReports = byStage.get(stage) ?? [];
    const paths = stageReports.map((e) => e.path);
    for (const entry of [...stageReports].reverse()) {
      const value = metricMean(entry.report, metric);
      if (value !== null) return { value, paths };
    }
    return { value: null, paths };
  }

  const gates: GateCheck[] = [];

  const coverage = stageMetric("organize", "organize.thought_coverage");
  gates.push({
    gate: "atomic-thought coverage ≥ 95%",
    threshold: ">=0.95",
    measured: coverage.value,
    passed: coverage.value !== null && coverage.value >= 0.95,
    evidence: coverage.paths,
    ...(coverage.value === null ? { note: "no organize evidence" } : {}),
  });

  const taskRecall = stageMetric("organize", "organize.task_recall");
  gates.push({
    gate: "task recall ≥ 95%",
    threshold: ">=0.95",
    measured: taskRecall.value,
    passed: taskRecall.value !== null && taskRecall.value >= 0.95,
    evidence: taskRecall.paths,
    ...(taskRecall.value === null ? { note: "no organize evidence" } : {}),
  });

  const acceptance = stageMetric("organize", "organize.bucket_acceptance");
  gates.push({
    gate: "first-pass bucket acceptance ≥ 85%",
    threshold: ">=0.85",
    measured: acceptance.value,
    passed: acceptance.value !== null && acceptance.value >= 0.85,
    evidence: acceptance.paths,
    ...(acceptance.value === null ? { note: "no organize evidence" } : {}),
  });

  const fidelity = stageMetric("organize", "organize.provenance_fidelity");
  const provenanceHardFailures = hardFailureCount(reports, "invalid-provenance");
  const provenancePassed =
    fidelity.value !== null && fidelity.value === 1 && provenanceHardFailures === 0;
  gates.push({
    gate: "valid provenance 100%",
    threshold: "=1.0 and zero invalid-provenance hard failures",
    measured: fidelity.value,
    passed: provenancePassed,
    evidence: fidelity.paths,
    note:
      provenanceHardFailures > 0
        ? `${provenanceHardFailures} invalid-provenance hard failure(s)`
        : fidelity.value === null
          ? "no organize evidence"
          : "all persisted thoughts carry canonical provenance",
  });

  const retrieval = stageMetric("retrieval", "retrieval.hit_at_k");
  gates.push({
    gate: "retrieval success ≥ 80%",
    threshold: ">=0.80",
    measured: retrieval.value,
    passed: retrieval.value !== null && retrieval.value >= 0.8,
    evidence: retrieval.paths,
    ...(retrieval.value === null ? { note: "no retrieval evidence" } : {}),
  });

  const tenantLeaks = hardFailureCount(reports, "tenant-leak");
  gates.push({
    gate: "zero tenant-isolation failures",
    threshold: "=0 hard failures",
    measured: tenantLeaks,
    passed: tenantLeaks === 0,
    evidence: evidence.map((e) => e.path),
  });

  const duplicateActions = hardFailureCount(reports, "duplicate-action");
  gates.push({
    gate: "zero duplicate external actions",
    threshold: "=0 hard failures",
    measured: duplicateActions,
    passed: duplicateActions === 0,
    evidence: evidence.map((e) => e.path),
    note: "no external action layer exists yet; the gate watches for its arrival",
  });

  const hardFailures: Record<HardFailureKind, number> = {
    "tenant-leak": tenantLeaks,
    "invalid-provenance": provenanceHardFailures,
    "unapproved-write": hardFailureCount(reports, "unapproved-write"),
    "duplicate-action": duplicateActions,
    "consent-violation": hardFailureCount(reports, "consent-violation"),
    "injection-succeeded": hardFailureCount(reports, "injection-succeeded"),
  };

  return {
    schema: GRADUATION_SCHEMA,
    generatedAt: now().toISOString(),
    allGatesPassed: gates.every((g) => g.passed),
    gates,
    hardFailures,
    evidenceReports: evidence.map((e) => ({
      path: e.path,
      stage: e.report.stage,
      dataset: `${e.report.dataset.name} v${e.report.dataset.version}`,
      fingerprint: e.report.fingerprint,
      commit: e.report.snapshot.commit,
    })),
    productOwnerSignOff: "pending",
    signOffNote: SIGN_OFF_NOTE,
  };
}

/** Load reports from paths and build the graduation report. */
export async function graduationFromPaths(
  paths: string[],
  now?: () => Date,
): Promise<GraduationReport> {
  const evidence = [];
  for (const path of paths) {
    evidence.push({ path, report: await loadReport(path) });
  }
  return buildGraduationReport(evidence, now);
}

/** Human-readable rendering for the product owner's review. */
export function renderGraduationMarkdown(report: GraduationReport): string {
  const lines: string[] = [];
  lines.push(`# CLI pilot graduation report`);
  lines.push("");
  lines.push(`- generated: ${report.generatedAt}`);
  lines.push(`- all gates passed (metrics side): **${report.allGatesPassed ? "YES" : "NO"}**`);
  lines.push(`- product-owner sign-off: **${report.productOwnerSignOff.toUpperCase()}** (manual — never automatic)`);
  lines.push("");
  lines.push(`## Gates`);
  lines.push("");
  lines.push(`| gate | measured | threshold | result |`);
  lines.push(`|---|---|---|---|`);
  for (const gate of report.gates) {
    const measured = gate.measured === null ? "no evidence" : Number.isInteger(gate.measured) ? String(gate.measured) : gate.measured.toFixed(4);
    lines.push(`| ${gate.gate} | ${measured} | ${gate.threshold} | ${gate.passed ? "PASS" : "FAIL"} |`);
  }
  lines.push("");
  lines.push(`## Hard failures across evidence`);
  lines.push("");
  for (const [kind, count] of Object.entries(report.hardFailures)) {
    lines.push(`- ${kind}: ${count}`);
  }
  lines.push("");
  lines.push(`## Evidence`);
  lines.push("");
  for (const e of report.evidenceReports) {
    lines.push(`- ${e.stage} — ${e.dataset} — commit ${e.commit.slice(0, 8)} — fingerprint ${e.fingerprint.slice(0, 12)}… — \`${e.path}\``);
  }
  lines.push("");
  lines.push(`---`);
  lines.push(report.signOffNote);
  lines.push("");
  return lines.join("\n");
}

/** Persist the graduation report (JSON + Markdown). */
export async function writeGraduationReport(
  report: GraduationReport,
  dir: string,
): Promise<{ jsonPath: string; markdownPath: string }> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = join(dir, `graduation-${stamp}.json`);
  const markdownPath = join(dir, `graduation-${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  await writeFile(markdownPath, renderGraduationMarkdown(report), { mode: 0o600 });
  return { jsonPath, markdownPath };
}

/* ================================================================== */
/* Specification 6.3 — measured graduation decision                    */
/* ================================================================== */

/**
 * The v2 graduation report adds the candidate freeze, full quality
 * distributions, cohort slices, latency/cost, pilot extras (correction
 * trends, misfire board, retention verification, privacy incidents), and
 * the decision block. v1 gate semantics are unchanged: hard failures
 * force rejection and product-owner sign-off stays manual.
 */
export const GRADUATION_RUNNER_SCHEMA = "donna.graduation-runner.v1";

/** The frozen candidate under evaluation (Spec 6.3 FR-1/FR-2). */
export interface GraduationFreeze {
  frozenAt: string;
  commit: string;
  branch: string;
  dirty: boolean;
  modelsConfigSha256: string;
  promptVersions: {
    organizePrompt: string;
    organizeSchema: string;
    answerPrompt: string;
    emotionAnalyzer: string;
  };
  /** Dataset name/version/content-hash per evidence stage. */
  datasets: Array<{ stage: string; name: string; version: number; sha256: string }>;
  /** Pseudonymous pilot cohort window, when the pilot ran. */
  cohortWindow: { start: string; end: string } | null;
}

/** Pilot-operational inputs the runner cannot compute from eval reports. */
export interface GraduationExtras {
  correctionTrends?: {
    scopes: number;
    total: number;
    pending: number;
    accepted: number;
    rejected: number;
    followed: number;
    contradicted: number;
    adherenceRate: number | null;
  };
  misfireBoard?: {
    total: number;
    byCategory: Record<string, number>;
    byDisposition: Record<string, number>;
    unresolved: number;
    blocksGraduation: number;
    promotedGoldenCases: number;
  };
  retention?: {
    verifiedAt: string;
    scopes: number;
    capturesScanned: number;
    audioRetained: number;
    transcriptOnly: number;
    /** Audio retained past the 7-day policy — must be zero. */
    policyViolations: number;
  };
  /** Privacy incidents observed during the window (0 expected). */
  privacyIncidents?: { count: number; notes: string[] };
  /** Known limitations, each naming affected users/workflows (FR-3). */
  limitations?: string[];
}

export interface GraduationDecision {
  /** "eligible" only when every gate passes and no blocker exists. */
  verdict: "eligible-for-signoff" | "rejected";
  /** Every reason the verdict is not eligible (empty when eligible). */
  reasons: string[];
  /** Manual — the product owner signs against reportHash. */
  productOwnerSignOff: "pending";
}

export interface GraduationReportV2 {
  schema: typeof GRADUATION_RUNNER_SCHEMA;
  generatedAt: string;
  freeze: GraduationFreeze;
  /** The v1 gate evaluation, embedded whole. */
  gates: GateCheck[];
  allGatesPassed: boolean;
  hardFailures: Record<HardFailureKind, number>;
  evidenceReports: GraduationReport["evidenceReports"];
  /** Quality distributions per stage (n/missing/mean/min/p50/p90/max). */
  quality: Record<string, Record<string, MetricStats>>;
  /** Merged cohort slices from evidence (small groups already suppressed). */
  cohorts: Array<{ stage: string; slice: Record<string, string>; n: number; hardFailures: number; metrics: Record<string, MetricStats> }>;
  latencyCost: {
    latencyTotalMs: MetricStats | null;
    costUsdPerAcceptedLoop: MetricStats | null;
    totalTokens: { prompt: number; completion: number };
    costNote: string;
  };
  extras: GraduationExtras;
  decision: GraduationDecision;
  /** SHA-256 over the canonical report content (excluding this field). */
  reportHash: string;
  signOffNote: string;
}

const V2_SIGN_OFF_NOTE =
  "Decision aid only — graduation never happens from metrics alone. The " +
  "product owner reviews this report and its linked evidence, then records " +
  "accept/reject in the decision record (docs/pilot/) against the report " +
  "hash. Any tenant leak, invalid provenance, unapproved mutation, " +
  "duplicate action, privacy incident, or unresolved graduation blocker " +
  "forces rejection regardless of averages.";

/**
 * Build the v2 graduation report. Pure: the candidate snapshot and pilot
 * extras are inputs gathered by the caller (the evals CLI gathers the
 * snapshot; the pilot CLI exports extras from live scoped stores).
 */
export function buildGraduationReportV2(
  evidence: Array<{ path: string; report: EvalReport }>,
  inputs: {
    snapshot: ConfigSnapshot;
    cohortWindow?: { start: string; end: string };
    extras?: GraduationExtras;
    now?: () => Date;
  },
): GraduationReportV2 {
  const now = inputs.now ?? (() => new Date());
  const base = buildGraduationReport(evidence, now);

  const quality: GraduationReportV2["quality"] = {};
  const cohorts: GraduationReportV2["cohorts"] = [];
  for (const { report } of evidence) {
    quality[report.stage] = report.aggregate.metrics;
    for (const cohort of report.cohorts) {
      cohorts.push({ stage: report.stage, ...cohort });
    }
  }

  const fullLoop = [...evidence].reverse().find((e) => e.report.stage === "full-loop");
  const latency = fullLoop?.report.aggregate.metrics["latency.total_ms"] ?? null;
  const cost = fullLoop?.report.aggregate.metrics["cost.usd_per_accepted_loop"] ?? null;
  let promptTokens = 0;
  let completionTokens = 0;
  for (const { report } of evidence) {
    for (const c of report.cases) {
      promptTokens += c.tokens?.prompt ?? 0;
      completionTokens += c.tokens?.completion ?? 0;
    }
  }

  const extras = inputs.extras ?? {};
  const reasons: string[] = [];
  for (const gate of base.gates) {
    if (!gate.passed) {
      reasons.push(`gate failed: ${gate.gate} (measured ${gate.measured === null ? "no evidence" : gate.measured}, threshold ${gate.threshold})`);
    }
  }
  // SR-1: these hard failures force rejection even if a gate were lenient.
  for (const kind of ["tenant-leak", "invalid-provenance", "unapproved-write", "duplicate-action"] as const) {
    if (base.hardFailures[kind] > 0) {
      reasons.push(`hard failure: ${base.hardFailures[kind]} ${kind}`);
    }
  }
  if ((extras.privacyIncidents?.count ?? 0) > 0) {
    reasons.push(`privacy incidents: ${extras.privacyIncidents!.count}`);
  }
  if ((extras.misfireBoard?.blocksGraduation ?? 0) > 0) {
    reasons.push(`unresolved graduation-blocking misfires: ${extras.misfireBoard!.blocksGraduation}`);
  }
  if ((extras.retention?.policyViolations ?? 0) > 0) {
    reasons.push(`retention policy violations: ${extras.retention!.policyViolations}`);
  }

  const report: Omit<GraduationReportV2, "reportHash"> = {
    schema: GRADUATION_RUNNER_SCHEMA,
    generatedAt: base.generatedAt,
    freeze: {
      frozenAt: base.generatedAt,
      commit: inputs.snapshot.commit,
      branch: inputs.snapshot.branch,
      dirty: inputs.snapshot.dirty,
      modelsConfigSha256: inputs.snapshot.modelsConfig.sha256,
      promptVersions: { ...inputs.snapshot.versions },
      datasets: evidence.map((e) => ({
        stage: e.report.stage,
        name: e.report.dataset.name,
        version: e.report.dataset.version,
        sha256: e.report.dataset.sha256,
      })),
      cohortWindow: inputs.cohortWindow ?? null,
    },
    gates: base.gates,
    allGatesPassed: base.allGatesPassed,
    hardFailures: base.hardFailures,
    evidenceReports: base.evidenceReports,
    quality,
    cohorts,
    latencyCost: {
      latencyTotalMs: latency,
      costUsdPerAcceptedLoop: cost,
      totalTokens: { prompt: promptTokens, completion: completionTokens },
      costNote:
        "Cost is the gateway-reported usage metric only (never estimated); " +
        "token totals are the proxy across evidence cases.",
    },
    extras,
    decision: {
      verdict: reasons.length === 0 ? "eligible-for-signoff" : "rejected",
      reasons,
      productOwnerSignOff: "pending",
    },
    signOffNote: V2_SIGN_OFF_NOTE,
  };
  return { ...report, reportHash: graduationReportHash(report) };
}

/** Stable content hash — what the product owner's sign-off references. */
export function graduationReportHash(
  report: Omit<GraduationReportV2, "reportHash">,
): string {
  return createHash("sha256").update(canonicalize(report)).digest("hex");
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Human-readable rendering of the v2 report for the review gate. */
export function renderGraduationMarkdownV2(report: GraduationReportV2): string {
  const fmt = (v: number | null): string =>
    v === null ? "no evidence" : Number.isInteger(v) ? String(v) : v.toFixed(4);
  const lines: string[] = [];
  lines.push(`# Graduation decision report (Spec 6.3)`);
  lines.push("");
  lines.push(`- generated: ${report.generatedAt}`);
  lines.push(`- report hash (sign-off anchor): \`${report.reportHash}\``);
  lines.push(`- gates: **${report.allGatesPassed ? "ALL PASS" : "NOT ALL PASS"}**`);
  lines.push(`- decision aid verdict: **${report.decision.verdict.toUpperCase()}**`);
  lines.push(`- product-owner sign-off: **PENDING** (manual — never automatic)`);
  lines.push("");
  lines.push(`## Candidate freeze`);
  lines.push("");
  lines.push(`- commit: ${report.freeze.commit}${report.freeze.dirty ? " (DIRTY TREE — not gradable)" : ""}`);
  lines.push(`- branch: ${report.freeze.branch}`);
  lines.push(`- models.config.yaml sha256: ${report.freeze.modelsConfigSha256.slice(0, 16)}…`);
  lines.push(`- prompt/schema versions: organize=${report.freeze.promptVersions.organizePrompt}/${report.freeze.promptVersions.organizeSchema} answer=${report.freeze.promptVersions.answerPrompt} emotion=${report.freeze.promptVersions.emotionAnalyzer}`);
  for (const d of report.freeze.datasets) {
    lines.push(`- dataset ${d.stage}: ${d.name} v${d.version} sha256:${d.sha256.slice(0, 12)}…`);
  }
  lines.push(`- cohort window: ${report.freeze.cohortWindow === null ? "not set (pre-pilot evidence)" : `${report.freeze.cohortWindow.start} → ${report.freeze.cohortWindow.end}`}`);
  lines.push(`- held-out note: dataset hashes above are frozen; held-out cases must not be altered after results are known (FR-2).`);
  lines.push("");
  lines.push(`## Gates`);
  lines.push("");
  lines.push(`| gate | measured | threshold | result |`);
  lines.push(`|---|---|---|---|`);
  for (const gate of report.gates) {
    lines.push(`| ${gate.gate} | ${fmt(gate.measured)} | ${gate.threshold} | ${gate.passed ? "PASS" : "FAIL"} |`);
  }
  lines.push("");
  lines.push(`## Quality distributions`);
  lines.push("");
  lines.push(`| stage | metric | n | missing | mean | min | p50 | p90 | max |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const [stage, metrics] of Object.entries(report.quality)) {
    for (const [name, s] of Object.entries(metrics)) {
      lines.push(`| ${stage} | ${name} | ${s.n} | ${s.missing} | ${fmt(s.mean)} | ${fmt(s.min)} | ${fmt(s.p50)} | ${fmt(s.p90)} | ${fmt(s.max)} |`);
    }
  }
  lines.push("");
  lines.push(`## Cohort slices (pseudonymous; groups < ${MIN_COHORT_SIZE} suppressed in evidence)`);
  lines.push("");
  if (report.cohorts.length === 0) {
    lines.push(`- none present in evidence (small groups are suppressed by design)`);
  }
  for (const cohort of report.cohorts) {
    lines.push(`- ${cohort.stage} ${JSON.stringify(cohort.slice)} (n=${cohort.n}, hard failures=${cohort.hardFailures})`);
  }
  lines.push("");
  lines.push(`## Latency and cost`);
  lines.push("");
  lines.push(`- latency.total_ms (full-loop): ${report.latencyCost.latencyTotalMs === null ? "no evidence" : `mean ${fmt(report.latencyCost.latencyTotalMs.mean)}, p90 ${fmt(report.latencyCost.latencyTotalMs.p90)}`}`);
  lines.push(`- cost.usd_per_accepted_loop: ${report.latencyCost.costUsdPerAcceptedLoop === null || Number.isNaN(report.latencyCost.costUsdPerAcceptedLoop.mean) ? "not reported by gateway (never estimated)" : `mean ${fmt(report.latencyCost.costUsdPerAcceptedLoop.mean)}`}`);
  lines.push(`- token proxy across evidence: prompt ${report.latencyCost.totalTokens.prompt}, completion ${report.latencyCost.totalTokens.completion}`);
  lines.push("");
  lines.push(`## Pilot extras`);
  lines.push("");
  const extras = report.extras;
  if (extras.correctionTrends !== undefined) {
    const t = extras.correctionTrends;
    lines.push(`- correction trends (${t.scopes} scope(s)): ${t.total} total — ${t.accepted} accepted, ${t.rejected} rejected, ${t.pending} pending; adherence ${t.adherenceRate === null ? "no observations" : `${(t.adherenceRate * 100).toFixed(0)}%`} (${t.followed} followed / ${t.contradicted} contradicted)`);
  } else {
    lines.push(`- correction trends: not provided`);
  }
  if (extras.misfireBoard !== undefined) {
    const b = extras.misfireBoard;
    lines.push(`- misfire board: ${b.total} report(s); dispositions ${Object.entries(b.byDisposition).map(([k, v]) => `${k}=${v}`).join(", ") || "—"}; unresolved ${b.unresolved}; blocks-graduation ${b.blocksGraduation}; promoted golden cases ${b.promotedGoldenCases}`);
  } else {
    lines.push(`- misfire board: not provided`);
  }
  if (extras.retention !== undefined) {
    const r = extras.retention;
    lines.push(`- retention (verified ${r.verifiedAt}): ${r.capturesScanned} capture(s) across ${r.scopes} scope(s); ${r.audioRetained} with audio retained, ${r.transcriptOnly} transcript-only; 7-day policy violations: ${r.policyViolations}`);
  } else {
    lines.push(`- retention: not provided`);
  }
  lines.push(`- privacy incidents: ${extras.privacyIncidents === undefined ? "not provided" : extras.privacyIncidents.count}${(extras.privacyIncidents?.notes.length ?? 0) > 0 ? ` (${extras.privacyIncidents!.notes.join("; ")})` : ""}`);
  lines.push("");
  lines.push(`## Known limitations (FR-3)`);
  lines.push("");
  for (const limitation of extras.limitations ?? []) {
    lines.push(`- ${limitation}`);
  }
  if ((extras.limitations ?? []).length === 0) lines.push(`- none recorded`);
  lines.push("");
  lines.push(`## Decision`);
  lines.push("");
  if (report.decision.reasons.length === 0) {
    lines.push(`All gates pass and no blocker is recorded. The product owner may accept graduation by signing the report hash in the decision record.`);
  } else {
    lines.push(`**NOT eligible for sign-off.** Reasons:`);
    for (const reason of report.decision.reasons) lines.push(`- ${reason}`);
  }
  lines.push("");
  lines.push(`## Evidence`);
  lines.push("");
  for (const e of report.evidenceReports) {
    lines.push(`- ${e.stage} — ${e.dataset} — commit ${e.commit.slice(0, 8)} — fingerprint ${e.fingerprint.slice(0, 12)}… — \`${e.path}\``);
  }
  lines.push("");
  lines.push(`---`);
  lines.push(report.signOffNote);
  lines.push("");
  return lines.join("\n");
}

/** Persist the v2 graduation report (JSON + Markdown). */
export async function writeGraduationReportV2(
  report: GraduationReportV2,
  dir: string,
): Promise<{ jsonPath: string; markdownPath: string }> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = join(dir, `graduation-run-${stamp}.json`);
  const markdownPath = join(dir, `graduation-run-${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  await writeFile(markdownPath, renderGraduationMarkdownV2(report), { mode: 0o600 });
  return { jsonPath, markdownPath };
}
