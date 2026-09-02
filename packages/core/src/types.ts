/**
 * Domain types for the Donna core loop.
 *
 * The loop: Capture → Transcript → Thoughts → (dynamic) Buckets → Retrieval.
 * Every organized item carries Provenance back to the exact transcript span
 * and audio window it came from — provenance is a product requirement, not
 * an implementation detail.
 */

/** Raw audio handed to the pipeline. */
export interface Capture {
  id: string;
  tenantId: string;
  userId: string;
  audioPath: string;
  capturedAt: string; // ISO 8601
  durationSec?: number;
}

/** One timed span of a transcript. */
export interface TranscriptSegment {
  id: string;
  text: string;
  startSec: number;
  endSec: number;
}

export interface Transcript {
  captureId: string;
  text: string;
  segments: TranscriptSegment[];
  language?: string;
  /** Model that produced this transcript, e.g. "gpt-4o-transcribe". */
  model: string;
}

/** Trace back to the exact spoken words. */
export interface Provenance {
  captureId: string;
  segmentIds: string[];
  /** Verbatim words this item was distilled from. */
  sourceText: string;
  startSec: number;
  endSec: number;
}

/**
 * A task candidate extracted from speech. Never acted on directly —
 * agents (see docs/roadmap-agents.md) pick these up from the Tasks bucket
 * and route them through a confirm/reject loop first.
 */
export interface TaskCandidate {
  title: string;
  assigneeHint?: string;
  dueHint?: string;
}

/** A single atomic thought distilled from the stream. */
export interface Thought {
  id: string;
  tenantId: string;
  userId: string;
  /** One-sentence clean restatement. */
  summary: string;
  /** Verbatim-ish cleaned text of the thought. */
  text: string;
  /** Organizer's self-reported confidence, 0..1. */
  confidence: number;
  task?: TaskCandidate;
  provenance: Provenance;
  embedding?: number[];
  /** Filled by the bucket engine. */
  bucketId?: string;
}

/**
 * A dynamic topic bucket. Buckets are created on demand when a thought
 * doesn't fit any existing bucket — never from a fixed taxonomy.
 */
export interface Bucket {
  id: string;
  tenantId: string;
  userId: string;
  name: string;
  /** One-line description of what belongs here, written at creation time. */
  description: string;
  /** Running centroid of member embeddings; used for assignment. */
  centroid: number[];
  itemCount: number;
  createdAt: string;
  /** Buckets the system created start as "auto"; a user can "pin" them. */
  origin: "auto" | "seeded" | "pinned";
}

/** The persisted result: a thought placed in a bucket. */
export interface OrganizedItem {
  thought: Thought;
  bucket: Bucket;
  /** True when assignment was below the high-confidence threshold. */
  needsReview: boolean;
}

/** End-to-end result of one capture through the loop. */
export interface CoreLoopResult {
  capture: Capture;
  transcript: Transcript;
  items: OrganizedItem[];
  bucketsCreated: Bucket[];
  metrics: {
    sttLatencyMs: number;
    organizeLatencyMs: number;
    embedLatencyMs: number;
    totalLatencyMs: number;
    /** USD, when the provider reports usage; else NaN. */
    estimatedCostUsd: number;
  };
}
