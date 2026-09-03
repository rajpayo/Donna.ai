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

/**
 * The durable, persisted form of a capture. Every derived record
 * (transcript, thought, memory) anchors back to this. The content hash is
 * SHA-256 over the captured audio bytes, hex-encoded.
 */
export interface CaptureRecord {
  id: string;
  tenantId: string;
  userId: string;
  /** SHA-256 of the source audio bytes, hex. */
  contentHash: string;
  capturedAt: string; // ISO 8601
  durationSec?: number;
  /** Set once the original audio is deleted or expires (Spec 1.3). */
  audioDeletedAt?: string;
}

/**
 * The persisted form of a transcript. Stored BEFORE any organization
 * result is accepted, so provenance always has a durable anchor. The
 * content hash covers the canonical transcript content and is re-verified
 * on every read — tampering fails closed.
 */
export interface TranscriptRecord {
  captureId: string;
  tenantId: string;
  userId: string;
  text: string;
  segments: TranscriptSegment[];
  language?: string;
  /** Model that produced this transcript, e.g. "gpt-4o-transcribe". */
  model: string;
  /** SHA-256 over the canonical transcript content, hex. */
  contentHash: string;
  createdAt: string; // ISO 8601
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

/**
 * Trace back to the exact spoken words. On persisted thoughts these values
 * are CANONICAL: derived from the stored transcript segments named by
 * segmentIds, never trusted from model output.
 */
export interface Provenance {
  captureId: string;
  segmentIds: string[];
  /** Verbatim words this item was distilled from. */
  sourceText: string;
  startSec: number;
  endSec: number;
}

/** Model/prompt/schema versions that produced a derived record. */
export interface DerivationVersions {
  /** Organizer model that produced the accepted output. */
  organizerModel: string;
  /** Structured-output contract version the output was validated against. */
  organizeSchemaVersion: string;
  /** Prompt template version used for the accepted output. */
  organizePromptVersion: string;
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
  /** Versions of the organizer lane that produced this thought. */
  versions: DerivationVersions;
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

/**
 * Append-only audit record for privacy lifecycle operations (Spec 1.3).
 * Deliberately non-content: operation, scope, identifiers, outcome, and
 * machine-readable detail tokens only — never audio, transcript text, key
 * material, or personal data.
 */
export interface AuditEntry {
  /** ISO 8601 time of the operation. */
  at: string;
  op:
    | "audio.store"
    | "audio.delete"
    | "audio.expire"
    | "capture.export"
    | "capture.delete";
  tenantId: string;
  userId: string;
  captureId?: string;
  result: "ok" | "error";
  /** Non-content detail token, e.g. "expired", "already-deleted". */
  detail?: string;
}

/* ------------------------------------------------------------------ */
/* Specification 2.1 — private memory domain                           */
/* ------------------------------------------------------------------ */

/**
 * The four memory layers. Working memory is bound to a session and dies
 * with it; episodic memory records captures, thoughts, decisions, and
 * outcomes; semantic memory holds confirmed facts, preferences, vocabulary,
 * people, and recurring themes; procedural memory holds corrections and
 * organization/action preferences.
 */
export type MemoryLayer = "working" | "episodic" | "semantic" | "procedural";

/**
 * Lifecycle status of a durable memory. Only `confirmed` records are ever
 * served as context. `proposed` memory lives in a separate quarantined
 * proposal record (MemoryProposal) until the user visibly approves it.
 */
export type MemoryStatus = "confirmed" | "superseded" | "expired";

/**
 * A link from a memory back to a source record it was derived from, with
 * the reason the memory exists (FR-2). `captureId` is carried whenever the
 * source derives from a capture so capture deletion can find every
 * dependent memory without consulting other stores (AC-4).
 */
export interface MemorySource {
  kind:
    | "capture"
    | "transcript"
    | "thought"
    | "correction"
    | "explicit-statement"
    | "session";
  /** Stable identifier of the source record within its kind. */
  id: string;
  /** Set when the source record derives from a capture. */
  captureId?: string;
  /** Why this memory exists, in the user's own terms. */
  reason: string;
}

/**
 * A durable private memory. Durable memory comes into existence in exactly
 * two ways (FR-1): the user explicitly states it (`origin: "explicit"`), or
 * the user visibly approves a quarantined proposal (`origin: "approved"`).
 * Conflicting information is never silently overwritten — it is resolved by
 * an explicit supersession that retires the old record (FR-3).
 */
export interface MemoryRecord {
  id: string;
  tenantId: string;
  userId: string;
  layer: MemoryLayer;
  status: MemoryStatus;
  /** How the memory came to exist: explicitly stated or approved from a proposal. */
  origin: "explicit" | "approved";
  /** The memory content itself, e.g. "Prefers short bullet summaries". */
  text: string;
  /** Category within the layer, e.g. "preference", "fact", "vocabulary", "person", "theme". */
  kind: string;
  /**
   * Normalized subject key (e.g. "preference:summary-style") used for
   * deterministic conflict detection — two confirmed memories with the same
   * subject but different text are a conflict.
   */
  subject: string;
  /** Confidence 0..1. Explicit statements default to 1. */
  confidence: number;
  sources: MemorySource[];
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  /** ISO time after which the memory is no longer served. Working memory always has one. */
  expiresAt?: string;
  /** Session scope for working memory (FR-4). */
  sessionId?: string;
  /** Set when this record was retired by an explicit supersession. */
  supersededBy?: string;
  supersededAt?: string;
}

/**
 * An inferred memory candidate, quarantined from confirmed memory. A
 * proposal never influences context until the user visibly approves it
 * (FR-1); rejecting it removes it from consideration permanently (AC-3).
 */
export interface MemoryProposal {
  id: string;
  tenantId: string;
  userId: string;
  /** Target layer once approved — semantic or procedural for inferred memory. */
  layer: MemoryLayer;
  text: string;
  kind: string;
  subject: string;
  confidence: number;
  sources: MemorySource[];
  /** What inferred this proposal (model/pipeline identity and version). */
  proposedBy: { model: string; version: string };
  createdAt: string; // ISO 8601
  status: "pending" | "approved" | "rejected";
  resolvedAt?: string;
}

/**
 * Append-only memory lifecycle event (FR-3). Deliberately non-content:
 * identifiers, event type, and machine-readable detail tokens only — never
 * memory text or personal data.
 */
export interface MemoryEvent {
  at: string; // ISO 8601
  type:
    | "stated"
    | "proposed"
    | "approved"
    | "rejected"
    | "conflict"
    | "superseded"
    | "forgotten"
    | "expired"
    | "source-removed";
  tenantId: string;
  userId: string;
  memoryId?: string;
  proposalId?: string;
  /** Non-content detail token, e.g. "by=<memoryId>", "source=thought:<id>". */
  detail?: string;
}

/**
 * An explicit, auditable consent decision for one specific processing
 * purpose. Records are append-only and the latest record for a purpose
 * decides: `granted: true` is a grant, `granted: false` is a revocation.
 * Persisting anything under a purpose without an active grant fails closed.
 */
export interface ConsentRecord {
  id: string;
  tenantId: string;
  userId: string;
  /** What is consented to, e.g. "emotion.persist" (Spec 2.4). */
  purpose: string;
  granted: boolean;
  /** When this decision took effect (ISO 8601). */
  grantedAt: string;
  /** How consent was captured, e.g. "cli:consent grant". */
  channel: string;
}

/**
 * A bounded interaction window. Working memory — and by default emotional
 * snapshots (Spec 2.4) — live and die with the session (FR-4).
 */
export interface Session {
  id: string;
  tenantId: string;
  userId: string;
  startedAt: string; // ISO 8601
  /** ISO time at which the session and its working memory expire. */
  expiresAt: string;
  endedAt?: string;
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
