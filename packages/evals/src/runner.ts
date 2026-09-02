/**
 * Eval runner: feeds golden transcripts through the organize stage with the
 * models from models.config.yaml, scores the outputs, writes a report.
 *
 * Usage:
 *   npm run eval                          # uses ./models.config.yaml
 *   DONNA_MODELS_CONFIG=./models.sonnet.yaml npm run eval
 *
 * Reports land in packages/evals/reports/<timestamp>.json so runs are
 * comparable across model swaps — that's the iteration loop.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Transcript } from "@donna/core";
import {
  gatewayFromEnv,
  loadModelsConfig,
  OpenAiCompatibleOrganizer,
  AnthropicOrganizer,
} from "@donna/providers";
import { scoreCase, type CaseScore, type GoldenCase } from "./scorers.js";

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const configPath = process.env.DONNA_MODELS_CONFIG ?? "./models.config.yaml";
  const datasetPath = join(here, "../datasets/golden/organize.v1.json");
  const dataset = JSON.parse(await readFile(datasetPath, "utf8")) as {
    name: string;
    cases: GoldenCase[];
  };

  const config = await loadModelsConfig(configPath);
  const gateway = gatewayFromEnv();
  const lane = config.stages.organize.default;
  const organizer =
    lane.provider === "anthropic"
      ? new AnthropicOrganizer(gateway, lane.model, lane.params)
      : new OpenAiCompatibleOrganizer(gateway, lane.model, lane.params);

  console.log(`Evaluating organizer: ${lane.model} on ${dataset.name} (${dataset.cases.length} cases)`);

  const scores: CaseScore[] = [];
  for (const golden of dataset.cases) {
    const transcript: Transcript = {
      captureId: `eval-${golden.id}`,
      text: golden.transcript,
      segments: [
        { id: "seg-0", text: golden.transcript, startSec: 0, endSec: 60 },
      ],
      model: "eval-harness",
    };
    let output = null;
    try {
      output = await organizer.organize(transcript, []);
    } catch (err) {
      console.error(`  ${golden.id}: organizer failed — ${(err as Error).message}`);
    }
    const score = scoreCase(golden, output);
    scores.push(score);
    console.log(
      `  ${golden.id}: schema=${score.schemaValid ? "ok" : "FAIL"} ` +
        `coverage=${score.contentCoverage.toFixed(2)} ` +
        `taskF1 p=${score.taskExtraction.precision.toFixed(2)} r=${score.taskExtraction.recall.toFixed(2)} ` +
        `tasksBucketed=${score.tasksBucketedCorrectly ? "ok" : "FAIL"}`,
    );
  }

  const valid = scores.filter((s) => s.schemaValid);
  const report = {
    dataset: dataset.name,
    model: lane.model,
    configPath,
    ranAt: new Date().toISOString(),
    aggregate: {
      cases: scores.length,
      schemaValidityRate: scores.length === 0 ? 0 : valid.length / scores.length,
      meanContentCoverage:
        scores.reduce((a, s) => a + s.contentCoverage, 0) / scores.length,
      meanTaskPrecision:
        scores.reduce((a, s) => a + s.taskExtraction.precision, 0) / scores.length,
      meanTaskRecall:
        scores.reduce((a, s) => a + s.taskExtraction.recall, 0) / scores.length,
      tasksBucketedRate:
        scores.filter((s) => s.tasksBucketedCorrectly).length / scores.length,
    },
    scores,
  };

  const reportsDir = join(here, "../reports");
  await mkdir(reportsDir, { recursive: true });
  const file = join(reportsDir, `${Date.now()}-${lane.model}.json`);
  await writeFile(file, JSON.stringify(report, null, 2));

  console.log("\nAggregate:");
  console.log(JSON.stringify(report.aggregate, null, 2));
  console.log(`\nReport written: ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
