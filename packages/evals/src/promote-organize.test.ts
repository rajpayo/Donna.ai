/**
 * Specification 6.4 tests: de-identified organize-case promotion (preview/
 * confirm, consent fail-closed, screening, deterministic IDs, idempotency),
 * partition discipline, the gated dev→held-out move, the freeze lock, and
 * cohort suppression (AC-3 … AC-11).
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { SensitiveContentError } from "@donna/memory";
import { loadDataset } from "./datasets.js";
import { buildGraduationReportV2 } from "./graduation.js";
import { runEval, type StageScorer } from "./harness.js";
import {
  buildOrganizePromotion,
  checkHeldoutLock,
  confirmOrganizePromotion,
  ConsentRequiredError,
  freezeHeldoutEnvelope,
  heldoutLockPath,
  isHeldoutEnvelopePath,
  organizeCasePayloadHash,
  previewOrganizePromotion,
  promoteOrganizeCasesToHeldout,
  PromotionError,
  variantsFromNotes,
  type AcceptedPromotionSource,
  type CorrectedPromotionSource,
  type OrganizeInlineCase,
} from "./promote-organize.js";
import { captureSnapshot } from "./snapshot.js";
import { createOrganizeScorer } from "./scorers/organize.js";
import type { CaseOutcome } from "./report.js";

const here = dirname(fileURLToPath(import.meta.url));
const evalsDir = resolve(here, "..");
const repoRoot = resolve(here, "../../..");
const configPath = resolve(repoRoot, "models.config.yaml");

let dir: string;
let devPath: string;
let heldoutPath: string;
let consented: boolean;
let now: Date;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "donna-promote-organize-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function devEnvelope(): Record<string, unknown> {
  return {
    schema: "donna.eval-dataset.v1",
    name: "organize.dev.v1",
    stage: "organize",
    version: 1,
    description: "test dev envelope",
    defaultMeta: {
      provenance: "de-identified",
      labeler: "labeler:pilot-participant",
      adjudicator: "labeler:product-owner",
      consent: "de-identified",
      sensitivity: "low",
      language: "en",
    },
    cases: [],
    adjudications: [],
  };
}

function heldoutEnvelope(): Record<string, unknown> {
  return {
    schema: "donna.eval-dataset.v1",
    name: "organize.heldout.v1",
    stage: "organize",
    version: 1,
    description: "test held-out envelope",
    defaultMeta: {
      provenance: "synthetic",
      labeler: "labeler:product-owner",
      consent: "not-required-synthetic",
      sensitivity: "none",
      language: "en",
    },
    cases: [],
    adjudications: [],
  };
}

function correctedSource(over: Partial<CorrectedPromotionSource> = {}): CorrectedPromotionSource {
  return {
    kind: "corrected",
    correctionId: "corr-1",
    summaryText: "Add quiet mode to vendor portal to hide badges",
    fromBucket: "Product Ideas",
    toBucket: "Vendor Portal",
    thoughtKind: "note",
    ...over,
  };
}

function acceptedSource(over: Partial<AcceptedPromotionSource> = {}): AcceptedPromotionSource {
  return {
    kind: "first-pass-accept",
    decisionId: "dec-1",
    summaryText: "Review the onboarding drop-off at step three",
    donnaBucket: "Product Ideas",
    thoughtKind: "idea",
    ...over,
  };
}

function deps() {
  return {
    hasConsent: async (purpose: string) => purpose === "eval-sharing" && consented,
    now: () => now,
  };
}

async function writeDev(over: Record<string, unknown> = {}): Promise<void> {
  await mkdir(dirname(devPath), { recursive: true });
  await writeFile(devPath, JSON.stringify({ ...devEnvelope(), ...over }, null, 2) + "\n");
}

async function writeHeldout(over: Record<string, unknown> = {}): Promise<void> {
  await mkdir(dirname(heldoutPath), { recursive: true });
  await writeFile(heldoutPath, JSON.stringify({ ...heldoutEnvelope(), ...over }, null, 2) + "\n");
}

async function readRaw(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

beforeEach(async () => {
  consented = false;
  now = new Date("2026-09-04T12:00:00.000Z");
  devPath = join(dir, `dev-${Math.random().toString(36).slice(2)}`, "organize.dev.v1.json");
  heldoutPath = join(dir, `heldout-${Math.random().toString(36).slice(2)}`, "organize.heldout.v1.json");
  await writeDev();
  await writeHeldout();
});

describe("promotion builder (FR-4/FR-11/FR-12)", () => {
  it("derives deterministic case IDs from the de-identified payload", () => {
    const a = buildOrganizePromotion(correctedSource(), { now: () => now });
    const b = buildOrganizePromotion(correctedSource(), { now: () => new Date("2027-01-01") });
    assert.equal(a.case.id, b.case.id); // timestamp-independent
    assert.match(a.case.id, /^organize-pilot-[0-9a-f]{12}$/);
    const other = buildOrganizePromotion(correctedSource({ summaryText: "Different summary entirely" }), { now: () => now });
    assert.notEqual(a.case.id, other.case.id);
  });

  it("builds the case from the field allowlist only (SR-3)", () => {
    const draft = buildOrganizePromotion(correctedSource(), { now: () => now });
    assert.deepEqual(
      Object.keys(draft.case).sort(),
      ["expected", "id", "meta", "transcript"],
    );
    assert.deepEqual(
      Object.keys(draft.case.meta).sort(),
      ["adjudicator", "consent", "labeler", "provenance", "sensitivity"],
    );
    assert.deepEqual(Object.keys(draft.case.expected.thoughts[0]!).sort(), ["bucket", "contains", "kind"]);
    // A source object smuggling extra fields cannot leak them.
    const smuggled = {
      ...correctedSource(),
      tenantId: "tenant-alpha",
      captureId: "cap-secret",
      audioPath: "data/audio/secret.enc",
    } as unknown as CorrectedPromotionSource;
    const leaked = buildOrganizePromotion(smuggled, { now: () => now });
    const raw = JSON.stringify(leaked.case);
    assert.ok(!raw.includes("tenant-alpha"));
    assert.ok(!raw.includes("cap-secret"));
    assert.ok(!raw.includes("secret.enc"));
  });

  it("corrected promotion: label is the corrected bucket, before recorded (FR-5)", () => {
    const draft = buildOrganizePromotion(correctedSource(), { now: () => now });
    assert.equal(draft.case.expected.thoughts[0]!.bucket, "Vendor Portal");
    assert.equal(draft.case.transcript, "Add quiet mode to vendor portal to hide badges");
    assert.equal(draft.adjudication.change, "expected.bucket: 'Product Ideas' → 'Vendor Portal'");
    assert.ok(draft.adjudication.reason.includes("corr-1"));
    assert.equal(draft.adjudication.adjudicator, "labeler:product-owner");
    assert.equal(draft.partition, "dev");
  });

  it("accepted promotion: label is Donna's chosen bucket (FR-6)", () => {
    const draft = buildOrganizePromotion(acceptedSource(), { now: () => now });
    assert.equal(draft.case.expected.thoughts[0]!.bucket, "Product Ideas");
    assert.equal(draft.adjudication.change, "new case: first-pass accepted placement 'Product Ideas'");
    assert.ok(draft.adjudication.reason.includes("dec-1"));
  });

  it("carries cohort metadata through the case-meta fields (FR-12)", () => {
    const draft = buildOrganizePromotion(
      acceptedSource({
        scenarioClass: "ideas",
        variants: ["V-NOISE", "V-PACE"],
        language: "en",
        accent: "en-IN neutral",
        noise: "simulated-cafe",
      }),
      { now: () => now },
    );
    assert.equal(draft.case.meta.notes, "scenario-class:ideas; variants:V-NOISE,V-PACE");
    assert.equal(draft.case.meta.accent, "en-IN neutral");
    assert.equal(draft.case.meta.noise, "simulated-cafe");
    assert.equal(draft.case.meta.provenance, "de-identified");
    assert.equal(draft.case.meta.consent, "de-identified");
  });

  it("supports the consented-volunteer provenance classification (FR-12)", () => {
    const draft = buildOrganizePromotion(
      acceptedSource({ provenance: "consented-volunteer" }),
      { now: () => now },
    );
    assert.equal(draft.case.meta.provenance, "consented-volunteer");
    assert.equal(draft.case.meta.consent, "consented");
  });

  it("includes capture-time snapshots in identity and derives joined/minted origins (Spec 6.5 FR-7)", () => {
    const joined = buildOrganizePromotion(
      acceptedSource({
        existingBuckets: [
          { name: "Product Ideas", description: "Ideas to explore" },
          { name: "Tasks", description: "Commitments" },
        ],
      }),
      { now: () => now },
    );
    assert.equal(joined.case.expected.thoughts[0]!.bucketOrigin, "joined");
    assert.equal(joined.case.existingBuckets?.length, 2);

    const minted = buildOrganizePromotion(
      acceptedSource({
        donnaBucket: "New Launch Notes",
        existingBuckets: [{ name: "Tasks", description: "Commitments" }],
      }),
      { now: () => now },
    );
    assert.equal(minted.case.expected.thoughts[0]!.bucketOrigin, "minted");
    assert.ok(
      !minted.case.existingBuckets?.some(
        (bucket) => bucket.name === "New Launch Notes",
      ),
    );
    assert.notEqual(
      joined.case.id,
      buildOrganizePromotion(acceptedSource(), { now: () => now }).case.id,
    );
    assert.equal(joined.payloadHash, organizeCasePayloadHash(joined.case));
  });

  it("screens bucket snapshot names and descriptions at preview", async () => {
    consented = true;
    await assert.rejects(
      previewOrganizePromotion(
        deps(),
        acceptedSource({
          existingBuckets: [
            {
              name: "Product Ideas",
              description: "password=synthetic-secret-value",
            },
          ],
        }),
      ),
      SensitiveContentError,
    );
  });

  it("parses variant labels from run notes deterministically", () => {
    assert.deepEqual(variantsFromNotes("V-NOISE, café; also V-PACE and V-NOISE again"), ["V-NOISE", "V-PACE"]);
    assert.deepEqual(variantsFromNotes("no variants here, V-UNKNOWN ignored"), []);
    assert.deepEqual(variantsFromNotes(undefined), []);
  });

  it("rejects empty summaries and empty bucket labels", async () => {
    assert.throws(
      () => buildOrganizePromotion(correctedSource({ summaryText: "   " }), { now: () => now }),
      PromotionError,
    );
    assert.throws(
      () => buildOrganizePromotion(correctedSource({ toBucket: " " }), { now: () => now }),
      PromotionError,
    );
  });
});

describe("consent fail-closed (FR-3, AC-3)", () => {
  it("preview without consent fails closed and writes nothing", async () => {
    await assert.rejects(previewOrganizePromotion(deps(), correctedSource()), ConsentRequiredError);
    const after = await readRaw(devPath);
    assert.equal((after["cases"] as unknown[]).length, 0);
    assert.equal(after["version"], 1);
  });

  it("confirm without consent fails closed and writes nothing", async () => {
    await assert.rejects(
      confirmOrganizePromotion({ ...deps(), envelopePath: devPath }, correctedSource()),
      ConsentRequiredError,
    );
    const after = await readRaw(devPath);
    assert.equal((after["cases"] as unknown[]).length, 0);
  });

  it("revocation between preview and confirm blocks the confirm", async () => {
    consented = true;
    const preview = await previewOrganizePromotion(deps(), correctedSource());
    assert.ok(preview.payloadHash.length === 64);
    consented = false; // revoked after preview
    await assert.rejects(
      confirmOrganizePromotion({ ...deps(), envelopePath: devPath }, correctedSource()),
      ConsentRequiredError,
    );
    const after = await readRaw(devPath);
    assert.equal((after["cases"] as unknown[]).length, 0);
    assert.equal(after["version"], 1);
  });
});

describe("confirm writes (FR-7, AC-4/AC-5/AC-6, AC-11)", () => {
  it("corrected promotion: case + adjudication + version bump in one write; validation passes (AC-5)", async () => {
    consented = true;
    const result = await confirmOrganizePromotion({ ...deps(), envelopePath: devPath }, correctedSource());
    assert.equal(result.alreadyShared, false);
    assert.equal(result.version, 2); // bumped by exactly one
    const dataset = await loadDataset(devPath);
    assert.equal(dataset.version, 2);
    assert.equal(dataset.cases.length, 1);
    const theCase = dataset.cases[0]!;
    assert.equal(theCase.id, result.caseId);
    assert.equal(
      (theCase.payload as Pick<OrganizeInlineCase, "expected">).expected.thoughts[0]!.bucket,
      "Vendor Portal",
    );
    assert.equal(dataset.adjudications.length, 1);
    assert.equal(dataset.adjudications[0]!.caseId, result.caseId);
    assert.equal(dataset.adjudications[0]!.change, "expected.bucket: 'Product Ideas' → 'Vendor Portal'");
  });

  it("accepted promotion: label is Donna's bucket; first-pass adjudication; version bumped (AC-6)", async () => {
    consented = true;
    const result = await confirmOrganizePromotion({ ...deps(), envelopePath: devPath }, acceptedSource());
    const dataset = await loadDataset(devPath);
    assert.equal(result.version, 2);
    const theCase = dataset.cases[0]!;
    assert.equal(
      (theCase.payload as Pick<OrganizeInlineCase, "expected">).expected.thoughts[0]!.bucket,
      "Product Ideas",
    );
    assert.ok(dataset.adjudications[0]!.change.startsWith("new case: first-pass accepted placement"));
  });

  it("preview fidelity: the written case hash equals the previewed hash (AC-4)", async () => {
    consented = true;
    const preview = await previewOrganizePromotion(deps(), correctedSource());
    // Preview lists exactly the shared fields.
    assert.deepEqual(
      Object.keys(preview.case).sort(),
      ["expected", "id", "meta", "transcript"],
    );
    const confirmed = await confirmOrganizePromotion({ ...deps(), envelopePath: devPath }, correctedSource());
    assert.equal(confirmed.payloadHash, preview.payloadHash);
    const raw = await readRaw(devPath);
    const written = (raw["cases"] as OrganizeInlineCase[])[0]!;
    assert.equal(organizeCasePayloadHash(written), preview.payloadHash);
  });

  it("Spec 6.5 AC-7: a new decision preview/confirm writes the screened snapshot and origin", async () => {
    consented = true;
    const source = acceptedSource({
      existingBuckets: [
        { name: "Tasks", description: "Commitments" },
        { name: "Product Ideas", description: "Ideas to explore" },
      ],
    });
    const preview = await previewOrganizePromotion(deps(), source);
    assert.deepEqual(
      Object.keys(preview.case).sort(),
      ["existingBuckets", "expected", "id", "meta", "transcript"],
    );
    assert.equal(preview.case.expected.thoughts[0]!.bucketOrigin, "joined");
    const confirmed = await confirmOrganizePromotion(
      { ...deps(), envelopePath: devPath },
      source,
    );
    assert.equal(confirmed.payloadHash, preview.payloadHash);
    const written = ((await readRaw(devPath))["cases"] as OrganizeInlineCase[])[0]!;
    assert.deepEqual(written.existingBuckets, source.existingBuckets);
    assert.equal(written.expected.thoughts[0]!.bucketOrigin, "joined");
    assert.equal(organizeCasePayloadHash(written), preview.payloadHash);
  });

  it("idempotency: re-promotion reports already shared and leaves the envelope byte-identical (AC-11)", async () => {
    consented = true;
    await confirmOrganizePromotion({ ...deps(), envelopePath: devPath }, correctedSource());
    const before = await readFile(devPath, "utf8");
    const again = await confirmOrganizePromotion({ ...deps(), envelopePath: devPath }, correctedSource());
    assert.equal(again.alreadyShared, true);
    assert.equal(again.version, 2);
    assert.equal(await readFile(devPath, "utf8"), before);
  });

  it("promotions land only in the development partition (FR-8)", async () => {
    consented = true;
    await assert.rejects(
      confirmOrganizePromotion({ ...deps(), envelopePath: heldoutPath }, correctedSource()),
      /development partition/,
    );
  });
});

describe("screening (SR-3, AC-7)", () => {
  const cases: Array<[string, string]> = [
    ["national-id", "My social security number is 123-45-6789, keep it safe"],
    ["card-number", "Charge the corporate card 4111 1111 1111 1111 tomorrow"],
    ["api-token", "The gateway key is sk-abcdefghijklmnopqrstuvwxyz1234, store it"],
    ["password", "The shared account password is hunter2, remember it"],
  ];
  for (const [category, summary] of cases) {
    it(`rejects a payload with a ${category} pattern at preview and never writes`, async () => {
      consented = true;
      await assert.rejects(
        previewOrganizePromotion(deps(), correctedSource({ summaryText: summary })),
        (error: unknown) => {
          assert.ok(error instanceof SensitiveContentError);
          assert.deepEqual(error.categories, [category]);
          return true;
        },
      );
      await assert.rejects(
        confirmOrganizePromotion({ ...deps(), envelopePath: devPath }, correctedSource({ summaryText: summary })),
        SensitiveContentError,
      );
      const after = await readRaw(devPath);
      assert.equal((after["cases"] as unknown[]).length, 0);
      assert.equal(after["version"], 1);
    });
  }

  it("forbidden values never appear in a promoted case (SR-3)", async () => {
    consented = true;
    // The surrounding pilot records carry identifiers; the promotion must not.
    const forbidden = [
      "tenant-alpha",
      "user-alice",
      "P-01",
      "cap-9f8e7d6c",
      "data/audio/cap-9f8e7d6c.enc",
      "Okay so the full transcript of everything I said verbatim",
    ];
    await confirmOrganizePromotion({ ...deps(), envelopePath: devPath }, correctedSource());
    const raw = await readFile(devPath, "utf8");
    for (const value of forbidden) {
      assert.ok(!raw.includes(value), `forbidden value leaked: ${value}`);
    }
  });
});

describe("gated dev→held-out promotion (FR-8, AC-8)", () => {
  async function seedDev(): Promise<{ first: string; second: string }> {
    consented = true;
    const first = await confirmOrganizePromotion({ ...deps(), envelopePath: devPath }, correctedSource());
    const second = await confirmOrganizePromotion(
      { ...deps(), envelopePath: devPath },
      acceptedSource(),
    );
    return { first: first.caseId, second: second.caseId };
  }

  it("moves the case: absent from dev, present in held-out, versions bumped, adjudications in both", async () => {
    const { first, second } = await seedDev();
    const result = await promoteOrganizeCasesToHeldout(
      { devEnvelopePath: devPath, heldoutEnvelopePath: heldoutPath, now: () => now },
      { caseIds: [first], rationale: "stratified batch: first pilot-grown ideas case" },
    );
    assert.deepEqual(result.moved, [first]);
    assert.equal(result.devVersion, 4); // v1 → 2 promotions → v3 → move → v4
    assert.equal(result.heldoutVersion, 2);

    const dev = await loadDataset(devPath);
    const heldout = await loadDataset(heldoutPath);
    assert.deepEqual(dev.cases.map((c) => c.id), [second]);
    assert.deepEqual(heldout.cases.map((c) => c.id), [first]);
    // The case never exists in both partitions.
    assert.ok(!dev.cases.some((c) => c.id === first));

    // Held-out carries the case's full history plus the partition entry.
    const heldoutEntries = heldout.adjudications.filter((a) => a.caseId === first);
    assert.equal(heldoutEntries.length, 2);
    assert.ok(heldoutEntries.some((a) => a.change.startsWith("expected.bucket:")));
    assert.ok(
      heldoutEntries.some(
        (a) => a.change.startsWith("partition:") && a.reason.includes("stratified batch"),
      ),
    );
    // Dev keeps the partition-move audit entry (validation passes via the
    // partition-entry exception to the unknown-case rule).
    const devEntries = dev.adjudications.filter((a) => a.caseId === first);
    assert.equal(devEntries.length, 1);
    assert.ok(devEntries[0]!.change.startsWith("partition:"));
    assert.equal(devEntries[0]!.adjudicator, "labeler:product-owner");
  });

  it("refuses unknown case IDs, duplicates, and empty rationales", async () => {
    const { first } = await seedDev();
    await assert.rejects(
      promoteOrganizeCasesToHeldout(
        { devEnvelopePath: devPath, heldoutEnvelopePath: heldoutPath, now: () => now },
        { caseIds: ["no-such-case"], rationale: "rationale" },
      ),
      /not in the development partition/,
    );
    await assert.rejects(
      promoteOrganizeCasesToHeldout(
        { devEnvelopePath: devPath, heldoutEnvelopePath: heldoutPath, now: () => now },
        { caseIds: [first], rationale: "  " },
      ),
      /rationale/,
    );
    await promoteOrganizeCasesToHeldout(
      { devEnvelopePath: devPath, heldoutEnvelopePath: heldoutPath, now: () => now },
      { caseIds: [first], rationale: "batch one" },
    );
    await assert.rejects(
      promoteOrganizeCasesToHeldout(
        { devEnvelopePath: devPath, heldoutEnvelopePath: heldoutPath, now: () => now },
        { caseIds: [first], rationale: "again" },
      ),
      /already in the held-out partition/,
    );
  });
});

describe("held-out freeze lock (FR-9, SR-6, AC-8/AC-9)", () => {
  const stubScorer: StageScorer = {
    stage: "organize",
    cohortKeys: ["language", "accent", "noise"],
    async score(testCase): Promise<CaseOutcome[]> {
      return [{
        caseId: testCase.id,
        scores: { "organize.bucket_acceptance": 1 },
        hardFailures: [],
      }];
    },
  };

  async function runStubbedOrganize(datasetPath: string, reportsDir: string) {
    return runEval({
      datasetPath,
      configPath,
      repoRoot,
      evalsDir,
      reportsDir,
      scorer: stubScorer,
    });
  }

  it("freeze writes the lock; the held-out run report matches it; hand-edits fail validation", async () => {
    consented = true;
    // Seed dev, move one case to held-out, then run + freeze.
    const promoted = await confirmOrganizePromotion({ ...deps(), envelopePath: devPath }, correctedSource());
    await promoteOrganizeCasesToHeldout(
      { devEnvelopePath: devPath, heldoutEnvelopePath: heldoutPath, now: () => now },
      { caseIds: [promoted.caseId], rationale: "batch" },
    );

    const reportsDir = await mkdtemp(join(tmpdir(), "donna-lock-reports-"));
    const { report } = await runStubbedOrganize(heldoutPath, reportsDir);
    // AC-8: the report's dataset identity matches the envelope content.
    const raw = await readFile(heldoutPath, "utf8");
    const envelopeSha = createHash("sha256").update(raw).digest("hex");
    assert.equal(report.dataset.name, "organize.heldout.v1");
    assert.equal(report.dataset.version, 2);
    assert.equal(report.dataset.sha256, envelopeSha);

    const reportPath = join(reportsDir, "first-results.json");
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    const lock = await freezeHeldoutEnvelope({
      envelopePath: heldoutPath,
      reportPath,
      now: () => now,
    });
    assert.equal(lock.name, "organize.heldout.v1");
    assert.equal(lock.version, 2);
    assert.equal(lock.sha256, envelopeSha);
    assert.equal(lock.frozenAt, now.toISOString());
    assert.equal(lock.firstResultsReportSha256.length, 64);
    assert.equal(heldoutLockPath(heldoutPath), join(dirname(heldoutPath), "organize.heldout.lock.json"));

    // Lock intact.
    const check = await checkHeldoutLock(heldoutPath);
    assert.equal(check.status, "intact");

    // AC-8: a hand-edit to the locked content is a hard validation failure.
    const tampered = JSON.parse(raw) as Record<string, unknown>;
    tampered["description"] = "hand-edited after freeze";
    await writeFile(heldoutPath, JSON.stringify(tampered, null, 2) + "\n");
    await assert.rejects(checkHeldoutLock(heldoutPath), /differs from its freeze lock/);

    // AC-9: a graduation run over the held-out report freezes the dataset
    // identity, and the freeze hash equals the lock hash.
    const snapshot = await captureSnapshot({
      repoRoot,
      configPath,
      dataset: { name: report.dataset.name, version: report.dataset.version, sha256: report.dataset.sha256 },
    });
    const graduation = buildGraduationReportV2([{ path: reportPath, report }], { snapshot });
    const frozen = graduation.freeze.datasets.find((d) => d.stage === "organize");
    assert.equal(frozen?.name, "organize.heldout.v1");
    assert.equal(frozen?.version, 2);
    assert.equal(frozen?.sha256, lock.sha256);
    await rm(reportsDir, { recursive: true, force: true });
  });

  it("refuses to freeze against a foreign or stale report", async () => {
    const reportsDir = await mkdtemp(join(tmpdir(), "donna-lock-reports-"));
    const foreignReport = join(reportsDir, "foreign.json");
    await writeFile(
      foreignReport,
      JSON.stringify({ dataset: { name: "organize.dev.v1", version: 1, sha256: "0".repeat(64) } }),
    );
    await assert.rejects(
      freezeHeldoutEnvelope({ envelopePath: heldoutPath, reportPath: foreignReport, now: () => now }),
      /not a results run/,
    );
    await rm(reportsDir, { recursive: true, force: true });
  });

  it("refuses to re-freeze an already-frozen version; a version bump unfreezes", async () => {
    const reportsDir = await mkdtemp(join(tmpdir(), "donna-lock-reports-"));
    const { report } = await runStubbedOrganize(heldoutPath, reportsDir);
    const reportPath = join(reportsDir, "results.json");
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    await freezeHeldoutEnvelope({ envelopePath: heldoutPath, reportPath, now: () => now });
    await assert.rejects(
      freezeHeldoutEnvelope({ envelopePath: heldoutPath, reportPath, now: () => now }),
      /already frozen/,
    );
    // A gated version bump makes the envelope newer than the lock — the
    // sanctioned results-then-refreeze window (FR-9).
    const raw = await readRaw(heldoutPath);
    await writeFile(heldoutPath, JSON.stringify({ ...raw, version: 2 }, null, 2) + "\n");
    const check = await checkHeldoutLock(heldoutPath);
    assert.equal(check.status, "unfrozen-new-version");
    await rm(reportsDir, { recursive: true, force: true });
  });

  it("no lock means nothing to check; non-held-out paths are not lockable", async () => {
    assert.equal((await checkHeldoutLock(heldoutPath)).status, "no-lock");
    assert.equal(isHeldoutEnvelopePath(heldoutPath), true);
    assert.equal(isHeldoutEnvelopePath(devPath), false);
    assert.throws(() => heldoutLockPath(devPath), /Not a held-out envelope/);
  });
});

describe("cohort suppression (SR-4, AC-10)", () => {
  it("the organize scorer declares cohort keys so promoted-case labels flow into slices", () => {
    assert.deepEqual(createOrganizeScorer({}).cohortKeys, ["language", "accent", "noise"]);
  });

  it("a promoted-case cohort of n < 3 is suppressed from the organize report slices", async () => {
    consented = true;
    // Two cases in a small cohort (simulated-cafe) and three in another.
    for (const [index, noise] of ["simulated-cafe", "simulated-cafe", "clean", "clean", "clean"].entries()) {
      await confirmOrganizePromotion(
        { ...deps(), envelopePath: devPath },
        acceptedSource({
          decisionId: `dec-${index}`,
          summaryText: `Synthetic pilot thought number ${index} about onboarding`,
          noise,
        }),
      );
    }
    const reportsDir = await mkdtemp(join(tmpdir(), "donna-cohort-reports-"));
    const scorer: StageScorer = {
      stage: "organize",
      cohortKeys: ["language", "accent", "noise"],
      async score(testCase): Promise<CaseOutcome[]> {
        return [{ caseId: testCase.id, scores: { "organize.bucket_acceptance": 1 }, hardFailures: [] }];
      },
    };
    const { report } = await runEval({
      datasetPath: devPath,
      configPath,
      repoRoot,
      evalsDir,
      reportsDir,
      scorer,
    });
    const noiseSlices = report.cohorts.filter((c) => c.slice["noise"] !== undefined);
    assert.equal(noiseSlices.length, 1);
    assert.equal(noiseSlices[0]!.slice["noise"], "clean");
    assert.equal(noiseSlices[0]!.n, 3);
    // The n=2 "simulated-cafe" cohort is suppressed entirely.
    assert.ok(!noiseSlices.some((c) => c.slice["noise"] === "simulated-cafe"));
    await rm(reportsDir, { recursive: true, force: true });
  });
});
