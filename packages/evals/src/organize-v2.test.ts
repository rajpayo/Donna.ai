/**
 * Spec 6.7 eval machinery tests: v2 scorer metric separation, prompt
 * label-leakage audit, plan immutability, and mechanical floor evaluation
 * (including the narrow mint-specific failure signal).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  BucketOption,
  OrganizeOutputV2,
  OrganizerV2,
} from "@donna/core";
import { createOrganizeV2Scorer } from "./scorers/organize-v2.js";
import { ScriptedEmbedder } from "./scripted.js";
import type { StageContext } from "./harness.js";
import type { LoadedCase } from "./datasets.js";
import type { EvalReport } from "./report.js";
import {
  buildV2ReviewPacket,
  evaluateV2Eligibility,
  summarizeV2Review,
  validateLockedV2Plan,
  V2_FLOORS,
  type V2ExperimentPlan,
} from "./organize-v2-experiment.js";

const TUNING = {
  assign_threshold: 0.82,
  create_threshold: 0.65,
  near_duplicate_threshold: 0.9,
};

function v2Thought(
  text: string,
  placement: OrganizeOutputV2["thoughts"][number]["placement"],
  task?: { title: string },
): OrganizeOutputV2["thoughts"][number] {
  return {
    summary: text,
    text,
    confidence: 0.9,
    ...(task !== undefined ? { task } : {}),
    provenance: { segmentIds: ["seg-0"], sourceText: text, startSec: 0, endSec: 60 },
    placement,
  };
}

class ScriptedOrganizerV2 implements OrganizerV2 {
  readonly modelId = "scripted-v2";
  readonly schemaVersion = "donna.organize.v2";
  readonly promptVersion = "donna.organize-prompt.v4-structured";
  lastAllowlist: BucketOption[] | undefined;
  constructor(private readonly thoughts: OrganizeOutputV2["thoughts"]) {}
  async organizeV2(
    _transcript: unknown,
    allowlist: BucketOption[],
  ): Promise<OrganizeOutputV2> {
    this.lastAllowlist = allowlist;
    return { thoughts: this.thoughts };
  }
}

function testCase(payload: Record<string, unknown>): LoadedCase {
  return {
    id: "case-1",
    meta: {
      provenance: "synthetic",
      labeler: "labeler:test",
      consent: "not-required-synthetic",
      sensitivity: "none",
    },
    payload,
  } as LoadedCase;
}

async function scoreWith(
  thoughts: OrganizeOutputV2["thoughts"],
  payload: Record<string, unknown>,
): Promise<{ outcomeScores: Record<string, number>; organizer: ScriptedOrganizerV2 }> {
  const organizer = new ScriptedOrganizerV2(thoughts);
  const scorer = createOrganizeV2Scorer({
    organizerV2: organizer,
    embedder: new ScriptedEmbedder(),
    bucketTuning: TUNING,
  });
  const scratchDir = await mkdtemp(join(tmpdir(), "donna-v2-scorer-"));
  const context = {
    scope: { tenantId: "eval-tenant", userId: "eval-user" },
    scratchDir,
    snapshot: {},
  } as unknown as StageContext;
  const outcomes = await scorer.score(testCase(payload), context);
  return { outcomeScores: outcomes[0]!.scores, organizer };
}

describe("organize v2 scorer (Spec 6.7 FR-14)", () => {
  it("scores a correct join: mode, stable ID, and final placement all pass", async () => {
    const payload = {
      transcript: "atlas launch checklist notes",
      existingBuckets: [
        { id: "eval-b-01-project-atlas", name: "Project Atlas", description: "atlas launch checklist notes" },
      ],
      expected: {
        thoughts: [
          { kind: "note", bucket: "Project Atlas", bucketOrigin: "joined", contains: ["atlas"] },
        ],
      },
    };
    const { outcomeScores } = await scoreWith(
      [v2Thought("atlas launch checklist notes", { mode: "existing", bucketId: "eval-b-01-project-atlas" })],
      payload,
    );
    assert.equal(outcomeScores["route.mode_accuracy"], 1);
    assert.equal(outcomeScores["route.join_id_accuracy"], 1);
    assert.equal(outcomeScores["final.placement_acceptance"], 1);
    assert.equal(outcomeScores["organize.schema_valid"], 1);
    assert.equal(outcomeScores["organize.provenance_fidelity"], 1);
  });

  it("scores a valid distinct mint: decision, validator, and final creation pass", async () => {
    const payload = {
      transcript: "thinking about vendor contract renewals",
      existingBuckets: [],
      expected: {
        thoughts: [
          { kind: "idea", bucket: "Vendor Contracts", bucketOrigin: "minted", contains: ["vendor"] },
        ],
      },
    };
    const { outcomeScores } = await scoreWith(
      [v2Thought("thinking about vendor contract renewals", { mode: "new", name: "Vendor Contracts", description: "Vendor paperwork and renewals." })],
      payload,
    );
    assert.equal(outcomeScores["route.mode_accuracy"], 1);
    assert.equal(outcomeScores["mint.recall"], 1);
    assert.equal(outcomeScores["mint.precision"], 1);
    assert.equal(outcomeScores["mint.validator_pass"], 1);
    assert.equal(outcomeScores["mint.exact_name"], 1);
    assert.equal(outcomeScores["final.placement_acceptance"], 1);
  });

  it("a model/geometry mismatch is pending: final placement not accepted, conflict counted", async () => {
    const payload = {
      transcript: "atlas launch checklist notes",
      existingBuckets: [
        { id: "eval-b-01-project-atlas", name: "Project Atlas", description: "atlas launch checklist notes" },
        { id: "eval-b-01-gardening", name: "Gardening", description: "tomatoes and tulips" },
      ],
      expected: {
        thoughts: [
          { kind: "note", bucket: "Project Atlas", bucketOrigin: "joined", contains: ["atlas"] },
        ],
      },
    };
    const { outcomeScores } = await scoreWith(
      [v2Thought("atlas launch checklist notes", { mode: "existing", bucketId: "eval-b-01-gardening" })],
      payload,
    );
    assert.equal(outcomeScores["route.join_id_accuracy"], 0);
    assert.equal(outcomeScores["final.placement_acceptance"], 0);
    assert.equal(outcomeScores["route.joined_conflict_rate"], 1);
    assert.equal(outcomeScores["review.pending_rate"], 1);
  });

  it("an invalid minted name fails the validator metric but keeps schema valid", async () => {
    const payload = {
      transcript: "thinking about vendor contract renewals",
      existingBuckets: [],
      expected: {
        thoughts: [
          { kind: "idea", bucket: "Vendor Contracts", bucketOrigin: "minted", contains: ["vendor"] },
        ],
      },
    };
    const { outcomeScores } = await scoreWith(
      [v2Thought("thinking about vendor contract renewals", { mode: "new", name: "Ask Arjun by Friday", description: "one-off" })],
      payload,
    );
    assert.equal(outcomeScores["organize.schema_valid"], 1);
    assert.equal(outcomeScores["mint.validator_pass"], 0);
    // No namer wired: the failed name persists pending, not accepted.
    assert.equal(outcomeScores["final.placement_acceptance"], 0);
  });

  it("Tasks hard rule: a task thought's final placement is Tasks", async () => {
    const payload = {
      transcript: "ask Priya to send the deck by Thursday",
      existingBuckets: [],
      expected: {
        thoughts: [
          { kind: "task", bucket: "Tasks", bucketOrigin: "minted", contains: ["priya"] },
        ],
      },
    };
    const { outcomeScores } = await scoreWith(
      [v2Thought("ask Priya to send the deck by Thursday", { mode: "new", name: "Random", description: "x" }, { title: "Send the deck" })],
      payload,
    );
    assert.equal(outcomeScores["tasks.hard_rule"], 1);
    assert.equal(outcomeScores["organize.task_recall"], 1);
  });

  it("expected labels never reach the organizer: the allowlist carries id/name/description only", async () => {
    const payload = {
      transcript: "atlas notes",
      existingBuckets: [
        { id: "eval-b-01-project-atlas", name: "Project Atlas", description: "atlas" },
      ],
      expected: {
        thoughts: [
          { kind: "note", bucket: "Project Atlas", bucketOrigin: "joined", contains: ["atlas"] },
        ],
      },
    };
    const { organizer } = await scoreWith(
      [v2Thought("atlas notes", { mode: "existing", bucketId: "eval-b-01-project-atlas" })],
      payload,
    );
    assert.ok(organizer.lastAllowlist !== undefined);
    for (const option of organizer.lastAllowlist!) {
      assert.deepEqual(Object.keys(option).sort(), ["description", "id", "name"]);
    }
  });
});

describe("6.7 plan immutability and floors (AC-10)", () => {
  const repoRoot = resolve(process.cwd(), "..", "..");
  const planPath = resolve(repoRoot, "packages/evals/experiments/organize/6.7/plan.json");

  it("the locked plan validates against its lock", async () => {
    const { plan } = await validateLockedV2Plan({ planPath, repoRoot });
    assert.equal(plan.implementation.model, "gpt-5-mini");
    assert.equal(plan.implementation.nearDuplicateThreshold, 0.9);
  });

  it("any plan-byte mutation is detected against the lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "donna-v2-plan-"));
    const raw = await readFile(planPath, "utf8");
    const tampered = raw.replace('"gpt-5-mini"', '"gpt-5-mini-x"');
    const tamperedPath = join(dir, "plan.json");
    await writeFile(tamperedPath, tampered);
    const lockRaw = await readFile(resolve(repoRoot, "packages/evals/experiments/organize/6.7/plan.lock.json"), "utf8");
    await writeFile(join(dir, "plan.lock.json"), lockRaw);
    await assert.rejects(
      validateLockedV2Plan({ planPath: tamperedPath, repoRoot }),
      /PLAN MUTATION DETECTED/,
    );
  });

  function fakeReport(metricMeans: Record<string, number>): EvalReport {
    const metrics = Object.fromEntries(
      Object.entries(metricMeans).map(([name, mean]) => [
        name,
        { n: 3, missing: 0, mean, min: mean, p50: mean, p90: mean, max: mean },
      ]),
    );
    return {
      schema: "donna.eval-report.v1",
      stage: "organize",
      dataset: { name: "organize.dev.v2", version: 1, sha256: "x", cases: 1 },
      snapshot: {},
      fingerprint: "x",
      startedAt: "2026-09-05T00:00:00.000Z",
      finishedAt: "2026-09-05T00:01:00.000Z",
      durationMs: 60000,
      cases: [
        {
          caseId: "c1",
          scores: metricMeans,
          hardFailures: [],
          latencyMs: 1000,
        },
      ],
      aggregate: {
        casesRun: 1,
        casesErrored: 0,
        externalErrors: 0,
        productErrors: 0,
        hardFailureCount: 0,
        hardFailures: [],
        metrics,
      },
      cohorts: [],
      redactionNote: "",
    } as unknown as EvalReport;
  }

  const PASSING_MEANS: Record<string, number> = {
    "organize.thought_coverage": 1,
    "organize.task_recall": 1,
    "organize.task_precision": 0.9,
    "organize.provenance_fidelity": 1,
    "organize.schema_valid": 1,
    "tasks.hard_rule": 1,
    "route.join_id_accuracy": 0.95,
    "route.mode_accuracy": 0.95,
    "mint.validator_pass": 0.95,
    "final.placement_acceptance": 0.95,
  };

  function fakePlan(): V2ExperimentPlan {
    return {
      schema: "donna.organize-v2-plan.v1",
      spec: "6.7",
      status: "locked",
      lockedAt: "2026-09-05T00:00:00.000Z",
      implementation: {
        id: "S",
        provider: "openai-compatible",
        model: "gpt-5-mini",
        contract: "donna.organize.v2",
        promptVersion: "donna.organize-prompt.v4-structured",
        promptSha256: "x",
        configPath: "x",
        configSha256: "x",
        nearDuplicateThreshold: 0.9,
        replicates: 3,
      },
      datasets: {
        dev: { path: "x", name: "organize.dev.v2", version: 1, cases: 28, sha256: "x" },
        validationV3: { path: "x", sha256: "x", lockPath: "x", lockSha256: "x", purpose: "preserved-history-not-run" },
      },
      aggregation: {
        metricMeans: "arithmetic-mean-of-three-run-means",
        latencyP90: "all-successful-case-latencies",
        bestOfThree: false,
        stopOnAnyFloorFailure: true,
      },
      floors: V2_FLOORS,
      safetyInvariants: {
        crossTenantOrForgedIdSuccesses: 0,
        duplicateBucketCreationUnderReplay: 0,
        productErrors: 0,
        hardFailures: 0,
        securityPrivacyFailures: 0,
        deterministicSuitesMustPass: true,
        eachReplicateIndependently: true,
      },
      gateMigration: {
        state: "dual-evidence-first",
        futureGate: "GATE v2: FINAL PLACEMENT >= 0.85",
        thresholdUnchanged: 0.85,
        diagnosticsRetained: [],
        requiresProductOwnerApproval: true,
      },
      rubric: {
        version: "donna.minted-name-rubric.v1",
        sha256: "x",
        diagnosticOnly: true,
        blindedReviewer: "product-owner",
      },
    };
  }

  const SUITES = {
    decisionTable: true,
    concurrencyReplay: true,
    security: true,
    filePostgresParity: true,
  };

  it("all floors pass with evaluated blinded review → ELIGIBLE", () => {
    const record = evaluateV2Eligibility({
      plan: fakePlan(),
      planSha256: "x",
      reports: [1, 2, 3].map((i) => ({ path: `S/replicate-${i}.json`, sha256: "x", report: fakeReport(PASSING_MEANS) })),
      blinded: { state: "evaluated", allFivePassRate: 0.9, reviewSha256: "x" },
      deterministicSuites: SUITES,
    });
    assert.equal(record.outcome, "ELIGIBLE FOR VALIDATION REVIEW");
    assert.equal(record.mintSpecificFailure, false);
  });

  it("without the product owner's blinded review the outcome is BLOCKED, never a pass", () => {
    const record = evaluateV2Eligibility({
      plan: fakePlan(),
      planSha256: "x",
      reports: [1, 2, 3].map((i) => ({ path: `S/replicate-${i}.json`, sha256: "x", report: fakeReport(PASSING_MEANS) })),
      blinded: { state: "awaiting-product-owner-review" },
      deterministicSuites: SUITES,
    });
    assert.equal(record.outcome, "BLOCKED — AWAITING BLINDED REVIEW");
  });

  it("mint-only failure is recorded as narrow mint-specific evidence", () => {
    const record = evaluateV2Eligibility({
      plan: fakePlan(),
      planSha256: "x",
      reports: [1, 2, 3].map((i) => ({
        path: `S/replicate-${i}.json`,
        sha256: "x",
        report: fakeReport({ ...PASSING_MEANS, "mint.validator_pass": 0.5 }),
      })),
      blinded: { state: "evaluated", allFivePassRate: 0.9, reviewSha256: "x" },
      deterministicSuites: SUITES,
    });
    assert.equal(record.outcome, "STOP — STRUCTURED ROUTING FAILED");
    assert.equal(record.mintSpecificFailure, true);
  });

  it("a routing failure is NOT mint-specific and stops", () => {
    const record = evaluateV2Eligibility({
      plan: fakePlan(),
      planSha256: "x",
      reports: [1, 2, 3].map((i) => ({
        path: `S/replicate-${i}.json`,
        sha256: "x",
        report: fakeReport({ ...PASSING_MEANS, "route.join_id_accuracy": 0.5 }),
      })),
      blinded: { state: "evaluated", allFivePassRate: 0.9, reviewSha256: "x" },
      deterministicSuites: SUITES,
    });
    assert.equal(record.outcome, "STOP — STRUCTURED ROUTING FAILED");
    assert.equal(record.mintSpecificFailure, false);
  });

  it("a hard failure in any replicate fails the safety invariant", () => {
    const reports = [1, 2, 3].map((i) => ({
      path: `S/replicate-${i}.json`,
      sha256: "x",
      report: fakeReport(PASSING_MEANS),
    }));
    reports[2]!.report.aggregate.hardFailureCount = 1;
    const record = evaluateV2Eligibility({
      plan: fakePlan(),
      planSha256: "x",
      reports,
      blinded: { state: "evaluated", allFivePassRate: 0.9, reviewSha256: "x" },
      deterministicSuites: SUITES,
    });
    assert.equal(record.outcome, "STOP — STRUCTURED ROUTING FAILED");
    assert.equal(record.replicateSafety[2]!.pass, false);
  });
});

describe("6.7 blinded review packet", () => {
  it("randomizes opaque item IDs and summarizes all-five pass rate", () => {
    const packet = buildV2ReviewPacket("plan-sha", [
      { replicate: 1, caseId: "c1", thought: "t", mintedBucketName: "Vendor Contracts", existingBucketNames: [] },
      { replicate: 2, caseId: "c2", thought: "t", mintedBucketName: "Hiring", existingBucketNames: [] },
    ]);
    assert.equal(packet.items.length, 2);
    assert.ok(/^[a-f0-9]{24}$/.test(packet.items[0]!.itemId));
    const summary = summarizeV2Review({
      decisions: packet.items.map((item, i) => ({
        itemId: item.itemId,
        decisions: {
          concise: true,
          reusable: true,
          correctTopic: true,
          distinctFromExisting: true,
          avoidsDatesAndOneOffActionWording: i === 0,
        },
      })),
    });
    assert.equal(summary.allFivePassRate, 0.5);
  });
});
