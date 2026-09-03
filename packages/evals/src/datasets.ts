/**
 * Versioned evaluation datasets (Specification 4.1).
 *
 * Every shared dataset is a versioned envelope (`donna.eval-dataset.v1`):
 * dataset-level identity (name, stage, integer version), default fixture
 * metadata, the cases themselves, and an append-only adjudication log that
 * makes every human label change auditable (FR-3).
 *
 * Fixture metadata (per case, falling back to `defaultMeta`):
 *   - provenance: synthetic | de-identified | consented-volunteer | adversarial
 *   - labeler / adjudicator: pseudonymous identifiers, never real names
 *   - consent: not-required-synthetic | consented | de-identified
 *   - sensitivity: none | low | moderate ("high" is not representable —
 *     high-sensitivity content is excluded from shared evals by schema, SR-1)
 *   - language / accent / noise notes for STT and full-loop cohorts
 *
 * Validation (AC-2) rejects: missing consent/labeler/provenance metadata,
 * consent states inconsistent with the declared provenance, adjudications
 * that reference unknown cases, duplicate case IDs, and any text field that
 * trips the shared sensitive-content screener (SR-1).
 *
 * Pre-Phase-4 flat golden files (organize.v1.json, buckets.v1.json,
 * retrieval.v1.json, emotion.v1.json, corrections.v1.json) stay in place and
 * keep working with their original runners. Stage envelopes REFERENCE them
 * via `legacyImport` so content is single-sourced; the loader lifts each
 * legacy case into the envelope with the declared default metadata.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { screenSensitiveContent } from "@donna/memory";

export const DATASET_SCHEMA = "donna.eval-dataset.v1";

export const EVAL_STAGES = [
  "transcribe",
  "organize",
  "provenance",
  "buckets",
  "memory",
  "retrieval",
  "emotion",
  "full-loop",
  "adversarial",
] as const;
export type EvalStage = (typeof EVAL_STAGES)[number];

/* ------------------------------------------------------------------ */
/* Fixture metadata                                                    */
/* ------------------------------------------------------------------ */

export const caseMetaSchema = z.object({
  provenance: z.enum([
    "synthetic",
    "de-identified",
    "consented-volunteer",
    "adversarial",
  ]),
  /** Pseudonymous labeler ID, e.g. "labeler:product-owner". Never a real name. */
  labeler: z.string().min(1),
  /** Pseudonymous adjudicator ID when labels were adjudicated. */
  adjudicator: z.string().min(1).optional(),
  consent: z.enum(["not-required-synthetic", "consented", "de-identified"]),
  /** "high" is deliberately not representable in shared fixtures (SR-1). */
  sensitivity: z.enum(["none", "low", "moderate"]),
  /** BCP-47-ish language tag, e.g. "en". */
  language: z.string().min(2).optional(),
  /** Free-text accent note, e.g. "en-IN neutral". */
  accent: z.string().optional(),
  /** Noise condition note, e.g. "clean", "simulated-cafe". */
  noise: z.string().optional(),
  notes: z.string().optional(),
});
export type CaseMeta = z.infer<typeof caseMetaSchema>;

/** Partial per-case override; unspecified keys inherit `defaultMeta`. */
const caseMetaOverrideSchema = caseMetaSchema.partial();

/* ------------------------------------------------------------------ */
/* Per-stage case payloads                                             */
/* ------------------------------------------------------------------ */

const transcriptSegmentSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  startSec: z.number(),
  endSec: z.number(),
});

const transcriptFixtureSchema = z.object({
  text: z.string().min(1),
  segments: z.array(transcriptSegmentSchema).min(1),
  language: z.string().optional(),
});

/** transcribe: reference TEXT + audio hashes only — never audio (SR-1). */
const transcribeCaseSchema = z.object({
  id: z.string().min(1),
  meta: caseMetaOverrideSchema.optional(),
  referenceText: z.string().min(1),
  audio: z.object({
    generator: z.literal("espeak-ng"),
    voice: z.string().min(1),
    speedWpm: z.number().int().positive(),
    /** SHA-256 of the canonical generated fixture, hex. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** Fixture file name relative to packages/evals/fixtures/audio/. */
    file: z.string().min(1),
  }),
  expect: z.object({
    /** Case passes when WER is at or below this threshold. */
    maxWer: z.number().min(0).max(1),
    /** Entity phrases that must survive transcription (case-insensitive). */
    entities: z.array(z.string()).default([]),
    /** Date/time phrases that must survive transcription. */
    dates: z.array(z.string()).default([]),
    /** Task/commitment phrases that must survive transcription. */
    tasks: z.array(z.string()).default([]),
  }),
});

/** organize (new-envelope cases; legacy cases come via legacyImport). */
const organizeCaseSchema = z.object({
  id: z.string().min(1),
  meta: caseMetaOverrideSchema.optional(),
  transcript: z.string().min(1),
  expected: z.object({
    thoughts: z.array(
      z.object({
        kind: z.enum(["idea", "task", "note"]),
        bucket: z.string().nullable(),
        contains: z.array(z.string().min(1)).min(1),
        task: z
          .object({
            assigneeHint: z.string().optional(),
            dueHint: z.string().optional(),
          })
          .optional(),
      }),
    ),
  }),
});

/** provenance: verifier claims against a fixed transcript fixture. */
const provenanceCaseSchema = z.object({
  id: z.string().min(1),
  meta: caseMetaOverrideSchema.optional(),
  transcript: transcriptFixtureSchema,
  claims: z
    .array(
      z.object({
        segmentIds: z.array(z.string()),
        expect: z.enum(["valid", "invalid"]),
        /** Machine token for the expected rejection reason when invalid. */
        reason: z.string().optional(),
      }),
    )
    .min(1),
});

/** memory: proposal precision, correction adherence, conflict handling. */
const memoryCaseSchema = z.object({
  id: z.string().min(1),
  meta: caseMetaOverrideSchema.optional(),
  kind: z.enum([
    "proposal-precision",
    "correction-adherence",
    "conflict-handling",
  ]),
  /** Kind-specific setup (see the 4.2 memory scorer for the contract). */
  given: z.record(z.string(), z.unknown()),
  /** Kind-specific expected outcomes (the labels). */
  expect: z.record(z.string(), z.unknown()),
});

/** A scripted organizer output for deterministic full-loop runs. */
const scriptedThoughtSchema = z.object({
  summary: z.string().min(1),
  text: z.string().min(1),
  confidence: z.number().min(0).max(1),
  suggestedBucket: z.string().optional(),
  newBucketName: z.string().optional(),
  newBucketDescription: z.string().optional(),
  task: z
    .object({
      title: z.string().min(1),
      assigneeHint: z.string().optional(),
      dueHint: z.string().optional(),
    })
    .optional(),
});

/** full-loop: longitudinal multi-capture scenarios (4.2 runner). */
const fullLoopCaseSchema = z.object({
  id: z.string().min(1),
  meta: caseMetaOverrideSchema.optional(),
  description: z.string().min(1),
  steps: z
    .array(
      z.discriminatedUnion("op", [
        z.object({
          op: z.literal("capture"),
          id: z.string().min(1),
          transcript: z.string().min(1),
          /**
           * Deterministic mode: the organizer output to replay for this
           * capture (model quality is scored by the stage evals; the
           * full-loop runner scores the plumbing — provenance, placement,
           * memory, corrections — plus, in live mode, the real models).
           */
          scriptedThoughts: z.array(scriptedThoughtSchema).optional(),
        }),
        z.object({
          op: z.literal("correction"),
          type: z.enum(["bucket.move", "bucket.rename"]),
          thoughtContains: z.string().min(1),
          toBucket: z.string().min(1),
        }),
      ]),
    )
    .min(1),
  expect: z.object({
    /** Final bucket names that must exist. */
    buckets: z.array(z.string().min(1)).default([]),
    /** Bucket names that must NOT exist (e.g. near-duplicates). */
    mustNotHaveBuckets: z.array(z.string().min(1)).default([]),
    /** Every task-bearing thought lands in Tasks (hard rule). */
    allTasksInTasksBucket: z.boolean().default(true),
    /** Correction adherence expectations across the sequence. */
    adherence: z
      .object({ followed: z.number().int().nonnegative(), contradicted: z.number().int().nonnegative() })
      .partial()
      .optional(),
  }),
});

/** adversarial: prompt injection, tenant scope, false provenance (AC-4). */
const adversarialCaseSchema = z.discriminatedUnion("category", [
  z.object({
    id: z.string().min(1),
    meta: caseMetaOverrideSchema.optional(),
    category: z.literal("prompt-injection"),
    /** Where the payload enters the system. */
    vector: z.enum(["organize-transcript", "stored-thought-answer"]),
    /** The untrusted text carrying the injection attempt. */
    payload: z.string().min(1),
    /** String the model would emit only if the injection succeeded. */
    canary: z.string().min(1),
  }),
  z.object({
    id: z.string().min(1),
    meta: caseMetaOverrideSchema.optional(),
    category: z.literal("tenant-scope"),
    /** Cross-scope read the eval tenant must never be able to perform. */
    operation: z.enum(["read-items", "search", "read-transcript"]),
  }),
  z.object({
    id: z.string().min(1),
    meta: caseMetaOverrideSchema.optional(),
    category: z.literal("false-provenance"),
    transcript: transcriptFixtureSchema,
    claims: z
      .array(
        z.object({
          segmentIds: z.array(z.string()),
          expect: z.literal("invalid"),
          reason: z.string().optional(),
        }),
      )
      .min(1),
  }),
]);

const STAGE_CASE_SCHEMAS: Record<EvalStage, z.ZodTypeAny> = {
  transcribe: transcribeCaseSchema,
  organize: organizeCaseSchema,
  provenance: provenanceCaseSchema,
  buckets: z.object({ id: z.string().min(1) }).passthrough(),
  memory: memoryCaseSchema,
  retrieval: z.object({ id: z.string().min(1) }).passthrough(),
  emotion: z.object({ id: z.string().min(1) }).passthrough(),
  "full-loop": fullLoopCaseSchema,
  adversarial: adversarialCaseSchema,
};

/* ------------------------------------------------------------------ */
/* Envelope                                                            */
/* ------------------------------------------------------------------ */

export const adjudicationSchema = z.object({
  /** ISO 8601 time of the label change. */
  at: z.string().min(1),
  /** Pseudonymous adjudicator ID. */
  adjudicator: z.string().min(1),
  caseId: z.string().min(1),
  /** What changed, e.g. "expected.bucket: 'Tasks' → 'Onboarding improvements'". */
  change: z.string().min(1),
  reason: z.string().min(1),
});
export type Adjudication = z.infer<typeof adjudicationSchema>;

const legacyImportSchema = z.object({
  /** Path to the pre-Phase-4 flat golden file, relative to the envelope. */
  path: z.string().min(1),
  format: z.enum([
    "organize-legacy-v1",
    "buckets-legacy-v1",
    "retrieval-legacy-v1",
    "emotion-legacy-v1",
    "corrections-legacy-v1",
  ]),
});

const envelopeSchema = z.object({
  schema: z.literal(DATASET_SCHEMA),
  name: z.string().regex(/^[\w][\w.-]*$/),
  stage: z.enum(EVAL_STAGES),
  version: z.number().int().positive(),
  description: z.string().min(1),
  defaultMeta: caseMetaSchema,
  cases: z.array(z.record(z.string(), z.unknown())).default([]),
  legacyImport: legacyImportSchema.optional(),
  adjudications: z.array(adjudicationSchema).default([]),
});
export type DatasetEnvelope = z.infer<typeof envelopeSchema>;

/* ------------------------------------------------------------------ */
/* Loaded form                                                         */
/* ------------------------------------------------------------------ */

export interface LoadedCase<T = Record<string, unknown>> {
  id: string;
  meta: CaseMeta;
  payload: T;
}

export interface LoadedDataset<T = Record<string, unknown>> {
  name: string;
  stage: EvalStage;
  version: number;
  description: string;
  /** SHA-256 over the canonical envelope JSON (content identity, FR-1). */
  sha256: string;
  cases: Array<LoadedCase<T>>;
  adjudications: Adjudication[];
  /** Absolute path the dataset was loaded from. */
  sourcePath: string;
}

export class DatasetValidationError extends Error {
  constructor(
    readonly datasetPath: string,
    readonly problems: string[],
  ) {
    super(
      `Dataset validation failed for ${datasetPath}:\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
    this.name = "DatasetValidationError";
  }
}

/** Consent state must be consistent with the declared provenance (AC-2). */
function consentProblems(meta: CaseMeta, where: string): string[] {
  const problems: string[] = [];
  if (meta.provenance === "synthetic" && meta.consent !== "not-required-synthetic") {
    problems.push(`${where}: synthetic case must declare consent "not-required-synthetic"`);
  }
  if (meta.provenance === "consented-volunteer" && meta.consent !== "consented") {
    problems.push(`${where}: consented-volunteer case must declare consent "consented"`);
  }
  if (meta.provenance === "de-identified" && meta.consent !== "de-identified") {
    problems.push(`${where}: de-identified case must declare consent "de-identified"`);
  }
  if (meta.provenance === "adversarial" && meta.consent !== "not-required-synthetic") {
    problems.push(`${where}: adversarial case must declare consent "not-required-synthetic"`);
  }
  return problems;
}

/** Collect every string value in a JSON tree for the PII screen (SR-1). */
function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, into);
  }
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Load and validate a dataset envelope (AC-2). Throws
 * DatasetValidationError listing EVERY problem found. Never mutates the
 * source file; adjudications are appended via `recordAdjudication`.
 */
export async function loadDataset<T = Record<string, unknown>>(
  datasetPath: string,
): Promise<LoadedDataset<T>> {
  const absolute = resolve(datasetPath);
  const raw = await readFile(absolute, "utf8");
  const problems: string[] = [];

  const parsedEnvelope = envelopeSchema.safeParse(JSON.parse(raw));
  if (!parsedEnvelope.success) {
    throw new DatasetValidationError(
      absolute,
      parsedEnvelope.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    );
  }
  const envelope = parsedEnvelope.data;

  // Legacy import: lift flat golden cases into the envelope (content is
  // single-sourced in the original file; metadata comes from defaultMeta).
  let rawCases = [...envelope.cases];
  if (envelope.legacyImport !== undefined) {
    const legacyPath = resolve(dirname(absolute), envelope.legacyImport.path);
    const legacy = JSON.parse(await readFile(legacyPath, "utf8")) as {
      cases?: Array<Record<string, unknown>>;
    };
    if (!Array.isArray(legacy.cases)) {
      problems.push(`legacyImport ${envelope.legacyImport.path}: no cases array`);
    } else {
      rawCases = [...rawCases, ...legacy.cases];
    }
  }

  const caseSchema = STAGE_CASE_SCHEMAS[envelope.stage];
  const seenIds = new Set<string>();
  const cases: Array<LoadedCase<T>> = [];
  for (const [index, rawCase] of rawCases.entries()) {
    const where = `cases[${index}] (${String(rawCase["id"] ?? "no-id")})`;
    const parsedCase = caseSchema.safeParse(rawCase);
    if (!parsedCase.success) {
      for (const issue of parsedCase.error.issues) {
        problems.push(`${where}: ${issue.path.join(".")}: ${issue.message}`);
      }
      continue;
    }
    const caseData = parsedCase.data as Record<string, unknown> & {
      id: string;
      meta?: Partial<CaseMeta>;
    };
    if (seenIds.has(caseData.id)) {
      problems.push(`${where}: duplicate case id "${caseData.id}"`);
      continue;
    }
    seenIds.add(caseData.id);

    const meta: CaseMeta = { ...envelope.defaultMeta, ...(caseData.meta ?? {}) };
    problems.push(...consentProblems(meta, where));

    // SR-1: screen every text field of the case for sensitive content.
    const strings: string[] = [];
    collectStrings(caseData, strings);
    const hits = strings.flatMap((s) => screenSensitiveContent(s));
    if (hits.length > 0) {
      const categories = [...new Set(hits.map((h) => h.category))].join(",");
      problems.push(`${where}: sensitive-content screen hit (${categories})`);
    }

    const { meta: _drop, ...payload } = caseData;
    cases.push({ id: caseData.id, meta, payload: payload as T });
  }

  // FR-3: adjudications must reference real cases.
  for (const adj of envelope.adjudications) {
    if (!seenIds.has(adj.caseId)) {
      problems.push(`adjudications: unknown case id "${adj.caseId}"`);
    }
  }

  if (problems.length > 0) {
    throw new DatasetValidationError(absolute, problems);
  }

  return {
    name: envelope.name,
    stage: envelope.stage,
    version: envelope.version,
    description: envelope.description,
    sha256: sha256Hex(raw),
    cases,
    adjudications: envelope.adjudications,
    sourcePath: absolute,
  };
}

/**
 * Append a human adjudication entry to a dataset envelope (FR-3). This is
 * the ONLY supported way to change labels: the entry records who changed
 * what and why, and the dataset version is bumped by the caller's edit.
 */
export async function recordAdjudication(
  datasetPath: string,
  entry: Adjudication,
): Promise<void> {
  const absolute = resolve(datasetPath);
  const raw = JSON.parse(await readFile(absolute, "utf8")) as Record<string, unknown>;
  const adjudications = Array.isArray(raw["adjudications"])
    ? (raw["adjudications"] as unknown[])
    : [];
  adjudications.push(entry);
  raw["adjudications"] = adjudications;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(absolute, JSON.stringify(raw, null, 2) + "\n", { mode: 0o644 });
}
