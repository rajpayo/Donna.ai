/**
 * Dataset envelope validation tests (Specification 4.1: AC-2, FR-3, SR-1).
 */
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  DatasetValidationError,
  loadDataset,
  recordAdjudication,
} from "./datasets.js";

const here = dirname(fileURLToPath(import.meta.url));
const evalsDir = resolve(here, "..");

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "donna.eval-dataset.v1",
    name: "test.v1",
    stage: "organize",
    version: 1,
    description: "test envelope",
    defaultMeta: {
      provenance: "synthetic",
      labeler: "labeler:test",
      consent: "not-required-synthetic",
      sensitivity: "none",
    },
    cases: [
      {
        id: "case-1",
        transcript: "A simple synthetic transcript about onboarding.",
        expected: {
          thoughts: [{ kind: "idea", bucket: null, contains: ["onboarding"] }],
        },
      },
    ],
    adjudications: [],
    ...overrides,
  };
}

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "donna-datasets-test-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeDataset(
  name: string,
  content: Record<string, unknown>,
): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(content));
  return path;
}

describe("dataset envelope validation (AC-2)", () => {
  it("loads a valid envelope and resolves default metadata", async () => {
    const path = await writeDataset("valid.json", envelope());
    const dataset = await loadDataset(path);
    assert.equal(dataset.name, "test.v1");
    assert.equal(dataset.cases.length, 1);
    assert.equal(dataset.cases[0]!.meta.labeler, "labeler:test");
    assert.equal(dataset.cases[0]!.meta.consent, "not-required-synthetic");
    assert.equal(dataset.sha256.length, 64);
  });

  it("rejects a missing envelope field", async () => {
    const bad = envelope();
    delete bad["defaultMeta"];
    const path = await writeDataset("bad-envelope.json", bad);
    await assert.rejects(loadDataset(path), DatasetValidationError);
  });

  it("rejects a case whose consent state contradicts its provenance", async () => {
    const bad = envelope({
      cases: [
        {
          id: "case-1",
          meta: { provenance: "consented-volunteer", consent: "not-required-synthetic" },
          transcript: "A synthetic transcript about onboarding.",
          expected: { thoughts: [{ kind: "idea", bucket: null, contains: ["onboarding"] }] },
        },
      ],
    });
    const path = await writeDataset("bad-consent.json", bad);
    await assert.rejects(loadDataset(path), /consent/);
  });

  it("rejects a case missing required labels (organize expected thoughts)", async () => {
    const bad = envelope({
      cases: [{ id: "case-1", transcript: "no labels at all" }],
    });
    const path = await writeDataset("bad-labels.json", bad);
    await assert.rejects(loadDataset(path), DatasetValidationError);
  });

  it("rejects duplicate case IDs", async () => {
    const caseOne = (envelope().cases as unknown[])[0];
    const bad = envelope({ cases: [caseOne, caseOne] });
    const path = await writeDataset("bad-dup.json", bad);
    await assert.rejects(loadDataset(path), /duplicate case id/);
  });

  it("rejects adjudications that reference unknown cases (FR-3)", async () => {
    const bad = envelope({
      adjudications: [
        {
          at: "2026-09-03T00:00:00.000Z",
          adjudicator: "labeler:product-owner",
          caseId: "no-such-case",
          change: "expected.bucket: A → B",
          reason: "test",
        },
      ],
    });
    const path = await writeDataset("bad-adj.json", bad);
    await assert.rejects(loadDataset(path), /unknown case id/);
  });

  it("rejects cases carrying sensitive content (SR-1)", async () => {
    const bad = envelope({
      cases: [
        {
          id: "case-1",
          transcript: "Reach me about the AWS key AKIA1234567890ABCDEF soon.",
          expected: { thoughts: [{ kind: "note", bucket: null, contains: ["aws"] }] },
        },
      ],
    });
    const path = await writeDataset("bad-pii.json", bad);
    await assert.rejects(loadDataset(path), /sensitive-content/);
  });

  it("rejects high-sensitivity declarations outright (SR-1)", async () => {
    const bad = envelope({
      defaultMeta: {
        provenance: "synthetic",
        labeler: "labeler:test",
        consent: "not-required-synthetic",
        sensitivity: "high",
      },
    });
    const path = await writeDataset("bad-sensitivity.json", bad);
    await assert.rejects(loadDataset(path), DatasetValidationError);
  });

  it("lifts legacy flat golden files into the envelope (single-sourced)", async () => {
    const path = resolve(evalsDir, "datasets/golden/organize/organize.v1.json");
    const dataset = await loadDataset(path);
    assert.equal(dataset.cases.length, 3); // the legacy flat file's cases
    assert.ok(dataset.cases.every((c) => c.meta.provenance === "synthetic"));
    assert.ok(dataset.cases.every((c) => typeof (c.payload as { transcript?: string }).transcript === "string"));
  });

  it("recordAdjudication appends an auditable entry (FR-3)", async () => {
    const path = await writeDataset("adj.json", envelope());
    await recordAdjudication(path, {
      at: "2026-09-03T12:00:00.000Z",
      adjudicator: "labeler:product-owner",
      caseId: "case-1",
      change: "expected.thoughts[0].bucket: null → 'Tasks'",
      reason: "adjudicated: the thought is a commitment",
    });
    const dataset = await loadDataset(path);
    assert.equal(dataset.adjudications.length, 1);
    assert.equal(dataset.adjudications[0]!.caseId, "case-1");
    const raw = JSON.parse(await readFile(path, "utf8")) as { adjudications: unknown[] };
    assert.equal(raw.adjudications.length, 1);
  });

  it("allows partition-move entries referencing cases that moved out (Spec 6.4 FR-8)", async () => {
    const ok = envelope({
      adjudications: [
        {
          at: "2026-09-04T12:00:00.000Z",
          adjudicator: "labeler:product-owner",
          caseId: "organize-pilot-movedaway",
          change: "partition: dev → held-out (to organize.heldout.v1 v2)",
          reason: "stratified batch promotion, product-owner gated",
        },
      ],
    });
    const path = await writeDataset("partition-move.json", ok);
    const dataset = await loadDataset(path);
    assert.equal(dataset.adjudications.length, 1);
    // A NON-partition entry referencing an absent case still fails.
    const bad = envelope({
      adjudications: [
        {
          at: "2026-09-04T12:00:00.000Z",
          adjudicator: "labeler:product-owner",
          caseId: "organize-pilot-movedaway",
          change: "expected.bucket: 'A' → 'B'",
          reason: "label change against a case that is not here",
        },
      ],
    });
    const badPath = await writeDataset("partition-move-bad.json", bad);
    await assert.rejects(loadDataset(badPath), /unknown case id/);
  });

  it("validates capture-time bucket snapshots and origin labels (Spec 6.5 AC-1)", async () => {
    const valid = envelope({
      cases: [
        {
          id: "snapshot-valid",
          transcript: "Review onboarding and capture a launch idea.",
          existingBuckets: [
            { name: "Product Ideas", description: "Potential product improvements" },
          ],
          expected: {
            thoughts: [
              {
                kind: "idea",
                bucket: "Product Ideas",
                bucketOrigin: "joined",
                contains: ["onboarding"],
              },
              {
                kind: "note",
                bucket: "Launch Notes",
                bucketOrigin: "minted",
                contains: ["launch"],
              },
            ],
          },
        },
      ],
    });
    const path = await writeDataset("snapshot-valid.json", valid);
    const loaded = await loadDataset(path);
    assert.equal(loaded.cases.length, 1);
  });

  it("rejects a joined label missing from its snapshot (Spec 6.5 AC-1)", async () => {
    const bad = envelope({
      cases: [
        {
          id: "joined-missing",
          transcript: "Review the onboarding drop-off.",
          existingBuckets: [{ name: "Tasks", description: "Commitments" }],
          expected: {
            thoughts: [
              {
                kind: "idea",
                bucket: "Product Ideas",
                bucketOrigin: "joined",
                contains: ["onboarding"],
              },
            ],
          },
        },
      ],
    });
    await assert.rejects(
      loadDataset(await writeDataset("joined-missing.json", bad)),
      /joined-missing[\s\S]*joined bucket label[\s\S]*missing/,
    );
  });

  it("rejects a minted label leaked into its snapshot (Spec 6.5 SR-1)", async () => {
    const bad = envelope({
      cases: [
        {
          id: "minted-leak",
          transcript: "Capture a new launch idea.",
          existingBuckets: [
            { name: "Launch Notes", description: "Launch preparation" },
          ],
          expected: {
            thoughts: [
              {
                kind: "idea",
                bucket: "launch notes",
                bucketOrigin: "minted",
                contains: ["launch"],
              },
            ],
          },
        },
      ],
    });
    await assert.rejects(
      loadDataset(await writeDataset("minted-leak.json", bad)),
      /minted-leak[\s\S]*label leak/,
    );
  });
});

describe("shipped datasets are all valid", () => {
  it("every dataset in the registry validates", async () => {
    const paths = [
      "datasets/golden/transcribe/transcribe.v1.json",
      "datasets/golden/organize/organize.v1.json",
      "datasets/golden/provenance/provenance.v1.json",
      "datasets/golden/buckets/buckets.v1.json",
      "datasets/golden/memory/memory.v1.json",
      "datasets/golden/retrieval/retrieval.v1.json",
      "datasets/golden/emotion/emotion.v1.json",
      "datasets/golden/full-loop/full-loop.v1.json",
      "datasets/adversarial/adversarial.v1.json",
    ];
    for (const rel of paths) {
      const dataset = await loadDataset(resolve(evalsDir, rel));
      assert.ok(dataset.cases.length > 0, `${rel} has no cases`);
    }
  });

  it("the Spec 6.4 organize partitions validate (held-out seeds the 3 pre-pilot cases)", async () => {
    const heldout = await loadDataset(
      resolve(evalsDir, "datasets/golden/organize/organize.heldout.v1.json"),
    );
    assert.equal(heldout.name, "organize.heldout.v1");
    assert.equal(heldout.cases.length, 32); // 29 pilot-grown + 3 cold legacy cases
    assert.equal(
      heldout.cases.filter((c) => c.meta.provenance === "synthetic").length,
      3,
    );
    // The dev partition validates whether empty or seeded (inline cases only).
    const dev = await loadDataset(
      resolve(evalsDir, "datasets/golden/organize/organize.dev.v1.json"),
    );
    assert.equal(dev.name, "organize.dev.v1");
    assert.ok(dev.cases.every((c) => c.id.startsWith("organize-pilot-")));
  });
});
