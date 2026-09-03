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
 *   donna session start|end|list               session lifecycle; working
 *                                              memory and emotion die with
 *                                              the session
 *   donna emotion [--session <id>]             view tentative inferences
 *   donna emotion correct|confirm|delete ...   user control over inferences
 *   donna emotion disable|enable               opt out of / into inference
 *                                              (durable persistence needs a
 *                                              separate `consent grant
 *                                              emotion.persist`)
 *   donna items --bucket <name>                list one bucket's contents
 *   donna search <text> [filters]              deterministic local retrieval
 *                                              (full-text; --semantic adds
 *                                              vector similarity via the
 *                                              configured embedder)
 *   donna reindex                              rebuild the retrieval index
 *                                              from the source-of-truth store
 *   donna query <text> [--answer] [--session]  hybrid natural-language
 *                                              retrieval with provenance;
 *                                              --answer adds grounded
 *                                              synthesis (every claim cites
 *                                              live hit IDs, fail-closed)
 *   donna explain-ranking <text>               show the versioned features
 *                                              and weights behind each hit
 *   donna retrieval-feedback <id> --verdict..  relevance feedback, recorded
 *                                              as a correction event
 *
 * This is the internal demo surface: one command turns a messy voice memo
 * into organized, bucketed, provenance-linked thoughts.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { Capture, EventSink, MemoryLayer } from "@donna/core";
import { FileBucketStore } from "@donna/buckets";
import { promoteCorrectionToGoldenCase, runCompatibilityCheck } from "@donna/evals";
import {
  ContextAssembler,
  CorrectionService,
  EmotionalContextService,
  FileConsentStore,
  FileCorrectionStore,
  FileMemoryStore,
  FileSessionStore,
  MemoryService,
} from "@donna/memory";
import {
  DeterministicProvenanceVerifier,
  DonnaPipeline,
  FileCaptureStore,
  FileTranscriptStore,
} from "@donna/pipeline";
import {
  AnswerSynthesizer,
  HybridRetriever,
  LocalRetrievalIndex,
  type HybridRankingConfig,
} from "@donna/retrieval";
import {
  AudioKeyError,
  CaptureLifecycleService,
  EncryptedFileAudioStore,
  FileAuditLog,
  parseAudioKey,
  RetentionService,
} from "@donna/privacy";
import {
  EMOTION_PERSIST_PURPOSE,
  EnrollmentError,
  ExcludedCategoryError,
  FileMisfireRegisterStore,
  FilePilotProfileStore,
  MisfireRegister,
  MISFIRE_CATEGORIES,
  NotEnrolledError,
  PILOT_DATA_CLASSES,
  PILOT_EXPLANATIONS,
  PILOT_REVIEW_CONFIDENCE_THRESHOLD,
  PilotService,
  pilotRedactionActive,
  redactContent,
  type EnrollmentDecisions,
  type MisfireCategory,
} from "@donna/pilot";
import type { M365ReadSourceType } from "@donna/core";
import {
  checkM365Connection,
  disconnectM365,
  inspectM365McpEnv,
  M365_IDENTITY_NOTE,
  M365ContextSource,
  m365ApprovalPathClient,
  m365EndpointFromEnv,
  m365McpEnvProblems,
  m365ReadOnlyClient,
  m365SelectionPlan,
  M365SelectionStore,
  M365SnippetCache,
  ONEDRIVE_DESTINATION_TOOLS,
  OneDriveMarkdownDestination,
  m365ScopeDir,
  parseM365Endpoint,
  type M365SelectionType,
} from "@donna/integrations-m365";
import {
  ActionDraftService,
  FileActionDraftStore,
  McpEmailDraftExecutor,
  SandboxDraftExecutor,
  UnavailableDraftExecutor,
} from "@donna/destinations";
import { M365_CONSENT_PURPOSES, type ActionDraft, type ActionDraftPayload } from "@donna/core";
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
  donna corrections promote <id> [--user <id>]
  donna items --bucket <name> [--user <id>]
  donna search <text> [--bucket <name>] [--from <iso>] [--to <iso>]
       [--task] [--person <name>] [--semantic] [--limit <n>] [--user <id>]
  donna reindex [--user <id>]
  donna query <text> [--bucket <name>] [--from <iso>] [--to <iso>]
       [--task] [--person <name>] [--limit <n>] [--session <id>]
       [--answer] [--user <id>]
  donna explain-ranking <text> [same filters] [--user <id>]
  donna retrieval-feedback <thought-id> --verdict relevant|irrelevant
       --query <text> [--user <id>]
  donna session start [--ttl-sec <n>] [--user <id>]
  donna session end <session-id> [--user <id>]
  donna session list [--user <id>]
  donna emotion [--session <id>] [--user <id>]
  donna emotion correct <snapshot-id> --labels <label:conf,...> | --none [--user <id>]
  donna emotion confirm <snapshot-id> [--user <id>]
  donna emotion delete <snapshot-id> [--user <id>]
  donna emotion disable [--user <id>]
  donna emotion enable [--user <id>]
  donna m365 status                      managed-MCP connection health
                                             (endpoint, gateway auth,
                                             initialize, tool discovery,
                                             one read-only probe)
  donna m365 connect-info [--user <id>]  identity model + Donna-side
                                             consent state per source type
  donna m365 disconnect [--user <id>]    revoke all m365.* consents and
                                             purge cached source snippets
  donna m365 select <email|event|teams-chat|teams-channel|file|sharepoint> <id>
                                         explicitly select one resource as
                                             context (needs the matching
                                             m365.read.* consent)
  donna m365 selected [--user <id>]      list selected resources
  donna m365 unselect <id> [--user <id>] remove a selection
  donna m365 snippets [--user <id>]      cached context snippets (IDs,
                                             source, TTL — never content)
  donna publish <bucket-name> [--show-content]
                                         preview the OneDrive Markdown
                                         publication for a bucket (no write)
  donna publish <bucket-name> --approve  commit EXACTLY the pending preview
                                             (needs m365.destination.onedrive
                                             consent); byte-identical state
                                             is a no-op
  donna draft create email --to <a@b[,c]> [--cc <...>] --subject <s> --body <b> --thoughts <id,id>
  donna draft create teams (--chat <id> | --team <id> --channel <id>) --text <t> --thoughts <id,id>
  donna draft create calendar --title <t> --start <iso> --end <iso> [--attendees <a,b>] --thoughts <id,id>
  donna draft create file --bucket <bucket-id> --thoughts <id,id>
  donna draft create task --title <t> [--due <hint>] --thoughts <id,id>
                                         prepare a typed action draft
                                             (validated, source-linked,
                                             24h expiry; nothing is sent)
  donna draft list [--user <id>]         list drafts (pending first)
  donna draft preview <id> [--user <id>] inspect a draft + source context
  donna draft cancel <id> [--user <id>]  cancel a pending draft
  donna draft commit <id> [--user <id>]  THE APPROVAL PATH: email drafts
                                             create an Outlook DRAFT (never
                                             send); other types are sandbox
                                             commits (no external mutation)
  donna draft capabilities               per-type execution capability
  donna pilot explain                    plain-language pilot explanations
                                             (what Donna stores, what admins
                                             cannot see, what Donna is not)
  donna pilot onboard [flags]            interactive enrollment; every setting
       --participant <pseudonymous-id>   is an affirmative, versioned consent
       [--data-classes <csv>]            record. Defaults are narrow: no M365
       [--m365-sources <csv>]            sources, emotion session-only, no
       [--durable-memory on|off]         emotion persistence. Non-interactive
       [--emotion-inference on|off]      needs every flag plus --affirm.
       [--emotion-persist on|off]
       [--affirm]
  donna pilot status                     enrollment + consent state, capture
                                             and review counts (no content)
  donna pilot review                     the review queue: pending corrections,
                                             memory proposals, low-confidence
                                             thoughts (Spec 6.1 FR-2)
  donna pilot settings                   current per-setting state
  donna pilot set data-classes <csv>     change a setting (records new
  donna pilot set m365-sources <csv>     versioned consent; revoking a source
  donna pilot set durable-memory on|off  purges its cached M365 snippets)
  donna pilot set emotion-inference on|off
  donna pilot set emotion-persist on|off
  donna pilot export --out <file>        full scoped export written to a file
                                             (never dumped to the terminal)
  donna pilot leave --out <file>         exit the pilot: export, revoke all
       [--delete-all]                    consents, disconnect M365; --delete-all
                                             also deletes captures+memories and
                                             verifies the deletion
  donna pilot report-misfire <category> --description <text>
       [--capture <id>] [--thought <id>] [--scenario <id>]
                                         private misfire report with a consent
                                             snapshot (categories: stt,
                                             provenance, organization, memory,
                                             retrieval, context, latency,
                                             integration, other)
  donna pilot misfires                   list the private misfire register

Pilot note: while enrolled, CLI commands redact verbatim transcript text by
default (SR-2). Pass --show-transcripts on capture/search/query/export to
view it in a private terminal.`;

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
  // Spec 6.1 FR-2: when a pilot profile is enrolled with durable memory
  // off, durable-memory creation fails closed everywhere (CLI, correction
  // derivation, future jobs). No profile → non-pilot behavior unchanged.
  const profiles = new FilePilotProfileStore(dir);
  return new MemoryService({
    memories: new FileMemoryStore(dir),
    consents: new FileConsentStore(dir),
    durableMemoryGate: async (scope) => {
      const profile = await profiles.get(scope.tenantId, scope.userId);
      if (profile === undefined || profile.status !== "enrolled") return true;
      return profile.durableMemory;
    },
    now: () => new Date(),
  });
}

function buildPilotService(): PilotService {
  const dir = dataDir();
  return new PilotService({
    profiles: new FilePilotProfileStore(dir),
    memory: buildMemoryService(),
    now: () => new Date(),
  });
}

function buildMisfireRegister(): MisfireRegister {
  return new MisfireRegister(
    new FileMisfireRegisterStore(dataDir()),
    () => new Date(),
    randomUUID,
  );
}

/**
 * SR-2 (Spec 6.1): transcript redaction for shared terminals. Enrolled
 * pilot profiles redact verbatim transcript text by default; the explicit
 * per-invocation `--show-transcripts` flag reveals it. Non-pilot scopes
 * keep the existing demo behavior.
 */
async function transcriptRedaction(tenantId: string, userId: string): Promise<boolean> {
  const profile = await new FilePilotProfileStore(dataDir()).get(tenantId, userId);
  return pilotRedactionActive(profile) && !process.argv.includes("--show-transcripts");
}

function buildEmotionService(): EmotionalContextService {
  const dir = dataDir();
  return new EmotionalContextService({
    sessions: new FileSessionStore(dir),
    memory: buildMemoryService(),
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
  let adherenceThreshold: number | undefined;
  try {
    const config = await loadModelsConfig(
      resolve(repoRoot, process.env.DONNA_MODELS_CONFIG ?? "models.config.yaml"),
    );
    const stack = resolveStack(gatewayFromEnv(), config);
    embedder = stack.embedder;
    adherenceThreshold = stack.corrections.adherenceSemanticThreshold;
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
    ...(adherenceThreshold !== undefined ? { adherenceThreshold } : {}),
    retrievalIndex: buildRetrievalIndex(),
    now: () => new Date(),
  });
}

/**
 * The deterministic local retrieval index (Spec 3.1): a rebuildable
 * projection over the bucket store, with memory links indexed from the
 * memory store.
 */
function buildRetrievalIndex(): LocalRetrievalIndex {
  const dir = dataDir();
  return new LocalRetrievalIndex({
    dataDir: dir,
    store: new FileBucketStore(dir),
    memories: new FileMemoryStore(dir),
  });
}

/**
 * The hybrid retriever (Spec 3.3): versioned, explainable ranking over
 * the local index. The embedder and answer generator come from
 * models.config.yaml via the registry — without gateway credentials the
 * retriever degrades to text-only ranking and no synthesis (FR-1).
 */
async function buildHybridRetriever(): Promise<{
  retriever: HybridRetriever;
  synthesizer: AnswerSynthesizer;
}> {
  const dir = dataDir();
  let embedder;
  let answerGenerator;
  let ranking: HybridRankingConfig | undefined;
  let adherenceThreshold: number | undefined;
  try {
    const config = await loadModelsConfig(
      resolve(repoRoot, process.env.DONNA_MODELS_CONFIG ?? "models.config.yaml"),
    );
    const stack = resolveStack(gatewayFromEnv(), config);
    embedder = stack.embedder;
    answerGenerator = stack.answerGenerator;
    adherenceThreshold = stack.corrections.adherenceSemanticThreshold;
    ranking = {
      version: stack.retrieval.rankingVersion,
      weights: stack.retrieval.weights,
      recencyHalfLifeDays: stack.retrieval.recencyHalfLifeDays,
      candidateLimit: stack.retrieval.candidateLimit,
      minScore: stack.retrieval.minScore,
    };
  } catch {
    embedder = undefined;
    answerGenerator = undefined;
  }
  const corrections = new CorrectionService({
    corrections: new FileCorrectionStore(dir),
    buckets: new FileBucketStore(dir),
    memory: buildMemoryService(),
    transcripts: new FileTranscriptStore(dir),
    verifier: new DeterministicProvenanceVerifier(),
    ...(embedder !== undefined ? { embedder } : {}),
    ...(adherenceThreshold !== undefined
      ? { adherenceThreshold }
      : {}),
    retrievalIndex: buildRetrievalIndex(),
    now: () => new Date(),
  });
  const retriever = new HybridRetriever({
    index: buildRetrievalIndex(),
    buckets: new FileBucketStore(dir),
    corrections,
    ...(embedder !== undefined ? { embedder } : {}),
    ...(ranking !== undefined ? { config: ranking } : {}),
    now: () => new Date(),
  });
  return {
    retriever,
    synthesizer: new AnswerSynthesizer({
      ...(answerGenerator !== undefined ? { generator: answerGenerator } : {}),
    }),
  };
}

/**
 * Audio-window state for a hit's provenance (Spec 3.3): transcript text
 * always; audio playback window while the audio is retained;
 * transcript-only state after expiry/deletion.
 */
async function audioStateLabel(
  captureId: string,
  tenantId: string,
  userId: string,
): Promise<string> {
  const dir = dataDir();
  const capture = await new FileCaptureStore(dir).getCapture(
    tenantId,
    userId,
    captureId,
  );
  if (capture === undefined) return "no capture record";
  if (capture.audioDeletedAt !== undefined) {
    return `transcript-only (audio deleted ${capture.audioDeletedAt})`;
  }
  try {
    const has = await buildAudioStore().has(tenantId, userId, captureId);
    return has ? "audio retained" : "transcript-only (audio expired)";
  } catch {
    return `transcript retained (audio state unverified — no audio key)`;
  }
}

function buildLifecycle(): {
  lifecycle: CaptureLifecycleService;
  retention: RetentionService;
} {
  const dir = dataDir();
  const memory = buildMemoryService();
  const retrieval = buildRetrievalIndex();
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
      // Spec 3.1 FR-4: deleted records disappear from search.
      {
        name: "retrieval-index",
        deleteForCapture: async (
          tenantId: string,
          userId: string,
          captureId: string,
        ) => {
          await retrieval.removeCapture(tenantId, userId, captureId);
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

/**
 * The Spec 5.2 context source, or undefined when the managed MCP is not
 * configured (missing credential/endpoint) — organization then proceeds
 * without external context. Reads are consent-gated per call, so wiring
 * is unconditional once credentials exist.
 */
function buildM365ContextSource(): M365ContextSource | undefined {
  try {
    if (m365McpEnvProblems(inspectM365McpEnv()).length > 0) return undefined;
    return new M365ContextSource({
      connection: m365ReadOnlyClient({
        endpointUrl: m365EndpointFromEnv(),
        apiKey: process.env.TRUEFOUNDRY_API_KEY!,
      }),
      consents: buildMemoryService(),
      dataDir: dataDir(),
    });
  } catch {
    return undefined;
  }
}

/**
 * The Spec 5.3 OneDrive destination, or undefined when the managed MCP is
 * not configured. Uses an approval-path client allowlisted to exactly the
 * destination tools; every call is consent-gated per invocation.
 */
function buildOneDriveDestination(): OneDriveMarkdownDestination | undefined {
  try {
    if (m365McpEnvProblems(inspectM365McpEnv()).length > 0) return undefined;
    return new OneDriveMarkdownDestination({
      connection: m365ApprovalPathClient(
        {
          endpointUrl: m365EndpointFromEnv(),
          apiKey: process.env.TRUEFOUNDRY_API_KEY!,
        },
        ONEDRIVE_DESTINATION_TOOLS,
      ),
      consents: buildMemoryService(),
      buckets: new FileBucketStore(dataDir()),
      dataDir: dataDir(),
    });
  } catch {
    return undefined;
  }
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
  const m365Context = buildM365ContextSource();
  const captures = new FileCaptureStore(dir);
  const transcripts = new FileTranscriptStore(dir);
  const corrections = new CorrectionService({
    corrections: new FileCorrectionStore(dir),
    buckets: store,
    memory: buildMemoryService(),
    transcripts,
    verifier: new DeterministicProvenanceVerifier(),
    embedder: stack.embedder,
    adherenceThreshold: stack.corrections.adherenceSemanticThreshold,
    retrievalIndex: buildRetrievalIndex(),
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
      // Spec 5.2: consent-gated M365 snippets in the untrusted section.
      // Without MCP credentials the source is omitted entirely and
      // organization proceeds unchanged.
      ...(m365Context !== undefined ? { externalContext: m365Context } : {}),
      // Spec 3.3: semantic correction-example selection — without the
      // embedder the assembler silently falls back to keyword overlap and
      // paraphrased captures never surface the user's corrections.
      embedder: stack.embedder,
      similarityThreshold: stack.corrections.adherenceSemanticThreshold,
      now: () => new Date(),
    }),
    correctionObserver: corrections,
    // Spec 2.4: tentative session emotion/intent context (session-scoped,
    // user-correctable, never durable without explicit opt-in).
    emotionalContext: buildEmotionService(),
    // Spec 3.1: placed items are indexed for retrieval as they persist.
    retrievalIndex: buildRetrievalIndex(),
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
    // Spec 6.1 FR-1: an exited pilot profile must re-onboard before any
    // further personal-data processing in this scope.
    const pilotProfile = await new FilePilotProfileStore(dataDir()).get(tenantId, userId);
    if (pilotProfile?.status === "exited") {
      console.error(
        "This scope left the pilot. Re-onboard before capturing again: donna pilot onboard",
      );
      process.exit(1);
    }
    // Spec 6.1 SR-2: enrolled pilot profiles get redacted transcripts by
    // default in shared terminals.
    const redact = pilotRedactionActive(pilotProfile) && !process.argv.includes("--show-transcripts");
    // Spec 2.4: optional session binding enables tentative session
    // emotion/intent context for this capture.
    const sessionId = arg("--session");
    let session: Capture["session"];
    if (sessionId !== undefined) {
      const sessions = new FileSessionStore(dataDir());
      const record = await sessions.getSession(tenantId, userId, sessionId);
      if (record === undefined) {
        console.error(
          `No session ${sessionId} in this scope. Start one with: donna session start`,
        );
        process.exit(1);
      }
      if (record.expiresAt <= new Date().toISOString()) {
        console.error(`Session ${sessionId} has expired. Start a new one.`);
        process.exit(1);
      }
      session = { id: record.id, expiresAt: record.expiresAt };
    }
    const { pipeline } = await buildPipeline();
    const capture: Capture = {
      id: randomUUID(),
      tenantId,
      userId,
      audioPath,
      capturedAt: new Date().toISOString(),
      ...(session !== undefined ? { session } : {}),
    };
    const result = await pipeline.run(capture);

    console.log("\n=== Transcript ===");
    console.log(redactContent(result.transcript.text, !redact));
    console.log("\n=== Organized ===");
    for (const item of result.items) {
      const flag = item.needsReview ? " (needs review)" : "";
      console.log(`• [${item.bucket.name}]${flag} ${item.thought.summary}`);
      if (item.thought.task) {
        console.log(`    ↳ task: ${item.thought.task.title}`);
      }
      console.log(
        `    ↳ source: ${item.thought.provenance.startSec.toFixed(1)}–${item.thought.provenance.endSec.toFixed(1)}s ${redact ? redactContent(item.thought.provenance.sourceText, false) : `"${item.thought.provenance.sourceText.slice(0, 80)}"`}`,
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

  if (command === "items") {
    const bucketName = arg("--bucket");
    if (!bucketName) {
      console.error("usage: donna items --bucket <name> [--user <id>]");
      process.exit(1);
    }
    const store = new FileBucketStore(dataDir());
    const bucket = await store.getBucketByName(tenantId, userId, bucketName);
    if (bucket === undefined) {
      console.error(`No bucket "${bucketName}" in this scope (see: donna buckets).`);
      process.exit(1);
    }
    const items = await store.listItemsByBucket(tenantId, userId, bucket.id);
    if (items.length === 0) {
      console.log(`Bucket "${bucket.name}" is empty.`);
      return;
    }
    console.log(`${bucket.name} — ${items.length} item(s):`);
    for (const item of items) {
      const task = item.thought.task ? " [task]" : "";
      console.log(`• ${item.thought.id}${task} ${item.thought.summary}`);
      console.log(
        `    ↳ source: capture ${item.thought.provenance.captureId}, ` +
          `${item.thought.provenance.startSec.toFixed(1)}–${item.thought.provenance.endSec.toFixed(1)}s, ` +
          `segments ${item.thought.provenance.segmentIds.join(", ")}`,
      );
    }
    return;
  }

  if (command === "search" || command === "reindex") {
    const index = buildRetrievalIndex();
    if (command === "reindex") {
      const result = await index.rebuild(tenantId, userId);
      console.log(
        `Rebuilt the retrieval index from the source-of-truth store: ${result.indexed} item(s) indexed.`,
      );
      return;
    }

    const text = process.argv[3];
    if (!text || text.startsWith("--")) {
      console.error(
        "usage: donna search <text> [--bucket <name>] [--from <iso>] [--to <iso>] [--task] [--person <name>] [--semantic] [--limit <n>] [--user <id>]",
      );
      process.exit(1);
    }

    const filters: NonNullable<Parameters<typeof index.search>[0]["filters"]> = {};
    const bucketName = arg("--bucket");
    if (bucketName !== undefined) {
      const store = new FileBucketStore(dataDir());
      const bucket = await store.getBucketByName(tenantId, userId, bucketName);
      if (bucket === undefined) {
        console.error(`No bucket "${bucketName}" in this scope (see: donna buckets).`);
        process.exit(1);
      }
      filters.bucketIds = [bucket.id];
    }
    const from = arg("--from");
    const to = arg("--to");
    if (from !== undefined) filters.createdFrom = from;
    if (to !== undefined) filters.createdTo = to;
    if (process.argv.includes("--task")) filters.hasTask = true;
    const person = arg("--person");
    if (person !== undefined) filters.people = [person];
    const limitArg = arg("--limit");
    const limit = limitArg !== undefined ? Number(limitArg) : undefined;

    // --semantic: embed the query with the configured embedder so cosine
    // similarity over the stored thought embeddings joins the ranking.
    let embedding: number[] | undefined;
    if (process.argv.includes("--semantic")) {
      try {
        const config = await loadModelsConfig(
          resolve(repoRoot, process.env.DONNA_MODELS_CONFIG ?? "models.config.yaml"),
        );
        const embedder = resolveStack(gatewayFromEnv(), config).embedder;
        [embedding] = await embedder.embed([text]);
      } catch (error) {
        console.error(
          `Cannot embed the query (--semantic needs live gateway credentials): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        process.exit(1);
      }
    }

    const started = Date.now();
    const hits = await index.search({
      tenantId,
      userId,
      text,
      ...(embedding !== undefined ? { embedding } : {}),
      ...(Object.keys(filters).length > 0 ? { filters } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    // SR-2: search logs carry timing and counts, never query/result text.
    console.error(`[telemetry] retrieval.search ms=${Date.now() - started} hits=${hits.length}`);

    if (hits.length === 0) {
      console.log("No matching thoughts.");
      return;
    }
    const redactSearch = await transcriptRedaction(tenantId, userId);
    for (const hit of hits) {
      const p = hit.thought.provenance;
      console.log(
        `• [${hit.bucketName}] ${hit.thought.summary}  (score ${hit.scores.combined.toFixed(3)}: text ${hit.scores.text.toFixed(3)}, semantic ${hit.scores.semantic.toFixed(3)})`,
      );
      console.log(`    thought ${hit.thought.id} · captured in ${p.captureId}`);
      console.log(
        `    ↳ provenance: segments ${p.segmentIds.join(", ")}, audio ${p.startSec.toFixed(1)}–${p.endSec.toFixed(1)}s`,
      );
      console.log(`    ↳ source: ${redactSearch ? redactContent(p.sourceText, false) : `"${p.sourceText}"`}`);
    }
    return;
  }

  if (command === "query" || command === "explain-ranking") {
    const text = process.argv[3];
    if (!text || text.startsWith("--")) {
      console.error(
        `usage: donna ${command} <text> [--bucket <name>] [--from <iso>] [--to <iso>] [--task] [--person <name>] [--limit <n>] [--session <id>]${command === "query" ? " [--answer]" : ""} [--user <id>]`,
      );
      process.exit(1);
    }
    const { retriever, synthesizer } = await buildHybridRetriever();

    const filters: Record<string, unknown> = {};
    const bucketName = arg("--bucket");
    if (bucketName !== undefined) {
      const store = new FileBucketStore(dataDir());
      const bucket = await store.getBucketByName(tenantId, userId, bucketName);
      if (bucket === undefined) {
        console.error(`No bucket "${bucketName}" in this scope (see: donna buckets).`);
        process.exit(1);
      }
      filters["bucketIds"] = [bucket.id];
    }
    const from = arg("--from");
    const to = arg("--to");
    if (from !== undefined) filters["createdFrom"] = from;
    if (to !== undefined) filters["createdTo"] = to;
    if (process.argv.includes("--task")) filters["hasTask"] = true;
    const person = arg("--person");
    if (person !== undefined) filters["people"] = [person];
    const limitArg = arg("--limit");

    // Follow-up support (Spec 3.3): within a session, prior queries live
    // in working memory and expand a follow-up that finds nothing.
    const sessionId = arg("--session");
    let sessionContext: string[] | undefined;
    let sessionExpiry: string | undefined;
    if (sessionId !== undefined) {
      const sessions = new FileSessionStore(dataDir());
      const session = await sessions.getSession(tenantId, userId, sessionId);
      if (session === undefined) {
        console.error(`No session ${sessionId} in this scope. Start one with: donna session start`);
        process.exit(1);
      }
      if (session.expiresAt <= new Date().toISOString()) {
        console.error(`Session ${sessionId} has expired. Start a new one.`);
        process.exit(1);
      }
      sessionExpiry = session.expiresAt;
      const working = await buildMemoryService().listConfirmed(
        { tenantId, userId },
        "working",
      );
      sessionContext = working
        .filter((record) => record.sessionId === sessionId && record.kind === "retrieval-query")
        .map((record) => record.text)
        .slice(-3);
    }

    const started = Date.now();
    const hits = await retriever.search(
      { tenantId, userId },
      {
        text,
        ...(Object.keys(filters).length > 0
          ? { filters: filters as Parameters<typeof retriever.search>[1]["filters"] }
          : {}),
        ...(limitArg !== undefined ? { limit: Number(limitArg) } : {}),
        ...(sessionContext !== undefined && sessionContext.length > 0
          ? { sessionContext }
          : {}),
      },
    );
    // SR-2: telemetry carries timing and counts, never query/result text.
    console.error(`[telemetry] retrieval.query ms=${Date.now() - started} hits=${hits.length}`);

    // Record the query in session working memory (expires with the session).
    if (sessionId !== undefined && sessionExpiry !== undefined) {
      await buildMemoryService().stateExplicit(
        { tenantId, userId },
        {
          layer: "working",
          kind: "retrieval-query",
          subject: `retrieval-query:${randomUUID()}`,
          text,
          sources: [
            { kind: "session", id: sessionId, reason: "retrieval query in this session" },
          ],
          expiresAt: sessionExpiry,
          sessionId,
        },
      );
    }

    if (command === "explain-ranking") {
      const description = retriever.describeRanking();
      console.log(`Ranking version: ${description.version}`);
      console.log(
        `Weights: ${Object.entries(description.weights)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}`,
      );
      if (hits.length === 0) {
        console.log("No hits above the relevance floor.");
        return;
      }
      for (const hit of hits) {
        const f = hit.features;
        const w = hit.weights;
        console.log(`• ${hit.thought.id} [${hit.bucketName}] combined ${hit.scores.combined.toFixed(3)}`);
        console.log(
          `    text ${f.text.toFixed(3)}×${w.text} + semantic ${f.semantic.toFixed(3)}×${w.semantic} + bucket ${f.bucketAffinity.toFixed(3)}×${w.bucketAffinity}`,
        );
        console.log(
          `    recency ${f.recency.toFixed(3)}×${w.recency} + personalization ${f.personalization.toFixed(3)}×${w.personalization} + task ${f.taskMatch.toFixed(3)}×${w.taskMatch}`,
        );
      }
      return;
    }

    // Direct hits first — always, with or without synthesis (FR-1).
    if (hits.length === 0) {
      console.log("No matching thoughts above the relevance floor.");
    }
    const redactQuery = await transcriptRedaction(tenantId, userId);
    for (const [index, hit] of hits.entries()) {
      const p = hit.thought.provenance;
      const audio = await audioStateLabel(p.captureId, tenantId, userId);
      console.log(
        `• [H${index + 1}] [${hit.bucketName}] ${hit.thought.summary}  (score ${hit.scores.combined.toFixed(3)})`,
      );
      console.log(`    thought ${hit.thought.id} · ${audio}`);
      console.log(
        `    ↳ provenance: capture ${p.captureId}, segments ${p.segmentIds.join(", ")}, audio ${p.startSec.toFixed(1)}–${p.endSec.toFixed(1)}s`,
      );
      console.log(`    ↳ source: ${redactQuery ? redactContent(p.sourceText, false) : `"${p.sourceText}"`}`);
    }

    if (process.argv.includes("--answer")) {
      let answer;
      let generatorFailed = false;
      try {
        answer = await synthesizer.answer(text, hits);
      } catch {
        // Fail closed: a generator error (including an upstream guardrail
        // rejection) means no synthesized answer, never a raw one.
        generatorFailed = true;
        answer = undefined;
      }
      if (generatorFailed) {
        console.log("\nAnswer synthesis failed closed (generator error) — the direct hits above are the source of truth.");
      } else if (answer === undefined) {
        console.log("\nAnswer synthesis is not configured (retrieval.answer lane) — showing direct hits only.");
      } else if (!answer.supported) {
        // Fail closed: never present ungrounded text as an answer.
        console.log(
          `\nNo grounded answer could be synthesized from the stored evidence (${answer.failureReason}). The direct hits above are the source of truth.`,
        );
      } else {
        console.log(`\n=== Grounded answer (${answer.model}, ${answer.promptVersion}) ===`);
        console.log(answer.text);
        console.log(`Cited hits: ${answer.citations.join(", ")}`);
      }
    }
    return;
  }

  if (command === "retrieval-feedback") {
    const thoughtId = process.argv[3];
    const verdict = arg("--verdict");
    const queryText = arg("--query");
    if (!thoughtId || (verdict !== "relevant" && verdict !== "irrelevant") || !queryText) {
      console.error(
        "usage: donna retrieval-feedback <thought-id> --verdict relevant|irrelevant --query <text> [--user <id>]",
      );
      process.exit(1);
    }
    // FR-4: relevance feedback becomes a correction event (review queue).
    const corrections = await buildCorrectionService();
    const event = await corrections.submit(
      { tenantId, userId },
      {
        type: "retrieval.relevance",
        target: { kind: "retrieval", id: thoughtId },
        payload: { verdict, query: queryText },
        sources: [
          { kind: "thought", id: thoughtId, reason: "hit the feedback is about" },
          {
            kind: "explicit-statement",
            id: `cli-${randomUUID()}`,
            reason: "user retrieval feedback via the CLI",
          },
        ],
      },
    );
    console.log(
      `Retrieval feedback recorded as correction ${event.id} (${verdict}). Review: donna corrections`,
    );
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
      console.error("usage: donna export <capture-id> [--user <id>] [--show-transcripts]");
      process.exit(1);
    }
    // SR-2 (Spec 6.1): an enrolled pilot profile never dumps transcripts to
    // a shared terminal by default — the pilot export writes to a file.
    if (await transcriptRedaction(tenantId, userId)) {
      console.error(
        "Transcript dumps to the terminal are redacted while enrolled in the pilot (SR-2).\n" +
          "Use `donna pilot export --out <file>` to write your export to a file, " +
          "or re-run with --show-transcripts in a private terminal.",
      );
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

  if (command === "session") {
    const sub = process.argv[3];
    const emotion = buildEmotionService();
    const scope = { tenantId, userId };

    if (sub === "start") {
      const ttlSec = Number(arg("--ttl-sec") ?? 4 * 3600);
      const session = await emotion.startSession(scope, ttlSec);
      console.log(`Session ${session.id} started (expires ${session.expiresAt}).`);
      console.log(`Bind a capture with: donna capture <audio> --session ${session.id}`);
      return;
    }

    if (sub === "end") {
      const sessionId = process.argv[4];
      if (!sessionId) {
        console.error("usage: donna session end <session-id> [--user <id>]");
        process.exit(1);
      }
      const result = await emotion.endSession(scope, sessionId);
      const promoted =
        result.promoted > 0
          ? `, ${result.promoted} emotional snapshot(s) promoted to durable memory under your emotion.persist consent`
          : ", no emotional context retained";
      console.log(
        `Session ended. ${result.workingRemoved} working memorie(s) expired, ${result.deleted} session snapshot(s) cleared${promoted}.`,
      );
      return;
    }

    if (sub === "list") {
      const sessions = await new FileSessionStore(dataDir()).listSessions(tenantId, userId);
      if (sessions.length === 0) {
        console.log("No sessions yet.");
        return;
      }
      for (const s of sessions) {
        const state = s.endedAt !== undefined ? `ended ${s.endedAt}` : `expires ${s.expiresAt}`;
        console.log(`• ${s.id}: started ${s.startedAt}, ${state}`);
      }
      return;
    }

    console.error(USAGE);
    process.exit(1);
  }

  if (command === "emotion") {
    const sub = process.argv[3];
    const emotion = buildEmotionService();
    const scope = { tenantId, userId };

    // `donna emotion [--session <id>]` — inspect current inferences.
    if (sub === undefined || sub === "--session" || sub === "--user" || sub?.startsWith("--")) {
      const sessionId = arg("--session");
      const enabled = await emotion.isEnabled(scope);
      if (!enabled) {
        console.log("Emotion inference is disabled. Re-enable with: donna emotion enable");
        return;
      }
      const snapshots = await emotion.listSnapshots(
        scope,
        ...(sessionId !== undefined ? [sessionId] : []),
      );
      if (snapshots.length === 0) {
        console.log("No session inferences. They are session-scoped and disappear when the session ends.");
        return;
      }
      console.log("Tentative session inferences (guesses from word choice — may be wrong; correct or disable anytime):");
      for (const s of snapshots) {
        const labels =
          s.labels.length > 0
            ? s.labels.map((l) => `possibly ${l.label} (${l.confidence.toFixed(2)})`).join(", ")
            : "no strong signal (abstained)";
        console.log(`• ${s.id} [${s.correctionState}] session ${s.sessionId}: ${labels}`);
        console.log(`    inferred by ${s.model} ${s.version}, expires ${s.expiresAt}`);
      }
      return;
    }

    if (sub === "correct") {
      const snapshotId = process.argv[4];
      const labelsArg = arg("--labels");
      const none = process.argv.includes("--none");
      if (!snapshotId || (!labelsArg && !none)) {
        console.error(
          "usage: donna emotion correct <snapshot-id> --labels <label:confidence,...> | --none [--user <id>]",
        );
        process.exit(1);
      }
      const labels = none
        ? []
        : labelsArg!.split(",").map((pair) => {
            const [label, confidence] = pair.split(":");
            return {
              label: label!.trim() as "urgency" | "frustration" | "uncertainty" | "positive",
              confidence: Number(confidence ?? 0.5),
            };
          });
      const corrected = await emotion.correct(scope, snapshotId, labels);
      console.log(
        labels.length === 0
          ? `Corrected ${snapshotId}: marked as "no strong emotion". Thanks — Donna will stay tentative.`
          : `Corrected ${snapshotId}: now ${labels.map((l) => `${l.label} (${l.confidence})`).join(", ")}.`,
      );
      return;
    }

    if (sub === "confirm" || sub === "delete") {
      const snapshotId = process.argv[4];
      if (!snapshotId) {
        console.error(`usage: donna emotion ${sub} <snapshot-id> [--user <id>]`);
        process.exit(1);
      }
      if (sub === "confirm") {
        await emotion.confirm(scope, snapshotId);
        console.log(`Confirmed ${snapshotId}.`);
      } else {
        await emotion.deleteSnapshot(scope, snapshotId);
        console.log(`Deleted ${snapshotId}.`);
      }
      return;
    }

    if (sub === "disable" || sub === "enable") {
      if (sub === "disable") {
        await emotion.disable(scope, "cli:emotion disable");
        console.log("Emotion inference disabled. The core capture loop is unaffected.");
      } else {
        await emotion.enable(scope, "cli:emotion enable");
        console.log("Emotion inference enabled (session-scoped, tentative, never durable without separate opt-in).");
      }
      return;
    }

    console.error(USAGE);
    process.exit(1);
  }

  if (command === "m365") {
    const sub = process.argv[3];
    const scope = { tenantId, userId };

    if (sub === "status") {
      // Spec 5.1 AC-1: endpoint config → gateway auth → initialize →
      // tool discovery → one read-only probe. Stage failures are redacted
      // by construction (statuses and counts only — never credentials or
      // Microsoft content). The probe discards what it reads.
      const report = await checkM365Connection();
      console.log(`Managed MCP endpoint: ${report.endpointHost}`);
      for (const stage of report.stages) {
        console.log(`  ${stage.ok ? "ok  " : "FAIL"} ${stage.stage} — ${stage.detail}`);
      }
      if (report.tools !== undefined) {
        console.log(
          `Tools: ${report.tools.total} (${report.tools.read} read / ${report.tools.write} write-draft / ${report.tools.unknown} unknown)`,
        );
      }
      if (report.ok) {
        console.log("Connection healthy. Read tools only from the context layer; writes need the approval path.");
      } else {
        console.error("Connection is NOT healthy — fix the first FAIL stage and re-run.");
        process.exit(1);
      }
      return;
    }

    if (sub === "connect-info") {
      const endpoint = m365EndpointFromEnv();
      console.log(`Managed MCP endpoint: ${parseM365Endpoint(endpoint).host}`);
      console.log(M365_IDENTITY_NOTE);
      console.log("\nDonna-side source consent (independent of Microsoft OAuth):");
      const memory = buildMemoryService();
      for (const purpose of M365_CONSENT_PURPOSES) {
        const active = await memory.hasConsent(scope, purpose);
        console.log(
          `  • ${purpose}: ${active ? "active" : "not granted"}${active ? "" : ` — grant with: donna consent grant ${purpose}`}`,
        );
      }
      return;
    }

    if (sub === "disconnect") {
      // Spec 5.1: stop calling the MCP (revoke every m365.* grant so all
      // consent gates fail closed) and purge cached source snippets.
      const result = await disconnectM365(buildMemoryService(), scope, dataDir());
      console.log(
        `Disconnected. Revoked ${result.revokedPurposes.length} consent grant(s)` +
          `${result.revokedPurposes.length > 0 ? ` (${result.revokedPurposes.join(", ")})` : ""}` +
          `; cached source snippets ${result.purgedCache ? "purged" : "none cached"}.`,
      );
      console.log("Donna will make no further Microsoft 365 calls until you re-grant consent.");
      return;
    }

    if (sub === "select") {
      // Spec 5.2: only explicitly selected resources are ever fetched.
      // Selection itself requires the matching Donna-side consent grant.
      const typeArg = process.argv[4];
      const resourceId = process.argv[5];
      const typeMap: Record<string, M365SelectionType> = {
        email: "email",
        event: "calendar-event",
        "teams-chat": "teams-chat",
        "teams-channel": "teams-channel",
        file: "file",
        sharepoint: "sharepoint-item",
      };
      const type = typeArg !== undefined ? typeMap[typeArg] : undefined;
      if (type === undefined || resourceId === undefined || resourceId.startsWith("--")) {
        console.error(
          "usage: donna m365 select <email|event|teams-chat|teams-channel|file|sharepoint> <id> [--user <id>]",
        );
        process.exit(1);
      }
      let plan;
      try {
        plan = m365SelectionPlan(type, resourceId);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
      const memory = buildMemoryService();
      if (!(await memory.hasConsent(scope, plan.consentPurpose))) {
        console.error(
          `Cannot select — this needs an active Donna-side consent: donna consent grant ${plan.consentPurpose}`,
        );
        process.exit(1);
      }
      const selection = await new M365SelectionStore(dataDir()).select(
        scope,
        type,
        resourceId,
      );
      console.log(
        `Selected ${selection.type} ${selection.resourceId} (consent ${selection.consentPurpose}; fetched via ${selection.fetch.tool}). ` +
          `It joins capture context on the next capture. Undo: donna m365 unselect ${selection.resourceId}`,
      );
      return;
    }

    if (sub === "selected") {
      const selections = await new M365SelectionStore(dataDir()).list(scope);
      if (selections.length === 0) {
        console.log("No Microsoft 365 resources selected. Calendar context (consent-gated) still applies per capture window.");
        return;
      }
      const memory = buildMemoryService();
      for (const s of selections) {
        const consent = (await memory.hasConsent(scope, s.consentPurpose))
          ? "consent active"
          : "CONSENT REVOKED — not read";
        console.log(`• ${s.type} ${s.resourceId} — selected ${s.selectedAt}, ${consent}`);
      }
      return;
    }

    if (sub === "unselect") {
      const resourceId = process.argv[4];
      if (resourceId === undefined || resourceId.startsWith("--")) {
        console.error("usage: donna m365 unselect <id> [--user <id>]");
        process.exit(1);
      }
      const removed = await new M365SelectionStore(dataDir()).unselect(scope, resourceId);
      console.log(
        removed
          ? `Unselected ${resourceId}. It will not be fetched again; cached snippets expire with their TTL.`
          : `No selection for ${resourceId} in this scope.`,
      );
      return;
    }

    if (sub === "snippets") {
      // Visibility (FR-2): identifiers, source, and TTL only — excerpts
      // (Microsoft content) are never printed here.
      const snippets = await new M365SnippetCache(dataDir()).list(scope);
      if (snippets.length === 0) {
        console.log("No cached snippets. Snippets appear after a capture reads consented M365 context and expire with their TTL.");
        return;
      }
      for (const s of snippets) {
        console.log(
          `• ${s.id} — ${s.source.resourceType} ${s.source.resourceId} via ${s.source.tool}`,
        );
        console.log(
          `    ↳ consent ${s.consentPurpose}; fetched ${s.fetchedAt}; expires ${s.expiresAt}; excerpt ${s.excerpt.length} chars`,
        );
      }
      return;
    }

    console.error(USAGE);
    process.exit(1);
  }

  if (command === "publish") {
    // Spec 5.3: preview → explicit --approve → commit. No auto-publish.
    const bucketName = process.argv[3];
    if (bucketName === undefined || bucketName.startsWith("--")) {
      console.error("usage: donna publish <bucket-name> [--approve] [--show-content] [--user <id>]");
      process.exit(1);
    }
    const destination = buildOneDriveDestination();
    if (destination === undefined) {
      console.error("The managed MCP is not configured (TRUEFOUNDRY_API_KEY / DONNA_M365_MCP_URL).");
      process.exit(1);
    }
    const store = new FileBucketStore(dataDir());
    const bucket = await store.getBucketByName(tenantId, userId, bucketName);
    if (bucket === undefined) {
      console.error(`No bucket "${bucketName}" in this scope (see: donna buckets).`);
      process.exit(1);
    }

    if (!process.argv.includes("--approve")) {
      // Preview only — nothing is written externally.
      let preview;
      try {
        preview = await destination.preview(scope0(tenantId, userId), bucket.id);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
      await destination.savePendingPreview(scope0(tenantId, userId), bucket.id, preview);
      const items = await store.listItemsByBucket(tenantId, userId, bucket.id);
      console.log(`Preview: ${preview.target.folder}${preview.target.documentName}`);
      console.log(`  ${items.length} item(s); content sha256 ${preview.contentHash.slice(0, 16)}… (${preview.content.length} bytes)`);
      console.log(
        preview.noOp
          ? "  Remote already holds exactly this content — committing is a no-op."
          : preview.existingHash !== undefined
            ? `  Remote holds different content (${preview.existingHash.slice(0, 16)}…) — committing overwrites it in place.`
            : "  No remote document yet — committing creates the folder/file as needed.",
      );
      const prior = await destination.state(scope0(tenantId, userId), bucket.id);
      if (prior !== undefined) {
        console.log(
          `  Last published: ${prior.publishedAt ?? "unknown"} (item ${prior.itemId ?? "?"}, hash ${prior.contentHash?.slice(0, 16) ?? "?"}…${prior.link !== undefined ? ", organization link recorded" : ""})`,
        );
      }
      if (process.argv.includes("--show-content")) {
        console.log("\n--- rendered document ---\n" + preview.content + "--- end ---");
      }
      console.log(`\nTo publish exactly this, run: donna publish ${bucketName} --approve`);
      return;
    }

    // Commit exactly the pending preview.
    const pending = await destination.loadPendingPreview(scope0(tenantId, userId), bucket.id);
    if (pending === undefined) {
      console.error(`No pending preview for "${bucketName}". Run: donna publish ${bucketName}`);
      process.exit(1);
    }
    try {
      const commit = await destination.commit(scope0(tenantId, userId), pending.preview);
      await destination.recordCommit(
        scope0(tenantId, userId),
        bucket.id,
        bucket.name,
        pending.preview.target.documentName,
        commit,
      );
      console.log(
        commit.noOp
          ? `No-op: ${pending.preview.target.folder}${pending.preview.target.documentName} already holds exactly this content (item ${commit.itemId}).`
          : `Published ${pending.preview.target.folder}${pending.preview.target.documentName} (item ${commit.itemId}, hash ${commit.contentHash.slice(0, 16)}…${commit.link !== undefined ? ", organization-scoped link recorded" : ""}).`,
      );
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      const message = error instanceof Error ? error.message : String(error);
      if (name === "PreviewStaleError") {
        console.error(`${message}`);
      } else {
        console.error(`Publish failed: ${message}`);
      }
      process.exit(1);
    }
    return;
  }

  if (command === "draft") {
    const sub = process.argv[3];
    const drafts = buildDraftService();
    const scope = scope0(tenantId, userId);

    if (sub === "capabilities") {
      for (const cap of drafts.capabilities()) {
        console.log(`• ${cap.type}: ${cap.capability} — ${cap.note}`);
      }
      return;
    }

    if (sub === "create") {
      const kind = process.argv[4];
      const thoughtsArg = arg("--thoughts");
      if (kind === undefined || thoughtsArg === undefined) {
        console.error(
          "usage: donna draft create <email|teams|calendar|file|task> <type flags> --thoughts <id,id> [--user <id>]",
        );
        process.exit(1);
      }
      const sourceThoughtIds = thoughtsArg.split(",").map((s) => s.trim()).filter((s) => s !== "");
      let payload: ActionDraftPayload;
      if (kind === "email") {
        const to = (arg("--to") ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
        const cc = (arg("--cc") ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
        payload = {
          type: "email-draft",
          to,
          ...(cc.length > 0 ? { cc } : {}),
          subject: arg("--subject") ?? "",
          body: arg("--body") ?? "",
        };
      } else if (kind === "teams") {
        const chatId = arg("--chat");
        const teamId = arg("--team");
        const channelId = arg("--channel");
        payload = {
          type: "teams-message",
          target:
            chatId !== undefined
              ? { chatId }
              : { teamId: teamId ?? "", channelId: channelId ?? "" },
          text: arg("--text") ?? "",
        };
      } else if (kind === "calendar") {
        const attendees = (arg("--attendees") ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
        payload = {
          type: "calendar-proposal",
          title: arg("--title") ?? "",
          start: arg("--start") ?? "",
          end: arg("--end") ?? "",
          ...(attendees.length > 0 ? { attendees } : {}),
          ...(arg("--notes") !== undefined ? { notes: arg("--notes")! } : {}),
        };
      } else if (kind === "file") {
        payload = { type: "file-publication", bucketId: arg("--bucket") ?? "" };
      } else if (kind === "task") {
        payload = {
          type: "task-action",
          title: arg("--title") ?? "",
          ...(arg("--due") !== undefined ? { dueHint: arg("--due")! } : {}),
          ...(arg("--notes") !== undefined ? { notes: arg("--notes")! } : {}),
        };
      } else {
        console.error(`unknown draft type "${kind}" (email|teams|calendar|file|task)`);
        process.exit(1);
      }
      try {
        const draft = await drafts.create(scope, { payload, sourceThoughtIds });
        console.log(
          `Draft ${draft.id} (${draft.type}) created — pending until ${draft.expiresAt}. Nothing was sent or posted.`,
        );
        console.log(`Inspect: donna draft preview ${draft.id} — Commit (approval): donna draft commit ${draft.id}`);
      } catch (error) {
        if (error instanceof Error && error.name === "DraftValidationError") {
          console.error(error.message);
        } else {
          console.error(error instanceof Error ? error.message : String(error));
        }
        process.exit(1);
      }
      return;
    }

    if (sub === "list") {
      const all = await drafts.list(scope);
      if (all.length === 0) {
        console.log("No drafts. Create one with: donna draft create ...");
        return;
      }
      const ordered = [...all].sort((a, b) =>
        a.status === b.status
          ? b.createdAt.localeCompare(a.createdAt)
          : a.status === "pending"
            ? -1
            : b.status === "pending"
              ? 1
              : a.status.localeCompare(b.status),
      );
      for (const d of ordered) {
        console.log(`• ${d.id} (${d.type}) ${d.status} — expires ${d.expiresAt}, sources ${d.sourceThoughtIds.join(", ")}`);
      }
      return;
    }

    if (sub === "preview") {
      const id = process.argv[4];
      if (id === undefined || id.startsWith("--")) {
        console.error("usage: donna draft preview <id> [--user <id>]");
        process.exit(1);
      }
      renderDraftPreview(await drafts.get(scope, id));
      return;
    }

    if (sub === "cancel") {
      const id = process.argv[4];
      if (id === undefined || id.startsWith("--")) {
        console.error("usage: donna draft cancel <id> [--user <id>]");
        process.exit(1);
      }
      const cancelled = await drafts.cancel(scope, id);
      console.log(`Cancelled draft ${cancelled.id}. It can never be committed.`);
      return;
    }

    if (sub === "commit") {
      // THE APPROVAL PATH (Spec 5.4): explicit human invocation only.
      // email-draft → create_draft (Outlook DRAFT, never send). Other
      // types → sandbox commit (no external mutation).
      const id = process.argv[4];
      if (id === undefined || id.startsWith("--")) {
        console.error("usage: donna draft commit <id> [--user <id>]");
        process.exit(1);
      }
      try {
        const committed = await drafts.commit(scope, id);
        console.log(
          `Committed draft ${committed.id} (${committed.type}): ${committed.commitResult?.note ?? "done"}` +
            `${committed.commitResult?.externalId !== undefined ? ` — external ID ${committed.commitResult.externalId}` : ""}.`,
        );
        if (committed.type === "email-draft") {
          console.log("An Outlook DRAFT was created in the mailbox. It was NOT sent — review and send it from Outlook.");
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
      return;
    }

    console.error(USAGE);
    process.exit(1);
  }

  if (command === "pilot") {
    const sub = process.argv[3];
    const scope = scope0(tenantId, userId);
    const pilot = buildPilotService();
    const dir = dataDir();

    if (sub === "explain") {
      console.log(`Donna pilot — plain-language explanations (consent text ${"pilot-consent.v1"})`);
      for (const explanation of PILOT_EXPLANATIONS) {
        console.log(`\n## ${explanation.title}\n${explanation.body}`);
      }
      return;
    }

    if (sub === "onboard") {
      const participantFlag = arg("--participant");
      let decisions: EnrollmentDecisions;
      if (participantFlag !== undefined) {
        // Non-interactive: every decision comes from flags; --affirm is the
        // affirmative acknowledgement (explanations + audio retention +
        // not-authoritative).
        const onoff = (flag: string): boolean | undefined => {
          const v = arg(flag);
          if (v === undefined) return undefined;
          if (v === "on") return true;
          if (v === "off") return false;
          console.error(`${flag} expects on|off`);
          process.exit(1);
        };
        const durable = onoff("--durable-memory");
        const inference = onoff("--emotion-inference");
        const persist = onoff("--emotion-persist");
        if (durable === undefined || inference === undefined || persist === undefined) {
          console.error(
            "Non-interactive onboarding needs --durable-memory, --emotion-inference, and --emotion-persist (on|off).",
          );
          process.exit(1);
        }
        if (!process.argv.includes("--affirm")) {
          console.error(
            "Non-interactive onboarding needs --affirm: you confirm you read `donna pilot explain`, " +
              "accept 7-day encrypted audio retention, and understand Donna is not authoritative and does not act autonomously.",
          );
          process.exit(1);
        }
        const dataClassesArg = arg("--data-classes");
        decisions = {
          participantId: participantFlag,
          dataClasses:
            dataClassesArg !== undefined
              ? dataClassesArg.split(",").map((s) => s.trim()).filter((s) => s !== "")
              : [...PILOT_DATA_CLASSES],
          m365Sources: (arg("--m365-sources") ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s !== "") as M365ReadSourceType[],
          durableMemory: durable,
          emotionInference: inference,
          emotionPersistence: persist,
          acknowledgements: { explanations: true, audioRetention: true, notAuthoritative: true },
        };
      } else {
        decisions = await promptOnboarding();
      }
      try {
        const profile = await pilot.enroll(scope, decisions);
        console.log(`\nEnrolled as ${profile.participantId} (consent text ${profile.consentTextVersion}).`);
        console.log(`  data classes: ${profile.dataClasses.join(", ")}`);
        console.log(
          `  Microsoft 365 sources: ${profile.m365Sources.length > 0 ? profile.m365Sources.join(", ") : "none (narrow default)"}`,
        );
        console.log(`  durable memory: ${profile.durableMemory ? "on" : "off"}`);
        console.log(
          `  emotion: ${profile.emotionInference ? "session-only inference" : "inference off"}, persistence ${profile.emotionPersistence ? "ON (opted in)" : "off (default)"}`,
        );
        console.log(`  audio: encrypted, auto-deleted after ${profile.audioRetentionDays} days`);
        console.log("\nEvery choice is a versioned consent record. Inspect: donna consent list · Change: donna pilot set …");
        console.log("First capture: donna capture <audio-file>");
      } catch (error) {
        if (error instanceof EnrollmentError || error instanceof ExcludedCategoryError) {
          console.error(error.message);
        } else {
          console.error(error instanceof Error ? error.message : String(error));
        }
        process.exit(1);
      }
      return;
    }

    if (sub === "status") {
      const profile = await pilot.getProfile(scope);
      if (profile === undefined) {
        console.log("Not enrolled. Run: donna pilot onboard");
        return;
      }
      console.log(`Pilot profile: ${profile.participantId} — ${profile.status} (consent text ${profile.consentTextVersion})`);
      console.log(`  enrolled ${profile.enrolledAt}${profile.exitedAt !== undefined ? `, exited ${profile.exitedAt}` : ""}`);
      console.log(`  data classes: ${profile.dataClasses.join(", ")}`);
      console.log(`  m365 sources: ${profile.m365Sources.length > 0 ? profile.m365Sources.join(", ") : "none"}`);
      console.log(`  durable memory: ${profile.durableMemory ? "on" : "off"}; emotion inference: ${profile.emotionInference ? "session-only" : "off"}; emotion persistence: ${profile.emotionPersistence ? "on" : "off"}`);
      const memory = buildMemoryService();
      const purposes = [...new Set((await memory.listConsents(scope)).map((r) => r.purpose))];
      if (purposes.length > 0) {
        console.log("  consent state:");
        for (const purpose of purposes) {
          console.log(`    • ${purpose}: ${(await memory.hasConsent(scope, purpose)) ? "active" : "not granted"}`);
        }
      }
      // Counts only — status never prints content (SR-2).
      const store = new FileBucketStore(dir);
      const [items, buckets, captures, pendingCorrections, pendingProposals, misfires, retentionStatuses] =
        await Promise.all([
          store.listItems(tenantId, userId),
          store.listBuckets(tenantId, userId),
          new FileCaptureStore(dir).listCaptures(tenantId, userId),
          (await buildCorrectionService()).reviewQueue(scope),
          memory.listPendingProposals(scope),
          buildMisfireRegister().list(scope),
          buildLifecycle().retention.statusAll(tenantId, userId),
        ]);
      const audioRetained = retentionStatuses.filter((s) => s.audioAvailable).length;
      const lowConfidence = items.filter((i) => i.thought.confidence < PILOT_REVIEW_CONFIDENCE_THRESHOLD).length;
      console.log("  state (counts only):");
      console.log(`    captures: ${captures.length} (${audioRetained} with audio retained, ${retentionStatuses.length - audioRetained} transcript-only)`);
      console.log(`    buckets: ${buckets.length}; thoughts: ${items.length} (${lowConfidence} low-confidence)`);
      console.log(`    awaiting review: ${pendingCorrections.length} correction(s), ${pendingProposals.length} memory proposal(s)`);
      console.log(`    misfire register: ${misfires.length} report(s) (${misfires.filter((m) => m.status === "open").length} open)`);
      return;
    }

    if (sub === "settings") {
      const profile = await requireEnrolledCli(pilot, scope);
      console.log(`Pilot settings for ${profile.participantId} (consent text ${profile.consentTextVersion}):`);
      console.log(`  data-classes:      ${profile.dataClasses.join(", ")}  — change: donna pilot set data-classes <csv>`);
      console.log(`  m365-sources:      ${profile.m365Sources.length > 0 ? profile.m365Sources.join(", ") : "none"}  — change: donna pilot set m365-sources <csv>`);
      console.log(`  durable-memory:    ${profile.durableMemory ? "on" : "off"}  — change: donna pilot set durable-memory on|off`);
      console.log(`  emotion-inference: ${profile.emotionInference ? "on (session-only)" : "off"}  — change: donna pilot set emotion-inference on|off`);
      console.log(`  emotion-persist:   ${profile.emotionPersistence ? "on" : "off"}  — change: donna pilot set emotion-persist on|off`);
      console.log(`  audio retention:   ${profile.audioRetentionDays} days, encrypted, then auto-deleted (fixed pilot policy)`);
      console.log("  excluded from the pilot: HR, legal, financial, KYC, payment content (rejected by configuration)");
      return;
    }

    if (sub === "set") {
      const setting = process.argv[4];
      const value = process.argv[5];
      if (setting === undefined || value === undefined || value.startsWith("--")) {
        console.error(
          "usage: donna pilot set <data-classes|m365-sources> <csv> | donna pilot set <durable-memory|emotion-inference|emotion-persist> on|off",
        );
        process.exit(1);
      }
      try {
        if (setting === "data-classes") {
          const result = await pilot.updateDataClasses(scope, value.split(",").map((s) => s.trim()).filter((s) => s !== ""));
          console.log(
            `Data classes now: ${result.profile.dataClasses.join(", ")}` +
              `${result.granted.length > 0 ? ` (granted: ${result.granted.join(", ")})` : ""}` +
              `${result.revoked.length > 0 ? ` (revoked: ${result.revoked.join(", ")})` : ""}.`,
          );
        } else if (setting === "m365-sources") {
          const next = value.split(",").map((s) => s.trim()).filter((s) => s !== "") as M365ReadSourceType[];
          const result = await pilot.updateM365Sources(scope, next);
          // Revoked sources: fail every read closed (consent gate) AND purge
          // cached snippets + selections of the revoked types.
          if (result.revoked.length > 0) {
            const selections = await new M365SelectionStore(dir).list(scope);
            const typeToSource: Record<string, M365ReadSourceType> = {
              email: "mail",
              "calendar-event": "calendar",
              "teams-chat": "teams",
              "teams-channel": "teams",
              file: "files",
              "sharepoint-item": "files",
            };
            let unselected = 0;
            for (const selection of selections) {
              const source = typeToSource[selection.type];
              if (source !== undefined && result.revoked.includes(source)) {
                await new M365SelectionStore(dir).unselect(scope, selection.resourceId);
                unselected += 1;
              }
            }
            let purged = false;
            try {
              await rm(m365ScopeDir(dir, scope), { recursive: true });
              purged = true;
            } catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            }
            console.log(
              `Revoked: ${result.revoked.join(", ")} — reads now fail closed; ${unselected} selection(s) removed; cached snippets ${purged ? "purged" : "none cached"}.`,
            );
          }
          console.log(`Microsoft 365 sources now: ${result.profile.m365Sources.length > 0 ? result.profile.m365Sources.join(", ") : "none"}.`);
        } else if (setting === "durable-memory" || setting === "emotion-inference" || setting === "emotion-persist") {
          if (value !== "on" && value !== "off") {
            console.error(`donna pilot set ${setting} expects on|off`);
            process.exit(1);
          }
          const on = value === "on";
          if (setting === "durable-memory") {
            const profile = await pilot.setDurableMemory(scope, on);
            console.log(`Durable memory ${profile.durableMemory ? "on" : "off"}.${on ? "" : " New durable memories now fail closed; existing memories are untouched — forget them with: donna memory forget <id>"}`);
          } else if (setting === "emotion-inference") {
            const profile = await pilot.setEmotionInference(scope, on);
            const emotion = buildEmotionService();
            if (on) await emotion.enable(scope, "cli:pilot set emotion-inference");
            else await emotion.disable(scope, "cli:pilot set emotion-inference");
            console.log(`Emotion inference ${profile.emotionInference ? "on (session-only, tentative)" : "off"}; persistence ${profile.emotionPersistence ? "on" : "off"}.`);
          } else {
            const profile = await pilot.setEmotionPersistence(scope, on);
            console.log(`Emotion persistence ${profile.emotionPersistence ? "on (separate opt-in recorded)" : "off"}.`);
          }
        } else {
          console.error(`Unknown pilot setting "${setting}".`);
          process.exit(1);
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
      return;
    }

    if (sub === "review") {
      const profile = await requireEnrolledCli(pilot, scope);
      const memory = buildMemoryService();
      const corrections = await buildCorrectionService();
      const [pendingCorrections, pendingProposals, items, buckets] = await Promise.all([
        corrections.reviewQueue(scope),
        memory.listPendingProposals(scope),
        new FileBucketStore(dir).listItems(tenantId, userId),
        new FileBucketStore(dir).listBuckets(tenantId, userId),
      ]);
      const bucketNames = new Map(buckets.map((b) => [b.id, b.name]));
      const lowConfidence = items.filter((i) => i.thought.confidence < PILOT_REVIEW_CONFIDENCE_THRESHOLD);
      console.log(`Review queue for ${profile.participantId} — nothing here influences Donna until you decide.`);
      console.log(`\nPending corrections (${pendingCorrections.length}):`);
      for (const e of pendingCorrections) {
        console.log(`  • ${e.id} ${e.type} on ${e.target.kind}:${e.target.id}`);
      }
      if (pendingCorrections.length > 0) {
        console.log("  decide: donna corrections accept|reject <id>");
      }
      console.log(`\nPending memory proposals (${pendingProposals.length}):`);
      for (const p of pendingProposals) {
        console.log(`  • ${p.id} (${p.layer}/${p.kind}, confidence ${p.confidence}) ${p.text}`);
      }
      if (pendingProposals.length > 0) {
        console.log("  decide: donna memory approve|reject <id>");
      }
      console.log(`\nLow-confidence thoughts (${lowConfidence.length}, organizer confidence < ${PILOT_REVIEW_CONFIDENCE_THRESHOLD}):`);
      for (const item of lowConfidence) {
        console.log(`  • ${item.thought.id} [${bucketNames.get(item.bucketId) ?? "?"}] (${item.thought.confidence.toFixed(2)}) ${item.thought.summary}`);
      }
      if (lowConfidence.length > 0) {
        console.log("  fix placement: donna correct move <thought-id> --to <bucket-name>");
      }
      return;
    }

    if (sub === "export") {
      const profile = await requireEnrolledCli(pilot, scope);
      const out = arg("--out");
      if (out === undefined) {
        console.error("usage: donna pilot export --out <file> — the export writes to a file, never the terminal (SR-2).");
        process.exit(1);
      }
      const bundle = await pilot.exportBundle(scope, {
        captures: await new FileCaptureStore(dir).listCaptures(tenantId, userId),
        corrections: await (await buildCorrectionService()).list(scope),
        misfires: await buildMisfireRegister().list(scope),
      });
      const outPath = resolve(invocationDir, out);
      await mkdir(dirname(outPath), { recursive: true, mode: 0o700 });
      await writeFile(outPath, JSON.stringify(bundle, null, 2) + "\n", { mode: 0o600 });
      console.log(
        `Export written to ${outPath} (mode 0600): ${bundle.captures.length} capture(s), ` +
          `${bundle.memory.memories.length} memor(ies), ${bundle.corrections.length} correction(s), ` +
          `${bundle.misfires.length} misfire report(s), ${bundle.memory.consents.length} consent record(s).`,
      );
      console.log(`Participant ${profile.participantId}; exported ${bundle.exportedAt}.`);
      return;
    }

    if (sub === "leave") {
      const profile = await requireEnrolledCli(pilot, scope);
      const out = arg("--out");
      if (out === undefined) {
        console.error(
          "usage: donna pilot leave --out <file> [--delete-all]\n" +
            "Leaving always exports your data to a file first, then revokes every consent and disconnects Microsoft 365.",
        );
        process.exit(1);
      }
      // 1. Export first — data portability before any revocation/deletion.
      const bundle = await pilot.exportBundle(scope, {
        captures: await new FileCaptureStore(dir).listCaptures(tenantId, userId),
        corrections: await (await buildCorrectionService()).list(scope),
        misfires: await buildMisfireRegister().list(scope),
      });
      const outPath = resolve(invocationDir, out);
      await mkdir(dirname(outPath), { recursive: true, mode: 0o700 });
      await writeFile(outPath, JSON.stringify(bundle, null, 2) + "\n", { mode: 0o600 });
      console.log(`Exported everything to ${outPath} (mode 0600) before leaving.`);

      // 2. Disconnect Microsoft 365 (revokes m365.* grants, purges cache).
      const disconnect = await disconnectM365(buildMemoryService(), scope, dir, "pilot:leave");
      console.log(`Microsoft 365 disconnected (${disconnect.revokedPurposes.length} grant(s) revoked, cache ${disconnect.purgedCache ? "purged" : "none cached"}).`);

      // 3. Revoke every remaining active consent; mark exited.
      const { revokedPurposes } = await pilot.exit(scope);
      console.log(`Revoked ${revokedPurposes.length} consent purpose(s) total. Consent history is kept as an audit trail.`);

      // 4. Optional verified deletion of content stores.
      if (process.argv.includes("--delete-all")) {
        const { lifecycle } = buildLifecycle();
        const captures = await new FileCaptureStore(dir).listCaptures(tenantId, userId);
        for (const capture of captures) {
          await lifecycle.deleteCapture(tenantId, userId, capture.id);
        }
        // Sessions + emotional snapshots + intents (far-future sweep removes all).
        await new FileSessionStore(dir).sweepExpired(tenantId, userId, "9999-12-31T23:59:59.999Z");
        // Remaining memories and proposals (explicit ones not capture-derived).
        const memory = buildMemoryService();
        for (const record of await memory.listAll(scope)) {
          await memory.forget(scope, record.id);
        }
        const memoryStore = new FileMemoryStore(dir);
        for (const proposal of await memoryStore.listProposals(tenantId, userId)) {
          await memoryStore.deleteProposal(tenantId, userId, proposal.id);
        }
        const corrections = await buildCorrectionService();
        for (const event of await corrections.list(scope)) {
          await corrections.deleteCorrection(scope, event.id);
        }
        await new FileMisfireRegisterStore(dir).saveAll(tenantId, userId, []);
        for (const selection of await new M365SelectionStore(dir).list(scope)) {
          await new M365SelectionStore(dir).unselect(scope, selection.resourceId);
        }

        // Verified deletion: re-list every content store and report counts.
        const remaining = {
          captures: (await new FileCaptureStore(dir).listCaptures(tenantId, userId)).length,
          thoughts: (await new FileBucketStore(dir).listItems(tenantId, userId)).length,
          memories: (await memory.listAll(scope)).length,
          proposals: (await memoryStore.listProposals(tenantId, userId)).length,
          corrections: (await corrections.list(scope)).length,
          sessions: (await new FileSessionStore(dir).listSessions(tenantId, userId)).length,
          misfires: (await buildMisfireRegister().list(scope)).length,
          m365Selections: (await new M365SelectionStore(dir).list(scope)).length,
        };
        const leftover = Object.entries(remaining).filter(([, n]) => n > 0);
        console.log("Deletion verification (each must be 0):");
        for (const [storeName, n] of Object.entries(remaining)) {
          console.log(`  ${storeName}: ${n}`);
        }
        if (leftover.length > 0) {
          console.error(`DELETION INCOMPLETE: ${leftover.map(([k, n]) => `${k}=${n}`).join(", ")}`);
          process.exit(1);
        }
        console.log("Verified: no captures, thoughts, memories, proposals, corrections, sessions, misfires, or selections remain. Consent history and the exited profile are kept as the audit trail.");
      }
      console.log(`Left the pilot, ${profile.participantId}. Thank you.`);
      return;
    }

    if (sub === "report-misfire") {
      const profile = await requireEnrolledCli(pilot, scope);
      const category = process.argv[4];
      const description = arg("--description");
      if (category === undefined || !MISFIRE_CATEGORIES.includes(category as MisfireCategory) || description === undefined) {
        console.error(
          `usage: donna pilot report-misfire <${MISFIRE_CATEGORIES.join("|")}> --description <text> [--capture <id>] [--thought <id>] [--correction <id>] [--scenario <id>]`,
        );
        process.exit(1);
      }
      const evalSharing = await buildMemoryService().hasConsent(scope, "eval-sharing");
      const record = await buildMisfireRegister().report(scope, {
        category: category as MisfireCategory,
        description,
        participantId: profile.participantId,
        consent: { evalSharing },
        ...(arg("--capture") !== undefined ? { captureId: arg("--capture")! } : {}),
        ...(arg("--thought") !== undefined ? { thoughtId: arg("--thought")! } : {}),
        ...(arg("--correction") !== undefined ? { correctionId: arg("--correction")! } : {}),
        ...(arg("--scenario") !== undefined ? { scenarioId: arg("--scenario")! } : {}),
      });
      console.log(
        `Misfire ${record.id} recorded privately (category ${record.category}). ` +
          `It stays in your partition${record.consent.evalSharing ? "; eval-sharing consent is active, so triage may propose it as a de-identified golden case" : " — you have NOT consented to eval sharing, so it can never become a shared golden case"}.`,
      );
      return;
    }

    if (sub === "misfires") {
      await requireEnrolledCli(pilot, scope);
      const records = await buildMisfireRegister().list(scope);
      if (records.length === 0) {
        console.log("No misfire reports. Report one with: donna pilot report-misfire <category> --description <text>");
        return;
      }
      for (const r of records) {
        const links = [r.captureId !== undefined ? `capture ${r.captureId}` : undefined, r.thoughtId !== undefined ? `thought ${r.thoughtId}` : undefined]
          .filter((x) => x !== undefined)
          .join(", ");
        console.log(`• ${r.id} [${r.status}] ${r.category} — reported ${r.reportedAt}${links !== "" ? ` (${links})` : ""}`);
        console.log(`    ${r.description}`);
        console.log(`    ↳ eval-sharing consent at report time: ${r.consent.evalSharing ? "active" : "not granted"}`);
      }
      return;
    }

    console.error(USAGE);
    process.exit(1);
  }

  console.error(USAGE);
  process.exit(1);
}

async function requireEnrolledCli(
  pilot: PilotService,
  scope: { tenantId: string; userId: string },
) {
  try {
    return await pilot.requireEnrolled(scope);
  } catch (error) {
    if (error instanceof NotEnrolledError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

/** Interactive onboarding (Spec 6.1 AC-1): explanations, per-setting
 * prompts with narrow defaults, and an explicit final affirmation. */
async function promptOnboarding(): Promise<EnrollmentDecisions> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // The async iterator buffers input lines, so piped (non-TTY) answers
  // arriving before their prompt are not dropped.
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question: string): Promise<string> => {
    process.stdout.write(question);
    const next = await lines.next();
    if (next.done) {
      console.error("\nOnboarding aborted — input ended before all answers were given. Nothing was recorded.");
      process.exit(1);
    }
    return next.value.trim();
  };
  try {
    console.log("Donna pilot onboarding. Read each explanation carefully — onboarding asks you to confirm them.");
    for (const explanation of PILOT_EXPLANATIONS) {
      console.log(`\n## ${explanation.title}\n${explanation.body}`);
    }
    console.log("");
    const participantId = await ask("Your pseudonymous participant ID (e.g. P-02 — never your name or email): ");
    const classesAnswer = await ask(`Data classes you will capture [all of: ${PILOT_DATA_CLASSES.join(", ")}]: `);
    const sourcesAnswer = await ask("Microsoft 365 sources Donna may read (calendar,mail,teams,files) [none]: ");
    const durableAnswer = await ask("Allow durable cross-session memory (facts/preferences you approve)? (yes/no) [yes]: ");
    const inferenceAnswer = await ask("Allow tentative, session-only emotion inference? (yes/no) [yes]: ");
    const persistAnswer = await ask("Also persist emotional context beyond sessions (separate opt-in)? (yes/no) [no]: ");
    const yes = (answer: string, fallback: boolean): boolean =>
      answer === "" ? fallback : /^y(es)?$/i.test(answer);
    const affirm = await ask(
      "\nType 'yes' to confirm: you read the explanations above, accept 7-day encrypted audio retention, " +
        "and understand Donna organizes and drafts but is not authoritative and does not act autonomously: ",
    );
    if (!/^yes$/i.test(affirm)) {
      console.error("Onboarding aborted — nothing was recorded. Re-run: donna pilot onboard");
      process.exit(1);
    }
    return {
      participantId,
      dataClasses:
        classesAnswer === ""
          ? [...PILOT_DATA_CLASSES]
          : classesAnswer.split(",").map((s) => s.trim()).filter((s) => s !== ""),
      m365Sources: sourcesAnswer
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "") as M365ReadSourceType[],
      durableMemory: yes(durableAnswer, true),
      emotionInference: yes(inferenceAnswer, true),
      emotionPersistence: yes(persistAnswer, false),
      acknowledgements: { explanations: true, audioRetention: true, notAuthoritative: true },
    };
  } finally {
    rl.close();
  }
}

function scope0(tenantId: string, userId: string): { tenantId: string; userId: string } {
  return { tenantId, userId };
}

/**
 * The Spec 5.4 draft service. Drafts persist inside the M365 scoped
 * partition so `m365 disconnect` purges them with everything else
 * (SR-3). The email executor is wired only when the managed MCP is
 * configured, on an approval-path connection allowlisted to create_draft
 * alone — it can create an Outlook DRAFT and can never send.
 */
function buildDraftService(): ActionDraftService {
  const dir = dataDir();
  const executors = [];
  try {
    if (m365McpEnvProblems(inspectM365McpEnv()).length === 0) {
      executors.push(
        new McpEmailDraftExecutor(
          m365ApprovalPathClient(
            { endpointUrl: m365EndpointFromEnv(), apiKey: process.env.TRUEFOUNDRY_API_KEY! },
            ["create_draft"],
          ),
        ),
      );
    }
  } catch {
    // No MCP configuration — email drafts stay creatable but uncommittable.
  }
  executors.push(
    new SandboxDraftExecutor(
      "teams-message",
      "Posts via send_chat_message/post_channel_message — gated for the agent approval runtime; sandbox commit performs no mutation.",
    ),
    new SandboxDraftExecutor(
      "calendar-proposal",
      "Creates events via create_event — gated for the agent approval runtime; sandbox commit performs no mutation.",
    ),
    new SandboxDraftExecutor(
      "file-publication",
      "Publish through the approved OneDrive Markdown destination (donna publish); sandbox commit performs no mutation.",
    ),
    new UnavailableDraftExecutor(
      "task-action",
      "The managed MCP exposes no Planner/To Do tools (verified 2026-09-03); task execution is deferred to a future integration.",
    ),
  );
  const buckets = new FileBucketStore(dir);
  return new ActionDraftService({
    store: new FileActionDraftStore((scope) => m365ScopeDir(dir, scope)),
    executors,
    now: () => new Date(),
    thoughtExists: async (scope, thoughtId) =>
      (await buckets.getItem(scope.tenantId, scope.userId, thoughtId)) !== undefined,
  });
}

function renderDraftPreview(draft: ActionDraft): void {
  console.log(`Draft ${draft.id} (${draft.type}) — ${draft.status}`);
  console.log(`  created ${draft.createdAt}; expires ${draft.expiresAt}`);
  if (draft.cancelledAt !== undefined) {
    console.log(`  cancelled ${draft.cancelledAt} (${draft.cancelReason ?? "no reason"})`);
  }
  if (draft.committedAt !== undefined) {
    console.log(
      `  committed ${draft.committedAt} — ${draft.commitResult?.note ?? ""}${draft.commitResult?.externalId !== undefined ? ` (external ${draft.commitResult.externalId})` : ""}`,
    );
  }
  console.log(`  source thoughts: ${draft.sourceThoughtIds.join(", ")}`);
  const p = draft.payload;
  switch (p.type) {
    case "email-draft":
      console.log(`  to: ${p.to.join(", ")}${p.cc !== undefined && p.cc.length > 0 ? ` cc: ${p.cc.join(", ")}` : ""}`);
      console.log(`  subject: ${p.subject}`);
      console.log(`  body:\n${p.body.split("\n").map((l) => `    ${l}`).join("\n")}`);
      break;
    case "teams-message":
      console.log(
        `  target: ${"chatId" in p.target ? `chat ${p.target.chatId}` : `team ${p.target.teamId} channel ${p.target.channelId}`}`,
      );
      console.log(`  text: ${p.text}`);
      break;
    case "calendar-proposal":
      console.log(`  title: ${p.title}`);
      console.log(`  when: ${p.start} → ${p.end}`);
      if (p.attendees !== undefined && p.attendees.length > 0) {
        console.log(`  attendees: ${p.attendees.join(", ")}`);
      }
      if (p.notes !== undefined) console.log(`  notes: ${p.notes}`);
      break;
    case "file-publication":
      console.log(`  bucket: ${p.bucketId}`);
      break;
    case "task-action":
      console.log(`  title: ${p.title}${p.dueHint !== undefined ? ` (due ${p.dueHint})` : ""}`);
      if (p.notes !== undefined) console.log(`  notes: ${p.notes}`);
      break;
  }
}

main().catch((err) => {
  // Domain errors (consent gates, enrollment refusals, not-found) carry
  // actionable messages — print those, not a stack trace, on this
  // pilot-facing surface.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
