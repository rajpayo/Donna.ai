/**
 * Eval harness CLI (Specification 4.1 + 4.2).
 *
 *   tsx src/cli.ts validate                          # schema-validate every dataset
 *   tsx src/cli.ts run <stage> [--mode live|deterministic] [--personalization on|off]
 *   tsx src/cli.ts snapshot                          # print the config fingerprint
 *
 * Deterministic stages (adversarial, provenance, buckets, memory,
 * retrieval, emotion, full-loop in deterministic mode) run with no
 * gateway credentials. Stages that need the live gateway (transcribe,
 * organize, full-loop --mode live) fail closed with a classified
 * external-flaky error when credentials are absent — never a crash,
 * never a fake pass.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import {
  inspectGatewayEnv,
  gatewayEnvProblems,
  loadModelsConfig,
  resolveStack,
  type ModelsConfig,
  type ResolvedStack,
} from "@donna/providers";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { loadDataset } from "./datasets.js";
import { runEval, type StageScorer } from "./harness.js";
import { adversarialScorer } from "./adversarial.js";
import { captureSnapshot, snapshotFingerprint } from "./snapshot.js";
import {
  compareReports,
  loadReport,
  renderComparisonMarkdown,
} from "./compare.js";
import {
  buildGraduationReportV2,
  graduationFromPaths,
  writeGraduationReport,
  writeGraduationReportV2,
  type GraduationExtras,
} from "./graduation.js";
import { MeteredGatewayClient } from "./scripted.js";
import { createSttScorer } from "./scorers/stt.js";
import { createOrganizeScorer } from "./scorers/organize.js";
import { createProvenanceScorer } from "./scorers/provenance.js";
import { createBucketsScorer } from "./scorers/buckets.js";
import { createMemoryScorer } from "./scorers/memory.js";
import { createRetrievalScorer } from "./scorers/retrieval.js";
import { createEmotionScorer } from "./scorers/emotion.js";
import { createFullLoopScorer } from "./scorers/full-loop.js";

const here = dirname(fileURLToPath(import.meta.url));
const evalsDir = resolve(here, "..");
const repoRoot = resolve(here, "../../..");
loadEnv({ path: resolve(repoRoot, ".env"), quiet: true });

const DATASETS: Record<string, string> = {
  transcribe: "datasets/golden/transcribe/transcribe.v1.json",
  organize: "datasets/golden/organize/organize.v1.json",
  provenance: "datasets/golden/provenance/provenance.v1.json",
  buckets: "datasets/golden/buckets/buckets.v1.json",
  memory: "datasets/golden/memory/memory.v1.json",
  retrieval: "datasets/golden/retrieval/retrieval.v1.json",
  emotion: "datasets/golden/emotion/emotion.v1.json",
  "full-loop": "datasets/golden/full-loop/full-loop.v1.json",
  adversarial: "datasets/adversarial/adversarial.v1.json",
};

function configPath(): string {
  return resolve(repoRoot, process.env.DONNA_MODELS_CONFIG ?? "models.config.yaml");
}

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

interface LiveStack {
  config: ModelsConfig;
  stack: ResolvedStack;
  metered: MeteredGatewayClient;
}

/** Build the live stack when gateway credentials exist; else undefined. */
async function liveStack(): Promise<LiveStack | undefined> {
  const problems = gatewayEnvProblems(inspectGatewayEnv());
  if (problems.length > 0) return undefined;
  const config = await loadModelsConfig(configPath());
  // Metering wraps the real client; adapters are unchanged (ports/adapters).
  const metered = new MeteredGatewayClient({
    baseUrl: process.env.TRUEFOUNDRY_BASE_URL!,
    apiKey: process.env.TRUEFOUNDRY_API_KEY!,
    tenantId: process.env.DONNA_TENANT_ID ?? "demo-tenant",
    appId: process.env.DONNA_APP_ID ?? "donna-mvp",
  });
  const stack = resolveStack(metered, config);
  return { config, stack, metered };
}

async function buildScorer(stage: string, live: LiveStack | undefined): Promise<StageScorer> {
  switch (stage) {
    case "adversarial":
      return adversarialScorer;
    case "provenance":
      return createProvenanceScorer();
    case "memory":
      return createMemoryScorer();
    case "emotion":
      return createEmotionScorer();
    case "buckets": {
      const config = await loadModelsConfig(configPath());
      return createBucketsScorer({ tuning: config.buckets });
    }
    case "retrieval": {
      const config = await loadModelsConfig(configPath());
      return createRetrievalScorer({
        ranking: {
          version: config.retrieval.rankingVersion,
          weights: config.retrieval.weights,
          recencyHalfLifeDays: config.retrieval.recencyHalfLifeDays,
          candidateLimit: config.retrieval.candidateLimit,
          minScore: config.retrieval.minScore,
        },
        ...(live?.stack.answerGenerator !== undefined
          ? { answerGenerator: live.stack.answerGenerator }
          : {}),
      });
    }
    case "transcribe":
      return createSttScorer({
        ...(live !== undefined ? { transcriber: live.stack.transcriber } : {}),
        fixturesDir: join(evalsDir, "fixtures", "audio"),
      });
    case "organize":
      return createOrganizeScorer({
        ...(live !== undefined ? { organizer: live.stack.organizer } : {}),
      });
    case "full-loop": {
      const config = live?.config ?? (await loadModelsConfig(configPath()));
      const mode = arg("--mode") ?? (live !== undefined ? "live" : "deterministic");
      const personalized = (arg("--personalization") ?? "on") !== "off";
      return createFullLoopScorer({
        mode: mode === "live" && live !== undefined ? "live" : "deterministic",
        personalized,
        bucketTuning: config.buckets,
        contextBudgets: config.context,
        ...(mode === "live" && live !== undefined
          ? {
              live: {
                transcriber: live.stack.transcriber,
                organizer: live.stack.organizer,
                ...(live.stack.escalationOrganizer !== undefined
                  ? { escalationOrganizer: live.stack.escalationOrganizer }
                  : {}),
                embedder: live.stack.embedder,
                meteredGateway: live.metered,
                defaultOrganizerModel: config.stages.organize.default.model,
                ...(config.stages.organize.escalation !== undefined
                  ? { escalationOrganizerModel: config.stages.organize.escalation.model }
                  : {}),
              },
            }
          : {}),
      });
    }
    default:
      throw new Error(`Unknown stage "${stage}". Known: ${Object.keys(DATASETS).join(", ")}`);
  }
}

async function validateAll(): Promise<boolean> {
  let ok = true;
  for (const [stage, rel] of Object.entries(DATASETS)) {
    const path = join(evalsDir, rel);
    try {
      const dataset = await loadDataset(path);
      console.log(
        `ok  ${stage}  ${dataset.name} v${dataset.version}  ${dataset.cases.length} cases  sha256:${dataset.sha256.slice(0, 12)}…`,
      );
    } catch (error) {
      ok = false;
      console.error(`FAIL  ${stage}  ${(error as Error).message}`);
    }
  }
  return ok;
}

async function main(): Promise<void> {
  const [command, stage] = process.argv.slice(2);

  if (command === "validate") {
    const ok = await validateAll();
    process.exit(ok ? 0 : 1);
  }

  if (command === "snapshot") {
    const snapshot = await captureSnapshot({
      repoRoot,
      configPath: configPath(),
      dataset: { name: "(none)", version: 0, sha256: "0".repeat(64) },
    });
    console.log(JSON.stringify({ fingerprint: snapshotFingerprint(snapshot), snapshot }, null, 2));
    return;
  }

  if (command === "run" && stage !== undefined) {
    const datasetRel = DATASETS[stage];
    if (datasetRel === undefined) {
      throw new Error(`Unknown stage "${stage}". Known: ${Object.keys(DATASETS).join(", ")}`);
    }
    const live = await liveStack();
    const scorer = await buildScorer(stage, live);
    if (live === undefined && ["transcribe", "organize"].includes(stage)) {
      console.error(`note: no gateway credentials — ${stage} cases will error external-flaky`);
    }
    const result = await runEval({
      datasetPath: join(evalsDir, datasetRel),
      configPath: configPath(),
      repoRoot,
      evalsDir,
      reportsDir: join(evalsDir, "reports", stage),
      scorer,
    });
    console.log(
      `\n${stage}: ${result.report.aggregate.casesRun} cases, ` +
        `${result.report.aggregate.hardFailureCount} hard failures, ` +
        `${result.report.aggregate.casesErrored} errored`,
    );
    console.log(`Report: ${result.jsonPath}`);
    console.log(`        ${result.markdownPath}`);
    // Hard failures fail the run loudly — they never average out.
    process.exit(result.report.aggregate.hardFailureCount > 0 ? 1 : 0);
  }

  // Spec 4.3: accept the current deterministic run as the stage baseline.
  if (command === "baseline" && stage !== undefined) {
    const datasetRel = DATASETS[stage];
    if (datasetRel === undefined) {
      throw new Error(`Unknown stage "${stage}".`);
    }
    const scorer = await buildScorer(stage, undefined);
    const result = await runEval({
      datasetPath: join(evalsDir, datasetRel),
      configPath: configPath(),
      repoRoot,
      evalsDir,
      reportsDir: join(evalsDir, "reports", stage),
      scorer,
    });
    if (result.report.aggregate.hardFailureCount > 0) {
      throw new Error("Refusing to baseline a run with hard failures");
    }
    const baselinesDir = join(evalsDir, "baselines");
    await mkdir(baselinesDir, { recursive: true });
    const baselinePath = join(baselinesDir, `${stage}.baseline.json`);
    await copyFile(result.jsonPath, baselinePath);
    console.log(`Baseline accepted: ${baselinePath}`);
    console.log(`  fingerprint: ${result.report.fingerprint.slice(0, 16)}…`);
    return;
  }

  // Spec 4.3: compare a candidate report against the accepted baseline.
  if (command === "compare" && stage !== undefined) {
    const candidatePath = process.argv[4];
    if (candidatePath === undefined) {
      throw new Error("usage: cli.ts compare <stage> <candidateReport.json>");
    }
    const baselinePath = join(evalsDir, "baselines", `${stage}.baseline.json`);
    const [baseline, candidate] = await Promise.all([
      loadReport(baselinePath),
      loadReport(resolve(candidatePath)),
    ]);
    const result = compareReports(baseline, candidate);
    console.log(renderComparisonMarkdown(result));
    process.exit(result.status === "fail" ? 1 : 0);
  }

  // Spec 4.3: CI check — run every deterministic stage and compare each
  // against its accepted baseline. No secrets required; exit 1 on any
  // hard failure or material regression (merge-blocking), 0 on pass.
  if (command === "check") {
    const deterministicStages = [
      "adversarial",
      "provenance",
      "buckets",
      "memory",
      "emotion",
      "retrieval",
      "full-loop",
    ];
    let failed = false;
    for (const checkStage of deterministicStages) {
      const scorer = await buildScorer(checkStage, undefined);
      const result = await runEval({
        datasetPath: join(evalsDir, DATASETS[checkStage]!),
        configPath: configPath(),
        repoRoot,
        evalsDir,
        reportsDir: join(evalsDir, "reports", checkStage),
        scorer,
      });
      const baselinePath = join(evalsDir, "baselines", `${checkStage}.baseline.json`);
      let comparison;
      try {
        comparison = compareReports(await loadReport(baselinePath), result.report);
      } catch {
        comparison = undefined;
      }
      const hardFailures = result.report.aggregate.hardFailureCount;
      const status = hardFailures > 0 ? "FAIL(hard-failures)" : (comparison?.status ?? "no-baseline");
      if (hardFailures > 0 || comparison?.status === "fail") failed = true;
      console.log(
        `${status === "pass" ? "ok  " : "FAIL"}  ${checkStage}  ` +
          `${result.report.aggregate.casesRun} cases, ${hardFailures} hard failures, ` +
          `baseline comparison: ${status}`,
      );
      if (comparison !== undefined && comparison.status !== "pass") {
        for (const reason of comparison.reasons) console.log(`     ${reason}`);
      }
    }
    process.exit(failed ? 1 : 0);
  }

  // Spec 4.3: graduation report from a set of evidence reports.
  if (command === "graduation") {
    const paths = process.argv.slice(3).filter((p) => !p.startsWith("--"));
    if (paths.length === 0) {
      throw new Error("usage: cli.ts graduation <report.json> [more reports...]");
    }
    const report = await graduationFromPaths(paths.map((p) => resolve(p)));
    const { jsonPath, markdownPath } = await writeGraduationReport(
      report,
      join(evalsDir, "reports", "graduation"),
    );
    console.log(
      `Graduation gates: ${report.allGatesPassed ? "ALL PASS" : "NOT ALL PASS"} — sign-off: PENDING (manual)`,
    );
    console.log(`Report: ${jsonPath}`);
    console.log(`        ${markdownPath}`);
    process.exit(report.allGatesPassed ? 0 : 1);
  }

  // Spec 6.3: the measured graduation decision. Freezes the candidate
  // (commit + config + prompts + dataset versions + cohort window) and
  // produces the signed-by-hash, evidence-linked v2 report. Extras JSON
  // (correction trends, misfire board, retention, privacy incidents,
  // limitations) comes from `donna pilot graduation-extras`.
  if (command === "graduation-run") {
    const paths: string[] = [];
    let extrasPath: string | undefined;
    let cohortWindow: { start: string; end: string } | undefined;
    const args = process.argv.slice(3);
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--extras") {
        extrasPath = args[++i];
      } else if (a === "--cohort-window") {
        const [start, end] = (args[++i] ?? "").split("..");
        if (start === undefined || end === undefined || start === "" || end === "") {
          throw new Error("--cohort-window expects <isoStart>..<isoEnd>");
        }
        cohortWindow = { start, end };
      } else if (!a.startsWith("--")) {
        paths.push(a);
      }
    }
    if (paths.length === 0) {
      throw new Error(
        "usage: cli.ts graduation-run <report.json> [more reports...] [--extras extras.json] [--cohort-window <start>..<end>]",
      );
    }
    const evidence = [];
    for (const path of paths) {
      evidence.push({ path: resolve(path), report: await loadReport(resolve(path)) });
    }
    let extras: GraduationExtras | undefined;
    if (extrasPath !== undefined) {
      extras = JSON.parse(await readFile(resolve(extrasPath), "utf8")) as GraduationExtras;
    }
    const snapshot = await captureSnapshot({
      repoRoot,
      configPath: configPath(),
      dataset: { name: "(graduation-run)", version: 0, sha256: "0".repeat(64) },
    });
    const report = buildGraduationReportV2(evidence, {
      snapshot,
      ...(cohortWindow !== undefined ? { cohortWindow } : {}),
      ...(extras !== undefined ? { extras } : {}),
    });
    const { jsonPath, markdownPath } = await writeGraduationReportV2(
      report,
      join(evalsDir, "reports", "graduation"),
    );
    console.log(
      `Graduation decision: ${report.decision.verdict === "eligible-for-signoff" ? "ELIGIBLE FOR SIGN-OFF" : "REJECTED"} — gates ${report.allGatesPassed ? "ALL PASS" : "NOT ALL PASS"} — sign-off: PENDING (manual)`,
    );
    for (const reason of report.decision.reasons) console.log(`  - ${reason}`);
    console.log(`Report hash: ${report.reportHash}`);
    console.log(`Report: ${jsonPath}`);
    console.log(`        ${markdownPath}`);
    process.exit(report.decision.verdict === "eligible-for-signoff" ? 0 : 1);
  }

  console.error("usage: cli.ts validate | snapshot | run <stage> [--mode …] | baseline <stage> | compare <stage> <report> | graduation <reports…>");
  process.exit(2);
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
