/**
 * Pilot evidence promotion into the versioned organize envelopes
 * (Specification 6.4): build, preview, screen, and write a de-identified
 * inline organize case plus exactly one adjudication entry, with the target
 * envelope's integer version bumped in the same write (FR-7).
 *
 * Two promotion kinds:
 *   - corrected (FR-5): an accepted `bucket.move` correction — the case
 *     label is the user's corrected bucket and the adjudication records the
 *     model's original placement as the before;
 *   - first-pass accept (FR-6): an explicit pilot accept decision — the
 *     case label is the bucket Donna chose at decision time.
 *
 * Privacy and consent:
 *   - the `eval-sharing` consent purpose stays mandatory and is checked per
 *     promotion — once at preview and again at confirm — failing closed
 *     with nothing written (FR-3);
 *   - the payload is built from a field allowlist (SR-3): the de-identified
 *     thought summary (which is also the case `transcript`, per the product
 *     owner's 2026-09-04 maximal-text-minimization resolution), the
 *     expected bucket label, scenario class, variant labels, the
 *     deterministic case ID, and the target partition. Raw audio paths,
 *     full transcripts, and capture/tenant/user/participant IDs are never
 *     part of the payload;
 *   - every text field passes the sensitive-content screener at preview and
 *     again at confirm, and the written envelope is re-validated (schema,
 *     consent/provenance consistency, screening) before it lands (SR-2/3);
 *   - case identity is deterministic (`organize-pilot-<sha256[:12]>` of the
 *     de-identified payload), so re-promotion is a byte-identical no-op
 *     (FR-11).
 *
 * Partitions (FR-8/FR-9): promotions land only in the development envelope
 * (`organize.dev.v1.json`). The held-out envelope changes only through the
 * product-owner-gated dev→held-out batch promotion (stratified, with a
 * recorded rationale — product-owner resolution, 2026-09-04) and is frozen
 * by a lock file after the first results run at each version; a locked
 * envelope whose content hash differs from the lock is a hard validation
 * failure (SR-6).
 */
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { writePrivateFile } from "@donna/file-security";
import { screenSensitiveContent, SensitiveContentError } from "@donna/memory";
import { loadDataset, type Adjudication } from "./datasets.js";
import { ConsentRequiredError, EVAL_SHARING_PURPOSE, PromotionError } from "./golden.js";

export { ConsentRequiredError, EVAL_SHARING_PURPOSE, PromotionError };

/* ------------------------------------------------------------------ */
/* Partitions and pseudonymous roles                                   */
/* ------------------------------------------------------------------ */

export const ORGANIZE_PARTITIONS = ["dev", "heldout"] as const;
export type OrganizePartition = (typeof ORGANIZE_PARTITIONS)[number];

/**
 * Pseudonymous role IDs written into promoted cases (SR-5). The
 * participant's pilot ID is deliberately NOT written into shared cases
 * (SR-3); the labeler is the role, and the adjudicator of record is the
 * product owner at batch review (product-owner resolution, 2026-09-04).
 */
export const PILOT_LABELER_ID = "labeler:pilot-participant";
export const PRODUCT_OWNER_ADJUDICATOR_ID = "labeler:product-owner";

export type BucketOrigin = "minted" | "joined";
export interface ExistingBucketSnapshot {
  name: string;
  description: string;
}

/** Scenario ID → class, mirroring the runbook matrix (docs/pilot/RUNBOOK.md). */
export const SCENARIO_CLASSES: Record<string, string> = {
  "SC-MEET-01": "meetings",
  "SC-TASK-01": "tasks",
  "SC-IDEA-01": "ideas",
  "SC-FOLL-01": "follow-ups",
  "SC-DEC-01": "decisions",
  "SC-PEOP-01": "people",
  "SC-PROJ-01": "projects",
  "SC-EMOT-01": "mixed/emotional",
  "SC-MULTI-01": "multi-capture",
};

/** Known variant labels from the runbook matrix. */
export const SCENARIO_VARIANTS = [
  "V-ACCENT",
  "V-PACE",
  "V-NOISE",
  "V-INTERRUPT",
  "V-CORRECT",
  "V-REPEAT",
] as const;

/** Extract known variant labels from free-text run notes (deterministic). */
export function variantsFromNotes(notes: string | undefined): string[] {
  if (notes === undefined) return [];
  const tokens = notes.match(/\bV-[A-Z]+\b/g) ?? [];
  return [...new Set(tokens)].filter((t) =>
    (SCENARIO_VARIANTS as readonly string[]).includes(t),
  );
}

/* ------------------------------------------------------------------ */
/* Promotion sources                                                   */
/* ------------------------------------------------------------------ */

/** Cohort metadata carried through the existing case-meta fields (FR-12). */
export interface PromotionCohort {
  scenarioClass?: string;
  variants?: string[];
  language?: string;
  accent?: string;
  noise?: string;
  /**
   * FR-12: defaults to "de-identified"; the product owner may classify a
   * case "consented-volunteer" (consent state follows automatically).
   */
  provenance?: "de-identified" | "consented-volunteer";
  /**
   * Specification 6.5: capture-time bucket context. When present, the
   * promotion is born in-context and its origin label is derived
   * mechanically from whether the expected bucket appears in this list.
   */
  existingBuckets?: ExistingBucketSnapshot[];
}

/** FR-6: an explicit accept decision — the label is Donna's chosen bucket. */
export interface AcceptedPromotionSource extends PromotionCohort {
  kind: "first-pass-accept";
  decisionId: string;
  /** De-identified thought summary — becomes the case transcript. */
  summaryText: string;
  /** Donna's bucket at decision time. */
  donnaBucket: string;
  thoughtKind: "idea" | "task" | "note";
}

/** FR-5: an accepted bucket.move correction — the label is the corrected bucket. */
export interface CorrectedPromotionSource extends PromotionCohort {
  kind: "corrected";
  correctionId: string;
  /** De-identified thought summary — becomes the case transcript. */
  summaryText: string;
  /** The model's original placement (the "before"). */
  fromBucket: string;
  /** The user's corrected bucket (the label). */
  toBucket: string;
  thoughtKind: "idea" | "task" | "note";
}

export type OrganizePromotionSource = AcceptedPromotionSource | CorrectedPromotionSource;

/** The inline organize case shape (datasets.ts organizeCaseSchema). */
export interface OrganizeInlineCase {
  id: string;
  meta: {
    provenance: "de-identified" | "consented-volunteer";
    labeler: string;
    adjudicator: string;
    consent: "de-identified" | "consented";
    sensitivity: "none" | "low" | "moderate";
    language?: string;
    accent?: string;
    noise?: string;
    notes?: string;
  };
  transcript: string;
  existingBuckets?: ExistingBucketSnapshot[];
  expected: {
    thoughts: Array<{
      kind: "idea" | "task" | "note";
      bucket: string;
      bucketOrigin?: BucketOrigin;
      contains: string[];
    }>;
  };
}

export interface OrganizePromotionDraft {
  /** The inline case exactly as it will be written into the envelope. */
  case: OrganizeInlineCase;
  /** SHA-256 over the canonical case JSON — preview hash == written hash (FR-4). */
  payloadHash: string;
  /** The adjudication entry appended with the case (FR-7). */
  adjudication: Adjudication;
  /** Promotions always land in the development partition (FR-8). */
  partition: "dev";
}

/* ------------------------------------------------------------------ */
/* Deterministic case identity                                         */
/* ------------------------------------------------------------------ */

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** FR-11: the case ID derives from the de-identified payload hash. */
export function organizeCaseId(caseWithoutId: Omit<OrganizeInlineCase, "id">): string {
  return `organize-pilot-${sha256Hex(canonicalize(caseWithoutId)).slice(0, 12)}`;
}

/**
 * FR-4: the content hash of a case exactly as written — the preview shows
 * it, the confirm writes byte-identical content, and the equality check
 * recomputes it from the written envelope.
 */
export function organizeCasePayloadHash(theCase: OrganizeInlineCase): string {
  return sha256Hex(canonicalize(theCase));
}

/**
 * Derive the `contains` substrings for the expected thought: the first two
 * significant words (≥ 4 letters, lowercased, deduped) of the de-identified
 * summary. Deterministic; the product owner adjudicates labels at batch
 * review like any other case.
 */
function deriveContains(summary: string): string[] {
  const words = summary.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (words.length === 0) {
    throw new PromotionError("The thought summary has no usable text for an eval case");
  }
  const significant = [...new Set(words.filter((w) => w.length >= 4))];
  const picked = significant.slice(0, 2);
  if (picked.length === 0) {
    picked.push(words.reduce((a, b) => (b.length > a.length ? b : a)));
  }
  return picked;
}

function normalizeBucketName(value: string): string {
  return value.trim().toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Build + screen                                                      */
/* ------------------------------------------------------------------ */

/**
 * Build the deterministic de-identified case and its adjudication entry
 * from a promotion source. Pure — the same source always yields the same
 * case (and therefore the same preview/written hash, FR-4).
 */
export function buildOrganizePromotion(
  source: OrganizePromotionSource,
  deps: { now: () => Date },
): OrganizePromotionDraft {
  const summary = source.summaryText.trim();
  if (summary.length === 0) {
    throw new PromotionError("A promoted case needs the de-identified thought summary");
  }
  const expectedBucket = (source.kind === "corrected" ? source.toBucket : source.donnaBucket).trim();
  if (expectedBucket.length === 0) {
    throw new PromotionError("A promoted case needs the expected bucket label");
  }
  const provenance = source.provenance ?? "de-identified";
  const existingBuckets = source.existingBuckets?.map((bucket) => ({
    name: bucket.name.trim(),
    description: bucket.description,
  }));
  const bucketOrigin: BucketOrigin | undefined =
    existingBuckets === undefined
      ? undefined
      : existingBuckets.some(
          (bucket) =>
            normalizeBucketName(bucket.name) === normalizeBucketName(expectedBucket),
        )
        ? "joined"
        : "minted";
  const cohortNotes = [
    source.scenarioClass !== undefined ? `scenario-class:${source.scenarioClass}` : undefined,
    source.variants !== undefined && source.variants.length > 0
      ? `variants:${source.variants.join(",")}`
      : undefined,
  ]
    .filter((part) => part !== undefined)
    .join("; ");
  const caseWithoutId: Omit<OrganizeInlineCase, "id"> = {
    meta: {
      provenance,
      labeler: PILOT_LABELER_ID,
      adjudicator: PRODUCT_OWNER_ADJUDICATOR_ID,
      consent: provenance === "consented-volunteer" ? "consented" : "de-identified",
      sensitivity: "low",
      ...(source.language !== undefined ? { language: source.language } : {}),
      ...(source.accent !== undefined ? { accent: source.accent } : {}),
      ...(source.noise !== undefined ? { noise: source.noise } : {}),
      ...(cohortNotes !== "" ? { notes: cohortNotes } : {}),
    },
    transcript: summary,
    ...(existingBuckets !== undefined ? { existingBuckets } : {}),
    expected: {
      thoughts: [
        {
          kind: source.thoughtKind,
          bucket: expectedBucket,
          ...(bucketOrigin !== undefined ? { bucketOrigin } : {}),
          contains: deriveContains(summary),
        },
      ],
    },
  };
  const id = organizeCaseId(caseWithoutId);
  const theCase: OrganizeInlineCase = { id, ...caseWithoutId };
  const adjudication: Adjudication =
    source.kind === "corrected"
      ? {
          at: deps.now().toISOString(),
          adjudicator: PRODUCT_OWNER_ADJUDICATOR_ID,
          caseId: id,
          change: `expected.bucket: '${source.fromBucket}' → '${source.toBucket}'`,
          reason:
            `pilot correction ${source.correctionId} accepted; ` +
            `promoted de-identified with eval-sharing consent`,
        }
      : {
          at: deps.now().toISOString(),
          adjudicator: PRODUCT_OWNER_ADJUDICATOR_ID,
          caseId: id,
          change: `new case: first-pass accepted placement '${source.donnaBucket}'`,
          reason:
            `pilot decision ${source.decisionId} (explicit accept); ` +
            `promoted de-identified with eval-sharing consent`,
        };
  return {
    case: theCase,
    payloadHash: organizeCasePayloadHash(theCase),
    adjudication,
    partition: "dev",
  };
}

/** Collect every string value in a JSON tree for the PII screen (SR-3). */
function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, into);
  }
}

/**
 * SR-3: screen every text field of the draft (case + adjudication).
 * Category tokens only, never the matched content.
 */
export function screenOrganizePromotion(draft: OrganizePromotionDraft): void {
  const strings: string[] = [];
  collectStrings(draft.case, strings);
  collectStrings(draft.adjudication, strings);
  const hits = strings.flatMap((s) => screenSensitiveContent(s));
  if (hits.length > 0) {
    throw new SensitiveContentError([...new Set(hits.map((h) => h.category))]);
  }
}

/* ------------------------------------------------------------------ */
/* Preview + confirm (consent fail-closed at both steps, FR-3)         */
/* ------------------------------------------------------------------ */

export interface PromotionDeps {
  hasConsent: (purpose: string) => Promise<boolean>;
  now: () => Date;
}

/**
 * FR-4: preview the exact de-identified payload to be written. Checks
 * consent and screens the payload; writes nothing.
 */
export async function previewOrganizePromotion(
  deps: PromotionDeps,
  source: OrganizePromotionSource,
): Promise<OrganizePromotionDraft> {
  if (!(await deps.hasConsent(EVAL_SHARING_PURPOSE))) {
    throw new ConsentRequiredError(EVAL_SHARING_PURPOSE);
  }
  const draft = buildOrganizePromotion(source, deps);
  screenOrganizePromotion(draft);
  return draft;
}

export interface ConfirmDeps extends PromotionDeps {
  /** Path to the DEVELOPMENT envelope (organize.dev.v1.json). */
  envelopePath: string;
}

export interface ConfirmResult {
  caseId: string;
  alreadyShared: boolean;
  /** The envelope version after the write (unchanged when already shared). */
  version: number;
  /** Hash of the written case — equals the previewed hash (FR-4). */
  payloadHash: string;
}

/**
 * FR-4/FR-7/FR-11: confirm a previewed promotion. Re-checks consent,
 * rebuilds and re-screens the payload, then appends the case + exactly one
 * adjudication entry with the envelope version bumped in a single write.
 * Re-promoting the same source is a byte-identical no-op.
 */
export async function confirmOrganizePromotion(
  deps: ConfirmDeps,
  source: OrganizePromotionSource,
): Promise<ConfirmResult> {
  if (!(await deps.hasConsent(EVAL_SHARING_PURPOSE))) {
    throw new ConsentRequiredError(EVAL_SHARING_PURPOSE);
  }
  const draft = buildOrganizePromotion(source, deps);
  screenOrganizePromotion(draft);

  const absolute = resolve(deps.envelopePath);
  // Fail closed: the target envelope must currently validate, and only the
  // development partition may receive promoted cases (FR-8).
  const current = await loadDataset(absolute);
  if (current.stage !== "organize" || !/^organize\.dev\./.test(current.name)) {
    throw new PromotionError(
      "Promoted cases land only in the development partition (organize.dev.* envelopes)",
    );
  }
  if (current.cases.some((c) => c.id === draft.case.id)) {
    return {
      caseId: draft.case.id,
      alreadyShared: true,
      version: current.version,
      payloadHash: draft.payloadHash,
    };
  }

  const raw = JSON.parse(await readFile(absolute, "utf8")) as Record<string, unknown>;
  const cases = Array.isArray(raw["cases"]) ? (raw["cases"] as unknown[]) : [];
  const adjudications = Array.isArray(raw["adjudications"])
    ? (raw["adjudications"] as unknown[])
    : [];
  const next = {
    ...raw,
    version: current.version + 1,
    cases: [...cases, draft.case],
    adjudications: [...adjudications, draft.adjudication],
  };
  await writeValidatedEnvelope(absolute, JSON.stringify(next, null, 2) + "\n");
  return {
    caseId: draft.case.id,
    alreadyShared: false,
    version: current.version + 1,
    payloadHash: draft.payloadHash,
  };
}

/**
 * Write an envelope only after the exact new bytes pass the full dataset
 * validation (schema, consent/provenance consistency, screening,
 * adjudication references). Validation runs against a temp sibling; the
 * real file is written only when validation passes (SR-2 fail-closed).
 */
async function writeValidatedEnvelope(absolutePath: string, content: string): Promise<void> {
  const tempPath = join(
    dirname(absolutePath),
    `.${basename(absolutePath)}.tmp-${process.pid}`,
  );
  await writePrivateFile(tempPath, content);
  try {
    await loadDataset(tempPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
  await rm(tempPath, { force: true });
  await writePrivateFile(absolutePath, content);
}

/* ------------------------------------------------------------------ */
/* Gated dev→held-out promotion (FR-8)                                 */
/* ------------------------------------------------------------------ */

export interface HeldoutMoveResult {
  moved: string[];
  devVersion: number;
  heldoutVersion: number;
  rationale: string;
}

/**
 * The product-owner-gated dev→held-out promotion: a stratified BATCH of
 * selected cases moves partitions with a recorded rationale (product-owner
 * resolution, 2026-09-04). A case never exists in both partitions after
 * the move; each envelope's version bumps and appends adjudication
 * entries — the held-out envelope also receives the case's full
 * adjudication history so its origin stays reconstructible (SR-5). The
 * held-out envelope is written first so a mid-move crash can never lose a
 * case from both partitions.
 */
export async function promoteOrganizeCasesToHeldout(
  deps: { devEnvelopePath: string; heldoutEnvelopePath: string; now: () => Date },
  input: { caseIds: string[]; rationale: string; adjudicator?: string },
): Promise<HeldoutMoveResult> {
  const caseIds = [...new Set(input.caseIds)];
  if (caseIds.length === 0) {
    throw new PromotionError("A dev→held-out promotion needs at least one case ID");
  }
  if (input.rationale.trim().length === 0) {
    throw new PromotionError("A dev→held-out promotion needs a recorded rationale");
  }
  const adjudicator = input.adjudicator ?? PRODUCT_OWNER_ADJUDICATOR_ID;
  const devPath = resolve(deps.devEnvelopePath);
  const heldoutPath = resolve(deps.heldoutEnvelopePath);

  const dev = await loadDataset(devPath);
  const heldout = await loadDataset(heldoutPath);
  if (!/^organize\.dev\./.test(dev.name)) {
    throw new PromotionError(`The dev partition must be an organize.dev.* envelope, got ${dev.name}`);
  }
  if (!/^organize\.heldout\./.test(heldout.name)) {
    throw new PromotionError(
      `The held-out partition must be an organize.heldout.* envelope, got ${heldout.name}`,
    );
  }
  const duplicated = caseIds.filter((id) => heldout.cases.some((c) => c.id === id));
  if (duplicated.length > 0) {
    throw new PromotionError(
      `Case(s) already in the held-out partition: ${duplicated.join(", ")}`,
    );
  }
  const missing = caseIds.filter((id) => !dev.cases.some((c) => c.id === id));
  if (missing.length > 0) {
    throw new PromotionError(`Case(s) not in the development partition: ${missing.join(", ")}`);
  }

  const at = deps.now().toISOString();
  const devRaw = JSON.parse(await readFile(devPath, "utf8")) as Record<string, unknown> & {
    version: number;
    cases: Array<Record<string, unknown> & { id: string }>;
    adjudications: Adjudication[];
  };
  const heldoutRaw = JSON.parse(await readFile(heldoutPath, "utf8")) as Record<string, unknown> & {
    version: number;
    cases: Array<Record<string, unknown> & { id: string }>;
    adjudications: Adjudication[];
  };

  const moving = devRaw.cases.filter((c) => caseIds.includes(c.id));
  const traveling = devRaw.adjudications.filter((a) => caseIds.includes(a.caseId));
  const devVersion = devRaw.version + 1;
  const heldoutVersion = heldoutRaw.version + 1;

  const heldoutNext = {
    ...heldoutRaw,
    version: heldoutVersion,
    cases: [...heldoutRaw.cases, ...moving],
    adjudications: [
      ...heldoutRaw.adjudications,
      ...traveling,
      ...caseIds.map((caseId) => ({
        at,
        adjudicator,
        caseId,
        change: `partition: dev → held-out (from ${dev.name} v${devRaw.version})`,
        reason: input.rationale,
      })),
    ],
  };
  await writeValidatedEnvelope(heldoutPath, JSON.stringify(heldoutNext, null, 2) + "\n");

  const devNext = {
    ...devRaw,
    version: devVersion,
    cases: devRaw.cases.filter((c) => !caseIds.includes(c.id)),
    adjudications: [
      ...devRaw.adjudications.filter((a) => !caseIds.includes(a.caseId)),
      ...caseIds.map((caseId) => ({
        at,
        adjudicator,
        caseId,
        change: `partition: dev → held-out (to ${heldout.name} v${heldoutVersion})`,
        reason: input.rationale,
      })),
    ],
  };
  await writeValidatedEnvelope(devPath, JSON.stringify(devNext, null, 2) + "\n");

  return { moved: caseIds, devVersion, heldoutVersion, rationale: input.rationale };
}

/* ------------------------------------------------------------------ */
/* Held-out freeze lock (FR-9, SR-6)                                   */
/* ------------------------------------------------------------------ */

export const HELDOUT_LOCK_SCHEMA = "donna.heldout-lock.v1";

export interface HeldoutLock {
  schema: typeof HELDOUT_LOCK_SCHEMA;
  /** Envelope name, e.g. "organize.heldout.v1". */
  name: string;
  /** The frozen envelope version. */
  version: number;
  /** SHA-256 over the envelope file content at freeze time. */
  sha256: string;
  frozenAt: string; // ISO 8601
  /** SHA-256 over the first-results report file for this held-out version. */
  firstResultsReportSha256: string;
}

const HELDOUT_ENVELOPE_NAME = /^([\w][\w.-]*\.heldout)\.v\d+\.json$/;

/** True when a dataset path names a held-out envelope (lockable). */
export function isHeldoutEnvelopePath(datasetPath: string): boolean {
  return HELDOUT_ENVELOPE_NAME.test(basename(datasetPath));
}

/** The lock file path conventionally paired with a held-out envelope. */
export function heldoutLockPath(envelopePath: string): string {
  const base = basename(envelopePath);
  const match = base.match(HELDOUT_ENVELOPE_NAME);
  if (match === null) {
    throw new PromotionError(`Not a held-out envelope path: ${base}`);
  }
  return join(dirname(envelopePath), `${match[1]}.lock.json`);
}

/** Read the lock paired with a held-out envelope, when one exists. */
export async function readHeldoutLock(envelopePath: string): Promise<HeldoutLock | undefined> {
  let raw: string;
  try {
    raw = await readFile(heldoutLockPath(envelopePath), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  return JSON.parse(raw) as HeldoutLock;
}

/**
 * FR-9: freeze a held-out version after its first results run. Writes the
 * lock (name, version, envelope content hash, frozen-at, first-results
 * report hash). The report must BE a results run against this exact
 * envelope content; re-freezing an already-frozen version is refused —
 * a version bump (via the gated dev→held-out promotion) plus a fresh
 * results run is the only way forward.
 */
export async function freezeHeldoutEnvelope(input: {
  envelopePath: string;
  reportPath: string;
  now: () => Date;
}): Promise<HeldoutLock> {
  const absolute = resolve(input.envelopePath);
  const raw = await readFile(absolute, "utf8");
  const envelope = JSON.parse(raw) as { name: string; version: number };
  const sha256 = sha256Hex(raw);

  const reportRaw = await readFile(resolve(input.reportPath), "utf8");
  const report = JSON.parse(reportRaw) as {
    dataset?: { name?: string; version?: number; sha256?: string };
  };
  if (
    report.dataset?.name !== envelope.name ||
    report.dataset?.version !== envelope.version ||
    report.dataset?.sha256 !== sha256
  ) {
    throw new PromotionError(
      "The report is not a results run against this held-out envelope version — freeze refused",
    );
  }

  const existing = await readHeldoutLock(absolute);
  if (existing !== undefined) {
    if (existing.version === envelope.version) {
      throw new PromotionError(
        `${envelope.name} is already frozen at version ${envelope.version} — ` +
          "held-out content is not re-frozen; bump the version via the gated dev→held-out promotion first",
      );
    }
    if (existing.version > envelope.version) {
      throw new PromotionError(
        `The lock (${existing.name} v${existing.version}) is ahead of the envelope (v${envelope.version}) — refusing to freeze`,
      );
    }
  }

  const lock: HeldoutLock = {
    schema: HELDOUT_LOCK_SCHEMA,
    name: envelope.name,
    version: envelope.version,
    sha256,
    frozenAt: input.now().toISOString(),
    firstResultsReportSha256: sha256Hex(reportRaw),
  };
  await writePrivateFile(heldoutLockPath(absolute), JSON.stringify(lock, null, 2) + "\n");
  return lock;
}

export type HeldoutLockStatus =
  | "no-lock"
  | "intact"
  | "unfrozen-new-version";

/**
 * SR-6: when a held-out envelope has a lock at its current version, the
 * envelope's content hash MUST equal the lock's — any drift is a hard
 * validation failure, never a warning. A newer envelope version than the
 * lock is the sanctioned post-promotion state (results run, then re-freeze).
 */
export async function checkHeldoutLock(
  envelopePath: string,
): Promise<{ status: HeldoutLockStatus; lock?: HeldoutLock }> {
  const lock = await readHeldoutLock(envelopePath);
  if (lock === undefined) return { status: "no-lock" };
  const absolute = resolve(envelopePath);
  const raw = await readFile(absolute, "utf8");
  const envelope = JSON.parse(raw) as { name: string; version: number };
  if (lock.name !== envelope.name) {
    throw new PromotionError(
      `Held-out lock names ${lock.name} but the envelope is ${envelope.name} — hard validation failure`,
    );
  }
  if (lock.version > envelope.version) {
    throw new PromotionError(
      `Held-out lock v${lock.version} is ahead of envelope v${envelope.version} — hard validation failure`,
    );
  }
  if (lock.version === envelope.version) {
    const sha256 = sha256Hex(raw);
    if (sha256 !== lock.sha256) {
      throw new PromotionError(
        `Held-out envelope ${envelope.name} v${envelope.version} content differs from its freeze lock ` +
          `(locked ${lock.sha256.slice(0, 12)}…, actual ${sha256.slice(0, 12)}…) — ` +
          "held-out cases must not be altered after results are known",
      );
    }
    return { status: "intact", lock };
  }
  return { status: "unfrozen-new-version", lock };
}
