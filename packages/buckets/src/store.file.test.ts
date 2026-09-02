import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Bucket } from "@donna/core";
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
