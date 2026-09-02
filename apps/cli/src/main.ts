/**
 * Donna demo CLI.
 *
 *   donna capture <audio-file> [--user <id>]   run the core loop on a recording
 *   donna buckets [--user <id>]                list the user's current buckets
 *
 * This is the internal demo surface: one command turns a messy voice memo
 * into organized, bucketed, provenance-linked thoughts.
 */
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capture, EventSink } from "@donna/core";
import { FileBucketStore } from "@donna/buckets";
import { DonnaPipeline } from "@donna/pipeline";
import { config as loadEnv } from "dotenv";
import {
  gatewayFromEnv,
  loadModelsConfig,
  resolveStack,
} from "@donna/providers";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const invocationDir = process.env.INIT_CWD ?? process.cwd();
loadEnv({ path: resolve(repoRoot, ".env"), quiet: true });

const USAGE = `usage:
  donna capture <audio-file> [--user <id>]
  donna buckets [--user <id>]`;

const consoleEvents: EventSink = {
  emit: (e) =>
    console.error(
      `[telemetry] ${e.name} ${Object.entries(e.attrs ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}`,
    ),
};

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function buildPipeline(): Promise<{ pipeline: DonnaPipeline; store: FileBucketStore }> {
  const configPath = resolve(
    repoRoot,
    process.env.DONNA_MODELS_CONFIG ?? "models.config.yaml",
  );
  const dataDir = resolve(repoRoot, process.env.DONNA_DATA_DIR ?? "data");
  const config = await loadModelsConfig(configPath);
  const stack = resolveStack(gatewayFromEnv(), config);
  const store = new FileBucketStore(dataDir);
  const pipeline = new DonnaPipeline({
    transcriber: stack.transcriber,
    organizer: stack.organizer,
    ...(stack.escalationOrganizer !== undefined
      ? { escalationOrganizer: stack.escalationOrganizer }
      : {}),
    embedder: stack.embedder,
    store,
    bucketTuning: stack.bucketTuning,
    events: consoleEvents,
  });
  return { pipeline, store };
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const tenantId = process.env.DONNA_TENANT_ID ?? "demo-tenant";
  const userId = arg("--user") ?? "demo-user";

  if (command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }

  if (command === "capture") {
    const audioArg = process.argv[3];
    if (!audioArg) {
      console.error("usage: donna capture <audio-file> [--user <id>]");
      process.exit(1);
    }
    const audioPath = resolve(invocationDir, audioArg);
    const { pipeline } = await buildPipeline();
    const capture: Capture = {
      id: randomUUID(),
      tenantId,
      userId,
      audioPath,
      capturedAt: new Date().toISOString(),
    };
    const result = await pipeline.run(capture);

    console.log("\n=== Transcript ===");
    console.log(result.transcript.text);
    console.log("\n=== Organized ===");
    for (const item of result.items) {
      const flag = item.needsReview ? " (needs review)" : "";
      console.log(`• [${item.bucket.name}]${flag} ${item.thought.summary}`);
      if (item.thought.task) {
        console.log(`    ↳ task: ${item.thought.task.title}`);
      }
      console.log(
        `    ↳ source: ${item.thought.provenance.startSec.toFixed(1)}–${item.thought.provenance.endSec.toFixed(1)}s "${item.thought.provenance.sourceText.slice(0, 80)}"`,
      );
    }
    if (result.bucketsCreated.length > 0) {
      console.log("\n=== New buckets created ===");
      for (const b of result.bucketsCreated) {
        console.log(`+ ${b.name} — ${b.description}`);
      }
    }
    console.log(
      `\n${result.items.length} thoughts, ${result.bucketsCreated.length} new buckets, ${(result.metrics.totalLatencyMs / 1000).toFixed(1)}s total`,
    );
    return;
  }

  if (command === "buckets") {
    const dataDir = resolve(repoRoot, process.env.DONNA_DATA_DIR ?? "data");
    const store = new FileBucketStore(dataDir);
    const buckets = await store.listBuckets(tenantId, userId);
    if (buckets.length === 0) {
      console.log("No buckets yet — capture something first.");
      return;
    }
    for (const b of buckets) {
      console.log(`• ${b.name} (${b.itemCount} items, ${b.origin}) — ${b.description}`);
    }
    return;
  }

  console.error(USAGE);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
