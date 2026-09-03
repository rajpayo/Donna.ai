/**
 * Configuration snapshots (Specification 4.1, FR-1).
 *
 * Every eval run records exactly what produced it: the git commit, the
 * dataset name/version/content-hash, a SHA-256 fingerprint of
 * models.config.yaml, the prompt/schema versions compiled into the code,
 * the retrieval ranking settings, and the memory policy. A report is
 * reproducible when commit + dataset version + config fingerprint match —
 * `snapshotFingerprint` reduces the snapshot to the single string that
 * comparison and baseline tooling keys on.
 *
 * Snapshots never contain secrets: the fingerprint covers the config FILE
 * BYTES (model IDs, thresholds, weights) — credentials come from the
 * environment and are never read here.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  loadModelsConfig,
  ORGANIZE_PROMPT_VERSION,
  ORGANIZE_SCHEMA_VERSION,
} from "@donna/providers";
import { ANSWER_PROMPT_VERSION } from "@donna/retrieval";
import { EMOTION_VERSION } from "@donna/memory";

const execFileAsync = promisify(execFile);

export interface ConfigSnapshot {
  schema: "donna.config-snapshot.v1";
  /** Git commit the run executed on ("unknown" outside a git checkout). */
  commit: string;
  branch: string;
  /** True when the working tree had uncommitted changes at run time. */
  dirty: boolean;
  modelsConfig: {
    path: string;
    sha256: string;
  };
  dataset: {
    name: string;
    version: number;
    sha256: string;
  };
  /** Prompt/schema versions compiled into the code at this commit. */
  versions: {
    organizePrompt: string;
    organizeSchema: string;
    answerPrompt: string;
    emotionAnalyzer: string;
  };
  /** Retrieval ranking settings from models.config.yaml. */
  ranking: {
    rankingVersion: string;
    weights: Record<string, number>;
    recencyHalfLifeDays: number;
    candidateLimit: number;
    minScore: number;
  };
  /** Memory policy: context budgets + correction adherence threshold. */
  memoryPolicy: {
    contextBudgets: Record<string, number>;
    adherenceSemanticThreshold: number;
  };
  bucketTuning: {
    assignThreshold: number;
    createThreshold: number;
  };
  /** Non-secret environment fingerprint. */
  environment: {
    node: string;
    platform: string;
    arch: string;
    ci: boolean;
  };
  capturedAt: string;
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...args]);
  return stdout.trim();
}

async function gitSafe(repoRoot: string, args: string[]): Promise<string> {
  try {
    return await git(repoRoot, args);
  } catch {
    return "unknown";
  }
}

export interface CaptureSnapshotOptions {
  repoRoot: string;
  configPath: string;
  dataset: { name: string; version: number; sha256: string };
  now?: () => Date;
}

/** Capture the full configuration snapshot for one eval run. */
export async function captureSnapshot(
  options: CaptureSnapshotOptions,
): Promise<ConfigSnapshot> {
  const now = options.now ?? (() => new Date());
  const [configRaw, config] = [
    await readFile(options.configPath, "utf8"),
    await loadModelsConfig(options.configPath),
  ];
  const [commit, branch, status] = await Promise.all([
    gitSafe(options.repoRoot, ["rev-parse", "HEAD"]),
    gitSafe(options.repoRoot, ["branch", "--show-current"]),
    gitSafe(options.repoRoot, ["status", "--porcelain"]),
  ]);

  return {
    schema: "donna.config-snapshot.v1",
    commit,
    branch,
    dirty: status.length > 0,
    modelsConfig: {
      path: options.configPath,
      sha256: createHash("sha256").update(configRaw).digest("hex"),
    },
    dataset: options.dataset,
    versions: {
      organizePrompt: ORGANIZE_PROMPT_VERSION,
      organizeSchema: ORGANIZE_SCHEMA_VERSION,
      answerPrompt: ANSWER_PROMPT_VERSION,
      emotionAnalyzer: EMOTION_VERSION,
    },
    ranking: {
      rankingVersion: config.retrieval.rankingVersion,
      weights: { ...config.retrieval.weights },
      recencyHalfLifeDays: config.retrieval.recencyHalfLifeDays,
      candidateLimit: config.retrieval.candidateLimit,
      minScore: config.retrieval.minScore,
    },
    memoryPolicy: {
      contextBudgets: { ...config.context },
      adherenceSemanticThreshold: config.corrections.adherenceSemanticThreshold,
    },
    bucketTuning: {
      assignThreshold: config.buckets.assign_threshold,
      createThreshold: config.buckets.create_threshold,
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      ci: process.env.CI === "true",
    },
    capturedAt: now().toISOString(),
  };
}

/**
 * The reproducibility key (FR-1): SHA-256 over everything that determines
 * scores — commit, dataset identity, config fingerprint, versions, ranking,
 * memory policy, bucket tuning. Timestamps, environment, and the dirty flag
 * are deliberately excluded (a dirty tree is reported, not fingerprinted;
 * the commit still identifies the code).
 */
export function snapshotFingerprint(snapshot: ConfigSnapshot): string {
  const determining = {
    commit: snapshot.commit,
    dataset: snapshot.dataset,
    modelsConfigSha256: snapshot.modelsConfig.sha256,
    versions: snapshot.versions,
    ranking: snapshot.ranking,
    memoryPolicy: snapshot.memoryPolicy,
    bucketTuning: snapshot.bucketTuning,
  };
  return createHash("sha256")
    .update(JSON.stringify(determining))
    .digest("hex");
}
