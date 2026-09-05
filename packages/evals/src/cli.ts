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
import { existsSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import {
  inspectGatewayEnv,
  gatewayEnvProblems,
  loadModelsConfig,
  resolveStack,
  type ModelsConfig,
  type ResolvedStack,
} from "@donna/providers";
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { FileBucketStore } from "@donna/buckets";
import {
  ContextAssembler,
  FileConsentStore,
  FileCorrectionStore,
  FileMemoryStore,
  MemoryService,
} from "@donna/memory";
import { FileCaptureStore, FileTranscriptStore } from "@donna/pipeline";
import {
  FilePilotDecisionStore,
  latestDecisionsPerThought,
} from "@donna/pilot";
import { ensurePrivateDirectory, writePrivateFile } from "@donna/file-security";
import { loadDataset } from "./datasets.js";
import { runEval, type StageScorer } from "./harness.js";
import type { EvalReport } from "./report.js";
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
import {
  buildBlindedReviewPacket,
  assertNoFreshResults,
  canRetryFreshFinal,
  loadCandidateReports,
  selectCandidate,
  sha256,
  validateContentFreeReview,
  validateFreshEnvelope,
  validatePrivateDiagnosticEvidence,
  validateLockedPlan,
  type ContentFreeReview,
  type PrivateMintedReviewSource,
  type PrivateReviewMap,
  type SelectionRecord,
  type FreshLock,
} from "./organize-experiment.js";
import { createOrganizeV2Scorer } from "./scorers/organize-v2.js";
import {
  buildV2ReviewPacket,
  evaluateV2Eligibility,
  loadV2Reports,
  summarizeV2Review,
  validateLockedV2Plan,
  type V2ReviewSource,
} from "./organize-v2-experiment.js";

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
  // Spec 6.7: the structured-routing dev envelope with fixture IDs.
  "organize-dev-v2": "datasets/golden/organize/organize.dev.v2.json",
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
async function liveStack(modelsPath = configPath()): Promise<LiveStack | undefined> {
  const problems = gatewayEnvProblems(inspectGatewayEnv());
  if (problems.length > 0) return undefined;
  const config = await loadModelsConfig(modelsPath);
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
        ...(live !== undefined ? { meteredGateway: live.metered } : {}),
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

function experimentPlanPath(): string {
  const supplied = arg("--plan");
  if (supplied === undefined) {
    return join(evalsDir, "experiments/organize/6.6/plan.json");
  }
  return resolveRepoOrCwd(supplied);
}

function resolveRepoOrCwd(supplied: string): string {
  if (resolve(supplied) === supplied) return supplied;
  const fromCwd = resolve(process.cwd(), supplied);
  return existsSync(fromCwd) ? fromCwd : resolve(repoRoot, supplied);
}

function experimentReportsRoot(): string {
  return join(evalsDir, "reports", "organize", "6.6");
}

async function moveRunArtifact(from: string, to: string): Promise<void> {
  await rm(to, { force: true });
  await rename(from, to);
}

async function readSelection(path: string): Promise<SelectionRecord> {
  return JSON.parse(await readFile(path, "utf8")) as SelectionRecord;
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

  if (command === "organize-experiment") {
    const action = stage;
    const planPath = experimentPlanPath();
    const validated = await validateLockedPlan({ planPath, repoRoot });
    const reportsRoot = experimentReportsRoot();
    if (action === "validate") {
      console.log(
        `PLAN LOCKED: ${validated.plan.candidates.map((candidate) => candidate.id).join("/")} — ` +
          `${validated.plan.candidates.length * 3} binding dev runs`,
      );
      console.log(
        validated.plan.tariff.candidateC === "excluded"
          ? "C OMITTED — NO AUTHORITATIVE TARIFF; no Sonnet capability request or run is authorized"
          : "C ADMITTED — TARIFF VERIFIED",
      );
      console.log(
        `dev ${validated.plan.datasets.dev.name} v${validated.plan.datasets.dev.version} ` +
          `${validated.plan.datasets.dev.cases} cases sha256:${validated.plan.datasets.dev.sha256}`,
      );
      console.log(`plan sha256:${validated.planSha256}`);
      return;
    }

    if (action === "run") {
      const candidateId = arg("--candidate");
      const candidate = validated.plan.candidates.find(
        (item) => item.id === candidateId,
      );
      if (candidate === undefined) {
        throw new Error(
          `--candidate must be one of ${validated.plan.candidates.map((item) => item.id).join(", ")}`,
        );
      }
      const candidateDir = join(reportsRoot, candidate.id);
      await ensurePrivateDirectory(candidateDir);
      const existing = await readdir(candidateDir);
      if (existing.some((name) => /^replicate-\d+\.(json|md)$/.test(name))) {
        throw new Error(
          `${candidate.id}: binding results already exist; fixed replicates cannot be rerun or replaced`,
        );
      }
      const candidateConfig = resolve(repoRoot, candidate.configPath);
      const live = await liveStack(candidateConfig);
      if (live === undefined) {
        throw new Error(
          "TrueFoundry gateway prerequisites are absent; zero binding runs were started",
        );
      }
      for (let replicate = 1; replicate <= candidate.replicates; replicate++) {
        const reviewItems: PrivateMintedReviewSource[] = [];
        console.log(
          `DEV ONLY — candidate ${candidate.id} — run ${replicate} of 3 — ` +
            `dataset ${validated.plan.datasets.dev.sha256.slice(0, 12)}… ` +
            `config ${candidate.configSha256.slice(0, 12)}… ` +
            `prompt ${candidate.promptSha256.slice(0, 12)}…`,
        );
        console.log("prompt-input audit: no label fields supplied");
        const scorer = createOrganizeScorer({
          organizer: live.stack.organizer,
          meteredGateway: live.metered,
          onMintedReviewItem: (item) => {
            reviewItems.push({
              candidate: candidate.id,
              replicate,
              ...item,
            });
          },
        });
        const result = await runEval({
          datasetPath: resolve(repoRoot, validated.plan.datasets.dev.path),
          configPath: candidateConfig,
          repoRoot,
          evalsDir,
          reportsDir: candidateDir,
          scorer,
        });
        const targetJson = join(candidateDir, `replicate-${replicate}.json`);
        const targetMarkdown = join(candidateDir, `replicate-${replicate}.md`);
        await moveRunArtifact(result.jsonPath, targetJson);
        await moveRunArtifact(result.markdownPath, targetMarkdown);
        await writePrivateFile(
          join(candidateDir, `review-source-${replicate}.json`),
          JSON.stringify(reviewItems, null, 2) + "\n",
        );
        console.log(
          `  ${result.report.aggregate.casesRun} cases; errors ` +
            `${result.report.aggregate.casesErrored} ` +
            `(external ${result.report.aggregate.externalErrors}, product ${result.report.aggregate.productErrors}); ` +
            `hard failures ${result.report.aggregate.hardFailureCount}`,
        );
        console.log(`  private report: ${targetJson}`);
      }
      return;
    }

    if (action === "prepare-review") {
      const sources: PrivateMintedReviewSource[] = [];
      for (const candidate of validated.plan.candidates) {
        for (let replicate = 1; replicate <= 3; replicate++) {
          const path = join(
            reportsRoot,
            candidate.id,
            `review-source-${replicate}.json`,
          );
          const items = JSON.parse(
            await readFile(path, "utf8"),
          ) as PrivateMintedReviewSource[];
          sources.push(...items);
        }
      }
      const prepared = buildBlindedReviewPacket({
        planSha256: validated.planSha256,
        sources,
      });
      const privateReviewDir = join(reportsRoot, "blinded-review");
      await ensurePrivateDirectory(privateReviewDir);
      const packetRaw = JSON.stringify(prepared.packet, null, 2) + "\n";
      const packetSha256 = sha256(packetRaw);
      await writePrivateFile(join(privateReviewDir, "packet.json"), packetRaw);
      await writePrivateFile(
        join(privateReviewDir, "map.json"),
        JSON.stringify(prepared.map, null, 2) + "\n",
      );
      const template: Omit<ContentFreeReview, "decisions"> & {
        decisions: Array<{
          itemId: string;
          decisions: Record<string, null>;
        }>;
      } = {
        schema: "donna.minted-name-review.v1",
        rubricVersion: prepared.packet.rubricVersion,
        rubricSha256: prepared.packet.rubricSha256,
        packetSha256,
        randomizationSha256: prepared.randomizationSha256,
        reviewer: "product-owner",
        reviewedAt: "",
        decisions: prepared.packet.items.map((item) => ({
          itemId: item.itemId,
          decisions: { ...item.decisions },
        })),
      };
      await writePrivateFile(
        join(privateReviewDir, "review-template.json"),
        JSON.stringify(template, null, 2) + "\n",
      );
      console.log(
        `Blinded minted-name packet ready: ${prepared.packet.items.length} randomized item(s).`,
      );
      console.log(`  private packet: ${join(privateReviewDir, "packet.json")}`);
      console.log(
        `  fill the five booleans in ${join(privateReviewDir, "review-template.json")}, ` +
          `then save the content-free result as ${join(dirname(planPath), "review.json")}`,
      );
      return;
    }

    if (action === "select") {
      const reviewArg = arg("--review");
      const reviewPath =
        reviewArg === undefined
          ? join(dirname(planPath), "review.json")
          : resolveRepoOrCwd(reviewArg);
      const privateReviewDir = join(reportsRoot, "blinded-review");
      const [reviewRaw, mapRaw, packetRaw] = await Promise.all([
        readFile(reviewPath, "utf8"),
        readFile(join(privateReviewDir, "map.json"), "utf8"),
        readFile(join(privateReviewDir, "packet.json"), "utf8"),
      ]);
      const review = JSON.parse(reviewRaw) as ContentFreeReview;
      validateContentFreeReview(review);
      if (review.packetSha256 !== sha256(packetRaw)) {
        throw new Error("Review packet hash mismatch");
      }
      const reviewMap = JSON.parse(mapRaw) as PrivateReviewMap;
      if (reviewMap.planSha256 !== validated.planSha256) {
        throw new Error("Private review map belongs to a different plan");
      }
      const aggregates = await loadCandidateReports({
        reportsRoot,
        plan: validated.plan,
      });
      const selection = selectCandidate({
        plan: validated.plan,
        planSha256: validated.planSha256,
        aggregates,
        review,
        reviewSha256: sha256(reviewRaw),
        reviewMap,
      });
      const selectionPath = join(dirname(planPath), "selection.json");
      await writeFile(selectionPath, JSON.stringify(selection, null, 2) + "\n");
      if (selection.outcome.kind === "winner") {
        console.log(`MECHANICAL WINNER: ${selection.outcome.candidate}`);
      } else if (selection.outcome.kind === "naming-measurement-mismatch") {
        console.log("STOP: naming-measurement-mismatch — no winner");
      } else {
        console.log("NO ELIGIBLE ORGANIZER CANDIDATE");
      }
      console.log(`selection: ${selectionPath}`);
      return;
    }

    if (action === "validation-v3") {
      const selectionArg = arg("--selection");
      const selectionPath =
        selectionArg === undefined
          ? join(dirname(planPath), "selection.json")
          : resolveRepoOrCwd(selectionArg);
      const selection = await readSelection(selectionPath);
      if (selection.outcome.kind !== "winner") {
        throw new Error("Validation-v3 is forbidden without a mechanical winner");
      }
      const winnerId = selection.outcome.candidate;
      const candidate = validated.plan.candidates.find(
        (item) => item.id === winnerId,
      )!;
      const datasetPath = resolve(repoRoot, validated.plan.datasets.validationV3.path);
      await assertHeldoutLockFor(datasetPath);
      const preflight = await captureSnapshot({
        repoRoot,
        configPath: configPath(),
        dataset: {
          name: validated.plan.datasets.validationV3.name,
          version: validated.plan.datasets.validationV3.version,
          sha256: validated.plan.datasets.validationV3.sha256,
        },
      });
      if (preflight.dirty) {
        throw new Error("Validation-v3 requires the clean committed canonical winner");
      }
      const canonical = await loadModelsConfig(configPath());
      const lane = canonical.stages.organize.default;
      if (
        lane.provider !== candidate.provider ||
        lane.model !== candidate.model ||
        lane.prompt !== candidate.promptVersion ||
        (typeof lane.params.temperature === "number" ? lane.params.temperature : null) !==
          candidate.temperature
      ) {
        throw new Error("Canonical models.config.yaml does not match the selected winner");
      }
      const live = await liveStack();
      if (live === undefined) throw new Error("Gateway prerequisites are absent");
      const targetDir = join(reportsRoot, "validation-v3");
      await ensurePrivateDirectory(targetDir);
      if (existsSync(join(targetDir, "validation-v3.json"))) {
        throw new Error("Validation-v3 winner result already exists and cannot be replaced");
      }
      console.log(
        `VALIDATION-V3 — NOT GRADUATION — winner ${candidate.id} — ` +
          `dataset ${validated.plan.datasets.validationV3.sha256}`,
      );
      const result = await runEval({
        datasetPath,
        configPath: configPath(),
        repoRoot,
        evalsDir,
        reportsDir: targetDir,
        scorer: createOrganizeScorer({
          organizer: live.stack.organizer,
          meteredGateway: live.metered,
        }),
      });
      await moveRunArtifact(result.jsonPath, join(targetDir, "validation-v3.json"));
      await moveRunArtifact(result.markdownPath, join(targetDir, "validation-v3.md"));
      console.log(
        `VALIDATION ONLY: ${result.report.aggregate.casesRun} cases, ` +
          `${result.report.aggregate.casesErrored} errors, ` +
          `${result.report.aggregate.hardFailureCount} hard failures`,
      );
      return;
    }

    if (action === "private-diagnostic") {
      if (!process.argv.includes("--participant-invoked")) {
        throw new Error("Private diagnostic requires explicit --participant-invoked");
      }
      const sourceDataArg = arg("--source-data") ?? process.env.DONNA_DATA_DIR;
      const tenantId = process.env.DONNA_TENANT_ID;
      const userId = process.env.DONNA_USER_ID;
      if (sourceDataArg === undefined || tenantId === undefined || userId === undefined) {
        throw new Error(
          "Private diagnostic requires DONNA_DATA_DIR, DONNA_TENANT_ID, and DONNA_USER_ID; values are never printed",
        );
      }
      const sourceData = resolve(repoRoot, sourceDataArg);
      const selectionArg = arg("--selection");
      const selectionPath =
        selectionArg === undefined
          ? join(dirname(planPath), "selection.json")
          : resolveRepoOrCwd(selectionArg);
      const selectionRaw = await readFile(selectionPath, "utf8");
      const selection = JSON.parse(selectionRaw) as SelectionRecord;
      if (selection.outcome.kind !== "winner") {
        throw new Error("Private diagnostic is forbidden without a mechanical winner");
      }
      const winnerId = selection.outcome.candidate;
      const memory = new MemoryService({
        memories: new FileMemoryStore(sourceData),
        consents: new FileConsentStore(sourceData),
        now: () => new Date(),
      });
      const scope = { tenantId, userId };
      if (!(await memory.hasConsent(scope, "eval-sharing"))) {
        throw new Error("Private diagnostic blocked: current eval-sharing consent is absent");
      }
      const canonical = await loadModelsConfig(configPath());
      const winner = validated.plan.candidates.find(
        (candidate) => candidate.id === winnerId,
      )!;
      const lane = canonical.stages.organize.default;
      if (
        lane.provider !== winner.provider ||
        lane.model !== winner.model ||
        lane.prompt !== winner.promptVersion
      ) {
        throw new Error("Canonical config does not match the selected winner");
      }
      const live = await liveStack();
      if (live === undefined) throw new Error("Gateway prerequisites are absent");
      const buckets = new FileBucketStore(sourceData);
      const captures = new FileCaptureStore(sourceData);
      const transcripts = new FileTranscriptStore(sourceData);
      const corrections = new FileCorrectionStore(sourceData);
      const decisions = latestDecisionsPerThought(
        await new FilePilotDecisionStore(sourceData).list(tenantId, userId),
      );
      const items = await buckets.listItems(tenantId, userId);
      const thoughtById = new Map(items.map((item) => [item.thought.id, item.thought]));
      const assembler = new ContextAssembler({
        memory,
        buckets,
        captures,
        transcripts,
        corrections: {
          listAccepted: async (requestedScope) =>
            (await corrections.listCorrections(
              requestedScope.tenantId,
              requestedScope.userId,
            )).filter((event) => event.status === "accepted"),
        },
        budgets: live.stack.contextBudgets,
        now: () => new Date(),
      });
      const tokenize = (text: string): Set<string> =>
        new Set(
          text
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((token) => token.length >= 3),
        );
      const scorePlacement = (
        output: Awaited<ReturnType<typeof live.stack.organizer.organize>>,
        thoughtText: string,
        expectedBucket: string,
      ): boolean => {
        const wanted = tokenize(thoughtText);
        const ranked = output.thoughts
          .map((thought) => {
            const actual = tokenize(`${thought.summary} ${thought.text}`);
            let overlap = 0;
            for (const token of wanted) if (actual.has(token)) overlap += 1;
            return { thought, overlap };
          })
          .sort((left, right) => right.overlap - left.overlap);
        const best = ranked[0];
        if (best === undefined || best.overlap === 0) return false;
        const proposed =
          best.thought.suggestedBucket ?? best.thought.newBucketName ?? "";
        return proposed.trim().toLowerCase() === expectedBucket.trim().toLowerCase();
      };
      let bucketListCorrect = 0;
      let fullContextCorrect = 0;
      let evaluated = 0;
      const opaqueCaseIds: string[] = [];
      for (const decision of decisions) {
        if (decision.captureId === undefined) continue;
        const thought = thoughtById.get(decision.thoughtId);
        const record = await transcripts.getTranscript(
          tenantId,
          userId,
          decision.captureId,
        );
        if (thought === undefined || record === undefined) continue;
        const transcript = {
          captureId: record.captureId,
          text: record.text,
          segments: record.segments,
          model: record.model,
        };
        const existingBuckets = (decision.existingBuckets ?? []).map((bucket) => ({
          name: bucket.name,
          description: bucket.description,
        }));
        const packet = await assembler.assemble(scope, {
          text: record.text,
          excludeCaptureId: record.captureId,
        });
        const [bucketListOutput, contextOutput] = await Promise.all([
          live.stack.organizer.organize(transcript, existingBuckets),
          live.stack.organizer.organize(transcript, existingBuckets, packet),
        ]);
        bucketListCorrect += Number(
          scorePlacement(bucketListOutput, thought.summary, decision.decidedBucket.name),
        );
        fullContextCorrect += Number(
          scorePlacement(contextOutput, thought.summary, decision.decidedBucket.name),
        );
        opaqueCaseIds.push(
          sha256(`${sha256(selectionRaw)}\0private-diagnostic\0${decision.id}`).slice(
            0,
            24,
          ),
        );
        evaluated += 1;
      }
      if (evaluated === 0) {
        throw new Error("Private diagnostic found no consented, linked placement cases");
      }
      const accepts = decisions.filter((decision) => decision.kind === "accept").length;
      const diagnostic = {
        schema: "donna.organize-private-diagnostic.v1",
        createdAt: new Date().toISOString(),
        consentCurrent: true,
        participantInvoked: true,
        views: {
          bucketListOnly: {
            score: bucketListCorrect / evaluated,
            correct: bucketListCorrect,
            count: evaluated,
          },
          privateFullContext: {
            score: fullContextCorrect / evaluated,
            correct: fullContextCorrect,
            count: evaluated,
          },
          observedPilotDecisions: {
            score: decisions.length === 0 ? 0 : accepts / decisions.length,
            accepts,
            count: decisions.length,
          },
        },
        caseIds: opaqueCaseIds,
        categoryTokens: [
          "bucket-list-only",
          "private-full-context",
          "observed-pilot-decisions",
        ],
        configSha256: sha256(await readFile(configPath())),
        selectionSha256: sha256(selectionRaw),
        reportHashes: [],
      };
      validatePrivateDiagnosticEvidence(diagnostic);
      const outputPath = join(reportsRoot, "private-context", "diagnostic.json");
      await writePrivateFile(outputPath, JSON.stringify(diagnostic, null, 2) + "\n");
      console.log(
        `Private diagnostic complete: ${evaluated} linked case(s); ` +
          `bucket-list-only ${(bucketListCorrect / evaluated).toFixed(4)}, ` +
          `private-context ${(fullContextCorrect / evaluated).toFixed(4)}, ` +
          `observed decisions ${(accepts / decisions.length).toFixed(4)}`,
      );
      console.log(`owner-only allowlisted report: ${outputPath}`);
      return;
    }

    if (action === "freeze-fresh") {
      const selectionArg = arg("--selection");
      const selectionPath =
        selectionArg === undefined
          ? join(dirname(planPath), "selection.json")
          : resolveRepoOrCwd(selectionArg);
      const datasetArg = arg("--dataset");
      if (datasetArg === undefined) {
        throw new Error("freeze-fresh requires --dataset <fresh-envelope>");
      }
      const freshPath = resolveRepoOrCwd(datasetArg);
      const selectionRaw = await readFile(selectionPath, "utf8");
      const selection = JSON.parse(selectionRaw) as SelectionRecord;
      if (selection.outcome.kind !== "winner") {
        throw new Error("Fresh freeze is forbidden without a mechanical winner");
      }
      const summary = await validateFreshEnvelope({
        freshPath,
        devPath: resolve(repoRoot, validated.plan.datasets.dev.path),
        validationPath: resolve(repoRoot, validated.plan.datasets.validationV3.path),
      });
      const fresh = await loadDataset(freshPath);
      const resultsDir = join(reportsRoot, "fresh-final");
      await assertNoFreshResults(resultsDir);
      const snapshot = await captureSnapshot({
        repoRoot,
        configPath: configPath(),
        dataset: { name: fresh.name, version: fresh.version, sha256: fresh.sha256 },
      });
      if (snapshot.dirty) {
        throw new Error("Fresh envelope freeze requires a clean winner commit");
      }
      const lock: FreshLock = {
        schema: "donna.organize-fresh-lock.v1",
        dataset: {
          name: fresh.name,
          version: fresh.version,
          sha256: fresh.sha256,
          cases: fresh.cases.length,
        },
        selectionSha256: sha256(selectionRaw),
        winnerCommit: snapshot.commit,
        frozenAt: new Date().toISOString(),
        classes: summary.byClass,
        mintedCases: summary.mintedCases,
        overlap: { caseIds: 0, contentHashes: 0 },
        resultState: "NO RESULTS YET",
      };
      const lockPath = resolve(
        dirname(freshPath),
        arg("--lock") ?? "organize.graduation-blind.lock.json",
      );
      await writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");
      console.log(
        `FRESH BLIND FROZEN: ${summary.total} cases, all 9 classes >=2, ` +
          `${summary.mintedCases} minted, zero overlap`,
      );
      console.log(`NO RESULTS YET — lock: ${lockPath}`);
      return;
    }

    if (action === "final") {
      const selectionArg = arg("--selection");
      const selectionPath =
        selectionArg === undefined
          ? join(dirname(planPath), "selection.json")
          : resolveRepoOrCwd(selectionArg);
      const datasetArg = arg("--dataset");
      if (datasetArg === undefined) throw new Error("final requires --dataset <fresh-envelope>");
      const freshPath = resolveRepoOrCwd(datasetArg);
      const lockPath = resolve(
        dirname(freshPath),
        arg("--lock") ?? "organize.graduation-blind.lock.json",
      );
      const [selectionRaw, lockRaw] = await Promise.all([
        readFile(selectionPath, "utf8"),
        readFile(lockPath, "utf8"),
      ]);
      const selection = JSON.parse(selectionRaw) as SelectionRecord;
      const lock = JSON.parse(lockRaw) as FreshLock;
      if (selection.outcome.kind !== "winner") {
        throw new Error("Fresh final is forbidden without a mechanical winner");
      }
      const winnerId = selection.outcome.candidate;
      if (lock.selectionSha256 !== sha256(selectionRaw)) {
        throw new Error("Fresh lock selection hash mismatch");
      }
      const fresh = await loadDataset(freshPath);
      if (
        fresh.sha256 !== lock.dataset.sha256 ||
        fresh.version !== lock.dataset.version ||
        fresh.cases.length !== lock.dataset.cases
      ) {
        throw new Error("Fresh envelope differs from its pre-result lock");
      }
      const snapshot = await captureSnapshot({
        repoRoot,
        configPath: configPath(),
        dataset: { name: fresh.name, version: fresh.version, sha256: fresh.sha256 },
      });
      if (snapshot.dirty || snapshot.commit !== lock.winnerCommit) {
        throw new Error("Fresh final requires the unchanged clean winner commit");
      }
      const resultsDir = join(reportsRoot, "fresh-final");
      await ensurePrivateDirectory(resultsDir);
      const existing = (await readdir(resultsDir))
        .filter((name) => /^attempt-\d+\.json$/.test(name))
        .sort();
      if (existing.length >= 2) throw new Error("Fresh final attempt limit already exhausted");
      if (existing.length === 1) {
        if (!process.argv.includes("--retry-external")) {
          throw new Error("Attempt 1 already exists; only --retry-external can request attempt 2");
        }
        const first = JSON.parse(
          await readFile(join(resultsDir, existing[0]!), "utf8"),
        ) as EvalReport;
        if (!canRetryFreshFinal(first)) {
          throw new Error("Attempt 1 is not a strict external-only retryable failure");
        }
      } else if (process.argv.includes("--retry-external")) {
        throw new Error("--retry-external is invalid before attempt 1");
      }
      const candidate = validated.plan.candidates.find(
        (item) => item.id === winnerId,
      )!;
      const canonical = await loadModelsConfig(configPath());
      const lane = canonical.stages.organize.default;
      if (
        lane.provider !== candidate.provider ||
        lane.model !== candidate.model ||
        lane.prompt !== candidate.promptVersion
      ) {
        throw new Error("Canonical config no longer matches the selected winner");
      }
      const live = await liveStack();
      if (live === undefined) throw new Error("Gateway prerequisites are absent");
      const attempt = existing.length + 1;
      console.log(
        `FRESH BLIND FINAL — ATTEMPT ${attempt} — winner ${candidate.id} — ` +
          `dataset sha256:${fresh.sha256}`,
      );
      const result = await runEval({
        datasetPath: freshPath,
        configPath: configPath(),
        repoRoot,
        evalsDir,
        reportsDir: resultsDir,
        scorer: createOrganizeScorer({
          organizer: live.stack.organizer,
          meteredGateway: live.metered,
        }),
      });
      await moveRunArtifact(result.jsonPath, join(resultsDir, `attempt-${attempt}.json`));
      await moveRunArtifact(result.markdownPath, join(resultsDir, `attempt-${attempt}.md`));
      console.log(
        `attempt ${attempt}: errors ${result.report.aggregate.casesErrored}, ` +
          `product ${result.report.aggregate.productErrors}, ` +
          `hard failures ${result.report.aggregate.hardFailureCount}`,
      );
      return;
    }

    throw new Error(
      "usage: organize-experiment validate|run|prepare-review|select|validation-v3|freeze-fresh|final --plan <path>",
    );
  }

  // Spec 6.7: structured-routing dev experiment — one approved
  // implementation, three fixed replicates, mechanical floors/stop.
  if (command === "organize-v2-experiment") {
    const action = stage;
    const suppliedPlan = arg("--plan");
    const planPath = suppliedPlan === undefined
      ? join(evalsDir, "experiments/organize/6.7/plan.json")
      : resolveRepoOrCwd(suppliedPlan);
    const validated = await validateLockedV2Plan({ planPath, repoRoot });
    const reportsRoot = join(evalsDir, "reports", "organize", "6.7");

    if (action === "validate") {
      console.log(
        `PLAN LOCKED: Spec 6.7 structured baseline S (gpt-5-mini, donna.organize.v2) — 3 binding dev runs`,
      );
      console.log(
        `dev ${validated.plan.datasets.dev.name} v${validated.plan.datasets.dev.version} ` +
          `${validated.plan.datasets.dev.cases} cases sha256:${validated.plan.datasets.dev.sha256}`,
      );
      console.log(`near-duplicate threshold (frozen candidate): ${validated.plan.implementation.nearDuplicateThreshold}`);
      console.log(`validation-v3 preserved, NOT run: sha256:${validated.plan.datasets.validationV3.sha256.slice(0, 12)}…`);
      console.log(`plan sha256:${validated.planSha256}`);
      return;
    }

    if (action === "run") {
      const candidateDir = join(reportsRoot, "S");
      await ensurePrivateDirectory(candidateDir);
      const existing = await readdir(candidateDir);
      if (existing.some((name) => /^replicate-\d+\.(json|md)$/.test(name))) {
        throw new Error(
          "S: binding results already exist; fixed replicates cannot be rerun or replaced",
        );
      }
      const candidateConfig = resolve(repoRoot, validated.plan.implementation.configPath);
      const live = await liveStack(candidateConfig);
      if (live === undefined) {
        throw new Error(
          "TrueFoundry gateway prerequisites are absent; zero binding runs were started",
        );
      }
      if (live.stack.organizerV2 === undefined) {
        throw new Error("The locked 6.7 config must resolve a donna.organize.v2 lane");
      }
      for (let replicate = 1; replicate <= 3; replicate++) {
        const reviewItems: V2ReviewSource[] = [];
        console.log(
          `DEV ONLY — NOT GRADUATION — structured baseline S — run ${replicate} of 3 — ` +
            `dataset ${validated.plan.datasets.dev.sha256.slice(0, 12)}… ` +
            `config ${validated.plan.implementation.configSha256.slice(0, 12)}… ` +
            `prompt ${validated.plan.implementation.promptSha256.slice(0, 12)}…`,
        );
        console.log("prompt-input audit: no label fields supplied");
        const scorer = createOrganizeV2Scorer({
          organizerV2: live.stack.organizerV2,
          ...(live.stack.escalationOrganizerV2 !== undefined
            ? { escalationOrganizerV2: live.stack.escalationOrganizerV2 }
            : {}),
          ...(live.stack.namer !== undefined ? { namer: live.stack.namer } : {}),
          embedder: live.stack.embedder,
          meteredGateway: live.metered,
          bucketTuning: live.config.buckets,
          onMintedReviewItem: (item) => {
            reviewItems.push({ replicate, ...item });
          },
        });
        const result = await runEval({
          datasetPath: resolve(repoRoot, validated.plan.datasets.dev.path),
          configPath: candidateConfig,
          repoRoot,
          evalsDir,
          reportsDir: candidateDir,
          scorer,
        });
        const targetJson = join(candidateDir, `replicate-${replicate}.json`);
        const targetMarkdown = join(candidateDir, `replicate-${replicate}.md`);
        await moveRunArtifact(result.jsonPath, targetJson);
        await moveRunArtifact(result.markdownPath, targetMarkdown);
        await writePrivateFile(
          join(candidateDir, `review-source-${replicate}.json`),
          JSON.stringify(reviewItems, null, 2) + "\n",
        );
        const agg = result.report.aggregate;
        console.log(
          `  ${agg.casesRun} cases; errors ${agg.casesErrored} ` +
            `(external ${agg.externalErrors}, product ${agg.productErrors}); ` +
            `hard failures ${agg.hardFailureCount}`,
        );
        const m = (name: string) => agg.metrics[name]?.mean?.toFixed(5) ?? "n/a";
        console.log("  MODEL PROPOSAL:");
        console.log(`    route.mode_accuracy ${m("route.mode_accuracy")}   route.join_id_accuracy ${m("route.join_id_accuracy")}`);
        console.log(`    mint.precision ${m("mint.precision")}   mint.recall ${m("mint.recall")}`);
        console.log("  DETERMINISTIC FINAL:");
        console.log(`    final.placement_acceptance ${m("final.placement_acceptance")}   route.joined_conflict_rate ${m("route.joined_conflict_rate")}   review.pending_rate ${m("review.pending_rate")}`);
        console.log("  MINT QUALITY:");
        console.log(`    mint.validator_pass ${m("mint.validator_pass")}   mint.exact_name (diagnostic) ${m("mint.exact_name")}`);
        console.log("  TASK/PROVENANCE:");
        console.log(`    thought_coverage ${m("organize.thought_coverage")}   task_precision ${m("organize.task_precision")}   task_recall ${m("organize.task_recall")}   tasks.hard_rule ${m("tasks.hard_rule")}`);
        console.log(`    provenance ${m("organize.provenance_fidelity")}   schema ${m("organize.schema_valid")}`);
        console.log(`  private report: ${targetJson}`);
      }
      return;
    }

    if (action === "prepare-review") {
      const sources: V2ReviewSource[] = [];
      for (let replicate = 1; replicate <= 3; replicate++) {
        const path = join(reportsRoot, "S", `review-source-${replicate}.json`);
        const items = JSON.parse(await readFile(path, "utf8")) as V2ReviewSource[];
        sources.push(...items);
      }
      const packet = buildV2ReviewPacket(validated.planSha256, sources);
      const privateReviewDir = join(reportsRoot, "blinded-review");
      await ensurePrivateDirectory(privateReviewDir);
      await writePrivateFile(
        join(privateReviewDir, "packet.json"),
        JSON.stringify(packet, null, 2) + "\n",
      );
      const template = {
        schema: "donna.organize-v2-review.v1",
        rubricSha256: packet.rubricSha256,
        reviewer: "product-owner",
        reviewedAt: "",
        decisions: packet.items.map((item) => ({
          itemId: item.itemId,
          decisions: { ...item.decisions },
        })),
      };
      await writePrivateFile(
        join(privateReviewDir, "review-template.json"),
        JSON.stringify(template, null, 2) + "\n",
      );
      console.log(
        `Blinded minted-name packet ready: ${packet.items.length} randomized item(s). ` +
          `Fill ${join(privateReviewDir, "review-template.json")} and save as review.json next to the plan.`,
      );
      return;
    }

    if (action === "eligibility") {
      const reports = await loadV2Reports({ reportsRoot, plan: validated.plan });
      const reviewArg = arg("--review");
      const reviewPath = reviewArg === undefined
        ? join(dirname(planPath), "review.json")
        : resolveRepoOrCwd(reviewArg);
      let blinded: { state: "evaluated"; allFivePassRate: number; reviewSha256: string } | { state: "awaiting-product-owner-review" };
      if (existsSync(reviewPath)) {
        const reviewRaw = await readFile(reviewPath, "utf8");
        const review = JSON.parse(reviewRaw) as {
          decisions: Array<{ itemId: string; decisions: Record<string, boolean> }>;
        };
        const summary = summarizeV2Review(review);
        blinded = {
          state: "evaluated",
          allFivePassRate: summary.allFivePassRate,
          reviewSha256: sha256(reviewRaw),
        };
      } else {
        blinded = { state: "awaiting-product-owner-review" };
      }
      // Deterministic suite results are attested from the committed test
      // runs (decision-table/concurrency/security/parity); the flags are
      // recorded by the operator running the suites, never assumed.
      const suitesAttested = arg("--deterministic-suites-passed") === "true";
      const record = evaluateV2Eligibility({
        plan: validated.plan,
        planSha256: validated.planSha256,
        reports,
        blinded,
        deterministicSuites: {
          decisionTable: suitesAttested,
          concurrencyReplay: suitesAttested,
          security: suitesAttested,
          filePostgresParity: suitesAttested,
        },
      });
      const outPath = join(dirname(planPath), "eligibility.json");
      await writeFile(outPath, JSON.stringify(record, null, 2) + "\n");
      for (const floor of record.floors) {
        console.log(
          `${floor.pass ? "PASS" : "FAIL"}  ${floor.floor}: ${floor.actual} (floor ${floor.threshold})`,
        );
      }
      console.log(`outcome: ${record.outcome}`);
      if (record.mintSpecificFailure) {
        console.log(
          "note: routing/join floors passed while mint quality failed — narrow evidence for a future mint-only specification; do not broaden or retry within 6.7.",
        );
      }
      console.log(`eligibility record: ${outPath}`);
      return;
    }

    throw new Error(
      `Unknown organize-v2-experiment action "${String(action)}". Known: validate, run, prepare-review, eligibility`,
    );
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

  console.error("usage: cli.ts validate | snapshot | run <stage> [--mode …] [--dataset <path>] | organize-experiment validate|run|prepare-review|select|validation-v3|private-diagnostic|freeze-fresh|final --plan <path> | heldout-freeze [--dataset <path>] --report <report.json> | amend-organize-snapshots --source-data <dir> --tenant <scope> --user <scope> [--apply --product-owner-approved] | baseline <stage> | compare <stage> <report> | graduation <reports…> | graduation-run <reports…> [--extras <f>] [--cohort-window <s>..<e>]");
  process.exit(2);
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
