/**
 * Pending-placement resolution (Specification 6.7 FR-8/FR-9, SR-10).
 *
 * Every review action — create, file-existing, edit-name, reject — is
 * idempotent and revalidates current scoped state atomically before any
 * write: a concurrent capture or replay can never create a duplicate
 * bucket or double-file a thought. Reject writes nothing but the
 * resolution audit. Resolved thoughts are filed through the real store so
 * bucket stats recompute exactly.
 */
import type {
  BucketStore,
  PendingPlacement,
  PendingPlacementStore,
  RetrievalIndex,
} from "@donna/core";
import { StructuredBucketEngine } from "./engine-v2.js";

export type ResolutionResult =
  | { status: "filed"; bucketName: string; created: boolean; already: boolean }
  | { status: "rejected"; already: boolean }
  | {
      status: "conflict";
      /** Human-readable name of the bucket that now collides. */
      existingName: string;
    };

export class PendingPlacementResolver {
  constructor(
    private readonly store: BucketStore,
    private readonly pending: PendingPlacementStore,
    private readonly engine: StructuredBucketEngine,
    private readonly retrievalIndex?: RetrievalIndex,
  ) {}

  /** Confirm the pending mint (optionally with an edited name). */
  async confirmCreate(
    scope: { tenantId: string; userId: string },
    id: string,
    editedName?: { name: string; description?: string },
  ): Promise<ResolutionResult> {
    const record = await this.mustGet(scope, id);
    if (record.status === "resolved") return this.replay(record);
    const alreadyFiled = await this.repairIfFiled(scope, record);
    if (alreadyFiled !== undefined) return alreadyFiled;
    const proposedName =
      editedName?.name ??
      (record.proposal?.mode === "new" ? record.proposal.name : undefined);
    const proposedDescription =
      editedName?.description ??
      (record.proposal?.mode === "new" ? record.proposal.description : undefined);
    if (proposedName === undefined || proposedDescription === undefined) {
      throw new Error("Pending placement has no new-bucket proposal to confirm");
    }
    // Atomic revalidation against CURRENT scoped state (SR-10): a race
    // becomes a conflict, never a duplicate bucket.
    const revalidated = await this.engine.revalidateMint(
      record.thought,
      proposedName,
      proposedDescription,
    );
    if (!revalidated.ok) {
      if (revalidated.conflict !== undefined) {
        return {
          status: "conflict",
          existingName: revalidated.conflict.name,
        };
      }
      throw new Error(
        `Edited name still fails validation: ${(revalidated.failures ?? []).join(", ")}`,
      );
    }
    const action = editedName !== undefined ? "edit-name" : "create";
    let bucket: Awaited<ReturnType<StructuredBucketEngine["mintAndFile"]>>["bucket"];
    try {
      bucket = (
        await this.engine.mintAndFile(
          record.thought,
          revalidated.name,
          revalidated.description,
        )
      ).bucket;
    } catch (error) {
      // A concurrent mint won the race between revalidation and creation:
      // surface a conflict (or the idempotent already-filed outcome),
      // never a duplicate bucket (SR-10).
      if (error instanceof Error && /canonical name/i.test(error.message)) {
        const repaired = await this.repairIfFiled(scope, record);
        if (repaired !== undefined) return repaired;
        const existing = await this.store.getBucketByName(
          scope.tenantId,
          scope.userId,
          revalidated.name,
        );
        return {
          status: "conflict",
          existingName: existing?.name ?? revalidated.name,
        };
      }
      throw error;
    }
    await this.store.saveItem({ thought: withBucket(record.thought, bucket.id), bucketId: bucket.id });
    await this.index(record, bucket.id);
    await this.pending.markResolved(scope.tenantId, scope.userId, id, {
      action,
      bucketId: bucket.id,
      name: revalidated.name,
      audit: editedName !== undefined ? "user-edited-name" : "user-confirmed",
    }, new Date().toISOString());
    return { status: "filed", bucketName: bucket.name, created: true, already: false };
  }

  /** File the pending thought into an existing scoped bucket. */
  async fileExisting(
    scope: { tenantId: string; userId: string },
    id: string,
    bucketName: string,
  ): Promise<ResolutionResult> {
    const record = await this.mustGet(scope, id);
    if (record.status === "resolved") return this.replay(record);
    const alreadyFiled = await this.repairIfFiled(scope, record);
    if (alreadyFiled !== undefined) return alreadyFiled;
    const bucket = await this.store.getBucketByName(
      scope.tenantId,
      scope.userId,
      bucketName,
    );
    if (bucket === undefined) {
      throw new Error(`No bucket named "${bucketName}" in this scope`);
    }
    await this.engine.fileExisting(record.thought, bucket);
    await this.store.saveItem({ thought: withBucket(record.thought, bucket.id), bucketId: bucket.id });
    await this.index(record, bucket.id);
    await this.pending.markResolved(scope.tenantId, scope.userId, id, {
      action: "file-existing",
      bucketId: bucket.id,
      audit: "user-filed-existing",
    }, new Date().toISOString());
    return { status: "filed", bucketName: bucket.name, created: false, already: false };
  }

  /** Reject the proposal: nothing is created or filed. */
  async reject(
    scope: { tenantId: string; userId: string },
    id: string,
  ): Promise<ResolutionResult> {
    const record = await this.mustGet(scope, id);
    if (record.status === "resolved") return this.replay(record);
    await this.pending.markResolved(scope.tenantId, scope.userId, id, {
      action: "reject",
      audit: "user-rejected",
    }, new Date().toISOString());
    return { status: "rejected", already: false };
  }

  /**
   * Crash/replay repair: the record is still pending but its thought is
   * already filed (a prior attempt filed and crashed before marking the
   * resolution). Mark it resolved and report the idempotent outcome —
   * never a duplicate write.
   */
  private async repairIfFiled(
    scope: { tenantId: string; userId: string },
    record: PendingPlacement,
  ): Promise<ResolutionResult | undefined> {
    const existing = await this.store.getItem(
      scope.tenantId,
      scope.userId,
      record.thought.id,
    );
    if (existing === undefined) return undefined;
    const bucket = await this.store.getBucketById(
      scope.tenantId,
      scope.userId,
      existing.bucketId,
    );
    await this.pending.markResolved(scope.tenantId, scope.userId, record.id, {
      action: "file-existing",
      bucketId: existing.bucketId,
      audit: "replayed-already-filed",
    }, new Date().toISOString());
    return {
      status: "filed",
      bucketName: bucket?.name ?? "(deleted bucket)",
      created: false,
      already: true,
    };
  }

  /** Idempotent replay of an already-resolved record. */
  private async replay(record: PendingPlacement): Promise<ResolutionResult> {
    const resolution = record.resolution!;
    if (resolution.action === "reject") {
      return { status: "rejected", already: true };
    }
    const bucket = resolution.bucketId === undefined
      ? undefined
      : await this.store.getBucketById(
          record.tenantId,
          record.userId,
          resolution.bucketId,
        );
    return {
      status: "filed",
      bucketName: bucket?.name ?? resolution.name ?? "(deleted bucket)",
      created: resolution.action === "create" || resolution.action === "edit-name",
      already: true,
    };
  }

  private async mustGet(
    scope: { tenantId: string; userId: string },
    id: string,
  ): Promise<PendingPlacement> {
    const record = await this.pending.get(scope.tenantId, scope.userId, id);
    if (record === undefined) {
      throw new Error("Pending placement does not exist in this scope");
    }
    return record;
  }

  private async index(record: PendingPlacement, bucketId: string): Promise<void> {
    if (this.retrievalIndex === undefined) return;
    const bucket = await this.store.getBucketById(
      record.tenantId,
      record.userId,
      bucketId,
    );
    if (bucket === undefined) return;
    await this.retrievalIndex.indexItem(
      { thought: withBucket(record.thought, bucketId), bucketId },
      bucket,
    );
  }
}

function withBucket(
  thought: PendingPlacement["thought"],
  bucketId: string,
): PendingPlacement["thought"] {
  return { ...thought, bucketId };
}
