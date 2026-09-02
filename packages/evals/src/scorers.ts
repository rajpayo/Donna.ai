/**
 * Scorers for the organize stage. Each returns 0..1; the runner aggregates.
 *
 * These are the numbers that move when you swap a model in
 * models.config.yaml — the iterate-to-perfection loop is: change config,
 * run evals, compare report, keep what wins.
 */
import type { OrganizeOutput } from "@donna/core";

export interface GoldenCase {
  id: string;
  transcript: string;
  expected: {
    thoughts: Array<{
      kind: "idea" | "task" | "note";
      /** Expected bucket name, or null for "any sensible new bucket". */
      bucket: string | null;
      /** Substrings the distilled thought must cover. */
      contains: string[];
      task?: { assigneeHint?: string; dueHint?: string };
    }>;
  };
}

export interface CaseScore {
  caseId: string;
  schemaValid: boolean;
  thoughtCountF1: number;
  contentCoverage: number;
  taskExtraction: { precision: number; recall: number };
  tasksBucketedCorrectly: boolean;
}

export function scoreCase(
  golden: GoldenCase,
  output: OrganizeOutput | null,
): CaseScore {
  if (!output) {
    return {
      caseId: golden.id,
      schemaValid: false,
      thoughtCountF1: 0,
      contentCoverage: 0,
      taskExtraction: { precision: 0, recall: 0 },
      tasksBucketedCorrectly: false,
    };
  }

  const expectedCount = golden.expected.thoughts.length;
  const actualCount = output.thoughts.length;
  const thoughtCountF1 =
    expectedCount === 0 && actualCount === 0
      ? 1
      : (2 * Math.min(expectedCount, actualCount)) / (expectedCount + actualCount);

  // Content coverage: fraction of expected substring groups fully covered
  // by at least one actual thought.
  let covered = 0;
  for (const exp of golden.expected.thoughts) {
    const hit = output.thoughts.some((t) =>
      exp.contains.every((c) =>
        `${t.text} ${t.summary}`.toLowerCase().includes(c.toLowerCase()),
      ),
    );
    if (hit) covered++;
  }
  const contentCoverage =
    golden.expected.thoughts.length === 0
      ? 1
      : covered / golden.expected.thoughts.length;

  // Task extraction precision/recall against expected tasks.
  const expectedTasks = golden.expected.thoughts.filter((t) => t.kind === "task");
  const actualTasks = output.thoughts.filter((t) => t.task !== undefined);
  const truePositives = expectedTasks.filter((exp) =>
    actualTasks.some((a) =>
      exp.contains.some((c) => a.text.toLowerCase().includes(c.toLowerCase())),
    ),
  ).length;
  const precision = actualTasks.length === 0 ? (expectedTasks.length === 0 ? 1 : 0) : truePositives / actualTasks.length;
  const recall = expectedTasks.length === 0 ? 1 : truePositives / expectedTasks.length;

  // Every actual task must target the Tasks bucket (suggested or new).
  const tasksBucketedCorrectly = output.thoughts
    .filter((t) => t.task !== undefined)
    .every((t) => {
      const name = (t.suggestedBucket ?? t.newBucketName ?? "").toLowerCase();
      return name === "tasks";
    });

  return {
    caseId: golden.id,
    schemaValid: true,
    thoughtCountF1,
    contentCoverage,
    taskExtraction: { precision, recall },
    tasksBucketedCorrectly,
  };
}
