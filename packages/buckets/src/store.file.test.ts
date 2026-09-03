import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Bucket, Thought } from "@donna/core";
import { FileBucketStore } from "./store.file.js";

function bucket(tenantId: string, userId: string, id: string): Bucket {
  return {
    id,
    tenantId,
    userId,
    name: "Shared name",
    description: "Test bucket",
    centroid: [1, 0],
    itemCount: 1,
    createdAt: "2026-09-02T00:00:00.000Z",
    origin: "auto",
  };
}

describe("FileBucketStore tenant isolation", () => {
  it("updates only the requested tenant/user partition", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "donna-store-"));
    try {
      const store = new FileBucketStore(dataDir);
      await store.createBucket(bucket("tenant-a", "user-1", "same-id"));
      await store.createBucket(bucket("tenant-b", "user-1", "same-id"));

      await store.updateBucketStats(
        "tenant-a",
        "user-1",
        "same-id",
        [0, 1],
        2,
      );

      const [tenantA] = await store.listBuckets("tenant-a", "user-1");
      const [tenantB] = await store.listBuckets("tenant-b", "user-1");
      assert.deepEqual(tenantA?.centroid, [0, 1]);
      assert.equal(tenantA?.itemCount, 2);
      assert.deepEqual(tenantB?.centroid, [1, 0]);
      assert.equal(tenantB?.itemCount, 1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects path traversal in tenant and user IDs", async () => {
    const store = new FileBucketStore("/tmp/donna-store-test");

    await assert.rejects(
      store.listBuckets("../other-tenant", "user-1"),
      /Invalid tenant ID/,
    );
    await assert.rejects(
      store.listBuckets("tenant-a", "../other-user"),
      /Invalid user ID/,
    );
  });

  it("fails when a bucket is absent from the requested scope", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "donna-store-"));
    try {
      const store = new FileBucketStore(dataDir);
      await store.createBucket(bucket("tenant-a", "user-1", "bucket-1"));

      await assert.rejects(
        store.updateBucketStats(
          "tenant-b",
          "user-1",
          "bucket-1",
          [0, 1],
          2,
        ),
        /Bucket does not exist in the requested tenant\/user scope/,
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("FileBucketStore correction operations (Spec 2.3)", () => {
  function thought(id: string, embedding: number[]): Thought {
    return {
      id,
      tenantId: "tenant-a",
      userId: "user-1",
      summary: `summary ${id}`,
      text: `text ${id}`,
      confidence: 0.9,
      provenance: {
        captureId: "cap-1",
        segmentIds: ["seg-0"],
        sourceText: `text ${id}`,
        startSec: 0,
        endSec: 1,
      },
      versions: {
        organizerModel: "test",
        organizeSchemaVersion: "s",
        organizePromptVersion: "p",
      },
      embedding,
    };
  }

  it("moveItem moves the item and recomputes both buckets exactly", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "donna-store-"));
    try {
      const store = new FileBucketStore(dataDir);
      const a = { ...bucket("tenant-a", "user-1", "b-a"), name: "A" };
      const b = { ...bucket("tenant-a", "user-1", "b-b"), name: "B" };
      await store.createBucket(a);
      await store.createBucket(b);
      await store.saveItem({ thought: thought("th-1", [1, 0]), bucketId: "b-a" });
      await store.saveItem({ thought: thought("th-2", [0, 1]), bucketId: "b-a" });
      await store.saveItem({ thought: thought("th-3", [0, 1]), bucketId: "b-b" });
      // Fix stats to match members.
      await store.updateBucketStats("tenant-a", "user-1", "b-a", [0.5, 0.5], 2);
      await store.updateBucketStats("tenant-a", "user-1", "b-b", [0, 1], 1);

      await store.moveItem("tenant-a", "user-1", "th-1", "b-b");

      const items = await store.listItems("tenant-a", "user-1");
      assert.equal(items.find((i) => i.thought.id === "th-1")?.bucketId, "b-b");
      const buckets = await store.listBuckets("tenant-a", "user-1");
      const after = new Map(buckets.map((x) => [x.id, x]));
      assert.equal(after.get("b-a")?.itemCount, 1);
      assert.deepEqual(after.get("b-a")?.centroid, [0, 1]);
      assert.equal(after.get("b-b")?.itemCount, 2);
      assert.deepEqual(after.get("b-b")?.centroid, [0.5, 0.5]);

      // Idempotent no-op: moving to the current bucket changes nothing.
      await store.moveItem("tenant-a", "user-1", "th-1", "b-b");
      assert.equal((await store.listBuckets("tenant-a", "user-1")).find((x) => x.id === "b-b")?.itemCount, 2);

      // Fail closed on unknown item/bucket.
      await assert.rejects(store.moveItem("tenant-a", "user-1", "nope", "b-b"), /Thought does not exist/);
      await assert.rejects(store.moveItem("tenant-a", "user-1", "th-1", "nope"), /Target bucket does not exist/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("renameBucket and mergeBuckets behave in scope", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "donna-store-"));
    try {
      const store = new FileBucketStore(dataDir);
      await store.createBucket({ ...bucket("tenant-a", "user-1", "b-a"), name: "A" });
      await store.createBucket({ ...bucket("tenant-a", "user-1", "b-b"), name: "B" });
      await store.saveItem({ thought: thought("th-1", [1, 0]), bucketId: "b-a" });

      await store.renameBucket("tenant-a", "user-1", "b-a", "Renamed");
      assert.equal(
        (await store.listBuckets("tenant-a", "user-1")).find((x) => x.id === "b-a")?.name,
        "Renamed",
      );
      await assert.rejects(store.renameBucket("tenant-a", "user-1", "b-a", "  "), /empty/);

      await store.mergeBuckets("tenant-a", "user-1", "b-a", "b-b");
      const buckets = await store.listBuckets("tenant-a", "user-1");
      assert.equal(buckets.length, 1);
      assert.equal(buckets[0]?.id, "b-b");
      assert.equal(buckets[0]?.itemCount, 1);
      assert.deepEqual(buckets[0]?.centroid, [1, 0]);
      await assert.rejects(store.mergeBuckets("tenant-a", "user-1", "b-b", "b-b"), /itself/);
      await assert.rejects(store.mergeBuckets("tenant-a", "user-1", "gone", "b-b"), /does not exist/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("updateItem updates only the requested fields in scope", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "donna-store-"));
    try {
      const store = new FileBucketStore(dataDir);
      await store.createBucket({ ...bucket("tenant-a", "user-1", "b-a"), name: "A" });
      await store.saveItem({ thought: thought("th-1", [1, 0]), bucketId: "b-a" });

      await store.updateItem("tenant-a", "user-1", "th-1", {
        text: "edited",
        task: { title: "do it" },
      });
      let item = (await store.listItems("tenant-a", "user-1"))[0]!;
      assert.equal(item.thought.text, "edited");
      assert.equal(item.thought.task?.title, "do it");
      assert.equal(item.thought.summary, "summary th-1"); // untouched

      await store.updateItem("tenant-a", "user-1", "th-1", { task: null });
      item = (await store.listItems("tenant-a", "user-1"))[0]!;
      assert.equal(item.thought.task, undefined);

      await assert.rejects(
        store.updateItem("tenant-a", "user-2", "th-1", { text: "cross-user" }),
        /does not exist/,
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
