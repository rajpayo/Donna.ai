/**
 * Donna demo CLI.
 *
 *   donna capture <audio-file> [--user <id>]   run the core loop on a recording
 *   donna buckets [--user <id>]                list the user's current buckets
 *   donna compat-check [--audio <file>]        offline Spec 1.1 preflight +
 *                                              sanitized compatibility report
 *   donna export <capture-id> [--user <id>]    scoped capture export (JSON)
 *   donna delete-audio <capture-id>            delete audio early (transcript
 *                                              and thoughts remain)
 *   donna delete-capture <capture-id>          delete a capture and every
 *                                              derived record
 *   donna retention [--cleanup] [--user <id>]  retention status; --cleanup
 *                                              removes expired audio
 *   donna memory <subcommand>                  private memory controls:
 *       list [--layer <l>] [--all]             view confirmed memories
 *       proposals                              view pending proposals
 *       approve <proposal-id>                  confirm a proposed memory
 *       reject <proposal-id>                   reject a proposed memory
 *       remember <text> --layer <l> --kind <k> [--subject <s>] [--ttl-sec <n>]
 *                                              explicitly state a memory
 *       supersede <memory-id> <new text>       correct a memory (old kept
 *                                              as superseded, never erased)
 *       forget <memory-id>                     delete a memory
 *       export                                 scoped memory export (JSON)
 *       events                                 lifecycle audit trail
 *   donna consent list|grant|revoke [purpose]  consent controls
 *   donna thoughts [--user <id>]               list organized thoughts (IDs
 *                                              for corrections)
 *   donna correct <type> ...                   capture a correction event:
 *       move <thought-id> --to <bucket-name>   thought is in the wrong bucket
 *       rename <bucket-id> --name <new-name>   rename a bucket
 *       merge <bucket-id> --into <bucket-id>   merge one bucket into another
 *       edit-thought <thought-id> --text <t> [--summary <s>]
 *       add-task <thought-id> --title <t>      mark a thought as a task
 *       remove-task <thought-id>               clear a thought's task
 *       provenance <thought-id> --segments <id,id,...>
 *   donna corrections [--all]                  review queue (pending first)
 *   donna corrections accept|reject <id>       review decisions; accepting
 *                                              applies the correction safely
 *   donna corrections delete <id>              remove an event + rebuild
 *   donna corrections replay                   rebuild derived preferences
 *   donna corrections stats                    correction + adherence metrics
 *   donna corrections promote <id>             share as a de-identified
 *                                              golden case (requires
 *                                              `consent grant eval-sharing`)
 *
 * This is the internal demo surface: one command turns a messy voice memo
 * into organized, bucketed, provenance-linked thoughts.
 */
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capture, EventSink, MemoryLayer } from "@donna/core";
import { FileBucketStore } from "@donna/buckets";
import { promoteCorrectionToGoldenCase, runCompatibilityCheck } from "@donna/evals";
import {
  ContextAssembler,
  CorrectionService,
  FileConsentStore,
  FileCorrectionStore,
  FileMemoryStore,
  MemoryService,
} from "@donna/memory";
import {
  DeterministicProvenanceVerifier,
  DonnaPipeline,
  FileCaptureStore,
  FileTranscriptStore,
} from "@donna/pipeline";
import {
  AudioKeyError,
  CaptureLifecycleService,
  EncryptedFileAudioStore,
  FileAuditLog,
  parseAudioKey,
  RetentionService,
} from "@donna/privacy";
import { config as loadEnv } from "dotenv";
import {
  gatewayEnvProblems,
  gatewayFromEnv,
  inspectGatewayEnv,
  loadModelsConfig,
  resolveStack,
} from "@donna/providers";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const invocationDir = process.env.INIT_CWD ?? process.cwd();
loadEnv({ path: resolve(repoRoot, ".env"), quiet: true });

const USAGE = `usage:
  donna capture <audio-file> [--user <id>]
  donna buckets [--user <id>]
  donna compat-check [--audio <file>]
  donna export <capture-id> [--user <id>]
  donna delete-audio <capture-id> [--user <id>]
  donna delete-capture <capture-id> [--user <id>]
  donna retention [--cleanup] [--user <id>]
  donna memory list [--layer <l>] [--all] [--user <id>]
  donna memory proposals [--user <id>]
  donna memory approve <proposal-id> [--user <id>]
  donna memory reject <proposal-id> [--user <id>]
  donna memory remember <text> --layer <l> --kind <k> [--subject <s>] [--ttl-sec <n>] [--user <id>]
  donna memory supersede <memory-id> <new text> [--user <id>]
  donna memory forget <memory-id> [--user <id>]
  donna memory export [--user <id>]
  donna memory events [--user <id>]
  donna consent list [--user <id>]
  donna consent grant <purpose> [--user <id>]
  donna consent revoke <purpose> [--user <id>]
  donna thoughts [--user <id>]
  donna correct move <thought-id> --to <bucket-name> [--user <id>]
  donna correct rename <bucket-id> --name <new-name> [--user <id>]
  donna correct merge <bucket-id> --into <bucket-id> [--user <id>]
  donna correct edit-thought <thought-id> --text <t> [--summary <s>] [--user <id>]
  donna correct add-task <thought-id> --title <t> [--user <id>]
  donna correct remove-task <thought-id> [--user <id>]
  donna correct provenance <thought-id> --segments <id,id,...> [--user <id>]
  donna corrections [--all] [--user <id>]
  donna corrections accept <id> [--user <id>]
  donna corrections reject <id> [--user <id>]
  donna corrections delete <id> [--user <id>]
  donna corrections replay [--user <id>]
  donna corrections stats [--user <id>]
  donna corrections promote <id> [--user <id>]`;

function dataDir(): string {
  return resolve(repoRoot, process.env.DONNA_DATA_DIR ?? "data");
}

/**
 * The audio encryption key comes from runtime secret management only. A
 * missing or invalid key fails closed with an actionable message — audio
 * is never stored unencrypted.
 */
function buildAudioStore(): EncryptedFileAudioStore {
  const key = parseAudioKey(process.env.DONNA_AUDIO_KEY);
  return new EncryptedFileAudioStore(dataDir(), key);
}

function buildMemoryService(): MemoryService {
  const dir = dataDir();
  return new MemoryService({
    memories: new FileMemoryStore(dir),
    consents: new FileConsentStore(dir),
    now: () => new Date(),
  });
}

/**
 * Corrections need the bucket store, transcripts, and the provenance
 * verifier. The embedder (for thought.edit re-embedding) is wired
 * best-effort: without gateway credentials the service still works and
 * thought.edit acceptance fails closed with an explicit reason.
 */
async function buildCorrectionService(): Promise<CorrectionService> {
  const dir = dataDir();
  let embedder;
  try {
    const config = await loadModelsConfig(
      resolve(repoRoot, process.env.DONNA_MODELS_CONFIG ?? "models.config.yaml"),
    );
    embedder = resolveStack(gatewayFromEnv(), config).embedder;
  } catch {
    embedder = undefined;
  }
  return new CorrectionService({
    corrections: new FileCorrectionStore(dir),
    buckets: new FileBucketStore(dir),
    memory: buildMemoryService(),
    transcripts: new FileTranscriptStore(dir),
    verifier: new DeterministicProvenanceVerifier(),
    ...(embedder !== undefined ? { embedder } : {}),
    now: () => new Date(),
  });
}

function buildLifecycle(): {
  lifecycle: CaptureLifecycleService;
  retention: RetentionService;
} {
  const dir = dataDir();
  const memory = buildMemoryService();
  const deps = {
    audio: buildAudioStore(),
    captures: new FileCaptureStore(dir),
    transcripts: new FileTranscriptStore(dir),
    buckets: new FileBucketStore(dir),
    audit: new FileAuditLog(dir),
    now: () => new Date(),
    // Spec 2.1 AC-4: deleting a capture removes or invalidates every
    // memory derived from it.
    extraProjections: [
      {
        name: "memories",
        deleteForCapture: async (
          tenantId: string,
          userId: string,
          captureId: string,
        ) => {
          await memory.removeSource(
            { tenantId, userId },
            { kind: "capture", id: captureId, captureId },
          );
        },
      },
    ],
  };
  return {
    lifecycle: new CaptureLifecycleService(deps),
    retention: new RetentionService(deps),
  };
}

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
  const dir = dataDir();
  const config = await loadModelsConfig(configPath);
  const stack = resolveStack(gatewayFromEnv(), config);
  const store = new FileBucketStore(dir);
  const captures = new FileCaptureStore(dir);
  const transcripts = new FileTranscriptStore(dir);
  const corrections = new CorrectionService({
    corrections: new FileCorrectionStore(dir),
    buckets: store,
    memory: buildMemoryService(),
    transcripts,
    verifier: new DeterministicProvenanceVerifier(),
    embedder: stack.embedder,
    now: () => new Date(),
  });
  const pipeline = new DonnaPipeline({
    transcriber: stack.transcriber,
    organizer: stack.organizer,
    ...(stack.escalationOrganizer !== undefined
      ? { escalationOrganizer: stack.escalationOrganizer }
      : {}),
    embedder: stack.embedder,
    store,
    captures,
    transcripts,
    audio: buildAudioStore(),
    audit: new FileAuditLog(dir),
    bucketTuning: stack.bucketTuning,
    // Spec 2.2: bounded, attributed private-memory context for the
    // organizer, under the budgets from models.config.yaml. Spec 2.3:
    // accepted corrections are injected as bounded personalized examples.
    contextAssembler: new ContextAssembler({
      memory: buildMemoryService(),
      buckets: store,
      captures,
      transcripts,
      corrections,
      budgets: stack.contextBudgets,
      now: () => new Date(),
    }),
    correctionObserver: corrections,
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
    // FR-1 (Spec 1.1): fail BEFORE any gateway request when credentials or
    // the recording are missing. Messages name variables, never values.
    const preflightProblems = gatewayEnvProblems(inspectGatewayEnv());
    try {
      const info = await stat(audioPath);
      if (!info.isFile() || info.size === 0) {
        preflightProblems.push(`audio file is empty or not a regular file: ${audioArg}`);
      }
    } catch {
      preflightProblems.push(`audio file does not exist: ${audioArg}`);
    }
    // Spec 1.3 FR-1: audio must be encryptable before durable storage.
    try {
      parseAudioKey(process.env.DONNA_AUDIO_KEY);
    } catch (error) {
      preflightProblems.push(
        error instanceof AudioKeyError ? error.message : String(error),
      );
    }
    if (preflightProblems.length > 0) {
      console.error(
        "Cannot run capture — prerequisites are not met:\n" +
          preflightProblems.map((p) => `  - ${p}`).join("\n") +
          "\nSet real secret-injected gateway credentials (see .env.example) " +
          "and pass an existing recording. Run `donna compat-check` for a " +
          "sanitized compatibility report.",
      );
      process.exit(1);
    }
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
    if (result.context !== undefined) {
      const degraded = result.context.degraded ? " (degraded)" : "";
      console.log(
        `\n=== Context that influenced this organization${degraded} ===`,
      );
      console.log(
        `packet ${result.context.packetId}: ${result.context.sourceIds.length} source(s)${result.context.sourceIds.length > 0 ? ` — ${result.context.sourceIds.join(", ")}` : ""}`,
      );
    }
    console.log(
      `\n${result.items.length} thoughts, ${result.bucketsCreated.length} new buckets, ${(result.metrics.totalLatencyMs / 1000).toFixed(1)}s total`,
    );
    return;
  }

  if (command === "buckets") {
    const store = new FileBucketStore(dataDir());
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

  if (command === "compat-check") {
    const audioArg = arg("--audio");
    const { report, reportPath } = await runCompatibilityCheck({
      ...(audioArg !== undefined
        ? { audioPath: resolve(invocationDir, audioArg) }
        : {}),
      configPath: resolve(
        repoRoot,
        process.env.DONNA_MODELS_CONFIG ?? "models.config.yaml",
      ),
      reportsDir: resolve(
        repoRoot,
        "packages/evals/reports/compatibility",
      ),
    });
    console.log(`Compatibility status: ${report.status}`);
    if (report.missingPrerequisites.length > 0) {
      console.log("Missing prerequisites:");
      for (const p of report.missingPrerequisites) console.log(`  - ${p}`);
    }
    for (const stage of report.stages) {
      const dims =
        stage.expectedDimensions !== null
          ? ` (${stage.expectedDimensions} dims)`
          : "";
      console.log(
        `  ${stage.stage}: ${stage.model} via ${stage.provider}${dims} — ${stage.status} (${stage.reason})`,
      );
    }
    console.log(`Sanitized report written: ${reportPath}`);
    if (report.status === "blocked") process.exit(1);
    return;
  }

  if (command === "export") {
    const captureId = process.argv[3];
    if (!captureId) {
      console.error("usage: donna export <capture-id> [--user <id>]");
      process.exit(1);
    }
    const { lifecycle } = buildLifecycle();
    const bundle = await lifecycle.exportCapture(tenantId, userId, captureId);
    console.log(JSON.stringify(bundle, null, 2));
    return;
  }

  if (command === "delete-audio") {
    const captureId = process.argv[3];
    if (!captureId) {
      console.error("usage: donna delete-audio <capture-id> [--user <id>]");
      process.exit(1);
    }
    const { lifecycle } = buildLifecycle();
    await lifecycle.deleteAudio(tenantId, userId, captureId);
    console.log(
      `Audio deleted for capture ${captureId}. Transcript and thoughts remain (transcript-only provenance).`,
    );
    return;
  }

  if (command === "delete-capture") {
    const captureId = process.argv[3];
    if (!captureId) {
      console.error("usage: donna delete-capture <capture-id> [--user <id>]");
      process.exit(1);
    }
    const { lifecycle } = buildLifecycle();
    await lifecycle.deleteCapture(tenantId, userId, captureId);
    console.log(
      `Capture ${captureId} and all derived records (audio, transcript, thoughts, embeddings) deleted.`,
    );
    return;
  }

  if (command === "retention") {
    const { retention } = buildLifecycle();
    if (process.argv.includes("--cleanup")) {
      const result = await retention.cleanup(tenantId, userId);
      console.log(
        `Cleanup: ${result.scanned} captures scanned, ${result.expired} expired, ${result.deleted} audio deleted, ${result.alreadyDeleted} already deleted.`,
      );
    }
    const statuses = await retention.statusAll(tenantId, userId);
    if (statuses.length === 0) {
      console.log("No captures yet.");
      return;
    }
    for (const s of statuses) {
      const state = s.audioAvailable
        ? `audio available until ${s.expiresAt}`
        : `transcript-only (audio deleted ${s.audioDeletedAt ?? "never stored"})`;
      console.log(`• ${s.captureId}: captured ${s.capturedAt} — ${state}`);
    }
    return;
  }

  if (command === "memory") {
    const sub = process.argv[3];
    const memory = buildMemoryService();
    const scope = { tenantId, userId };

    if (sub === "list") {
      const layerArg = arg("--layer");
      const showAll = process.argv.includes("--all");
      const records = showAll
        ? await memory.listAll(scope)
        : await memory.listConfirmed(
            scope,
            ...(layerArg !== undefined ? [layerArg as MemoryLayer] : []),
          );
      if (records.length === 0) {
        console.log("No memories yet.");
        return;
      }
      for (const m of records) {
        const status = m.status === "confirmed" ? "" : ` [${m.status}]`;
        const expiry = m.expiresAt !== undefined ? `, expires ${m.expiresAt}` : "";
        console.log(
          `• ${m.id} (${m.layer}/${m.kind}, ${m.origin}, confidence ${m.confidence}${expiry})${status}`,
        );
        console.log(`    ${m.text}`);
        for (const s of m.sources) {
          console.log(`    ↳ source: ${s.kind}:${s.id} — ${s.reason}`);
        }
      }
      return;
    }

    if (sub === "proposals") {
      const pending = await memory.listPendingProposals(scope);
      if (pending.length === 0) {
        console.log("No pending proposals.");
        return;
      }
      console.log("Pending memory proposals (nothing here influences Donna until you approve it):");
      for (const p of pending) {
        console.log(
          `• ${p.id} (${p.layer}/${p.kind}, confidence ${p.confidence}, inferred by ${p.proposedBy.model})`,
        );
        console.log(`    ${p.text}`);
        for (const s of p.sources) {
          console.log(`    ↳ source: ${s.kind}:${s.id} — ${s.reason}`);
        }
      }
      return;
    }

    if (sub === "approve" || sub === "reject") {
      const proposalId = process.argv[4];
      if (!proposalId) {
        console.error(`usage: donna memory ${sub} <proposal-id> [--user <id>]`);
        process.exit(1);
      }
      if (sub === "approve") {
        const record = await memory.approve(scope, proposalId);
        console.log(`Approved. Memory ${record.id} is now confirmed and may inform Donna.`);
      } else {
        await memory.reject(scope, proposalId);
        console.log(`Rejected. Proposal ${proposalId} will never influence Donna.`);
      }
      return;
    }

    if (sub === "remember") {
      const text = process.argv[4];
      const layer = arg("--layer") as MemoryLayer | undefined;
      const kind = arg("--kind");
      if (!text || !layer || !kind) {
        console.error(
          "usage: donna memory remember <text> --layer <working|episodic|semantic|procedural> --kind <kind> [--subject <s>] [--ttl-sec <n>] [--user <id>]",
        );
        process.exit(1);
      }
      const ttlSec = arg("--ttl-sec");
      const record = await memory.stateExplicit(scope, {
        layer,
        kind,
        subject: arg("--subject") ?? `${kind}:${text.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 48)}`,
        text,
        sources: [
          {
            kind: "explicit-statement",
            id: `cli-${randomUUID()}`,
            reason: "stated directly by the user via the CLI",
          },
        ],
        ...(ttlSec !== undefined
          ? { expiresAt: new Date(Date.now() + Number(ttlSec) * 1000).toISOString() }
          : {}),
      });
      console.log(`Remembered (${record.layer}/${record.kind}) as ${record.id}.`);
      return;
    }

    if (sub === "supersede") {
      const memoryId = process.argv[4];
      const text = process.argv[5];
      if (!memoryId || !text) {
        console.error("usage: donna memory supersede <memory-id> <new text> [--user <id>]");
        process.exit(1);
      }
      const next = await memory.supersede(scope, memoryId, { text });
      console.log(
        `Corrected. ${memoryId} is retired (kept as superseded history); ${next.id} is now confirmed.`,
      );
      return;
    }

    if (sub === "forget") {
      const memoryId = process.argv[4];
      if (!memoryId) {
        console.error("usage: donna memory forget <memory-id> [--user <id>]");
        process.exit(1);
      }
      await memory.forget(scope, memoryId);
      console.log(`Forgot ${memoryId}. It will never be served as context again.`);
      return;
    }

    if (sub === "export") {
      const bundle = await memory.exportAll(scope);
      console.log(JSON.stringify(bundle, null, 2));
      return;
    }

    if (sub === "events") {
      const dir = dataDir();
      const events = await new FileMemoryStore(dir).listEvents(tenantId, userId);
      if (events.length === 0) {
        console.log("No memory events yet.");
        return;
      }
      for (const e of events) {
        const target = e.memoryId ?? e.proposalId ?? "-";
        console.log(`• ${e.at} ${e.type} ${target}${e.detail ? ` (${e.detail})` : ""}`);
      }
      return;
    }

    console.error(USAGE);
    process.exit(1);
  }

  if (command === "consent") {
    const sub = process.argv[3];
    const memory = buildMemoryService();
    const scope = { tenantId, userId };

    if (sub === "list") {
      const records = await memory.listConsents(scope);
      if (records.length === 0) {
        console.log("No consent records. Everything that needs consent is off by default.");
        return;
      }
      // Effective state is latest-record-wins; history lines follow.
      const purposes = [...new Set(records.map((r) => r.purpose))];
      for (const purpose of purposes) {
        const history = records.filter((r) => r.purpose === purpose);
        const active = await memory.activeConsent(scope, purpose);
        console.log(
          `• ${purpose}: ${active !== undefined ? "active" : "not granted"} (${history.length} record${history.length === 1 ? "" : "s"})`,
        );
        for (const c of history) {
          console.log(
            `    ↳ ${c.granted ? "granted" : "revoked"} ${c.grantedAt} via ${c.channel}`,
          );
        }
      }
      return;
    }

    if (sub === "grant" || sub === "revoke") {
      const purpose = process.argv[4];
      if (!purpose) {
        console.error(`usage: donna consent ${sub} <purpose> [--user <id>]`);
        process.exit(1);
      }
      if (sub === "grant") {
        await memory.grantConsent(scope, purpose, "cli:consent grant");
        console.log(`Consent granted for "${purpose}". Revoke anytime with: donna consent revoke ${purpose}`);
      } else {
        await memory.revokeConsent(scope, purpose, "cli:consent revoke");
        console.log(`Consent revoked for "${purpose}".`);
      }
      return;
    }

    console.error(USAGE);
    process.exit(1);
  }

  if (command === "thoughts") {
    const store = new FileBucketStore(dataDir());
    const [items, buckets] = await Promise.all([
      store.listItems(tenantId, userId),
      store.listBuckets(tenantId, userId),
    ]);
    if (items.length === 0) {
      console.log("No organized thoughts yet — capture something first.");
      return;
    }
    const names = new Map(buckets.map((b) => [b.id, b.name]));
    for (const item of items) {
      const task = item.thought.task ? " [task]" : "";
      console.log(
        `• ${item.thought.id} [${names.get(item.bucketId) ?? "?"}]${task} ${item.thought.summary}`,
      );
    }
    return;
  }

  if (command === "correct") {
    const sub = process.argv[3];
    const corrections = await buildCorrectionService();
    const scope = { tenantId, userId };
    const store = new FileBucketStore(dataDir());
    const source = {
      kind: "explicit-statement" as const,
      id: `cli-${randomUUID()}`,
      reason: "user correction via the CLI",
    };

    if (sub === "move") {
      const thoughtId = process.argv[4];
      const toName = arg("--to");
      if (!thoughtId || !toName) {
        console.error("usage: donna correct move <thought-id> --to <bucket-name> [--user <id>]");
        process.exit(1);
      }
      const [items, buckets] = await Promise.all([
        store.listItems(tenantId, userId),
        store.listBuckets(tenantId, userId),
      ]);
      const item = items.find((candidate) => candidate.thought.id === thoughtId);
      let target = buckets.find(
        (b) => b.name.trim().toLowerCase() === toName.trim().toLowerCase(),
      );
      if (!item) {
        console.error(`No thought ${thoughtId} in this scope (see: donna thoughts).`);
        process.exit(1);
      }
      if (!target) {
        // A correction can mean "this deserves its own bucket" — the user
        // pins it into existence.
        target = await store.createBucket({
          id: randomUUID(),
          tenantId,
          userId,
          name: toName.trim(),
          description: `Pinned by user correction on ${new Date().toISOString().slice(0, 10)}`,
          centroid: item.thought.embedding ?? [],
          itemCount: 0,
          createdAt: new Date().toISOString(),
          origin: "pinned",
        });
        console.log(`Created bucket "${target.name}" (pinned).`);
      }
      const from = buckets.find((b) => b.id === item.bucketId);
      const event = await corrections.submit(scope, {
        type: "bucket.move",
        target: { kind: "thought", id: thoughtId },
        payload: {
          fromBucketId: item.bucketId,
          fromBucketName: from?.name ?? item.bucketId,
          toBucketId: target.id,
          toBucketName: target.name,
          thoughtSummary: item.thought.summary,
        },
        sources: [
          { kind: "thought", id: thoughtId, captureId: item.thought.provenance.captureId, reason: "the misplaced thought" },
          source,
        ],
      });
      console.log(`Correction ${event.id} queued: move "${item.thought.summary}" → ${target.name}. Review: donna corrections`);
      return;
    }

    if (sub === "rename") {
      const bucketId = process.argv[4];
      const newName = arg("--name");
      if (!bucketId || !newName) {
        console.error("usage: donna correct rename <bucket-id> --name <new-name> [--user <id>]");
        process.exit(1);
      }
      const event = await corrections.submit(scope, {
        type: "bucket.rename",
        target: { kind: "bucket", id: bucketId },
        payload: { newName },
        sources: [source],
      });
      console.log(`Correction ${event.id} queued: rename bucket ${bucketId} → "${newName}".`);
      return;
    }

    if (sub === "merge") {
      const bucketId = process.argv[4];
      const into = arg("--into");
      if (!bucketId || !into) {
        console.error("usage: donna correct merge <bucket-id> --into <bucket-id> [--user <id>]");
        process.exit(1);
      }
      const event = await corrections.submit(scope, {
        type: "bucket.merge",
        target: { kind: "bucket", id: bucketId },
        payload: { intoBucketId: into },
        sources: [source],
      });
      console.log(`Correction ${event.id} queued: merge bucket ${bucketId} into ${into}.`);
      return;
    }

    if (sub === "edit-thought") {
      const thoughtId = process.argv[4];
      const text = arg("--text");
      const summary = arg("--summary");
      if (!thoughtId || (!text && !summary)) {
        console.error("usage: donna correct edit-thought <thought-id> --text <t> [--summary <s>] [--user <id>]");
        process.exit(1);
      }
      const event = await corrections.submit(scope, {
        type: "thought.edit",
        target: { kind: "thought", id: thoughtId },
        payload: {
          ...(text !== undefined ? { text } : {}),
          ...(summary !== undefined ? { summary } : {}),
        },
        sources: [{ kind: "thought", id: thoughtId, reason: "the thought being edited" }, source],
      });
      console.log(`Correction ${event.id} queued: edit thought ${thoughtId}.`);
      return;
    }

    if (sub === "add-task" || sub === "remove-task") {
      const thoughtId = process.argv[4];
      const title = arg("--title");
      if (!thoughtId || (sub === "add-task" && !title)) {
        console.error(`usage: donna correct ${sub} <thought-id>${sub === "add-task" ? " --title <t>" : ""} [--user <id>]`);
        process.exit(1);
      }
      const event = await corrections.submit(scope, {
        type: sub === "add-task" ? "task.add" : "task.remove",
        target: { kind: "thought", id: thoughtId },
        payload: { ...(title !== undefined ? { title } : {}) },
        sources: [{ kind: "thought", id: thoughtId, reason: "the thought being re-classed" }, source],
      });
      console.log(`Correction ${event.id} queued: ${sub} on ${thoughtId}.`);
      return;
    }

    if (sub === "provenance") {
      const thoughtId = process.argv[4];
      const segments = arg("--segments");
      if (!thoughtId || !segments) {
        console.error("usage: donna correct provenance <thought-id> --segments <id,id,...> [--user <id>]");
        process.exit(1);
      }
      const event = await corrections.submit(scope, {
        type: "provenance.correct",
        target: { kind: "thought", id: thoughtId },
        payload: { segmentIds: segments },
        sources: [{ kind: "thought", id: thoughtId, reason: "the thought whose provenance is corrected" }, source],
      });
      console.log(`Correction ${event.id} queued: provenance fix on ${thoughtId}.`);
      return;
    }

    console.error(USAGE);
    process.exit(1);
  }

  if (command === "corrections") {
    const sub = process.argv[3];
    const corrections = await buildCorrectionService();
    const scope = { tenantId, userId };

    if (sub === undefined || sub === "--all" || sub === "--user" || sub?.startsWith("--")) {
      const showAll = process.argv.includes("--all");
      const events = showAll
        ? await corrections.list(scope)
        : await corrections.reviewQueue(scope);
      if (events.length === 0) {
        console.log(showAll ? "No corrections yet." : "Review queue is empty.");
        return;
      }
      for (const e of events) {
        const flags = [
          e.status,
          ...(e.contradictedBy !== undefined ? [`contradicted-by ${e.contradictedBy}`] : []),
          ...(e.sharedAt !== undefined ? ["shared"] : []),
          ...(e.followedCount + e.contradictedCount > 0
            ? [`followed ${e.followedCount}, contradicted ${e.contradictedCount}`]
            : []),
        ].join(", ");
        console.log(`• ${e.id} ${e.type} on ${e.target.kind}:${e.target.id} (${flags})`);
        console.log(`    ${JSON.stringify(e.payload)}`);
      }
      return;
    }

    if (sub === "accept" || sub === "reject" || sub === "delete" || sub === "promote") {
      const id = process.argv[4];
      if (!id) {
        console.error(`usage: donna corrections ${sub} <id> [--user <id>]`);
        process.exit(1);
      }
      if (sub === "accept") {
        const event = await corrections.accept(scope, id);
        const note = event.appliedAt !== undefined ? "applied" : "recorded";
        console.log(`Accepted and ${note}: ${event.type} (${event.id}).`);
      } else if (sub === "reject") {
        await corrections.reject(scope, id);
        console.log(`Rejected ${id}. It will not influence later decisions.`);
      } else if (sub === "delete") {
        await corrections.deleteCorrection(scope, id);
        console.log(`Deleted ${id} and rebuilt derived preferences.`);
      } else {
        const memory = buildMemoryService();
        const result = await promoteCorrectionToGoldenCase(
          {
            corrections: new FileCorrectionStore(dataDir()),
            hasConsent: (purpose) => memory.hasConsent(scope, purpose),
            datasetPath: resolve(repoRoot, "packages/evals/datasets/golden/corrections.v1.json"),
            now: () => new Date(),
          },
          scope,
          id,
        );
        console.log(
          result.alreadyShared
            ? `${id} was already shared as a golden case.`
            : `Shared ${id} as a de-identified golden case (corrections.v1.json).`,
        );
      }
      return;
    }

    if (sub === "replay") {
      const result = await corrections.replay(scope);
      console.log(`Replayed the accepted event log: ${result.derived} derived preference(s) rebuilt.`);
      return;
    }

    if (sub === "stats") {
      const stats = await corrections.stats(scope);
      console.log(`Corrections: ${stats.total} total (${stats.pending} pending, ${stats.accepted} accepted, ${stats.rejected} rejected)`);
      console.log(
        `Adherence: ${stats.followed} followed, ${stats.contradicted} contradicted` +
          (stats.adherenceRate !== null ? ` — rate ${(stats.adherenceRate * 100).toFixed(0)}%` : " — no observations yet"),
      );
      return;
    }

    console.error(USAGE);
    process.exit(1);
  }

  console.error(USAGE);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
