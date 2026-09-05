/**
 * One-time import of file-backed fixtures into PostgreSQL
 * (Specification 3.2, AC-4).
 *
 * The importer speaks to both sides through the existing ports, so any
 * source adapter can feed it. It is idempotent: captures, transcripts,
 * and items insert with ON CONFLICT DO NOTHING and buckets are created
 * only when missing, so running the import twice changes nothing and
 * produces no duplicates. Bucket stats are recomputed exactly from the
 * imported items after the load.
 */
import type {
  BucketStore,
  CaptureStore,
  TranscriptStore,
} from "@donna/core";
import type { Scope } from "./client.js";

export interface ImportStores {
  buckets: BucketStore;
  captures: CaptureStore;
  transcripts: TranscriptStore;
}

export interface ImportResult {
  buckets: number;
  captures: number;
  transcripts: number;
  items: number;
}

export async function importFileFixtures(
  source: ImportStores,
  target: ImportStores,
  scope: Scope,
): Promise<ImportResult> {
  const [buckets, items, captures] = await Promise.all([
    source.buckets.listBuckets(scope.tenantId, scope.userId),
    source.buckets.listItems(scope.tenantId, scope.userId),
    source.captures.listCaptures(scope.tenantId, scope.userId),
  ]);

  // Buckets first (items reference them). Skip names already present so
  // a re-run does not trip the per-user name uniqueness constraint.
  const existing = await target.buckets.listBuckets(scope.tenantId, scope.userId);
  const existingNames = new Set(
    existing.map((bucket) => bucket.name.trim().toLowerCase()),
  );
  const existingIds = new Set(existing.map((bucket) => bucket.id));
  let bucketsCreated = 0;
  for (const bucket of buckets) {
    if (existingIds.has(bucket.id) || existingNames.has(bucket.name.trim().toLowerCase())) {
      continue;
    }
    await target.buckets.createBucket(bucket);
    bucketsCreated += 1;
  }

  let capturesSaved = 0;
  let transcriptsSaved = 0;
  for (const capture of captures) {
    await target.captures.saveCapture(capture); // idempotent
    capturesSaved += 1;
    const transcript = await source.transcripts.getTranscript(
      scope.tenantId,
      scope.userId,
      capture.id,
    );
    if (transcript !== undefined) {
      await target.transcripts.saveTranscript(transcript); // idempotent
      transcriptsSaved += 1;
    }
  }

  let itemsSaved = 0;
  for (const item of items) {
    await target.buckets.saveItem(item); // idempotent; refreshes stats
    itemsSaved += 1;
  }

  return {
    buckets: bucketsCreated,
    captures: capturesSaved,
    transcripts: transcriptsSaved,
    items: itemsSaved,
  };
}
