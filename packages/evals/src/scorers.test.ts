import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { OrganizeOutput } from "@donna/core";
import { scoreCase, type GoldenCase } from "./scorers.js";

const golden: GoldenCase = {
  id: "t1",
  transcript: "I promised Arjun the pricing deck by Thursday.",
  expected: {
    thoughts: [
      {
        kind: "task",
        bucket: "Tasks",
        contains: ["pricing deck", "Arjun"],
        task: { assigneeHint: "Arjun", dueHint: "Thursday" },
      },
    ],
  },
};

function outputWith(task: boolean, bucket: string): OrganizeOutput {
  return {
    thoughts: [
      {
        summary: "Send Arjun the pricing deck",
        text: "Send Arjun the pricing deck by Thursday",
        confidence: 0.9,
        suggestedBucket: bucket,
        ...(task ? { task: { title: "Send pricing deck", assigneeHint: "Arjun", dueHint: "Thursday" } } : {}),
        provenance: { segmentIds: ["seg-0"], sourceText: "I promised Arjun the pricing deck by Thursday.", startSec: 0, endSec: 3 },
      },
    ],
  };
}

describe("scoreCase", () => {
  it("scores a perfect run at 1 across the board", () => {
    const s = scoreCase(golden, outputWith(true, "Tasks"));
    assert.equal(s.schemaValid, true);
    assert.equal(s.contentCoverage, 1);
    assert.equal(s.taskExtraction.recall, 1);
    assert.equal(s.tasksBucketedCorrectly, true);
  });

  it("fails schema validity on null output", () => {
    const s = scoreCase(golden, null);
    assert.equal(s.schemaValid, false);
    assert.equal(s.contentCoverage, 0);
  });

  it("flags tasks that miss the Tasks bucket", () => {
    const s = scoreCase(golden, outputWith(true, "Random Ideas"));
    assert.equal(s.tasksBucketedCorrectly, false);
  });

  it("drops task recall when the task is not extracted", () => {
    const s = scoreCase(golden, outputWith(false, "Tasks"));
    assert.equal(s.taskExtraction.recall, 0);
  });
});
