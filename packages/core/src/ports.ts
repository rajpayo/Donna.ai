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
  CaptureRecord,
  CoreLoopResult,
  Provenance,
  Thought,
  Transcript,
  TranscriptRecord,
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
  /** Structured-output contract version the adapter validates against. */
  readonly schemaVersion?: string;
  /** Prompt template version the adapter renders. */
  readonly promptVersion?: string;
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
    tenantId: string,
    userId: string,
    bucketId: string,
    centroid: number[],
    itemCount: number,
  ): Promise<void>;
  saveItem(item: { thought: Thought; bucketId: string }): Promise<void>;
}

/**
 * Durable store for capture records. Every method is scoped: a record is
 * only ever read or written inside its own tenant/user partition, and a
 * stored record whose scope does not match its partition fails closed.
 */
export interface CaptureStore {
  saveCapture(record: CaptureRecord): Promise<void>;
  getCapture(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<CaptureRecord | undefined>;
  listCaptures(tenantId: string, userId: string): Promise<CaptureRecord[]>;
}

/**
 * Durable store for transcript records. Transcripts are persisted BEFORE
 * any organization result is accepted, so provenance always has a durable
 * anchor. Reads re-verify the content hash and fail closed on tampering.
 */
export interface TranscriptStore {
  saveTranscript(record: TranscriptRecord): Promise<void>;
  getTranscript(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<TranscriptRecord | undefined>;
}

/** Outcome of checking one organizer provenance proposal. */
export type ProvenanceVerification =
  | { ok: true; provenance: Provenance }
  | { ok: false; reason: string };

/**
 * Deterministic provenance verification. The LLM PROPOSES source segments;
 * the verifier checks them against the stored transcript and derives the
 * canonical sourceText/startSec/endSec from those segments. Model-generated
 * text and bounds are never trusted.
 */
export interface ProvenanceVerifier {
  verify(
    transcript: TranscriptRecord,
    proposal: { captureId: string; segmentIds: string[] },
  ): ProvenanceVerification;
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
