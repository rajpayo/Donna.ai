/**
 * donna.organize.v2 contract tests (Specification 6.7 AC-1/AC-2):
 * exactly one placement branch, preservation of all v1 content fields,
 * rejection of every forbidden join/mint combination and ID-bearing new
 * name, strict unknown field/action rejection, identical allowlist
 * rendering with and without context, and no label/scope leakage.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ContextPacket } from "@donna/core";
import {
  buildNamingPrompt,
  buildOrganizePromptV2,
  nameContainsIdReference,
  namingOutputSchema,
  organizeOutputSchema,
  organizeOutputSchemaV2,
} from "./organize-schema.js";

const PROVENANCE = {
  segmentIds: ["seg-0"],
  sourceText: "hello",
  startSec: 0,
  endSec: 1,
};

function thought(placement: unknown, extra: Record<string, unknown> = {}) {
  return {
    summary: "s",
    text: "t",
    confidence: 0.9,
    provenance: PROVENANCE,
    placement,
    ...extra,
  };
}

const ALLOWLIST = [
  { id: "eval-b-01-project-atlas", name: "Project Atlas", description: "Atlas work." },
  { id: "eval-b-01-tasks", name: "Tasks", description: "Commitments." },
];

describe("donna.organize.v2 schema (AC-1)", () => {
  it("accepts exactly one existing branch and preserves v1 fields", () => {
    const parsed = organizeOutputSchemaV2.parse({
      thoughts: [
        thought(
          { mode: "existing", bucketId: "eval-b-01-project-atlas" },
          { task: { title: "Send deck", assigneeHint: "Priya", dueHint: "Thursday" } },
        ),
      ],
    });
    const t = parsed.thoughts[0]!;
    assert.equal(t.placement.mode, "existing");
    assert.equal(t.summary, "s");
    assert.equal(t.task?.assigneeHint, "Priya");
    assert.equal(t.provenance.segmentIds[0], "seg-0");
  });

  it("accepts exactly one new branch", () => {
    const parsed = organizeOutputSchemaV2.parse({
      thoughts: [thought({ mode: "new", name: "Vendor Contracts", description: "Renewals." })],
    });
    assert.equal(parsed.thoughts[0]!.placement.mode, "new");
  });

  it("rejects zero branches, unknown route actions, and unknown fields", () => {
    assert.throws(() =>
      organizeOutputSchemaV2.parse({ thoughts: [{ summary: "s", text: "t", confidence: 0.5, provenance: PROVENANCE }] }),
    );
    assert.throws(() =>
      organizeOutputSchemaV2.parse({ thoughts: [thought({ mode: "maybe", bucketId: "x" })] }),
    );
    assert.throws(() =>
      organizeOutputSchemaV2.parse({
        thoughts: [thought({ mode: "existing", bucketId: "x", tenantId: "evil" })],
      }),
    );
    assert.throws(() =>
      organizeOutputSchemaV2.parse({
        thoughts: [thought({ mode: "new", name: "N", description: "D", threshold: 0.1 })],
      }),
    );
  });

  it("rejects joins carrying new-name fields and mints carrying an existing ID", () => {
    assert.throws(() =>
      organizeOutputSchemaV2.parse({
        thoughts: [thought({ mode: "existing", bucketId: "x", name: "Vendor Contracts" })],
      }),
    );
    assert.throws(() =>
      organizeOutputSchemaV2.parse({
        thoughts: [thought({ mode: "new", name: "N", description: "D", bucketId: "x" })],
      }),
    );
  });

  it("rejects empty required values", () => {
    assert.throws(() =>
      organizeOutputSchemaV2.parse({ thoughts: [thought({ mode: "existing", bucketId: "" })] }),
    );
    assert.throws(() =>
      organizeOutputSchemaV2.parse({ thoughts: [thought({ mode: "new", name: "", description: "d" })] }),
    );
  });

  it("flags ID-bearing new names (adapter-level rejection)", () => {
    assert.ok(nameContainsIdReference("eval-b-01-project-atlas", ALLOWLIST.map((o) => o.id)));
    assert.ok(
      nameContainsIdReference(
        "bucket:45ce0675-1234-1234-1234-123456789abc",
        ALLOWLIST.map((o) => o.id),
      ),
    );
    assert.ok(
      nameContainsIdReference(
        "45ce0675-1234-1234-1234-123456789abc",
        ALLOWLIST.map((o) => o.id),
      ),
    );
    assert.ok(!nameContainsIdReference("Vendor Contracts", ALLOWLIST.map((o) => o.id)));
  });

  it("keeps the v1 schema byte-compatible for historical reports and rollback", () => {
    const parsed = organizeOutputSchema.parse({
      thoughts: [
        {
          summary: "s",
          text: "t",
          confidence: 0.5,
          suggestedBucket: "Project Atlas",
          provenance: PROVENANCE,
        },
      ],
    });
    assert.equal(parsed.thoughts[0]!.suggestedBucket, "Project Atlas");
  });
});

describe("v2 prompt rendering (AC-2, FR-2)", () => {
  const segments = [{ id: "seg-0", startSec: 0, endSec: 1, text: "hello" }];

  it("renders the full ID/name/description allowlist identically with and without context", () => {
    const withoutContext = buildOrganizePromptV2("hello", segments, ALLOWLIST);
    const packet: ContextPacket = {
      id: "pkt-1",
      tenantId: "eval-tenant",
      userId: "eval-user",
      createdAt: "2026-09-05T00:00:00.000Z",
      degraded: false,
      degradedReasons: [],
      elements: [
        {
          sourceId: "mem-1",
          sourceKind: "memory",
          trust: "trusted-user-settings",
          text: "Prefers short summaries",
          asOf: "2026-09-05T00:00:00.000Z",
          tokens: 5,
        },
        {
          sourceId: "cap-1",
          sourceKind: "capture",
          trust: "untrusted-retrieved",
          text: "Earlier note excerpt",
          asOf: "2026-09-05T00:00:00.000Z",
          tokens: 5,
        },
      ],
      budgets: {
        maxTokens: 100,
        maxItems: 5,
        recentCaptures: 1,
        maxMemories: 1,
        maxBucketSummaries: 1,
        maxCorrectionExamples: 0,
        maxExternalSnippets: 0,
      },
      totals: { tokens: 10, items: 2, truncated: 0 },
    };
    const withContext = buildOrganizePromptV2("hello", segments, ALLOWLIST, packet);
    for (const option of ALLOWLIST) {
      const line = `- id: "${option.id}" — "${option.name}": ${option.description}`;
      assert.ok(withoutContext.includes(line), "no-context branch missing allowlist entry");
      assert.ok(withContext.includes(line), "context branch missing allowlist entry");
    }
    // Memory/retrieved context stays in separate labeled sections.
    assert.ok(withContext.includes("TRUSTED USER SETTINGS"));
    assert.ok(withContext.includes("RETRIEVED CONTEXT"));
    assert.ok(!withoutContext.includes("RETRIEVED CONTEXT"));
  });

  it("carries no tenant/user/tool/model/threshold or expected-label fields", () => {
    const prompt = buildOrganizePromptV2("hello", segments, ALLOWLIST);
    // Structured field names / label carriers must never appear. (The
    // policy's own prohibition sentence is prose, not a label field.)
    for (const forbidden of [
      "tenantId",
      "userId",
      '"expected"',
      "expected.bucket",
      "bucketOrigin",
      "bucket_acceptance",
      "assign_threshold",
      "create_threshold",
      "near_duplicate",
    ]) {
      assert.ok(!prompt.includes(forbidden), `prompt leaks ${forbidden}`);
    }
  });

  it("forbids IDs in new names in the policy text", () => {
    const prompt = buildOrganizePromptV2("hello", segments, ALLOWLIST);
    assert.ok(/never appear in new-bucket names/.test(prompt));
  });
});

describe("isolated naming contract (FR-6)", () => {
  it("validates name + description only, strictly", () => {
    assert.deepEqual(
      namingOutputSchema.parse({ name: "Vendor Contracts", description: "Renewals." }),
      { name: "Vendor Contracts", description: "Renewals." },
    );
    assert.throws(() =>
      namingOutputSchema.parse({ name: "N", description: "D", summary: "rewrite" }),
    );
  });

  it("the naming prompt carries immutable inputs and validator reasons, never labels", () => {
    const prompt = buildNamingPrompt({
      summary: "Renew the Acme contract",
      text: "Renew the Acme contract",
      task: { title: "Renew Acme", assigneeHint: "Priya" },
      allowlist: ALLOWLIST,
      invalidReasons: ["imperative-wording"],
    });
    assert.ok(prompt.includes("imperative-wording"));
    assert.ok(prompt.includes("Renew the Acme contract"));
    assert.ok(!prompt.includes("expected"));
    assert.ok(!prompt.includes("bucketOrigin"));
  });
});
