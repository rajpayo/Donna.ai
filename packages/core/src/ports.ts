/**
 * Ports — the swappable interfaces between the pipeline and the outside world.
 *
 * Every stage of the loop depends only on these interfaces. Providers
 * (packages/providers) implement them; the model registry wires them up from
 * models.config.yaml. To swap a model — or an entire vendor — you change
 * config or add one adapter file. The pipeline never changes.
 *
 * This is also what makes the future agent layer possible without rework:
 * agents subscribe to bucket events and use the same ports.
 */
import type {
  Bucket,
  Capture,
  CoreLoopResult,
  Thought,
  Transcript,
} from "./types.js";

export interface Transcriber {
  readonly modelId: string;
  transcribe(capture: Capture): Promise<Transcript>;
}

/** Structured organization output the organizer must produce. */
export interface OrganizeOutput {
  thoughts: Array<{
    summary: string;
    text: string;
    confidence: number;
    /** Name of an existing bucket the organizer believes this belongs to. */
    suggestedBucket?: string;
    /** Name for a new bucket when nothing existing fits. */
    newBucketName?: string;
    /** One-line description for a proposed new bucket. */
    newBucketDescription?: string;
    task?: { title: string; assigneeHint?: string; dueHint?: string };
    provenance: {
      segmentIds: string[];
      sourceText: string;
      startSec: number;
      endSec: number;
    };
  }>;
}

export interface Organizer {
  readonly modelId: string;
  /**
   * Distill a transcript into atomic thoughts. `existingBuckets` is the
   * user's current bucket list (name + description) so the model can prefer
   * reuse over creation.
   */
  organize(
    transcript: Transcript,
    existingBuckets: Array<Pick<Bucket, "name" | "description">>,
  ): Promise<OrganizeOutput>;
}

export interface Embedder {
  readonly modelId: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface BucketStore {
  listBuckets(tenantId: string, userId: string): Promise<Bucket[]>;
  getBucketByName(
    tenantId: string,
    userId: string,
    name: string,
  ): Promise<Bucket | undefined>;
  createBucket(bucket: Bucket): Promise<Bucket>;
  /** Persist the new centroid and item count after an item joins. */
  updateBucketStats(
    bucketId: string,
    centroid: number[],
    itemCount: number,
  ): Promise<void>;
  saveItem(item: { thought: Thought; bucketId: string }): Promise<void>;
}

/** Telemetry sink — cost/latency per stage, for cost-per-successful-loop. */
export interface EventSink {
  emit(event: {
    name: string;
    tenantId: string;
    userId: string;
    attrs?: Record<string, string | number | boolean>;
  }): void;
}

/** The composed pipeline itself. */
export interface CoreLoop {
  run(capture: Capture): Promise<CoreLoopResult>;
}
