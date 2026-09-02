/**
 * File-backed bucket store for the MVP. One JSON file per user under
 * DONNA_DATA_DIR. Deliberately boring — the Postgres + pgvector production
 * store implements the same BucketStore port later without pipeline changes.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Bucket, BucketStore, Thought } from "@donna/core";

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
  constructor(private readonly dataDir: string) {}

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
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  async listBuckets(tenantId: string, userId: string): Promise<Bucket[]> {
    return (await this.load(tenantId, userId)).buckets;
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
    const data = await this.load(bucket.tenantId, bucket.userId);
    data.buckets.push(bucket);
    await this.save(bucket.tenantId, bucket.userId, data);
    return bucket;
  }

  async updateBucketStats(
    tenantId: string,
    userId: string,
    bucketId: string,
    centroid: number[],
    itemCount: number,
  ): Promise<void> {
    const data = await this.load(tenantId, userId);
    const bucket = data.buckets.find((candidate) => candidate.id === bucketId);
    if (!bucket) {
      throw new Error("Bucket does not exist in the requested tenant/user scope");
    }
    bucket.centroid = centroid;
    bucket.itemCount = itemCount;
    await this.save(tenantId, userId, data);
  }

  async saveItem(item: { thought: Thought; bucketId: string }): Promise<void> {
    const { tenantId, userId } = item.thought;
    const data = await this.load(tenantId, userId);
    if (!data.buckets.some((bucket) => bucket.id === item.bucketId)) {
      throw new Error("Bucket does not exist in the requested tenant/user scope");
    }
    data.items.push(item);
    await this.save(tenantId, userId, data);
  }
}
