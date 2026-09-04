import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type {
  Bucket,
  CaptureRecord,
  CorrectionEvent,
} from "@donna/core";
import type { PilotDecision } from "@donna/pilot";
import {
  amendOrganizeSnapshotEnvelopes,
  reconstructCaptureTimeBuckets,
  type SnapshotSourceStores,
} from "./amend-organize-snapshots.js";

const SCOPE = { tenantId: "eval-tenant", userId: "eval-user" };
const CAPTURE: CaptureRecord = {
  id: "capture-1",
  ...SCOPE,
  contentHash: "0".repeat(64),
  capturedAt: "2026-09-05T10:00:00.000Z",
};

function bucket(
  id: string,
  name: string,
  createdAt: string,
  description = `${name} description`,
): Bucket {
  return {
    id,
    ...SCOPE,
    name,
    description,
    centroid: [],
    itemCount: 0,
    createdAt,
    origin: "auto",
  };
}

function correction(
  type: "bucket.rename" | "bucket.merge",
  targetId: string,
  payload: Record<string, string>,
): CorrectionEvent {
  return {
    id: `correction-${type}`,
    ...SCOPE,
    type,
    target: { kind: "bucket", id: targetId },
    payload,
    sources: [{ kind: "capture", id: CAPTURE.id, captureId: CAPTURE.id, reason: "test" }],
    status: "accepted",
    createdAt: "2026-09-05T11:00:00.000Z",
    resolvedAt: "2026-09-05T11:01:00.000Z",
    appliedAt: "2026-09-05T11:01:00.000Z",
    followedCount: 0,
    contradictedCount: 0,
  };
}

describe("capture-time bucket reconstruction (Spec 6.5 FR-5)", () => {
  it("applies the createdAt existence rule deterministically", () => {
    const result = reconstructCaptureTimeBuckets({
      capture: CAPTURE,
      currentBuckets: [
        bucket("b-old", "Tasks", "2026-09-05T09:00:00.000Z"),
        bucket("b-new", "Launch Notes", "2026-09-05T10:01:00.000Z"),
      ],
      corrections: [],
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(result.existingBuckets, [
      { name: "Tasks", description: "Tasks description" },
    ]);
  });

  it("rolls back a timestamped rename when the inverse name is present", () => {
    const result = reconstructCaptureTimeBuckets({
      capture: CAPTURE,
      currentBuckets: [
        bucket("b-ideas", "Roadmap Ideas", "2026-09-05T09:00:00.000Z"),
      ],
      corrections: [
        correction("bucket.rename", "b-ideas", {
          oldName: "Product Ideas",
          newName: "Roadmap Ideas",
        }),
      ],
    });
    assert.equal(result.status, "ok");
    assert.equal(result.existingBuckets[0]!.name, "Product Ideas");
    assert.equal(result.correctionsRolledBack, 1);
  });

  it("restores a merged-away bucket from its inverse snapshot", () => {
    const result = reconstructCaptureTimeBuckets({
      capture: CAPTURE,
      currentBuckets: [
        bucket("b-target", "Projects", "2026-09-05T08:00:00.000Z"),
      ],
      corrections: [
        correction("bucket.merge", "b-source", {
          intoBucketId: "b-target",
          sourceName: "Website Redesign",
          sourceDescription: "Website work",
          sourceCreatedAt: "2026-09-05T09:00:00.000Z",
        }),
      ],
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.existingBuckets.map((item) => item.name),
      ["Projects", "Website Redesign"],
    );
  });

  it("flags incomplete rename/merge history instead of guessing", () => {
    const renamed = reconstructCaptureTimeBuckets({
      capture: CAPTURE,
      currentBuckets: [
        bucket("b-ideas", "Roadmap Ideas", "2026-09-05T09:00:00.000Z"),
      ],
      corrections: [
        correction("bucket.rename", "b-ideas", { newName: "Roadmap Ideas" }),
      ],
    });
    assert.equal(renamed.status, "ambiguous");
    assert.deepEqual(renamed.reasons, ["rename-missing-old-name"]);

    const merged = reconstructCaptureTimeBuckets({
      capture: CAPTURE,
      currentBuckets: [],
      corrections: [
        correction("bucket.merge", "b-source", { intoBucketId: "b-target" }),
      ],
    });
    assert.equal(merged.status, "ambiguous");
    assert.deepEqual(merged.reasons, ["merge-missing-source-snapshot"]);
  });
});

let dir: string;
let devPath: string;
let driftPath: string;
let diffPath: string;
let decisions: PilotDecision[];
let buckets: Bucket[];
let corrections: CorrectionEvent[];

function inlineCase(
  id: string,
  bucketName: string,
  decisionId: string,
): Record<string, unknown> {
  return {
    id,
    meta: {
      provenance: "de-identified",
      labeler: "labeler:pilot-participant",
      adjudicator: "labeler:product-owner",
      consent: "de-identified",
      sensitivity: "low",
    },
    transcript: `Synthetic summary for ${bucketName}`,
    expected: {
      thoughts: [
        {
          kind: "note",
          bucket: bucketName,
          contains: ["synthetic"],
        },
      ],
    },
    _decisionIdForTest: decisionId,
  };
}

function envelope(name = "organize.dev.v1", version = 1): Record<string, unknown> {
  const joined = inlineCase("organize-pilot-joined", "Tasks", "decision-joined");
  const minted = inlineCase(
    "organize-pilot-minted",
    "Launch Notes",
    "decision-minted",
  );
  delete joined["_decisionIdForTest"];
  delete minted["_decisionIdForTest"];
  return {
    schema: "donna.eval-dataset.v1",
    name,
    stage: "organize",
    version,
    description: "synthetic amendment envelope",
    defaultMeta: {
      provenance: "de-identified",
      labeler: "labeler:pilot-participant",
      adjudicator: "labeler:product-owner",
      consent: "de-identified",
      sensitivity: "low",
    },
    cases: [joined, minted],
    adjudications: [
      {
        at: "2026-09-05T12:00:00.000Z",
        adjudicator: "labeler:product-owner",
        caseId: "organize-pilot-joined",
        change: "new case",
        reason: "pilot decision decision-joined (explicit accept); promoted",
      },
      {
        at: "2026-09-05T12:00:00.000Z",
        adjudicator: "labeler:product-owner",
        caseId: "organize-pilot-minted",
        change: "new case",
        reason: "pilot decision decision-minted (explicit accept); promoted",
      },
    ],
  };
}

function decision(id: string, bucketId: string, bucketName: string): PilotDecision {
  return {
    schema: "donna.pilot-decision.v1",
    id,
    ...SCOPE,
    participantId: "P-TEST",
    thoughtId: `thought-${id}`,
    captureId: CAPTURE.id,
    kind: "accept",
    donnaBucket: { id: bucketId, name: bucketName },
    decidedBucket: { id: bucketId, name: bucketName },
    decidedAt: "2026-09-05T12:00:00.000Z",
  };
}

function stores(): SnapshotSourceStores {
  return {
    captures: {
      async getCapture(t: string, u: string, id: string) {
        return t === SCOPE.tenantId && u === SCOPE.userId && id === CAPTURE.id
          ? CAPTURE
          : undefined;
      },
    },
    buckets: {
      async listBuckets() {
        return buckets;
      },
    },
    corrections: {
      async listCorrections() {
        return corrections;
      },
    },
    decisions: {
      async list() {
        return decisions;
      },
      async saveAll() {
        throw new Error("source store is read-only");
      },
    },
  } as unknown as SnapshotSourceStores;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "donna-amend-snapshots-"));
  devPath = join(dir, "organize.dev.v1.json");
  driftPath = join(dir, "drift.json");
  diffPath = join(dir, "diff.json");
  buckets = [
    bucket("b-tasks", "Tasks", "2026-09-05T09:00:00.000Z", "Commitments"),
    bucket(
      "b-launch",
      "Launch Notes",
      "2026-09-05T10:01:00.000Z",
      "Launch preparation",
    ),
  ];
  corrections = [];
  decisions = [
    decision("decision-joined", "b-tasks", "Tasks"),
    decision("decision-minted", "b-launch", "Launch Notes"),
  ];
  await writeFile(devPath, JSON.stringify(envelope(), null, 2) + "\n");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("organize snapshot amendment (Spec 6.5 AC-3/AC-4)", () => {
  it("dry-runs without changing the envelope, then applies additive fields with stable IDs", async () => {
    const before = await readFile(devPath, "utf8");
    const dry = await amendOrganizeSnapshotEnvelopes({
      envelopePaths: [devPath],
      scope: SCOPE,
      stores: stores(),
      apply: false,
      driftReportPath: driftPath,
      diffArtifactPath: diffPath,
      now: () => new Date("2026-09-05T13:00:00.000Z"),
    });
    assert.equal(dry.applied, false);
    assert.equal(dry.drift.reconstructibleCases, 2);
    assert.equal(await readFile(devPath, "utf8"), before);

    const applied = await amendOrganizeSnapshotEnvelopes({
      envelopePaths: [devPath],
      scope: SCOPE,
      stores: stores(),
      apply: true,
      driftReportPath: driftPath,
      diffArtifactPath: diffPath,
      now: () => new Date("2026-09-05T13:00:00.000Z"),
    });
    assert.equal(applied.applied, true);
    assert.equal(applied.diff?.sameCaseIds, true);
    assert.equal(applied.diff?.onlyPermittedChanges, true);
    const raw = JSON.parse(await readFile(devPath, "utf8")) as {
      version: number;
      cases: Array<{
        id: string;
        existingBuckets: Array<{ name: string }>;
        expected: { thoughts: Array<{ bucketOrigin: string }> };
      }>;
      adjudications: Array<{ change: string }>;
    };
    assert.equal(raw.version, 2);
    assert.deepEqual(
      raw.cases.map((item) => item.id),
      ["organize-pilot-joined", "organize-pilot-minted"],
    );
    assert.equal(raw.cases[0]!.expected.thoughts[0]!.bucketOrigin, "joined");
    assert.equal(raw.cases[1]!.expected.thoughts[0]!.bucketOrigin, "minted");
    assert.ok(
      !raw.cases[1]!.existingBuckets.some((item) => item.name === "Launch Notes"),
    );
    assert.equal(
      raw.adjudications.filter((item) =>
        item.change.startsWith("context: added capture-time"),
      ).length,
      2,
    );

    const once = await readFile(devPath, "utf8");
    await amendOrganizeSnapshotEnvelopes({
      envelopePaths: [devPath],
      scope: SCOPE,
      stores: stores(),
      apply: true,
      driftReportPath: driftPath,
      diffArtifactPath: diffPath,
      now: () => new Date("2026-09-05T14:00:00.000Z"),
    });
    assert.equal(await readFile(devPath, "utf8"), once);
  });

  it("blocks every write on ambiguity and accepts an explicit batch override", async () => {
    corrections = [
      correction("bucket.rename", "b-tasks", { newName: "Tasks" }),
    ];
    const before = await readFile(devPath, "utf8");
    const blocked = await amendOrganizeSnapshotEnvelopes({
      envelopePaths: [devPath],
      scope: SCOPE,
      stores: stores(),
      apply: true,
      driftReportPath: driftPath,
      diffArtifactPath: diffPath,
      now: () => new Date("2026-09-05T13:00:00.000Z"),
    });
    assert.equal(blocked.applied, false);
    assert.equal(blocked.drift.unresolvedCases, 2);
    assert.equal(await readFile(devPath, "utf8"), before);

    const applied = await amendOrganizeSnapshotEnvelopes({
      envelopePaths: [devPath],
      scope: SCOPE,
      stores: stores(),
      overrides: [
        {
          caseId: "organize-pilot-joined",
          existingBuckets: [{ name: "Tasks", description: "Commitments" }],
          bucketOrigin: "joined",
          reason: "po-reviewed-rename-history",
        },
        {
          caseId: "organize-pilot-minted",
          existingBuckets: [{ name: "Tasks", description: "Commitments" }],
          bucketOrigin: "minted",
          reason: "po-reviewed-rename-history",
        },
      ],
      apply: true,
      driftReportPath: driftPath,
      diffArtifactPath: diffPath,
      now: () => new Date("2026-09-05T13:00:00.000Z"),
    });
    assert.equal(applied.applied, true);
    assert.equal(applied.drift.overriddenCases, 2);
    assert.equal(applied.drift.unresolvedCases, 0);
  });

  it("requires the held-out v2 lock intact and advances only the envelope to v3", async () => {
    const heldoutPath = join(dir, "organize.heldout.v1.json");
    const heldoutContent = JSON.stringify(
      envelope("organize.heldout.v1", 2),
      null,
      2,
    ) + "\n";
    await writeFile(heldoutPath, heldoutContent);
    await writeFile(
      join(dir, "organize.heldout.lock.json"),
      JSON.stringify(
        {
          schema: "donna.heldout-lock.v1",
          name: "organize.heldout.v1",
          version: 2,
          sha256: createHash("sha256").update(heldoutContent).digest("hex"),
          frozenAt: "2026-09-05T12:30:00.000Z",
          firstResultsReportSha256: "1".repeat(64),
        },
        null,
        2,
      ) + "\n",
    );
    const result = await amendOrganizeSnapshotEnvelopes({
      envelopePaths: [heldoutPath],
      scope: SCOPE,
      stores: stores(),
      apply: true,
      driftReportPath: driftPath,
      diffArtifactPath: diffPath,
      now: () => new Date("2026-09-05T13:00:00.000Z"),
    });
    assert.equal(result.applied, true);
    const after = JSON.parse(await readFile(heldoutPath, "utf8")) as {
      version: number;
    };
    assert.equal(after.version, 3);
    const lock = JSON.parse(
      await readFile(join(dir, "organize.heldout.lock.json"), "utf8"),
    ) as { version: number; sha256: string };
    assert.equal(lock.version, 2);
    assert.equal(
      lock.sha256,
      createHash("sha256").update(heldoutContent).digest("hex"),
    );
  });
});
