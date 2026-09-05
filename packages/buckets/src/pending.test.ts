/**
 * Pending placement durability and resolution (Specification 6.7 AC-6):
 * restart survival, idempotent create/file-existing/edit-name/reject,
 * atomic revalidation on confirmation, replay and concurrency safety
 * (at most one bucket/item), and retrieval exclusion until resolved.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PendingPlacement, Thought } from "@donna/core";
import { StructuredBucketEngine } from "./engine-v2.js";
import { FilePendingPlacementStore } from "./pending-store.file.js";
import { PendingPlacementResolver } from "./pending-resolution.js";
import { FileBucketStore } from "./store.file.js";

const TUNING = { assign_threshold: 0.82, create_threshold: 0.65 };
const SCOPE = { tenantId: "t1", userId: "u1" };

function pendingThought(): Thought {
  return {
    id: "th-pending-1",
    tenantId: "t1",
    userId: "u1",
    summary: "Renew the Acme vendor contract",
    text: "Renew the Acme vendor contract",
    confidence: 0.9,
    provenance: {
      captureId: "c1",
      segmentIds: ["seg-0"],
      sourceText: "Renew the Acme vendor contract",
      startSec: 0,
      endSec: 1,
    },
    versions: {
      organizerModel: "test",
      organizeSchemaVersion: "donna.organize.v2",
      organizePromptVersion: "donna.organize-prompt.v4-structured",
    },
    embedding: [1, 0, 0],
    createdAt: "2026-09-05T00:00:00.000Z",
  };
}

function pendingRecord(id = "pp-1"): PendingPlacement {
  return {
    id,
    tenantId: "t1",
    userId: "u1",
    thought: { ...pendingThought(), id: `th-${id}` },
    proposal: { mode: "new", name: "Vendor Contracts", description: "Vendor paperwork and renewals." },
    reason: "naming-invalid",
    namingFailures: ["imperative-wording"],
    candidates: [],
    allowlistHash: "0".repeat(64),
    createdAt: "2026-09-05T00:00:00.000Z",
    status: "pending",
  };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "donna-pending-"));
  const store = new FileBucketStore(dir);
  const pending = new FilePendingPlacementStore(dir);
  const engine = new StructuredBucketEngine(store, TUNING, {
    nearDuplicateThreshold: 0.9,
  });
  const resolver = new PendingPlacementResolver(store, pending, engine);
  return { dir, store, pending, engine, resolver };
}

describe("FilePendingPlacementStore (Spec 6.7 FR-9)", () => {
  it("persists pending placements across store instances (CLI restart)", async () => {
    const { dir } = await fixture();
    await new FilePendingPlacementStore(dir).save(pendingRecord());
    // A fresh instance = a restarted CLI invocation.
    const reopened = new FilePendingPlacementStore(dir);
    const list = await reopened.list("t1", "u1", "pending");
    assert.equal(list.length, 1);
    assert.equal(list[0]!.thought.summary, "Renew the Acme vendor contract");
  });

  it("keeps partitions isolated and rejects duplicate IDs", async () => {
    const { pending } = await fixture();
    await pending.save(pendingRecord());
    await assert.rejects(pending.save(pendingRecord()), /already exists/);
    // Another partition's reads never see this scope's records.
    assert.equal(await pending.get("t1", "u2", "pp-1"), undefined);
    assert.equal((await pending.list("t1", "u2")).length, 0);
  });

  it("markResolved is idempotent and rejects conflicting replays", async () => {
    const { pending } = await fixture();
    await pending.save(pendingRecord());
    const resolution = { action: "create" as const, bucketId: "b-1", name: "Vendor Contracts", audit: "user-confirmed" };
    const first = await pending.markResolved("t1", "u1", "pp-1", resolution, "2026-09-05T01:00:00.000Z");
    assert.equal(first.status, "resolved");
    const replay = await pending.markResolved("t1", "u1", "pp-1", resolution, "2026-09-05T01:00:00.000Z");
    assert.equal(replay.status, "resolved");
    await assert.rejects(
      pending.markResolved("t1", "u1", "pp-1", { action: "reject", audit: "user-rejected" }, "2026-09-05T01:00:00.000Z"),
      /different action/,
    );
  });

  it("deleteForCapture removes only that capture's records", async () => {
    const { pending } = await fixture();
    await pending.save(pendingRecord("pp-1"));
    const other = pendingRecord("pp-2");
    other.thought = {
      ...pendingThought(),
      id: "th-other",
      provenance: { ...pendingThought().provenance, captureId: "c2" },
    };
    await pending.save(other);
    const removed = await pending.deleteForCapture("t1", "u1", "c1");
    assert.equal(removed.removed, 1);
    assert.equal((await pending.list("t1", "u1")).length, 1);
  });
});

describe("PendingPlacementResolver (Spec 6.7 AC-6)", () => {
  it("confirmCreate mints and files once; replay says already filed", async () => {
    const { store, pending, resolver } = await fixture();
    await pending.save(pendingRecord());
    const first = await resolver.confirmCreate(SCOPE, "pp-1");
    assert.deepEqual(first, { status: "filed", bucketName: "Vendor Contracts", created: true, already: false });
    assert.equal((await store.listBuckets("t1", "u1")).length, 1);
    assert.equal((await store.listItems("t1", "u1")).length, 1);
    const replay = await resolver.confirmCreate(SCOPE, "pp-1");
    assert.ok(replay.status === "filed" && replay.already);
    assert.equal((await store.listBuckets("t1", "u1")).length, 1);
    assert.equal((await store.listItems("t1", "u1")).length, 1);
  });

  it("concurrent confirmations create at most one bucket and one item", async () => {
    const { store, pending, resolver } = await fixture();
    await pending.save(pendingRecord());
    const results = await Promise.all([
      resolver.confirmCreate(SCOPE, "pp-1"),
      resolver.confirmCreate(SCOPE, "pp-1"),
      resolver.confirmCreate(SCOPE, "pp-1"),
    ]);
    const buckets = await store.listBuckets("t1", "u1");
    const items = await store.listItems("t1", "u1");
    // The invariant: at most one canonical bucket and one item, no lost
    // or double-filed thought. Losers of the race see the idempotent
    // already-filed outcome or a safe conflict — never a duplicate.
    assert.equal(buckets.length, 1);
    assert.equal(items.length, 1);
    assert.ok(results.every((r) => r.status === "filed" || r.status === "conflict"));
    assert.ok(results.some((r) => r.status === "filed"));
  });

  it("edit-name validates the edited name and files under it", async () => {
    const { store, pending, resolver } = await fixture();
    await pending.save(pendingRecord());
    const result = await resolver.confirmCreate(SCOPE, "pp-1", {
      name: "Vendor Renewals",
      description: "Vendor renewal tracking.",
    });
    assert.equal(result.status, "filed");
    assert.equal(result.bucketName, "Vendor Renewals");
    const resolved = await pending.get("t1", "u1", "pp-1");
    assert.equal(resolved?.resolution?.action, "edit-name");
    // An invalid edit fails validation and writes nothing.
    await pending.save(pendingRecord("pp-2"));
    await assert.rejects(
      resolver.confirmCreate(SCOPE, "pp-2", { name: "Ask Arjun by Friday" }),
      /still fails validation/,
    );
    assert.equal((await store.listItems("t1", "u1")).length, 1);
  });

  it("file-existing files into the named bucket; reject creates nothing", async () => {
    const { store, pending, engine, resolver } = await fixture();
    await engine.mintAndFile(pendingThought(), "Vendor Contracts", "Vendor paperwork.");
    await store.saveItem({ thought: { ...pendingThought(), id: "th-other" }, bucketId: (await store.listBuckets("t1", "u1"))[0]!.id });
    await pending.save(pendingRecord());
    const filed = await resolver.fileExisting(SCOPE, "pp-1", "Vendor Contracts");
    assert.equal(filed.status, "filed");
    assert.equal(filed.created, false);
    assert.equal((await store.listBuckets("t1", "u1")).length, 1);

    await pending.save(pendingRecord("pp-2"));
    const rejected = await resolver.reject(SCOPE, "pp-2");
    assert.deepEqual(rejected, { status: "rejected", already: false });
    const replay = await resolver.reject(SCOPE, "pp-2");
    assert.ok(replay.status === "rejected" && replay.already);
    // Rejection created nothing and filed nothing for pp-2's thought.
    assert.equal((await store.listBuckets("t1", "u1")).length, 1);
    assert.equal((await pending.get("t1", "u1", "pp-2"))?.status, "resolved");
  });

  it("a confirmation racing a concurrent mint becomes a conflict, never a duplicate", async () => {
    const { store, pending, engine, resolver } = await fixture();
    await pending.save(pendingRecord());
    // The concurrent capture mints the same canonical bucket first.
    const raced = await engine.mintAndFile(
      { ...pendingThought(), id: "th-race" },
      "Vendor Contracts",
      "Vendor paperwork and renewals.",
    );
    await store.saveItem({
      thought: { ...pendingThought(), id: "th-race" },
      bucketId: raced.bucket.id,
    });
    const result = await resolver.confirmCreate(SCOPE, "pp-1");
    assert.equal(result.status, "conflict");
    assert.equal(result.existingName, "Vendor Contracts");
    assert.equal((await store.listBuckets("t1", "u1")).length, 1);
    // The pending record stays unresolved for the user.
    assert.equal((await pending.get("t1", "u1", "pp-1"))?.status, "pending");
    // The user then files into the existing bucket.
    const filed = await resolver.fileExisting(SCOPE, "pp-1", "Vendor Contracts");
    assert.equal(filed.status, "filed");
    assert.equal((await store.listItems("t1", "u1")).length, 2);
  });

  it("crash repair: a filed-but-unmarked record resolves idempotently", async () => {
    const { store, pending, engine, resolver } = await fixture();
    const record = pendingRecord();
    await pending.save(record);
    // Simulate a crash after filing but before markResolved.
    const bucket = await engine.mintAndFile(record.thought, "Vendor Contracts", "Vendor paperwork.");
    await store.saveItem({ thought: record.thought, bucketId: bucket.bucket.id });
    const result = await resolver.confirmCreate(SCOPE, "pp-1");
    assert.equal(result.status, "filed");
    assert.equal(result.already, true);
    assert.equal((await store.listBuckets("t1", "u1")).length, 1);
    assert.equal((await store.listItems("t1", "u1")).length, 1);
    assert.equal((await pending.get("t1", "u1", "pp-1"))?.status, "resolved");
  });
});
