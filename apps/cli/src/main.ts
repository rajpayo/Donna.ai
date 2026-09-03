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
import { runCompatibilityCheck } from "@donna/evals";
import {
  FileConsentStore,
  FileMemoryStore,
  MemoryService,
} from "@donna/memory";
import {
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
  donna consent revoke <purpose> [--user <id>]`;

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
  const pipeline = new DonnaPipeline({
    transcriber: stack.transcriber,
    organizer: stack.organizer,
    ...(stack.escalationOrganizer !== undefined
      ? { escalationOrganizer: stack.escalationOrganizer }
      : {}),
    embedder: stack.embedder,
    store,
    captures: new FileCaptureStore(dir),
    transcripts: new FileTranscriptStore(dir),
    audio: buildAudioStore(),
    audit: new FileAuditLog(dir),
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

  console.error(USAGE);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
