/**
 * One-time seed (Specification 6.4, product-owner resolution to open
 * question 5, 2026-09-04): the two existing de-identified `bucket.move`
 * cases in `datasets/golden/corrections.v1.json` ARE re-promoted into the
 * organize development envelope under the new mechanics — the full
 * build → screen → validate → single-write path of
 * `confirmOrganizePromotion` — never by hand-editing dataset JSON.
 *
 * Consent note: these two cases were already consented and de-identified
 * through the Spec 6.2 golden-case loop (they live in the shared
 * corrections.v1.json), so the consent gate is pre-established for this
 * seeding (`hasConsent: () => true`); every other guard — screening,
 * schema validation, deterministic IDs, idempotency — runs unchanged.
 * Re-running is a byte-identical no-op.
 *
 * Thought kinds are seeded as "note" (the legacy cases carry no task
 * metadata); the product owner adjudicates labels at batch review like any
 * other promoted case.
 *
 *   npx tsx src/seed-organize-dev.ts
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import {
  confirmOrganizePromotion,
  type CorrectedPromotionSource,
} from "./promote-organize.js";

const here = dirname(fileURLToPath(import.meta.url));
const evalsDir = resolve(here, "..");

interface LegacyCorrectionCase {
  id: string;
  type: string;
  thoughtSummary: string;
  fromBucketName: string;
  toBucketName: string;
}

async function main(): Promise<void> {
  const legacyPath = resolve(evalsDir, "datasets/golden/corrections.v1.json");
  const devPath = resolve(evalsDir, "datasets/golden/organize/organize.dev.v1.json");
  const legacy = JSON.parse(await readFile(legacyPath, "utf8")) as { cases: LegacyCorrectionCase[] };

  for (const legacyCase of legacy.cases) {
    if (legacyCase.type !== "bucket.move") {
      console.log(`skip ${legacyCase.id}: type ${legacyCase.type} is not bucket.move`);
      continue;
    }
    const source: CorrectedPromotionSource = {
      kind: "corrected",
      correctionId: legacyCase.id,
      summaryText: legacyCase.thoughtSummary,
      fromBucket: legacyCase.fromBucketName,
      toBucket: legacyCase.toBucketName,
      thoughtKind: "note",
    };
    const result = await confirmOrganizePromotion(
      {
        // Pre-established consent: these cases are already consented,
        // de-identified shared golden cases (Spec 6.2 loop evidence).
        hasConsent: async () => true,
        envelopePath: devPath,
        now: () => new Date(),
      },
      source,
    );
    console.log(
      result.alreadyShared
        ? `already shared: ${legacyCase.id} → ${result.caseId} (envelope unchanged)`
        : `re-promoted: ${legacyCase.id} → ${result.caseId} (organize.dev.v1 → v${result.version})`,
    );
  }
  console.log("Seed complete. Validate: npm run eval:harness --workspace @donna/evals -- validate");
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
