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
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadReport } from "./compare.js";
import type { EvalReport, HardFailureKind } from "./report.js";

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
