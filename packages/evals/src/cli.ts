/**
 * Eval harness CLI (Specification 4.1).
 *
 *   tsx src/cli.ts validate                 # schema-validate every dataset
 *   tsx src/cli.ts run <stage>              # run one stage eval, write reports
 *   tsx src/cli.ts snapshot                 # print the config fingerprint
 *
 * Stage scorers are registered in SCORERS. Deterministic stages
 * (adversarial, provenance, retrieval, memory, emotion) run with no
 * gateway credentials; stages that need the live gateway (transcribe,
 * organize, full-loop in live mode) fail closed with a classified
 * external-flaky error when credentials are absent — never a crash, never
 * a fake pass.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { loadDataset } from "./datasets.js";
import { runEval, type StageScorer } from "./harness.js";
import { adversarialScorer } from "./adversarial.js";
import { captureSnapshot, snapshotFingerprint } from "./snapshot.js";

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

/** Stage scorers. 4.2 adds transcribe/organize/retrieval/memory/full-loop. */
const SCORERS: Record<string, () => Promise<StageScorer>> = {
  adversarial: async () => adversarialScorer,
};

function configPath(): string {
  return resolve(repoRoot, process.env.DONNA_MODELS_CONFIG ?? "models.config.yaml");
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
    const scorerFactory = SCORERS[stage];
    if (datasetRel === undefined) {
      throw new Error(`Unknown stage "${stage}". Known: ${Object.keys(DATASETS).join(", ")}`);
    }
    if (scorerFactory === undefined) {
      throw new Error(
        `No scorer registered for stage "${stage}" yet (4.2 wires the remaining stages).`,
      );
    }
    const scorer = await scorerFactory();
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
