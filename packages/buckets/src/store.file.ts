/**
 * File-backed bucket store for the MVP. One JSON file per user under
 * DONNA_DATA_DIR. Deliberately boring — the Postgres + pgvector production
 * store implements the same BucketStore port later without pipeline changes.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bucket, BucketStore, Thought } from "@donna/core";

interface UserFile {
  buckets: Bucket[];
  items: Array<{ thought: Thought; bucketId: string }>;
}

const EMPTY: UserFile = { buckets: [], items: [] };

export class FileBucketStore implements BucketStore {
  constructor(private readonly dataDir: string) {}

  private fileFor(tenantId: string, userId: string): string {
    return join(this.dataDir, tenantId, `${userId}.json`);
  }

  private async load(tenantId: string, userId: string): Promise<UserFile> {
    try {
      const raw = await readFile(this.fileFor(tenantId, userId), "utf8");
      return JSON.parse(raw) as UserFile;
    } catch {
      return structuredClone(EMPTY);
    }
  }

  private async save(
    tenantId: string,
    userId: string,
    data: UserFile,
  ): Promise<void> {
    const file = this.fileFor(tenantId, userId);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify(data, null, 2));
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
    bucketId: string,
    centroid: number[],
    itemCount: number,
  ): Promise<void> {
    // The file store keys everything by tenant/user, so find the bucket
    // across the small demo dataset by scanning the tenant directory.
    const tenantDir = this.dataDir;
    const { readdir } = await import("node:fs/promises");
    for (const tenant of await readdir(tenantDir).catch(() => [] as string[])) {
      const tenantPath = join(tenantDir, tenant);
      for (const file of await readdir(tenantPath).catch(() => [] as string[])) {
        if (!file.endsWith(".json")) continue;
        const userId = file.slice(0, -5);
        const data = await this.load(tenant, userId);
        const bucket = data.buckets.find((b) => b.id === bucketId);
        if (bucket) {
          bucket.centroid = centroid;
          bucket.itemCount = itemCount;
          await this.save(tenant, userId, data);
          return;
        }
      }
    }
  }

  async saveItem(item: { thought: Thought; bucketId: string }): Promise<void> {
    const { tenantId, userId } = item.thought;
    const data = await this.load(tenantId, userId);
    data.items.push(item);
    await this.save(tenantId, userId, data);
  }
}
