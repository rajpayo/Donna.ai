import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Bucket, BucketStore, Thought } from "@donna/core";
import { BucketEngine, TASKS_BUCKET } from "./engine.js";

/** In-memory store for tests. */
class MemStore implements BucketStore {
  buckets: Bucket[] = [];
  items: Array<{ thought: Thought; bucketId: string }> = [];

  async listBuckets(): Promise<Bucket[]> {
    return this.buckets;
  }
  async getBucketByName(_t: string, _u: string, name: string): Promise<Bucket | undefined> {
    return this.buckets.find((b) => b.name === name);
  }
  async createBucket(bucket: Bucket): Promise<Bucket> {
    this.buckets.push(bucket);
    return bucket;
  }
  async updateBucketStats(
    tenantId: string,
    userId: string,
    id: string,
    centroid: number[],
    itemCount: number,
  ): Promise<void> {
    const b = this.buckets.find(
      (x) =>
        x.tenantId === tenantId && x.userId === userId && x.id === id,
    );
    if (b) {
      b.centroid = centroid;
      b.itemCount = itemCount;
    }
  }
  async saveItem(item: { thought: Thought; bucketId: string }): Promise<void> {
    this.items.push(item);
  }
  async listItems(): Promise<Array<{ thought: Thought; bucketId: string }>> {
    return this.items;
  }
  async deleteItemsForCapture(
    _t: string,
    _u: string,
    captureId: string,
  ): Promise<{ removed: number }> {
    const before = this.items.length;
    this.items = this.items.filter(
      (item) => item.thought.provenance.captureId !== captureId,
    );
    return { removed: before - this.items.length };
  }
}

function thought(embedding: number[], withTask = false): Thought {
  return {
    id: Math.random().toString(36).slice(2),
    tenantId: "t",
    userId: "u",
    summary: "test thought",
    text: "test thought text",
    confidence: 0.9,
    ...(withTask ? { task: { title: "do the thing" } } : {}),
    provenance: {
      captureId: "c",
      segmentIds: ["seg-0"],
      sourceText: "test thought text",
      startSec: 0,
      endSec: 1,
    },
    versions: {
      organizerModel: "test-organizer",
      organizeSchemaVersion: "test-schema",
      organizePromptVersion: "test-prompt",
    },
    embedding,
  };
}

const TUNING = { assign_threshold: 0.82, create_threshold: 0.65 };

describe("BucketEngine", () => {
  it("creates a new bucket when nothing exists", async () => {
    const store = new MemStore();
    const engine = new BucketEngine(store, TUNING);
    const placement = await engine.place(
      thought([1, 0, 0]),
      { newBucketName: "Hiring", newBucketDescription: "Hiring plans" },
      [],
    );
    assert.equal(placement.created, true);
    assert.equal(placement.bucket.name, "Hiring");
    assert.equal(store.buckets.length, 1);
  });

  it("assigns to an existing bucket on high similarity", async () => {
    const store = new MemStore();
    const engine = new BucketEngine(store, TUNING);
    const first = await engine.place(thought([1, 0, 0]), { newBucketName: "Hiring" }, []);
    const second = await engine.place(thought([0.99, 0.01, 0]), {}, store.buckets);
    assert.equal(second.created, false);
    assert.equal(second.bucket.id, first.bucket.id);
    assert.equal(store.buckets.length, 1);
  });

  it("creates a second bucket for a dissimilar thought", async () => {
    const store = new MemStore();
    const engine = new BucketEngine(store, TUNING);
    await engine.place(thought([1, 0, 0]), { newBucketName: "Hiring" }, []);
    const placement = await engine.place(
      thought([0, 1, 0]),
      { newBucketName: "Investor Updates" },
      store.buckets,
    );
    assert.equal(placement.created, true);
    assert.equal(store.buckets.length, 2);
  });

  it("forces task thoughts into the Tasks bucket, creating it on demand", async () => {
    const store = new MemStore();
    const engine = new BucketEngine(store, TUNING);
    const placement = await engine.place(thought([0, 0, 1], true), {}, []);
    assert.equal(placement.bucket.name, TASKS_BUCKET.name);
    assert.equal(placement.created, true);

    // A second task joins the same bucket even if the organizer suggested elsewhere.
    const again = await engine.place(
      thought([0, 0.9, 0.1], true),
      { newBucketName: "Random" },
      store.buckets,
    );
    assert.equal(again.bucket.name, TASKS_BUCKET.name);
    assert.equal(again.created, false);
    assert.equal(store.buckets.filter((b) => b.name === TASKS_BUCKET.name).length, 1);
  });

  it("joins an existing bucket when the proposed new-bucket name collides, even below threshold", async () => {
    const store = new MemStore();
    const engine = new BucketEngine(store, TUNING);
    await engine.place(thought([1, 0, 0]), { newBucketName: "Onboarding improvements" }, []);

    // Dissimilar embedding (sim ≈ 0.32, below create_threshold) but the
    // organizer proposed the SAME bucket name — join, never duplicate.
    const placement = await engine.place(
      thought([0.3, 0.9, 0]),
      { newBucketName: " onboarding improvements " },
      store.buckets,
    );
    assert.equal(placement.created, false);
    assert.equal(placement.bucket.name, "Onboarding improvements");
    assert.equal(placement.needsReview, true);
    assert.equal(store.buckets.length, 1);
    assert.equal(store.buckets[0]!.itemCount, 2);
  });

  it("still mints a new bucket when the proposed name does not collide", async () => {
    const store = new MemStore();
    const engine = new BucketEngine(store, TUNING);
    await engine.place(thought([1, 0, 0]), { newBucketName: "Hiring" }, []);
    const placement = await engine.place(
      thought([0.3, 0.9, 0]),
      { newBucketName: "Investor Updates" },
      store.buckets,
    );
    assert.equal(placement.created, true);
    assert.equal(store.buckets.length, 2);
  });

  it("rejects buckets from a different tenant or user", async () => {
    const store = new MemStore();
    const engine = new BucketEngine(store, TUNING);
    await engine.place(thought([1, 0, 0]), { newBucketName: "Hiring" }, []);

    const otherTenantThought = {
      ...thought([1, 0, 0]),
      tenantId: "other-tenant",
    };
    await assert.rejects(
      engine.place(otherTenantThought, {}, store.buckets),
      /Bucket scope does not match thought scope/,
    );
  });
});
