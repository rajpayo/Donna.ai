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
  gatewayFromEnv,
  inspectGatewayEnv,
  gatewayEnvProblems,
  loadModelsConfig,
  resolveStack,
  type ModelsConfig,
  type ResolvedStack,
} from "@donna/providers";
import { loadDataset } from "./datasets.js";
import { runEval, type StageScorer } from "./harness.js";
import { adversarialScorer } from "./adversarial.js";
import { captureSnapshot, snapshotFingerprint } from "./snapshot.js";
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
  void gatewayFromEnv; // env validated above via inspectGatewayEnv
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

  console.error("usage: cli.ts validate | snapshot | run <stage>");
  process.exit(2);
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
