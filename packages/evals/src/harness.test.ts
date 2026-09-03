/**
 * Harness tests (Specification 4.1: AC-1 reproducibility, FR-2 hard
 * failures, FR-4 isolation, report artifacts).
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { adversarialScorer } from "./adversarial.js";
import { runEval } from "./harness.js";
import { EvalIsolationError } from "./isolation.js";
import { reportsEquivalent, type CaseOutcome } from "./report.js";

const here = dirname(fileURLToPath(import.meta.url));
const evalsDir = resolve(here, "..");
const repoRoot = resolve(here, "../../..");
const configPath = resolve(repoRoot, "models.config.yaml");
const ADVERSARIAL = resolve(evalsDir, "datasets/adversarial/adversarial.v1.json");

let reportsDir: string;
before(async () => {
  reportsDir = await mkdtemp(join(tmpdir(), "donna-harness-test-"));
});
after(async () => {
  await rm(reportsDir, { recursive: true, force: true });
});

function baseOptions(scorer: Parameters<typeof runEval>[0]["scorer"]) {
  return {
    datasetPath: ADVERSARIAL,
    configPath,
    repoRoot,
    evalsDir,
    reportsDir,
    scorer,
  };
}

describe("runEval", () => {
  it("runs the adversarial suite: all attacks blocked, zero hard failures", async () => {
    const { report, jsonPath, markdownPath } = await runEval(baseOptions(adversarialScorer));
    assert.equal(report.stage, "adversarial");
    assert.equal(report.cases.length, 8);
    assert.equal(report.aggregate.hardFailureCount, 0);
    assert.equal(report.aggregate.metrics["adversarial.blocked"]?.mean, 1);
    // Both artifacts exist; the JSON parses back; the MD names the dataset.
    const parsed = JSON.parse(await readFile(jsonPath, "utf8")) as { schema: string };
    assert.equal(parsed.schema, "donna.eval-report.v1");
    const markdown = await readFile(markdownPath, "utf8");
    assert.ok(markdown.includes("adversarial.v1"));
    assert.ok(markdown.includes("HARD FAILURES: 0"));
  });

  it("AC-1: the same commit + config + dataset reproduces equivalent scores", async () => {
    const first = await runEval(baseOptions(adversarialScorer));
    const second = await runEval(baseOptions(adversarialScorer));
    assert.equal(first.report.fingerprint, second.report.fingerprint);
    const equivalence = reportsEquivalent(first.report, second.report);
    assert.deepEqual(equivalence.differences, []);
    assert.ok(equivalence.equivalent);
  });

  it("FR-2: hard failures are surfaced per case and never averaged out", async () => {
    const failingScorer: typeof adversarialScorer = {
      stage: "adversarial",
      async score(testCase, context): Promise<CaseOutcome> {
        if (testCase.id === "tenant-read-items-01") {
          return {
            caseId: testCase.id,
            scores: { "adversarial.blocked": 1 },
            hardFailures: [{ kind: "tenant-leak", detail: "seeded leak for the test" }],
          };
        }
        return adversarialScorer.score(testCase, context);
      },
    };
    const { report } = await runEval(baseOptions(failingScorer));
    assert.equal(report.aggregate.hardFailureCount, 1);
    assert.equal(report.aggregate.hardFailures[0]?.kind, "tenant-leak");
    assert.equal(report.aggregate.hardFailures[0]?.caseId, "tenant-read-items-01");
    // The mean score stays high — the hard failure is a separate dimension.
    assert.ok(report.aggregate.metrics["adversarial.blocked"]!.mean > 0.8);
  });

  it("FR-4: non-eval scopes and pilot data dirs are refused", async () => {
    await assert.rejects(
      runEval({
        ...baseOptions(adversarialScorer),
        scope: { tenantId: "demo-tenant", userId: "eval-user" },
      }),
      EvalIsolationError,
    );
    await assert.rejects(
      runEval({
        ...baseOptions(adversarialScorer),
        reportsDir: join(repoRoot, "data", "reports"),
      }),
      EvalIsolationError,
    );
  });

  it("report carries the config fingerprint and redaction note (FR-1, SR-2)", async () => {
    const { report } = await runEval(baseOptions(adversarialScorer));
    assert.equal(report.fingerprint.length, 64);
    assert.equal(report.snapshot.dataset.name, "adversarial.v1");
    assert.ok(report.redactionNote.includes("No transcript text"));
    // SR-2: no secret material anywhere in the serialized report.
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes(process.env.TRUEFOUNDRY_API_KEY ?? "\0never"));
  });
});
