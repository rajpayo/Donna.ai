/**
 * Consented de-identification path from a correction to a shared golden
 * evaluation case (Specification 2.3, SR-1).
 *
 * The default is NOT shared: nothing leaves the owner's partition unless
 * ALL of the following hold:
 *   1. the correction exists in the requesting scope and is accepted;
 *   2. the owner holds an active consent record for the "eval-sharing"
 *      purpose (revocation stops further promotion immediately);
 *   3. every text field passes the sensitive-content screener.
 *
 * De-identification: the case carries no tenant ID, no user ID, no
 * capture/transcript IDs — only the correction type and the minimal
 * before/after labels needed to reproduce the scenario in an eval.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CorrectionStore } from "@donna/core";
import { screenSensitiveContent, SensitiveContentError } from "@donna/memory";

export const EVAL_SHARING_PURPOSE = "eval-sharing";

export class ConsentRequiredError extends Error {
  constructor(purpose: string) {
    super(
      `Sharing a correction as a golden case requires active consent for "${purpose}"`,
    );
    this.name = "ConsentRequiredError";
  }
}

export class PromotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromotionError";
  }
}

export interface GoldenCorrectionCase {
  id: string;
  type: string;
  thoughtSummary: string;
  fromBucketName: string;
  toBucketName: string;
  promotedAt: string;
  source: "consented-correction-deidentified";
}

interface GoldenDataset {
  name: string;
  description: string;
  cases: GoldenCorrectionCase[];
}

export interface PromoteDeps {
  corrections: CorrectionStore;
  hasConsent: (purpose: string) => Promise<boolean>;
  /** Path to the shared golden dataset JSON file. */
  datasetPath: string;
  now: () => Date;
}

/**
 * Promote one accepted correction to the shared golden dataset. Returns
 * the case ID. Idempotent: re-promoting the same correction is a no-op.
 */
export async function promoteCorrectionToGoldenCase(
  deps: PromoteDeps,
  scope: { tenantId: string; userId: string },
  correctionId: string,
): Promise<{ caseId: string; alreadyShared: boolean }> {
  const event = await deps.corrections.getCorrection(
    scope.tenantId,
    scope.userId,
    correctionId,
  );
  if (event === undefined) {
    throw new PromotionError("Correction does not exist in the requested tenant/user scope");
  }
  if (event.status !== "accepted") {
    throw new PromotionError("Only accepted corrections can be promoted");
  }
  if (event.type !== "bucket.move") {
    throw new PromotionError(
      `Only bucket.move corrections are currently promotable, not ${event.type}`,
    );
  }
  if (event.sharedAt !== undefined) {
    return { caseId: event.id, alreadyShared: true };
  }
  if (!(await deps.hasConsent(EVAL_SHARING_PURPOSE))) {
    throw new ConsentRequiredError(EVAL_SHARING_PURPOSE);
  }

  const thoughtSummary = event.payload["thoughtSummary"] ?? "";
  const fromBucketName = event.payload["fromBucketName"] ?? "";
  const toBucketName = event.payload["toBucketName"] ?? "";
  if (thoughtSummary.length === 0 || toBucketName.length === 0) {
    throw new PromotionError("Correction payload is incomplete for a golden case");
  }

  // De-identification screen: category tokens only, never the content.
  const hits = [thoughtSummary, fromBucketName, toBucketName].flatMap(
    (field) => screenSensitiveContent(field),
  );
  if (hits.length > 0) {
    throw new SensitiveContentError([...new Set(hits.map((h) => h.category))]);
  }

  const dataset = await loadDataset(deps.datasetPath);
  const goldenCase: GoldenCorrectionCase = {
    id: event.id,
    type: event.type,
    thoughtSummary,
    fromBucketName,
    toBucketName,
    promotedAt: deps.now().toISOString(),
    source: "consented-correction-deidentified",
  };
  dataset.cases.push(goldenCase);
  await mkdir(dirname(deps.datasetPath), { recursive: true, mode: 0o700 });
  await writeFile(deps.datasetPath, JSON.stringify(dataset, null, 2) + "\n", {
    mode: 0o644,
  });

  await deps.corrections.saveCorrection({
    ...event,
    sharedAt: deps.now().toISOString(),
  });
  return { caseId: event.id, alreadyShared: false };
}

async function loadDataset(path: string): Promise<GoldenDataset> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as GoldenDataset;
    if (!Array.isArray(parsed.cases)) throw new Error("bad dataset");
    return parsed;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        name: "corrections.v1",
        description:
          "De-identified golden cases promoted from accepted user corrections with explicit eval-sharing consent. Never contains tenant/user IDs.",
        cases: [],
      };
    }
    throw error;
  }
}
