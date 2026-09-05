/**
 * Organize scorer unit tests (Specification 4.2): metric correctness and
 * the seeded-regression proof (AC-1 — a known-broken implementation must
 * reduce the expected metrics).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OrganizeOutput, Organizer } from "@donna/core";
import { createOrganizeScorer } from "./organize.js";
import type { LoadedCase } from "../datasets.js";
import type { StageContext } from "../harness.js";
import { bucketNamesEquivalent } from "./organize.js";

const CONTEXT = {
  scope: { tenantId: "eval-tenant", userId: "eval-user" },
  scratchDir: "/tmp",
  snapshot: undefined as never,
} satisfies StageContext;

const CASE = {
  id: "case-1",
  meta: {
    provenance: "synthetic",
    labeler: "labeler:test",
    consent: "not-required-synthetic",
    sensitivity: "none",
  },
  payload: {
    transcript:
      "The onboarding drop-off is at step three. I promised Arjun the pricing deck by Thursday.",
    expected: {
      thoughts: [
        { kind: "idea", bucket: "Product Ideas", contains: ["onboarding", "step three"] },
        { kind: "task", bucket: "Tasks", contains: ["pricing deck", "Arjun"], task: { assigneeHint: "Arjun" } },
      ],
    },
  },
} as unknown as LoadedCase;

function organizerReturning(output: OrganizeOutput): Organizer {
  return { modelId: "stub", async organize() { return output; } };
}

function originCase(
  bucketOrigin: "minted" | "joined",
  bucket: string,
  existingBuckets: Array<{ name: string; description: string }>,
): LoadedCase {
  return {
    id: `case-${bucketOrigin}`,
    meta: CASE.meta,
    payload: {
      transcript: "Review the onboarding drop-off.",
      existingBuckets,
      expected: {
        thoughts: [
          {
            kind: "note",
            bucket,
            bucketOrigin,
            contains: ["onboarding"],
          },
        ],
      },
    },
  } as unknown as LoadedCase;
}

function originOutput(
  placement:
    | { suggestedBucket: string }
    | { newBucketName: string },
): OrganizeOutput {
  return {
    thoughts: [
      {
        summary: "Review the onboarding drop-off",
        text: "Review the onboarding drop-off.",
        confidence: 0.9,
        ...placement,
        provenance: {
          segmentIds: ["seg-0"],
          sourceText: "Review the onboarding drop-off.",
          startSec: 0,
          endSec: 60,
        },
      },
    ],
  };
}

const GOOD_OUTPUT: OrganizeOutput = {
  thoughts: [
    {
      summary: "Onboarding drop-off is at step three",
      text: "The onboarding drop-off is at step three.",
      confidence: 0.9,
      suggestedBucket: "Product Ideas",
      provenance: { segmentIds: ["seg-0"], sourceText: "The onboarding drop-off is at step three.", startSec: 0, endSec: 60 },
    },
    {
      summary: "Send the pricing deck to Arjun by Thursday",
      text: "I promised Arjun the pricing deck by Thursday.",
      confidence: 0.95,
      suggestedBucket: "Tasks",
      task: { title: "Send the pricing deck to Arjun", assigneeHint: "Arjun", dueHint: "Thursday" },
      provenance: { segmentIds: ["seg-0"], sourceText: "I promised Arjun the pricing deck by Thursday.", startSec: 0, endSec: 60 },
    },
  ],
};

describe("organize scorer", () => {
  it("errors external-flaky without an organizer", async () => {
    const scorer = createOrganizeScorer({});
    const [outcome] = await scorer.score(CASE, CONTEXT);
    assert.equal(outcome!.error?.class, "external-flaky");
  });

  it("scores a good output at 1.0 across metrics", async () => {
    const scorer = createOrganizeScorer({ organizer: organizerReturning(GOOD_OUTPUT) });
    const [outcome] = await scorer.score(CASE, CONTEXT);
    assert.equal(outcome!.scores["organize.schema_valid"], 1);
    assert.equal(outcome!.scores["organize.thought_coverage"], 1);
    assert.equal(outcome!.scores["organize.thought_count_f1"], 1);
    assert.equal(outcome!.scores["organize.task_precision"], 1);
    assert.equal(outcome!.scores["organize.task_recall"], 1);
    assert.equal(outcome!.scores["organize.bucket_acceptance"], 1);
    assert.equal(outcome!.scores["organize.provenance_fidelity"], 1);
    assert.equal(outcome!.hardFailures.length, 0);
  });

  it("AC-1: an under-splitting organizer reduces coverage and count F1", async () => {
    const broken: OrganizeOutput = {
      thoughts: [
        {
          summary: "Onboarding drop-off and the pricing deck",
          text: "The onboarding drop-off is at step three and I promised Arjun the pricing deck.",
          confidence: 0.8,
          newBucketName: "Misc",
          provenance: { segmentIds: ["seg-0"], sourceText: "x", startSec: 0, endSec: 60 },
        },
      ],
    };
    const scorer = createOrganizeScorer({ organizer: organizerReturning(broken) });
    const [outcome] = await scorer.score(CASE, CONTEXT);
    assert.ok(outcome!.scores["organize.thought_coverage"]! < 1);
    assert.ok(outcome!.scores["organize.thought_count_f1"]! < 1);
    assert.ok(outcome!.scores["organize.task_recall"]! < 1);
    assert.ok(outcome!.scores["organize.bucket_acceptance"]! < 1);
  });

  it("invalid model-proposed provenance is a HARD FAILURE, never averaged", async () => {
    const badProvenance: OrganizeOutput = {
      thoughts: [
        {
          summary: "Onboarding drop-off is at step three",
          text: "The onboarding drop-off is at step three.",
          confidence: 0.9,
          suggestedBucket: "Product Ideas",
          provenance: { segmentIds: ["seg-99"], sourceText: "fabricated", startSec: 0, endSec: 60 },
        },
      ],
    };
    const scorer = createOrganizeScorer({ organizer: organizerReturning(badProvenance) });
    const [outcome] = await scorer.score(CASE, CONTEXT);
    assert.equal(outcome!.scores["organize.provenance_fidelity"], 0);
    assert.equal(outcome!.hardFailures.length, 1);
    assert.equal(outcome!.hardFailures[0]!.kind, "invalid-provenance");
  });

  it("passes the validated snapshot unchanged and keeps the legacy cold call", async () => {
    const received: Array<Array<{ name: string; description: string }>> = [];
    const organizer: Organizer = {
      modelId: "recording",
      async organize(_transcript, buckets) {
        received.push(buckets);
        return originOutput({ suggestedBucket: "Product Ideas" });
      },
    };
    const scorer = createOrganizeScorer({ organizer });
    const snapshot = [
      { name: "Tasks", description: "Commitments" },
      { name: "Product Ideas", description: "Ideas to explore" },
    ];
    await scorer.score(originCase("joined", "Product Ideas", snapshot), CONTEXT);
    await scorer.score(originCase("joined", "Product Ideas", snapshot), CONTEXT);
    await scorer.score(CASE, CONTEXT);
    assert.deepEqual(received, [snapshot, snapshot, []]);
    assert.notEqual(received[0], snapshot);
  });

  it("joined exact match passes and joined mismatch fails", async () => {
    const testCase = originCase(
      "joined",
      "Product Ideas",
      [{ name: "Product Ideas", description: "Ideas to explore" }],
    );
    const pass = await createOrganizeScorer({
      organizer: organizerReturning(originOutput({ suggestedBucket: "product ideas" })),
    }).score(testCase, CONTEXT);
    const fail = await createOrganizeScorer({
      organizer: organizerReturning(originOutput({ suggestedBucket: "Launch Notes" })),
    }).score(testCase, CONTEXT);
    assert.equal(pass[0]!.scores["organize.bucket_acceptance"], 1);
    assert.equal(pass[0]!.scores["organize.bucket_acceptance_joined"], 1);
    assert.equal(fail[0]!.scores["organize.bucket_acceptance"], 0);
    assert.equal(fail[0]!.scores["organize.bucket_acceptance_joined"], 0);
  });

  it("minted exact match passes only when the organizer actually mints", async () => {
    const testCase = originCase(
      "minted",
      "Roadmap Ideas",
      [{ name: "Tasks", description: "Commitments" }],
    );
    const exact = await createOrganizeScorer({
      organizer: organizerReturning(originOutput({ newBucketName: "roadmap ideas" })),
    }).score(testCase, CONTEXT);
    const misjoin = await createOrganizeScorer({
      organizer: organizerReturning(originOutput({ suggestedBucket: "Roadmap Ideas" })),
    }).score(testCase, CONTEXT);
    assert.equal(exact[0]!.scores["organize.bucket_acceptance"], 1);
    assert.equal(exact[0]!.scores["organize.bucket_acceptance_minted"], 1);
    assert.equal(misjoin[0]!.scores["organize.bucket_acceptance"], 0);
    assert.equal(misjoin[0]!.scores["organize.bucket_name_equivalence"], 0);
  });

  it("minted equivalent-but-different name stays a gate failure", async () => {
    const outcome = await createOrganizeScorer({
      organizer: organizerReturning(originOutput({ newBucketName: "Ideas - Roadmap" })),
    }).score(
      originCase(
        "minted",
        "Roadmap Ideas",
        [{ name: "Tasks", description: "Commitments" }],
      ),
      CONTEXT,
    );
    assert.equal(outcome[0]!.scores["organize.bucket_acceptance"], 0);
    assert.equal(outcome[0]!.scores["organize.bucket_acceptance_minted"], 0);
    assert.equal(outcome[0]!.scores["organize.bucket_name_equivalence"], 1);
    assert.ok(outcome[0]!.notes?.includes("bucket-equivalence-only:1"));
    assert.equal(bucketNamesEquivalent("Ideas - Roadmap", "roadmap ideas"), true);
    assert.equal(bucketNamesEquivalent("Roadmap", "Roadmap Ideas"), false);
  });
});
