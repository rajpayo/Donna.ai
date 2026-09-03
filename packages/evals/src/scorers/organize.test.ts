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
});
