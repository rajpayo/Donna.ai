/**
 * Specification 1.1 — gateway compatibility preflight and sanitized report.
 *
 * Runs BEFORE any live capture: verifies that gateway credentials are real
 * (not .env.example placeholders), that a reference recording exists and is
 * readable, and that models.config.yaml loads with the expected stages. The
 * result is written to packages/evals/reports/compatibility/ so the product
 * owner can see exactly what is missing.
 *
 * Redaction contract (SR-1/SR-2): the report contains variable NAMES,
 * stage/model identifiers, and check outcomes only — never credential
 * values, audio bytes/paths beyond a caller-supplied label, transcript text,
 * or personal names. When prerequisites are missing this module performs no
 * network I/O at all.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  gatewayEnvProblems,
  inspectGatewayEnv,
  loadModelsConfig,
  type GatewayEnv,
  type GatewayEnvStatus,
} from "@donna/providers";

export interface StageCompatibility {
  stage: string;
  provider: string;
  model: string;
  /** Expected embedding dimensions for the embed stage; else null. */
  expectedDimensions: number | null;
  status: "not-run";
  reason: string;
}

export interface CompatibilityReport {
  schema: "donna.compatibility.v1";
  generatedAt: string;
  status: "blocked" | "ready-for-live-run";
  /** Exact missing prerequisites, named without values. */
  missingPrerequisites: string[];
  checks: {
    gatewayBaseUrl: GatewayEnvStatus["baseUrl"];
    gatewayApiKey: GatewayEnvStatus["apiKey"];
    referenceAudio: "not-provided" | "missing" | "unreadable" | "present";
    modelsConfig: "ok" | "error";
  };
  stages: StageCompatibility[];
  redactionNote: string;
}

export interface CompatibilityOptions {
  /** Absolute path to the reference recording, when one is supplied. */
  audioPath?: string;
  /** Absolute path to models.config.yaml. */
  configPath: string;
  /** Directory the sanitized report is written into. */
  reportsDir: string;
  /** Injectable for tests; defaults to process.env. */
  env?: GatewayEnv;
  /** Injectable clock for tests. */
  now?: () => Date;
}

const REDACTION_NOTE =
  "Contains variable names, stage/model IDs, and check outcomes only. " +
  "No credential values, audio content, transcript text, or personal names " +
  "are recorded.";

async function checkAudio(
  audioPath: string | undefined,
): Promise<CompatibilityReport["checks"]["referenceAudio"]> {
  if (audioPath === undefined) return "not-provided";
  let info;
  try {
    info = await stat(audioPath);
  } catch {
    return "missing";
  }
  if (!info.isFile() || info.size === 0) return "unreadable";
  return "present";
}

/**
 * Run the offline compatibility preflight and persist the sanitized report.
 * Never throws for missing prerequisites — that is the expected blocked
 * path; it throws only for unexpected I/O failures (e.g. unwritable report
 * directory).
 */
export interface CompatibilityResult {
  report: CompatibilityReport;
  /** Absolute path of the sanitized report file that was written. */
  reportPath: string;
}

export async function runCompatibilityCheck(
  options: CompatibilityOptions,
): Promise<CompatibilityResult> {
  const now = options.now ?? (() => new Date());
  const envStatus = inspectGatewayEnv(options.env ?? process.env);
  const audio = await checkAudio(options.audioPath);

  const missingPrerequisites: string[] = gatewayEnvProblems(envStatus);
  if (audio === "not-provided") {
    missingPrerequisites.push(
      "reference recording not provided (pass --audio <file>)",
    );
  } else if (audio === "missing") {
    missingPrerequisites.push("reference recording does not exist");
  } else if (audio === "unreadable") {
    missingPrerequisites.push("reference recording is empty or unreadable");
  }

  let stages: StageCompatibility[] = [];
  let modelsConfig: "ok" | "error" = "ok";
  try {
    const config = await loadModelsConfig(options.configPath);
    const reason =
      missingPrerequisites.length > 0
        ? "missing-prerequisites"
        : "awaiting-live-run";
    const organize = config.stages.organize;
    stages = [
      {
        stage: "transcribe",
        provider: config.stages.transcribe.default.provider,
        model: config.stages.transcribe.default.model,
        expectedDimensions: null,
        status: "not-run",
        reason,
      },
      {
        stage: "organize.default",
        provider: organize.default.provider,
        model: organize.default.model,
        expectedDimensions: null,
        status: "not-run",
        reason,
      },
      ...(organize.escalation !== undefined
        ? [
            {
              stage: "organize.escalation",
              provider: organize.escalation.provider,
              model: organize.escalation.model,
              expectedDimensions: null,
              status: "not-run" as const,
              reason,
            },
          ]
        : []),
      {
        stage: "embed",
        provider: config.stages.embed.default.provider,
        model: config.stages.embed.default.model,
        expectedDimensions: Number(
          config.stages.embed.default.params["dimensions"] ?? 1024,
        ),
        status: "not-run",
        reason,
      },
    ];
  } catch {
    modelsConfig = "error";
    missingPrerequisites.push("models.config.yaml failed to load or parse");
  }

  const report: CompatibilityReport = {
    schema: "donna.compatibility.v1",
    generatedAt: now().toISOString(),
    status: missingPrerequisites.length > 0 ? "blocked" : "ready-for-live-run",
    missingPrerequisites,
    checks: {
      gatewayBaseUrl: envStatus.baseUrl,
      gatewayApiKey: envStatus.apiKey,
      referenceAudio: audio,
      modelsConfig,
    },
    stages,
    redactionNote: REDACTION_NOTE,
  };

  await mkdir(options.reportsDir, { recursive: true });
  const reportPath = join(
    options.reportsDir,
    `${now().toISOString().replace(/[:.]/g, "-")}-compatibility.json`,
  );
  await writeFile(reportPath, JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  return { report, reportPath };
}
