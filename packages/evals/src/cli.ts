/**
 * Eval harness CLI (Specification 4.1 + 4.2 + 6.4).
 *
 *   tsx src/cli.ts validate                          # schema-validate every dataset
 *   tsx src/cli.ts run <stage> [--mode live|deterministic] [--personalization on|off]
 *                                                    [--dataset <path>]
 *   tsx src/cli.ts snapshot                          # print the config fingerprint
 *   tsx src/cli.ts heldout-freeze [--dataset <path>] --report <report.json>
 *                                                    # lock a held-out version after
 *                                                    # its first results run (Spec 6.4)
 *
 * Deterministic stages (adversarial, provenance, buckets, memory,
 * retrieval, emotion, full-loop in deterministic mode) run with no
 * gateway credentials. Stages that need the live gateway (transcribe,
 * organize, full-loop --mode live) fail closed with a classified
 * external-flaky error when credentials are absent — never a crash,
 * never a fake pass.
 *
 * Spec 6.4: the organize stage's registry default is the HELD-OUT envelope
 * (the partition the graduation gate reads). `--dataset` points a run at
 * another partition (e.g. the development envelope for tuning experiments).
 * A locked held-out envelope whose content hash differs from its lock is a
 * hard validation failure (SR-6).
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
import { FileBucketStore } from "@donna/buckets";
import { FileCorrectionStore } from "@donna/memory";
import { FileCaptureStore } from "@donna/pipeline";
import { FilePilotDecisionStore } from "@donna/pilot";
import { writePrivateFile } from "@donna/file-security";
import { loadDataset } from "./datasets.js";
import { runEval, type StageScorer } from "./harness.js";
import {
  checkHeldoutLock,
  freezeHeldoutEnvelope,
  heldoutLockPath,
  isHeldoutEnvelopePath,
} from "./promote-organize.js";
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
import {
  amendOrganizeSnapshotEnvelopes,
  type SnapshotAdjudicationOverride,
} from "./amend-organize-snapshots.js";

const here = dirname(fileURLToPath(import.meta.url));
const evalsDir = resolve(here, "..");
const repoRoot = resolve(here, "../../..");
loadEnv({ path: resolve(repoRoot, ".env"), quiet: true });

const DATASETS: Record<string, string> = {
  transcribe: "datasets/golden/transcribe/transcribe.v1.json",
  // Spec 6.4: the organize registry default is the HELD-OUT partition — the
  // set the graduation gate reads. The development partition is reachable
  // via `run organize --dataset datasets/golden/organize/organize.dev.v1.json`.
  organize: "datasets/golden/organize/organize.heldout.v1.json",
  provenance: "datasets/golden/provenance/provenance.v1.json",
  buckets: "datasets/golden/buckets/buckets.v1.json",
  memory: "datasets/golden/memory/memory.v1.json",
  retrieval: "datasets/golden/retrieval/retrieval.v1.json",
  emotion: "datasets/golden/emotion/emotion.v1.json",
  "full-loop": "datasets/golden/full-loop/full-loop.v1.json",
  adversarial: "datasets/adversarial/adversarial.v1.json",
};

/**
 * Supplementary envelopes `validate` covers alongside the registry
 * (Spec 6.4): the organize development partition and the pre-pilot
 * organize envelope (kept valid though no longer the registry default).
 */
const EXTRA_VALIDATE: Record<string, string> = {
  "organize-dev": "datasets/golden/organize/organize.dev.v1.json",
  "organize-prepilot": "datasets/golden/organize/organize.v1.json",
};

/**
 * SR-6: when a held-out envelope carries a freeze lock, its content must
 * match the lock at the locked version — a hard failure otherwise. Prints
 * the lock state for reviewable output.
 */
async function assertHeldoutLockFor(datasetPath: string): Promise<void> {
  if (!isHeldoutEnvelopePath(datasetPath)) return;
  const check = await checkHeldoutLock(datasetPath);
  if (check.status === "intact") {
    console.log(
      `held-out lock intact: ${check.lock!.name} v${check.lock!.version} sha256:${check.lock!.sha256.slice(0, 12)}…`,
    );
  } else if (check.status === "unfrozen-new-version") {
    console.log(
      `note: held-out envelope is ahead of the lock (locked ${check.lock!.name} v${check.lock!.version}) — ` +
        "this run produces results for the new version; freeze it with heldout-freeze afterward (FR-9)",
    );
  }
}

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
  for (const [stage, rel] of [...Object.entries(DATASETS), ...Object.entries(EXTRA_VALIDATE)]) {
    const path = join(evalsDir, rel);
    try {
      const dataset = await loadDataset(path);
      await assertHeldoutLockFor(path);
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
    // Spec 6.4 FR-10: --dataset points the run at another partition (e.g.
    // the development envelope); the registry default stays the held-out set.
    const datasetOverride = arg("--dataset");
    const datasetPath = datasetOverride !== undefined
      ? resolve(process.cwd(), datasetOverride)
      : join(evalsDir, datasetRel);
    // SR-6: a locked held-out envelope whose content drifted fails hard.
    await assertHeldoutLockFor(datasetPath);
    const live = await liveStack();
    const scorer = await buildScorer(stage, live);
    if (live === undefined && ["transcribe", "organize"].includes(stage)) {
      console.error(`note: no gateway credentials — ${stage} cases will error external-flaky`);
    }
    const result = await runEval({
      datasetPath,
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

  // Spec 6.4 FR-9: freeze a held-out version after its first results run.
  // Writes the lock (name, version, envelope content hash, frozen-at,
  // first-results report hash); the report must be a results run against
  // this exact envelope content. Re-freezing a frozen version is refused.
  if (command === "heldout-freeze") {
    const datasetOverride = arg("--dataset");
    const envelopePath = datasetOverride !== undefined
      ? resolve(process.cwd(), datasetOverride)
      : join(evalsDir, DATASETS["organize"]!);
    const reportPath = arg("--report");
    if (reportPath === undefined) {
      throw new Error(
        "usage: cli.ts heldout-freeze [--dataset <path>] --report <report.json>",
      );
    }
    if (!isHeldoutEnvelopePath(envelopePath)) {
      throw new Error("heldout-freeze applies to held-out envelopes only (organize.heldout.*)");
    }
    const lock = await freezeHeldoutEnvelope({
      envelopePath,
      reportPath: resolve(process.cwd(), reportPath),
      now: () => new Date(),
    });
    console.log(
      `Held-out frozen: ${lock.name} v${lock.version} sha256:${lock.sha256.slice(0, 12)}…`,
    );
    console.log(`  first-results report sha256: ${lock.firstResultsReportSha256.slice(0, 12)}…`);
    console.log(`  lock: ${heldoutLockPath(envelopePath)}`);
    return;
  }

  // Specification 6.5: reconstruct capture-time bucket snapshots from one
  // explicitly supplied, scoped source tree. The source is read-only; dry
  // run is the default, and held-out amendment requires an explicit product-
  // owner gate. Ambiguity blocks every envelope write.
  if (command === "amend-organize-snapshots") {
    const sourceData = arg("--source-data");
    const tenantId = arg("--tenant") ?? process.env.DONNA_TENANT_ID;
    const userId = arg("--user") ?? process.env.DONNA_USER_ID;
    if (sourceData === undefined || tenantId === undefined || userId === undefined) {
      throw new Error(
        "usage: cli.ts amend-organize-snapshots --source-data <read-only-data-dir> " +
          "--tenant <scope> --user <scope> [--apply --product-owner-approved] " +
          "[--adjudications <json>]",
      );
    }
    const apply = process.argv.includes("--apply");
    if (apply && !process.argv.includes("--product-owner-approved")) {
      throw new Error(
        "Held-out amendment is gated: --apply also requires --product-owner-approved",
      );
    }
    const devPath = resolve(
      process.cwd(),
      arg("--dev") ??
        join(evalsDir, "datasets/golden/organize/organize.dev.v1.json"),
    );
    const heldoutPath = resolve(
      process.cwd(),
      arg("--heldout") ??
        join(evalsDir, "datasets/golden/organize/organize.heldout.v1.json"),
    );
    const driftPath = resolve(
      process.cwd(),
      arg("--drift") ??
        join(evalsDir, "datasets/golden/organize/organize.snapshot-drift.v3.json"),
    );
    const diffPath = resolve(
      process.cwd(),
      arg("--diff") ??
        join(evalsDir, "datasets/golden/organize/organize.amendment-diff.v2-v3.json"),
    );
    let overrides: SnapshotAdjudicationOverride[] | undefined;
    const adjudicationsPath = arg("--adjudications");
    if (adjudicationsPath !== undefined) {
      const parsed = JSON.parse(
        await readFile(resolve(process.cwd(), adjudicationsPath), "utf8"),
      ) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error("The adjudications file must contain a JSON array");
      }
      overrides = parsed as SnapshotAdjudicationOverride[];
    }
    const absoluteSource = resolve(process.cwd(), sourceData);
    const result = await amendOrganizeSnapshotEnvelopes({
      envelopePaths: [devPath, heldoutPath],
      scope: { tenantId, userId },
      stores: {
        captures: new FileCaptureStore(absoluteSource),
        buckets: new FileBucketStore(absoluteSource),
        corrections: new FileCorrectionStore(absoluteSource),
        decisions: new FilePilotDecisionStore(absoluteSource),
      },
      ...(overrides !== undefined ? { overrides } : {}),
      apply,
      driftReportPath: driftPath,
      diffArtifactPath: diffPath,
      now: () => new Date(),
    });
    if (result.applied) {
      const lockPath = heldoutLockPath(heldoutPath);
      const archivePath = resolve(
        process.cwd(),
        arg("--lock-archive") ??
          join(dirname(heldoutPath), "organize.heldout.v2.lock.json"),
      );
      await writePrivateFile(archivePath, await readFile(lockPath, "utf8"));
      console.log(
        `Snapshot amendment applied: ${result.drift.reconstructibleCases} case(s), ` +
          `${result.drift.overriddenCases} product-owner override(s), 0 unresolved.`,
      );
      console.log(`  additive-only proof: ${diffPath}`);
      console.log(`  v2 lock archive: ${archivePath}`);
      console.log("  held-out is now unfrozen; run organize live, then heldout-freeze.");
    } else {
      console.log(
        `Snapshot amendment dry run: ${result.drift.reconstructibleCases} reconstructible, ` +
          `${result.drift.unresolvedCases} flagged, ${result.drift.overriddenCases} overridden.`,
      );
    }
    console.log(`  drift report: ${driftPath}`);
    process.exit(result.drift.unresolvedCases > 0 ? 1 : 0);
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

  console.error("usage: cli.ts validate | snapshot | run <stage> [--mode …] [--dataset <path>] | heldout-freeze [--dataset <path>] --report <report.json> | amend-organize-snapshots --source-data <dir> --tenant <scope> --user <scope> [--apply --product-owner-approved] | baseline <stage> | compare <stage> <report> | graduation <reports…> | graduation-run <reports…> [--extras <f>] [--cohort-window <s>..<e>]");
  process.exit(2);
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
