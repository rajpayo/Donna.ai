/**
 * File-backed bucket store for the MVP. One JSON file per user under
 * DONNA_DATA_DIR. Deliberately boring — the Postgres + pgvector production
 * store implements the same BucketStore port later without pipeline changes.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bucket, BucketStore, Thought } from "@donna/core";
import { writePrivateFile } from "@donna/file-security";
import { canonicalNameKey } from "./canonical.js";

interface UserFile {
  buckets: Bucket[];
  items: Array<{ thought: Thought; bucketId: string }>;
}

const EMPTY: UserFile = { buckets: [], items: [] };
const PARTITION_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

function assertPartitionId(kind: "tenant" | "user", value: string): void {
  if (!PARTITION_ID.test(value)) {
    throw new Error(`Invalid ${kind} ID for file-backed storage`);
  }
}

export class FileBucketStore implements BucketStore {
  /**
   * In-process per-file serialization (Spec 6.7 SR-10): load-modify-save
   * cycles for the same partition file are chained so concurrent
   * placements/confirmations in one process cannot lose a write or create
   * a duplicate bucket. Cross-process safety is the PostgreSQL adapter's
   * row locks and unique indexes.
   */
  private static locks = new Map<string, Promise<void>>();

  constructor(private readonly dataDir: string) {}

  private async withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
    const prior = FileBucketStore.locks.get(file) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((res) => {
      release = res;
    });
    FileBucketStore.locks.set(file, prior.then(() => current));
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private fileFor(tenantId: string, userId: string): string {
    assertPartitionId("tenant", tenantId);
    assertPartitionId("user", userId);
    return join(this.dataDir, tenantId, `${userId}.json`);
  }

  private async load(tenantId: string, userId: string): Promise<UserFile> {
    let raw: string;
    try {
      raw = await readFile(this.fileFor(tenantId, userId), "utf8");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return structuredClone(EMPTY);
      }
      throw error;
    }

    const parsed = JSON.parse(raw) as Partial<UserFile>;
    if (!Array.isArray(parsed.buckets) || !Array.isArray(parsed.items)) {
      throw new Error("Invalid file-backed store data");
    }
    const data = parsed as UserFile;
    if (
      data.buckets.some(
        (bucket) =>
          bucket.tenantId !== tenantId || bucket.userId !== userId,
      ) ||
      data.items.some(
        ({ thought }) =>
          thought.tenantId !== tenantId || thought.userId !== userId,
      )
    ) {
      throw new Error("Stored data does not match its tenant/user partition");
    }
    return data;
  }

  private async save(
    tenantId: string,
    userId: string,
    data: UserFile,
  ): Promise<void> {
    const file = this.fileFor(tenantId, userId);
    await writePrivateFile(file, JSON.stringify(data, null, 2));
  }

  async listBuckets(tenantId: string, userId: string): Promise<Bucket[]> {
    return (await this.load(tenantId, userId)).buckets;
  }

  async getBucketById(
    tenantId: string,
    userId: string,
    bucketId: string,
  ): Promise<Bucket | undefined> {
    return (await this.load(tenantId, userId)).buckets.find(
      (bucket) => bucket.id === bucketId,
    );
  }

  async getBucketByName(
    tenantId: string,
    userId: string,
    name: string,
  ): Promise<Bucket | undefined> {
    const wanted = name.trim().toLowerCase();
    return (await this.load(tenantId, userId)).buckets.find(
      (b) => b.name.trim().toLowerCase() === wanted,
    );
  }

  async createBucket(bucket: Bucket): Promise<Bucket> {
    return this.withLock(this.fileFor(bucket.tenantId, bucket.userId), async () => {
    const data = await this.load(bucket.tenantId, bucket.userId);
    // Spec 6.7 (architecture D): per-user canonical-name uniqueness is
    // enforced before append, with parity to the PostgreSQL
    // canonical-name key. A collision fails closed — never a duplicate.
    const key = canonicalNameKey(bucket.name);
    if (
      data.buckets.some(
        (existing) => canonicalNameKey(existing.name) === key,
      )
    ) {
      throw new Error(
        "A bucket with this canonical name already exists in the requested tenant/user scope",
      );
    }
    data.buckets.push(bucket);
    await this.save(bucket.tenantId, bucket.userId, data);
    return bucket;
    });
  }

  async updateBucketStats(
    tenantId: string,
    userId: string,
    bucketId: string,
    centroid: number[],
    itemCount: number,
  ): Promise<void> {
    return this.withLock(this.fileFor(tenantId, userId), async () => {
    const data = await this.load(tenantId, userId);
    const bucket = data.buckets.find((candidate) => candidate.id === bucketId);
    if (!bucket) {
      throw new Error("Bucket does not exist in the requested tenant/user scope");
    }
    bucket.centroid = centroid;
    bucket.itemCount = itemCount;
    await this.save(tenantId, userId, data);
    });
  }

  async saveItem(item: { thought: Thought; bucketId: string }): Promise<void> {
    const { tenantId, userId } = item.thought;
    return this.withLock(this.fileFor(tenantId, userId), async () => {
    const data = await this.load(tenantId, userId);
    if (!data.buckets.some((bucket) => bucket.id === item.bucketId)) {
      throw new Error("Bucket does not exist in the requested tenant/user scope");
    }
    // Idempotent on the thought ID (parity with the PostgreSQL
    // ON CONFLICT DO NOTHING primary key): replaying a placement write
    // never double-files a thought (Spec 6.7 SR-10).
    if (data.items.some((existing) => existing.thought.id === item.thought.id)) {
      return;
    }
    data.items.push(item);
    await this.save(tenantId, userId, data);
    });
  }

  async listItems(
    tenantId: string,
    userId: string,
  ): Promise<Array<{ thought: Thought; bucketId: string }>> {
    return (await this.load(tenantId, userId)).items;
  }

  async getItem(
    tenantId: string,
    userId: string,
    thoughtId: string,
  ): Promise<{ thought: Thought; bucketId: string } | undefined> {
    return (await this.load(tenantId, userId)).items.find(
      (item) => item.thought.id === thoughtId,
    );
  }

  async listItemsByBucket(
    tenantId: string,
    userId: string,
    bucketId: string,
  ): Promise<Array<{ thought: Thought; bucketId: string }>> {
    const data = await this.load(tenantId, userId);
    if (!data.buckets.some((bucket) => bucket.id === bucketId)) {
      throw new Error("Bucket does not exist in the requested tenant/user scope");
    }
    return data.items.filter((item) => item.bucketId === bucketId);
  }

  async listItemsInRange(
    tenantId: string,
    userId: string,
    range: { from?: string; to?: string },
  ): Promise<Array<{ thought: Thought; bucketId: string }>> {
    const items = (await this.load(tenantId, userId)).items;
    return items.filter((item) => {
      const createdAt = item.thought.createdAt;
      // Fail closed: a thought without a creation time cannot be proven
      // to be inside the requested window.
      if (createdAt === undefined) return false;
      if (range.from !== undefined && createdAt < range.from) return false;
      if (range.to !== undefined && createdAt > range.to) return false;
      return true;
    });
  }

  async deleteItemsForCapture(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<{ removed: number }> {
    return this.withLock(this.fileFor(tenantId, userId), async () => {
    const data = await this.load(tenantId, userId);
    const kept = data.items.filter(
      (item) => item.thought.provenance.captureId !== captureId,
    );
    const removed = data.items.length - kept.length;
    if (removed === 0) return { removed: 0 };
    data.items = kept;
    // Repair bucket stats: exact recompute from the surviving members.
    for (const bucket of data.buckets) {
      recomputeBucketStats(bucket, kept);
    }
    await this.save(tenantId, userId, data);
    return { removed };
    });
  }

  async moveItem(
    tenantId: string,
    userId: string,
    thoughtId: string,
    toBucketId: string,
  ): Promise<void> {
    return this.withLock(this.fileFor(tenantId, userId), async () => {
    const data = await this.load(tenantId, userId);
    const item = data.items.find((candidate) => candidate.thought.id === thoughtId);
    if (!item) {
      throw new Error("Thought does not exist in the requested tenant/user scope");
    }
    if (!data.buckets.some((bucket) => bucket.id === toBucketId)) {
      throw new Error("Target bucket does not exist in the requested tenant/user scope");
    }
    if (item.bucketId === toBucketId) return; // idempotent no-op
    item.bucketId = toBucketId;
    for (const bucket of data.buckets) {
      recomputeBucketStats(bucket, data.items);
    }
    await this.save(tenantId, userId, data);
    });
  }

  async renameBucket(
    tenantId: string,
    userId: string,
    bucketId: string,
    newName: string,
  ): Promise<void> {
    if (newName.trim().length === 0) {
      throw new Error("Bucket name must not be empty");
    }
    return this.withLock(this.fileFor(tenantId, userId), async () => {
    const data = await this.load(tenantId, userId);
    const bucket = data.buckets.find((candidate) => candidate.id === bucketId);
    if (!bucket) {
      throw new Error("Bucket does not exist in the requested tenant/user scope");
    }
    bucket.name = newName.trim();
    await this.save(tenantId, userId, data);
    });
  }

  async mergeBuckets(
    tenantId: string,
    userId: string,
    sourceBucketId: string,
    targetBucketId: string,
  ): Promise<void> {
    if (sourceBucketId === targetBucketId) {
      throw new Error("Cannot merge a bucket into itself");
    }
    return this.withLock(this.fileFor(tenantId, userId), async () => {
    const data = await this.load(tenantId, userId);
    const source = data.buckets.find((candidate) => candidate.id === sourceBucketId);
    const target = data.buckets.find((candidate) => candidate.id === targetBucketId);
    if (!source || !target) {
      throw new Error("Bucket does not exist in the requested tenant/user scope");
    }
    for (const item of data.items) {
      if (item.bucketId === sourceBucketId) item.bucketId = targetBucketId;
    }
    data.buckets = data.buckets.filter((candidate) => candidate.id !== sourceBucketId);
    recomputeBucketStats(target, data.items);
    await this.save(tenantId, userId, data);
    });
  }

  async updateItem(
    tenantId: string,
    userId: string,
    thoughtId: string,
    updates: {
      text?: string;
      summary?: string;
      task?: Thought["task"] | null;
      provenance?: Thought["provenance"];
      embedding?: number[];
    },
  ): Promise<void> {
    return this.withLock(this.fileFor(tenantId, userId), async () => {
    const data = await this.load(tenantId, userId);
    const item = data.items.find((candidate) => candidate.thought.id === thoughtId);
    if (!item) {
      throw new Error("Thought does not exist in the requested tenant/user scope");
    }
    if (updates.text !== undefined) item.thought.text = updates.text;
    if (updates.summary !== undefined) item.thought.summary = updates.summary;
    if (updates.task !== undefined) {
      if (updates.task === null) {
        delete item.thought.task;
      } else {
        item.thought.task = updates.task;
      }
    }
    if (updates.provenance !== undefined) item.thought.provenance = updates.provenance;
    if (updates.embedding !== undefined) item.thought.embedding = updates.embedding;
    await this.save(tenantId, userId, data);
    });
  }
}

/** Exact centroid/count recompute from a bucket's surviving members. */
function recomputeBucketStats(
  bucket: Bucket,
  items: Array<{ thought: Thought; bucketId: string }>,
): void {
  const members = items.filter((item) => item.bucketId === bucket.id);
  bucket.itemCount = members.length;
  const embeddings = members
    .map((item) => item.thought.embedding)
    .filter((e): e is number[] => e !== undefined);
  if (embeddings.length === 0) {
    bucket.centroid = [];
  } else {
    const dims = embeddings[0]!.length;
    bucket.centroid = Array.from({ length: dims }, (_, i) =>
      embeddings.reduce((sum, e) => sum + (e[i] ?? 0), 0) / embeddings.length,
    );
  }
}
