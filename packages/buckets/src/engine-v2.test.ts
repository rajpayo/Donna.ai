/**
 * StructuredBucketEngine decision-table tests (Specification 6.7 AC-4):
 * every branch with fixed vectors — Tasks override, high-agreement
 * auto-file, middle-band review, existing mismatch, new-versus-existing,
 * valid distinct immediate mint, exact collision, lexical and semantic
 * near-duplicates, first naming failure, second naming failure pending,
 * unknown ID fail-closed, invalid route, and no-fit fallback.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bucket, Embedder, Thought } from "@donna/core";
import { StructuredBucketEngine } from "./engine-v2.js";
import { FileBucketStore } from "./store.file.js";

const TUNING = { assign_threshold: 0.82, create_threshold: 0.65 };
const NEAR_DUP = 0.9;

/** Deterministic bag-of-words embedder (same scheme as the eval harness). */
class TestEmbedder implements Embedder {
  readonly modelId = "test-bow";
  readonly dimensions = 64;
  async embed(texts: string[]): Promise<number[][]> {
    const { createHash } = await import("node:crypto");
    return texts.map((text) => {
      const vector = new Array<number>(this.dimensions).fill(0);
      for (const token of text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2)) {
        const digest = createHash("sha256").update(token).digest();
        vector[digest[0]! % this.dimensions]! += 1;
        vector[digest[1]! % this.dimensions]! += 0.5;
      }
      const norm = Math.sqrt(vector.reduce((a, b) => a + b * b, 0)) || 1;
      return vector.map((x) => x / norm);
    });
  }
}

function thought(embedding: number[], extra: Partial<Thought> = {}): Thought {
  return {
    id: "th-1",
    tenantId: "t1",
    userId: "u1",
    summary: "a thought",
    text: "a thought",
    confidence: 0.9,
    provenance: {
      captureId: "c1",
      segmentIds: ["seg-0"],
      sourceText: "a thought",
      startSec: 0,
      endSec: 1,
    },
    versions: {
      organizerModel: "test",
      organizeSchemaVersion: "donna.organize.v2",
      organizePromptVersion: "donna.organize-prompt.v4-structured",
    },
    embedding,
    ...extra,
  };
}

function bucket(id: string, name: string, centroid: number[]): Bucket {
  return {
    id,
    tenantId: "t1",
    userId: "u1",
    name,
    description: `${name} bucket`,
    centroid,
    itemCount: 1,
    createdAt: "2026-09-05T00:00:00.000Z",
    origin: "auto",
  };
}

async function fixture(): Promise<{
  store: FileBucketStore;
  engine: StructuredBucketEngine;
}> {
  const dir = await mkdtemp(join(tmpdir(), "donna-engine-v2-"));
  const store = new FileBucketStore(dir);
  return {
    store,
    engine: new StructuredBucketEngine(store, TUNING, {
      nearDuplicateThreshold: NEAR_DUP,
      embedder: new TestEmbedder(),
    }),
  };
}

describe("StructuredBucketEngine decision table (Spec 6.7)", () => {
  it("Tasks override: a task-bearing thought routes to Tasks regardless of a conflicting proposal", async () => {
    const { store, engine } = await fixture();
    const atlas = bucket("b-atlas", "Project Atlas", [1, 0, 0]);
    await store.createBucket(atlas);
    const outcome = await engine.place(
      thought([1, 0, 0], {
        task: { title: "Send the deck", assigneeHint: "Priya", dueHint: "Thursday" },
      }),
      { mode: "existing", bucketId: "b-atlas" },
      [atlas],
    );
    assert.equal(outcome.kind, "filed");
    assert.equal(outcome.bucket.name, "Tasks");
    assert.equal(outcome.created, true);
    assert.equal(outcome.proposalConflict, "tasks-override");
  });

  it("agreement auto-files: model ID equals top geometry and clears assign_threshold", async () => {
    const { store, engine } = await fixture();
    const atlas = bucket("b-atlas", "Project Atlas", [1, 0, 0]);
    await store.createBucket(atlas);
    const outcome = await engine.place(
      thought([1, 0, 0]),
      { mode: "existing", bucketId: "b-atlas" },
      [atlas],
    );
    assert.equal(outcome.kind, "filed");
    assert.equal(outcome.bucket.id, "b-atlas");
    assert.equal(outcome.needsReview, false);
    const stored = await store.getBucketById("t1", "u1", "b-atlas");
    assert.equal(stored?.itemCount, 2);
  });

  it("middle band: same bucket below assign_threshold stays pending as a recommendation", async () => {
    const { store, engine } = await fixture();
    // sim([0.8,0.6],[1,0]) = 0.8 — in [0.65, 0.82).
    const atlas = bucket("b-atlas", "Project Atlas", [1, 0, 0]);
    await store.createBucket(atlas);
    const outcome = await engine.place(
      thought([0.8, 0.6, 0]),
      { mode: "existing", bucketId: "b-atlas" },
      [atlas],
    );
    assert.equal(outcome.kind, "pending");
    assert.equal(outcome.reason, "middle-band");
    assert.equal(outcome.recommendedBucketId, "b-atlas");
    // Zero side effects.
    assert.equal((await store.getBucketById("t1", "u1", "b-atlas"))?.itemCount, 1);
  });

  it("mismatch: model ID disagrees with top geometry — pending, no silent join", async () => {
    const { store, engine } = await fixture();
    const atlas = bucket("b-atlas", "Project Atlas", [1, 0, 0]);
    const ideas = bucket("b-ideas", "Product Ideas", [0, 1, 0]);
    await store.createBucket(atlas);
    await store.createBucket(ideas);
    const outcome = await engine.place(
      thought([1, 0, 0]),
      { mode: "existing", bucketId: "b-ideas" },
      [atlas, ideas],
    );
    assert.equal(outcome.kind, "pending");
    assert.equal(outcome.reason, "model-geometry-mismatch");
    const names = outcome.candidates.map((c) => c.name);
    assert.ok(names.includes("Project Atlas") && names.includes("Product Ideas"));
    assert.equal((await store.listItems("t1", "u1")).length, 0);
  });

  it("new-versus-existing: mode new while geometry clears create_threshold — pending with recommendation", async () => {
    const { store, engine } = await fixture();
    const atlas = bucket("b-atlas", "Project Atlas", [1, 0, 0]);
    await store.createBucket(atlas);
    const outcome = await engine.place(
      thought([1, 0, 0]),
      { mode: "new", name: "Atlas Updates", description: "News about Atlas." },
      [atlas],
    );
    assert.equal(outcome.kind, "pending");
    assert.equal(outcome.reason, "new-vs-existing");
    assert.equal(outcome.recommendedBucketId, "b-atlas");
  });

  it("valid distinct mint: below create_threshold, validators pass, no duplicate — create and file immediately", async () => {
    const { store, engine } = await fixture();
    const atlas = bucket("b-atlas", "Project Atlas", [1, 0, 0]);
    await store.createBucket(atlas);
    const outcome = await engine.place(
      thought([0, 0, 1]),
      { mode: "new", name: "Vendor Contracts", description: "Vendor paperwork and renewals." },
      [atlas],
    );
    assert.equal(outcome.kind, "filed");
    assert.equal(outcome.created, true);
    assert.equal(outcome.bucket.name, "Vendor Contracts");
    assert.equal((await store.listBuckets("t1", "u1")).length, 2);
  });

  it("exact canonical collision recommends the existing bucket and never auto-creates", async () => {
    const { store, engine } = await fixture();
    const existing = bucket("b-vendor", "Vendor Contracts", [0, 0, 1]);
    await store.createBucket(existing);
    const outcome = await engine.place(
      thought([0, 0.9, 0.1]), // below create_threshold vs [0,0,1]
      { mode: "new", name: "vendor  contracts", description: "Duplicate name." },
      [existing],
    );
    assert.equal(outcome.kind, "pending");
    assert.equal(outcome.reason, "possible-existing-match");
    assert.equal(outcome.recommendedBucketId, "b-vendor");
    assert.equal((await store.listBuckets("t1", "u1")).length, 1);
  });

  it("lexical containment is a near-duplicate conflict", async () => {
    const { store, engine } = await fixture();
    const existing = bucket("b-atlas", "Project Atlas", [0, 0, 1]);
    await store.createBucket(existing);
    const outcome = await engine.place(
      thought([0, 0.9, 0.1]),
      { mode: "new", name: "Project Atlas Updates", description: "Different enough?" },
      [existing],
    );
    assert.equal(outcome.kind, "pending");
    assert.equal(outcome.reason, "possible-existing-match");
  });

  it("semantic near-duplicate over descriptors uses the separate locked threshold", async () => {
    // Deterministic descriptor embedder: vendor-ish descriptors are
    // near-identical (sim ≈ 0.999 ≥ 0.90); unrelated descriptors are
    // orthogonal. Tests the threshold wiring, not a model.
    const stubEmbedder: Embedder = {
      modelId: "stub-descriptor",
      dimensions: 2,
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map((text) =>
          text.toLowerCase().includes("vendor") ? [1, 0.05] : [0, 1],
        );
      },
    };
    const dir = await mkdtemp(join(tmpdir(), "donna-engine-v2-"));
    const store = new FileBucketStore(dir);
    const engine = new StructuredBucketEngine(store, TUNING, {
      nearDuplicateThreshold: NEAR_DUP,
      embedder: stubEmbedder,
    });
    const existing = bucket("b-vendor", "Vendor Contracts", [0, 0, 1]);
    await store.createBucket(existing);
    // Thought embedding far from the centroid (below create_threshold),
    // no exact/lexical name overlap — only the semantic descriptor
    // comparison can catch this.
    const outcome = await engine.place(
      thought([0, 0.9, 0.1]),
      { mode: "new", name: "Supplier Agreements", description: "Vendor renewals and paperwork." },
      [existing],
    );
    assert.equal(outcome.kind, "pending");
    assert.equal(outcome.reason, "possible-existing-match");
    assert.equal(outcome.recommendedBucketId, "b-vendor");

    // A genuinely distinct topic below the threshold still mints.
    const distinct = await engine.place(
      thought([0, 0.9, 0.1]),
      { mode: "new", name: "Launch Readiness", description: "Launch tracking." },
      [existing],
    );
    assert.equal(distinct.kind, "filed");
    assert.equal(distinct.created, true);
  });

  it("first naming failure returns naming-failed; the retried failure persists pending", async () => {
    const { store, engine } = await fixture();
    const first = await engine.place(
      thought([0, 0, 1]),
      { mode: "new", name: "Ask Arjun by Friday", description: "One-off." },
      [],
    );
    assert.equal(first.kind, "naming-failed");
    assert.ok(first.reasons.includes("imperative-wording"));
    const second = await engine.place(
      thought([0, 0, 1]),
      { mode: "new", name: "Send deck Thursday", description: "Still one-off." },
      [],
      { namingRetried: true },
    );
    assert.equal(second.kind, "pending");
    assert.equal(second.reason, "naming-invalid");
    assert.ok(second.namingFailures !== undefined && second.namingFailures.length > 0);
    assert.equal((await store.listBuckets("t1", "u1")).length, 0);
  });

  it("unknown ID fails closed: pending unknown-id with zero placement or mint side effects", async () => {
    const { store, engine } = await fixture();
    const atlas = bucket("b-atlas", "Project Atlas", [1, 0, 0]);
    await store.createBucket(atlas);
    const outcome = await engine.place(
      thought([1, 0, 0]),
      { mode: "existing", bucketId: "b-forged-cross-scope" },
      [atlas],
    );
    assert.equal(outcome.kind, "pending");
    assert.equal(outcome.reason, "unknown-id");
    assert.equal((await store.listItems("t1", "u1")).length, 0);
    assert.equal((await store.listBuckets("t1", "u1")).length, 1);
    assert.equal((await store.getBucketById("t1", "u1", "b-atlas"))?.itemCount, 1);
  });

  it("null proposal (invalid route after escalation) persists pending with a geometry recommendation", async () => {
    const { engine } = await fixture();
    const atlas = bucket("b-atlas", "Project Atlas", [1, 0, 0]);
    const outcome = await engine.place(thought([1, 0, 0]), null, [atlas]);
    assert.equal(outcome.kind, "pending");
    assert.equal(outcome.reason, "invalid-route");
    assert.equal(outcome.recommendedBucketId, "b-atlas");
  });

  it("no-fit fallback: an empty bucket list mints a valid distinct name immediately", async () => {
    const { store, engine } = await fixture();
    const outcome = await engine.place(
      thought([1, 0, 0]),
      { mode: "new", name: "Launch Readiness", description: "Launch tracking." },
      [],
    );
    assert.equal(outcome.kind, "filed");
    assert.equal(outcome.created, true);
    assert.equal((await store.listBuckets("t1", "u1")).length, 1);
  });

  it("rejects cross-scope bucket lists", async () => {
    const { engine } = await fixture();
    const foreign = { ...bucket("b-x", "Foreign", [1, 0, 0]), userId: "u2" };
    await assert.rejects(
      engine.place(thought([1, 0, 0]), { mode: "existing", bucketId: "b-x" }, [foreign]),
      /scope/i,
    );
  });

  it("file store enforces canonical-name uniqueness (parity with PostgreSQL)", async () => {
    const { store } = await fixture();
    await store.createBucket(bucket("b-1", "Vendor Contracts", [1, 0, 0]));
    await assert.rejects(
      store.createBucket(bucket("b-2", "vendor  contracts", [0, 1, 0])),
      /canonical name/i,
    );
  });

  it("revalidateMint re-runs checks against current state (race becomes conflict)", async () => {
    const { store, engine } = await fixture();
    const clean = await engine.revalidateMint(
      thought([0, 0, 1]),
      "Vendor Contracts",
      "Vendor paperwork.",
    );
    assert.equal(clean.ok, true);
    // A concurrent mint lands first.
    await store.createBucket(bucket("b-vendor", "Vendor Contracts", [0, 0, 1]));
    const raced = await engine.revalidateMint(
      thought([0, 0, 1]),
      "Vendor Contracts",
      "Vendor paperwork.",
    );
    assert.equal(raced.ok, false);
    assert.equal(raced.conflict?.id, "b-vendor");
  });
});
