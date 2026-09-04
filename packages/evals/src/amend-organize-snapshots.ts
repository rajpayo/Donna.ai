/**
 * Capture-time bucket-snapshot reconstruction and additive organize-envelope
 * amendment (Specification 6.5).
 *
 * Source stores are read-only. The only writes are the explicitly supplied
 * eval envelopes and content-free evidence artifacts. Ambiguous history is
 * reported and blocks amendment until a product-owner batch override is
 * supplied; it is never guessed or silently excluded.
 */
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
  Bucket,
  BucketStore,
  CaptureRecord,
  CaptureStore,
  CorrectionEvent,
  CorrectionStore,
} from "@donna/core";
import { writePrivateFile } from "@donna/file-security";
import { screenSensitiveContent } from "@donna/memory";
import type {
  PilotBucketSnapshot,
  PilotDecision,
  PilotDecisionStore,
} from "@donna/pilot";
import { loadDataset, type Adjudication } from "./datasets.js";
import {
  checkHeldoutLock,
  PRODUCT_OWNER_ADJUDICATOR_ID,
  type BucketOrigin,
  type ExistingBucketSnapshot,
} from "./promote-organize.js";

export const SNAPSHOT_DRIFT_SCHEMA = "donna.organize-snapshot-drift.v1";
export const AMENDMENT_DIFF_SCHEMA = "donna.organize-amendment-diff.v1";

type ReconstructionBucket = Pick<
  Bucket,
  "id" | "name" | "description" | "createdAt"
>;

export interface SnapshotReconstructionResult {
  status: "ok" | "ambiguous";
  existingBuckets: ExistingBucketSnapshot[];
  /** Local reconstruction aid; IDs/names are never written to evidence artifacts. */
  bucketNamesById: Record<string, string>;
  /** Machine tokens only; never bucket content. */
  reasons: string[];
  correctionsRolledBack: number;
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function effectiveCorrectionTime(event: CorrectionEvent): string {
  return event.appliedAt ?? event.resolvedAt ?? event.createdAt;
}

/**
 * Reconstruct the bucket list visible when a capture began. Current state is
 * rolled backward through accepted rename/merge corrections newer than the
 * capture. Historical events without enough inverse data are ambiguous.
 */
export function reconstructCaptureTimeBuckets(input: {
  capture: Pick<CaptureRecord, "id" | "capturedAt">;
  currentBuckets: ReconstructionBucket[];
  corrections: CorrectionEvent[];
}): SnapshotReconstructionResult {
  const capturedAt = input.capture.capturedAt;
  if (Number.isNaN(Date.parse(capturedAt))) {
    return {
      status: "ambiguous",
      existingBuckets: [],
      bucketNamesById: {},
      reasons: ["capture-time-invalid"],
      correctionsRolledBack: 0,
    };
  }

  const buckets = new Map<string, ReconstructionBucket>(
    input.currentBuckets.map((bucket) => [bucket.id, { ...bucket }]),
  );
  const reasons = new Set<string>();
  let correctionsRolledBack = 0;
  const later = input.corrections
    .filter(
      (event) =>
        event.status === "accepted" &&
        event.appliedAt !== undefined &&
        effectiveCorrectionTime(event) > capturedAt &&
        (event.type === "bucket.rename" || event.type === "bucket.merge"),
    )
    .sort((a, b) => effectiveCorrectionTime(b).localeCompare(effectiveCorrectionTime(a)));

  for (const event of later) {
    if (event.type === "bucket.rename") {
      const target = buckets.get(event.target.id);
      if (target === undefined || target.createdAt > capturedAt) continue;
      const oldName = event.payload["oldName"];
      if (oldName === undefined || oldName.trim().length === 0) {
        reasons.add("rename-missing-old-name");
        continue;
      }
      target.name = oldName;
      correctionsRolledBack += 1;
      continue;
    }

    const sourceCreatedAt = event.payload["sourceCreatedAt"];
    if (sourceCreatedAt !== undefined && sourceCreatedAt > capturedAt) {
      continue;
    }
    const sourceName = event.payload["sourceName"];
    const sourceDescription = event.payload["sourceDescription"];
    if (
      sourceCreatedAt === undefined ||
      sourceName === undefined ||
      sourceDescription === undefined
    ) {
      reasons.add("merge-missing-source-snapshot");
      continue;
    }
    buckets.set(event.target.id, {
      id: event.target.id,
      name: sourceName,
      description: sourceDescription,
      createdAt: sourceCreatedAt,
    });
    correctionsRolledBack += 1;
  }

  const atCapture = [...buckets.values()]
    .filter((bucket) => bucket.createdAt <= capturedAt)
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  if (atCapture.some((bucket) => bucket.createdAt > capturedAt)) {
    reasons.add("post-capture-bucket-in-snapshot");
  }
  const seen = new Set<string>();
  for (const bucket of atCapture) {
    const key = normalized(bucket.name);
    if (seen.has(key)) reasons.add("duplicate-normalized-bucket-name");
    seen.add(key);
  }

  return {
    status: reasons.size === 0 ? "ok" : "ambiguous",
    existingBuckets: atCapture.map(({ name, description }) => ({
      name,
      description,
    })),
    bucketNamesById: Object.fromEntries(
      atCapture.map((bucket) => [bucket.id, bucket.name]),
    ),
    reasons: [...reasons].sort(),
    correctionsRolledBack,
  };
}

export interface SnapshotAdjudicationOverride {
  caseId: string;
  existingBuckets: PilotBucketSnapshot[];
  bucketOrigin: BucketOrigin;
  /** Content-free rationale token, e.g. "po-reviewed-merge-history". */
  reason: string;
}

export interface SnapshotSourceStores {
  captures: CaptureStore;
  buckets: BucketStore;
  corrections: CorrectionStore;
  decisions: PilotDecisionStore;
}

export interface SnapshotDriftEntry {
  caseId: string;
  source: "pilot-decision" | "pilot-correction" | "unknown";
  reasons: string[];
  nameDrift: boolean;
}

export interface SnapshotDriftReport {
  schema: typeof SNAPSHOT_DRIFT_SCHEMA;
  generatedAt: string;
  candidateCases: number;
  reconstructibleCases: number;
  overriddenCases: number;
  unresolvedCases: number;
  cases: SnapshotDriftEntry[];
}

export interface OrganizeAmendmentDiff {
  schema: typeof AMENDMENT_DIFF_SCHEMA;
  generatedAt: string;
  onlyPermittedChanges: boolean;
  sameCaseIds: boolean;
  permittedAdditions: ["existingBuckets", "expected.thoughts[].bucketOrigin"];
  envelopes: Array<{
    name: string;
    beforeVersion: number;
    afterVersion: number;
    beforeSha256: string;
    afterSha256: string;
    inlineCaseCount: number;
    loadedCaseCount: number;
    caseIds: string[];
    amendedCaseCount: number;
    adjudicationsAdded: number;
  }>;
  caseIds: string[];
}

interface RawThought {
  bucket: string | null;
  bucketOrigin?: BucketOrigin;
  [key: string]: unknown;
}

interface RawCase {
  id: string;
  existingBuckets?: ExistingBucketSnapshot[];
  expected: { thoughts: RawThought[] };
  [key: string]: unknown;
}

interface RawEnvelope {
  name: string;
  version: number;
  cases: RawCase[];
  adjudications: Adjudication[];
  [key: string]: unknown;
}

interface SourceReference {
  kind: "pilot-decision" | "pilot-correction";
  id: string;
}

function sourceReference(
  caseId: string,
  adjudications: Adjudication[],
): SourceReference | undefined {
  for (const entry of adjudications) {
    if (entry.caseId !== caseId) continue;
    const match = entry.reason.match(/\bpilot (decision|correction) ([A-Za-z0-9._-]+)/);
    if (match?.[1] === "decision" && match[2] !== undefined) {
      return { kind: "pilot-decision", id: match[2] };
    }
    if (match?.[1] === "correction" && match[2] !== undefined) {
      return { kind: "pilot-correction", id: match[2] };
    }
  }
  return undefined;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function withoutSnapshotFields(theCase: RawCase): unknown {
  const clone = structuredClone(theCase);
  delete clone.existingBuckets;
  for (const thought of clone.expected.thoughts) delete thought.bucketOrigin;
  return clone;
}

function withoutAmendmentFields(envelope: RawEnvelope): unknown {
  const {
    version: _version,
    adjudications: _adjudications,
    ...clone
  } = structuredClone(envelope);
  clone.cases = clone.cases.map(
    (theCase) => withoutSnapshotFields(theCase) as RawCase,
  );
  return clone;
}

function snapshotOrigin(
  label: string,
  buckets: ExistingBucketSnapshot[],
): BucketOrigin {
  return buckets.some((bucket) => normalized(bucket.name) === normalized(label))
    ? "joined"
    : "minted";
}

function snapshotSafetyProblems(
  snapshot: ExistingBucketSnapshot[],
  forbiddenValues: string[],
): string[] {
  const reasons = new Set<string>();
  for (const bucket of snapshot) {
    for (const value of [bucket.name, bucket.description]) {
      if (screenSensitiveContent(value).length > 0) {
        reasons.add("sensitive-content");
      }
      for (const forbidden of forbiddenValues) {
        if (forbidden.length >= 4 && value.includes(forbidden)) {
          reasons.add("forbidden-source-identifier");
        }
      }
    }
  }
  return [...reasons].sort();
}

async function validateEnvelopeContent(path: string, content: string): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.amend-${process.pid}.tmp`);
  await writePrivateFile(temp, content);
  try {
    await loadDataset(temp);
  } finally {
    await rm(temp, { force: true });
  }
}

/**
 * Amend one or more organize envelopes. Application is all-or-nothing with
 * respect to ambiguity: any unresolved case leaves every envelope untouched.
 * The held-out v2 lock must be intact before a v3 amendment is allowed.
 */
export async function amendOrganizeSnapshotEnvelopes(input: {
  envelopePaths: string[];
  scope: { tenantId: string; userId: string };
  stores: SnapshotSourceStores;
  overrides?: SnapshotAdjudicationOverride[];
  apply: boolean;
  driftReportPath: string;
  diffArtifactPath: string;
  now: () => Date;
}): Promise<{
  applied: boolean;
  drift: SnapshotDriftReport;
  diff?: OrganizeAmendmentDiff;
}> {
  const paths = input.envelopePaths.map((path) => resolve(path));
  const now = input.now().toISOString();
  const [currentBuckets, corrections, decisions] = await Promise.all([
    input.stores.buckets.listBuckets(input.scope.tenantId, input.scope.userId),
    input.stores.corrections.listCorrections(input.scope.tenantId, input.scope.userId),
    input.stores.decisions.list(input.scope.tenantId, input.scope.userId),
  ]);
  const overrides = new Map((input.overrides ?? []).map((item) => [item.caseId, item]));
  const rawInputs = await Promise.all(
    paths.map(async (path) => {
      const content = await readFile(path, "utf8");
      const loaded = await loadDataset(path);
      if (/\.heldout\./.test((JSON.parse(content) as RawEnvelope).name)) {
        const lock = await checkHeldoutLock(path);
        if (lock.status !== "intact") {
          throw new Error(
            "Held-out snapshot amendment requires an intact lock at the current version",
          );
        }
      }
      return {
        path,
        beforeContent: content,
        before: JSON.parse(content) as RawEnvelope,
        loadedCaseIds: loaded.cases.map((theCase) => theCase.id),
      };
    }),
  );

  const allAdjudications = rawInputs.flatMap(({ before }) => before.adjudications);
  const decisionById = new Map(decisions.map((decision) => [decision.id, decision]));
  const correctionById = new Map(corrections.map((event) => [event.id, event]));
  const unresolved: SnapshotDriftEntry[] = [];
  const reconstructible: SnapshotDriftEntry[] = [];
  let overriddenCases = 0;
  const caseIds: string[] = [];
  const nextInputs: Array<{
    path: string;
    beforeContent: string;
    before: RawEnvelope;
    loadedCaseIds: string[];
    next: RawEnvelope;
    amended: number;
  }> = [];

  for (const rawInput of rawInputs) {
    const next = structuredClone(rawInput.before);
    let amended = 0;
    for (const theCase of next.cases) {
      if (!theCase.id.startsWith("organize-pilot-")) continue;
      caseIds.push(theCase.id);
      if (
        theCase.existingBuckets !== undefined &&
        theCase.expected.thoughts.every((thought) => thought.bucketOrigin !== undefined)
      ) {
        continue;
      }

      const reference = sourceReference(theCase.id, allAdjudications);
      const source = reference?.kind ?? "unknown";
      const override = overrides.get(theCase.id);
      let existingBuckets: ExistingBucketSnapshot[] | undefined;
      let expectedBucketId: string | undefined;
      let reconstructionReasons: string[] = [];
      let bucketNamesById: Record<string, string> | undefined;
      let captureId: string | undefined;
      let participantId: string | undefined;

      if (override !== undefined) {
        existingBuckets = override.existingBuckets.map(({ name, description }) => ({
          name,
          description,
        }));
        overriddenCases += 1;
      } else if (reference?.kind === "pilot-decision") {
        const decision = decisionById.get(reference.id);
        if (decision === undefined) {
          reconstructionReasons.push("decision-not-found");
        } else {
          captureId = decision.captureId;
          participantId = decision.participantId;
          expectedBucketId =
            decision.kind === "accept"
              ? decision.donnaBucket.id
              : decision.decidedBucket.id;
          if (decision.existingBuckets !== undefined) {
            existingBuckets = decision.existingBuckets.map(({ name, description }) => ({
              name,
              description,
            }));
          }
        }
      } else if (reference?.kind === "pilot-correction") {
        const event = correctionById.get(reference.id);
        const decision = decisions.find((item) => item.correctionId === reference.id);
        if (event === undefined) {
          reconstructionReasons.push("correction-not-found");
        } else {
          captureId =
            decision?.captureId ??
            event.sources.find((item) => item.captureId !== undefined)?.captureId;
          participantId = decision?.participantId;
          expectedBucketId = event.payload["toBucketId"];
          if (decision?.existingBuckets !== undefined) {
            existingBuckets = decision.existingBuckets.map(({ name, description }) => ({
              name,
              description,
            }));
          }
        }
      } else {
        reconstructionReasons.push("promotion-source-not-found");
      }

      if (existingBuckets === undefined) {
        if (captureId === undefined) {
          reconstructionReasons.push("capture-link-missing");
        } else {
          const capture = await input.stores.captures.getCapture(
            input.scope.tenantId,
            input.scope.userId,
            captureId,
          );
          if (capture === undefined) {
            reconstructionReasons.push("capture-not-found");
          } else {
            const reconstruction = reconstructCaptureTimeBuckets({
              capture,
              currentBuckets,
              corrections,
            });
            existingBuckets = reconstruction.existingBuckets;
            bucketNamesById = reconstruction.bucketNamesById;
            reconstructionReasons.push(...reconstruction.reasons);
          }
        }
      }

      const forbiddenValues = [
        input.scope.tenantId,
        input.scope.userId,
        captureId ?? "",
        reference?.id ?? "",
        participantId ?? "",
      ];
      if (existingBuckets !== undefined) {
        reconstructionReasons.push(
          ...snapshotSafetyProblems(existingBuckets, forbiddenValues),
        );
      }

      const labeledThoughts = theCase.expected.thoughts.filter(
        (thought): thought is RawThought & { bucket: string } =>
          thought.bucket !== null,
      );
      const nameDrift =
        existingBuckets !== undefined &&
        expectedBucketId !== undefined &&
        bucketNamesById?.[expectedBucketId] !== undefined &&
        labeledThoughts.some(
          (thought) =>
            normalized(thought.bucket) !==
            normalized(bucketNamesById![expectedBucketId]!),
        );
      if (nameDrift) reconstructionReasons.push("expected-name-drift");

      const uniqueReasons = [...new Set(reconstructionReasons)].sort();
      if (existingBuckets === undefined || uniqueReasons.length > 0) {
        unresolved.push({
          caseId: theCase.id,
          source,
          reasons: uniqueReasons.length > 0 ? uniqueReasons : ["snapshot-unavailable"],
          nameDrift,
        });
        continue;
      }

      for (const thought of labeledThoughts) {
        const derived = snapshotOrigin(thought.bucket, existingBuckets);
        if (override !== undefined && derived !== override.bucketOrigin) {
          unresolved.push({
            caseId: theCase.id,
            source,
            reasons: ["override-origin-inconsistent"],
            nameDrift,
          });
          existingBuckets = undefined;
          break;
        }
        thought.bucketOrigin = derived;
      }
      if (existingBuckets === undefined) continue;
      theCase.existingBuckets = existingBuckets;
      next.adjudications.push({
        at: now,
        adjudicator: PRODUCT_OWNER_ADJUDICATOR_ID,
        caseId: theCase.id,
        change: `context: added capture-time bucket snapshot (${existingBuckets.length} buckets)`,
        reason:
          override !== undefined
            ? `product-owner batch adjudication (${override.reason})`
            : `reconstructed from capture timestamp, bucket createdAt, and correction history (${source})`,
      });
      amended += 1;
      reconstructible.push({ caseId: theCase.id, source, reasons: [], nameDrift: false });
    }
    if (amended > 0) next.version += 1;
    nextInputs.push({ ...rawInput, next, amended });
  }

  const drift: SnapshotDriftReport = {
    schema: SNAPSHOT_DRIFT_SCHEMA,
    generatedAt: now,
    candidateCases: caseIds.length,
    reconstructibleCases: reconstructible.length,
    overriddenCases,
    unresolvedCases: unresolved.length,
    cases: [...reconstructible, ...unresolved].sort((a, b) =>
      a.caseId.localeCompare(b.caseId),
    ),
  };
  await writePrivateFile(
    resolve(input.driftReportPath),
    JSON.stringify(drift, null, 2) + "\n",
  );
  if (unresolved.length > 0 || !input.apply) {
    return { applied: false, drift };
  }

  const envelopes: OrganizeAmendmentDiff["envelopes"] = [];
  let onlyPermittedChanges = true;
  let sameCaseIds = true;
  for (const item of nextInputs) {
    const beforeIds = item.before.cases.map((theCase) => theCase.id);
    const afterIds = item.next.cases.map((theCase) => theCase.id);
    sameCaseIds &&= canonical(beforeIds) === canonical(afterIds);
    onlyPermittedChanges &&=
      canonical(withoutAmendmentFields(item.before)) ===
      canonical(withoutAmendmentFields(item.next));
    for (let index = 0; index < item.before.cases.length; index += 1) {
      onlyPermittedChanges &&=
        canonical(withoutSnapshotFields(item.before.cases[index]!)) ===
        canonical(withoutSnapshotFields(item.next.cases[index]!));
    }
    onlyPermittedChanges &&=
      item.next.adjudications.length - item.before.adjudications.length === item.amended;
    const afterContent = JSON.stringify(item.next, null, 2) + "\n";
    envelopes.push({
      name: item.before.name,
      beforeVersion: item.before.version,
      afterVersion: item.next.version,
      beforeSha256: sha256(item.beforeContent),
      afterSha256: sha256(afterContent),
      inlineCaseCount: item.before.cases.length,
      loadedCaseCount: item.loadedCaseIds.length,
      caseIds: [...item.loadedCaseIds].sort(),
      amendedCaseCount: item.amended,
      adjudicationsAdded: item.amended,
    });
  }
  if (!sameCaseIds || !onlyPermittedChanges) {
    throw new Error("Snapshot amendment proof failed: a non-permitted case change was detected");
  }

  const plannedWrites = nextInputs
    .filter((item) => item.amended > 0)
    .map((item) => ({
      path: item.path,
      content: JSON.stringify(item.next, null, 2) + "\n",
    }));
  for (const planned of plannedWrites) {
    await validateEnvelopeContent(planned.path, planned.content);
  }
  for (const planned of plannedWrites) {
    await writePrivateFile(planned.path, planned.content);
  }
  const diff: OrganizeAmendmentDiff = {
    schema: AMENDMENT_DIFF_SCHEMA,
    generatedAt: now,
    onlyPermittedChanges,
    sameCaseIds,
    permittedAdditions: [
      "existingBuckets",
      "expected.thoughts[].bucketOrigin",
    ],
    envelopes,
    caseIds: [
      ...new Set(nextInputs.flatMap((item) => item.loadedCaseIds)),
    ].sort(),
  };
  await writePrivateFile(
    resolve(input.diffArtifactPath),
    JSON.stringify(diff, null, 2) + "\n",
  );
  return { applied: true, drift, diff };
}
