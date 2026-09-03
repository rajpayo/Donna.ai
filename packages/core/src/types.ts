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
  /**
   * Optional session binding (Spec 2.4): when present, session-scoped
   * working memory and tentative emotion/intent context apply. Without a
   * session, no emotional context is inferred or stored.
   */
  session?: { id: string; expiresAt: string };
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
  /**
   * ISO 8601 creation time of this thought record (Specification 3.1):
   * the basis for time-filtered reads and recency ranking. Records
   * persisted before Specification 3.1 may lack it; time-filtered reads
   * fail closed and exclude them.
   */
  createdAt?: string;
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

/* ------------------------------------------------------------------ */
/* Specification 2.3 — correction-driven personalization               */
/* ------------------------------------------------------------------ */

/**
 * The immutable correction event types. A correction is something the user
 * changed by hand: it is first-class learning input and evaluation data,
 * never a silent rewrite of history (FR-1).
 */
export type CorrectionType =
  | "bucket.move"
  | "bucket.merge"
  | "bucket.rename"
  | "thought.edit"
  | "thought.split"
  | "thought.merge"
  | "task.add"
  | "task.remove"
  | "provenance.correct"
  | "memory.decision"
  | "retrieval.relevance";

/**
 * One immutable correction event. The payload is user-authored and always
 * treated as untrusted content (SR-2). Events are captured `pending`,
 * influence later decisions only after explicit acceptance (FR-3), and
 * their application is idempotent (SR-3). `contradictedBy` records when a
 * later accepted correction overrode this one (adherence tracking).
 */
export interface CorrectionEvent {
  id: string;
  tenantId: string;
  userId: string;
  type: CorrectionType;
  createdAt: string; // ISO 8601
  /** What the correction targets. */
  target: {
    kind: "thought" | "bucket" | "memory" | "proposal" | "capture" | "retrieval";
    id: string;
  };
  /**
   * Type-specific data, e.g. bucket.move: { fromBucketId, toBucketId,
   * thoughtSummary }. String-valued only; untrusted content.
   */
  payload: Record<string, string>;
  /** Source links — every correction is source-linked. */
  sources: MemorySource[];
  status: "pending" | "accepted" | "rejected";
  resolvedAt?: string;
  /** Set once the correction's effects have been applied (idempotency marker). */
  appliedAt?: string;
  /** Set when a later accepted correction contradicted this one. */
  contradictedBy?: string;
  /** Set when this correction was promoted to a shared golden case (consented). */
  sharedAt?: string;
  /** Adherence counters: how often the system followed/contradicted this correction. */
  followedCount: number;
  contradictedCount: number;
}

/* ------------------------------------------------------------------ */
/* Specification 2.2 — context assembly                                */
/* ------------------------------------------------------------------ */

/**
 * Trust tier of a context element. The organizer prompt renders each tier
 * in its own clearly-labeled section: system policy (code-only) first,
 * then trusted user settings, then untrusted retrieved content. Retrieved
 * content is data, never executable instruction (SR-1).
 */
export type ContextTrust = "trusted-user-settings" | "untrusted-retrieved";

/**
 * One attributed element of an assembled context packet. Every element
 * carries its source ID and freshness so the product owner can trace
 * exactly what influenced an organize request (AC-5).
 */
export interface ContextElement {
  /** Stable source identifier (memory ID, bucket ID, capture ID, correction ID). */
  sourceId: string;
  sourceKind: "memory" | "bucket" | "capture" | "correction";
  trust: ContextTrust;
  /** The rendered text of the element. */
  text: string;
  /** ISO 8601 freshness of the underlying record. */
  asOf: string;
  /** Deterministic token estimate (chars/4 of the rendered line). */
  tokens: number;
  /**
   * Present on correction-example elements (Spec 2.3): lets the pipeline
   * measure whether placement followed or contradicted the correction.
   */
  correction?: { correctionId: string; preferredBucketId: string };
}

/**
 * Configurable assembly budgets. These live in models.config.yaml, never
 * in code, so the product can tune context size without a deploy.
 */
export interface ContextBudgets {
  /** Total token budget across all elements (chars/4 estimate). */
  maxTokens: number;
  /** Total element cap. */
  maxItems: number;
  /** How many recent captures may contribute excerpts. */
  recentCaptures: number;
  /** Cap on confirmed-memory elements. */
  maxMemories: number;
  /** Cap on bucket-summary elements. */
  maxBucketSummaries: number;
  /** Cap on personalized correction examples (Spec 2.3). */
  maxCorrectionExamples: number;
}

/**
 * The bounded, attributed context handed to the organizer for one capture.
 * Selection is query-specific (FR-1); truncation under budget is
 * deterministic with source priority (FR-2); a packet built while a store
 * was unavailable is marked degraded with machine-readable reasons.
 */
export interface ContextPacket {
  id: string;
  tenantId: string;
  userId: string;
  createdAt: string; // ISO 8601
  degraded: boolean;
  /** Machine-readable reason tokens, e.g. "memories-unavailable". */
  degradedReasons: string[];
  elements: ContextElement[];
  budgets: ContextBudgets;
  totals: {
    tokens: number;
    items: number;
    /** Elements dropped by budget truncation. */
    truncated: number;
  };
}

/* ------------------------------------------------------------------ */
/* Specification 2.4 — session emotion and intent context              */
/* ------------------------------------------------------------------ */

/** Emotional labels Donna may tentatively infer. Never diagnostic. */
export type EmotionLabel =
  | "urgency"
  | "frustration"
  | "uncertainty"
  | "positive";

/** User correction state of an inference. */
export type InferenceCorrectionState =
  | "uncorrected"
  | "confirmed"
  | "corrected"
  | "disabled";

/**
 * A tentative, session-scoped emotional inference (FR-1). Every snapshot
 * is labeled as inferred, confidence-scored (capped below certainty),
 * evidence-linked to transcript segments, and stamped with the producing
 * model/version. Snapshots live and die with their session unless a
 * separate explicit opt-in ("emotion.persist" consent) promotes them to
 * durable private memory at session expiry (FR-2, SR-3).
 *
 * Emotional context may adjust tone, review priority, and uncertainty
 * handling ONLY — never access, permissions, or external actions (SR-2).
 */
export interface EmotionalSnapshot {
  id: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  /** Per-label confidence 0..1, capped by the analyzer. Empty = abstained. */
  labels: Array<{ label: EmotionLabel; confidence: number }>;
  /** True when the analyzer declined to infer (insufficient evidence). */
  abstained: boolean;
  /** Transcript segment IDs that motivated the inference. */
  evidence: string[];
  /** What produced the inference, e.g. "heuristic" + version. */
  model: string;
  version: string;
  correctionState: InferenceCorrectionState;
  createdAt: string; // ISO 8601
  expiresAt: string; // ISO 8601 — the session's expiry
}

/**
 * A tentative, session-scoped intent inference (what the user is trying to
 * do in this session, e.g. capturing, planning, deciding, delegating,
 * venting). Same privacy rules as EmotionalSnapshot.
 */
export interface IntentSignal {
  id: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  intent: string;
  confidence: number; // 0..1, capped by the analyzer
  /** Transcript segment IDs that motivated the signal. */
  evidence: string[];
  model: string;
  version: string;
  correctionState: InferenceCorrectionState;
  createdAt: string; // ISO 8601
  expiresAt: string; // ISO 8601 — the session's expiry
}

/**
 * Tentative session context handed to the organizer prompt (Spec 2.4).
 * Rendered in its own clearly-labeled section as an unverified inference.
 */
export interface SessionContext {
  /** Tentative note, e.g. "The speaker may be in a hurry (inferred, 0.55)". */
  note?: string;
}

/**
 * At or above this emotional-signal confidence, organized items are
 * flagged for human review (Spec 2.4: emotion may adjust review priority
 * and uncertainty handling — never placement, access, or actions).
 */
export const REVIEW_PRIORITY_THRESHOLD = 0.5;

/* ------------------------------------------------------------------ */
/* Specification 3.1 — read model and deterministic local retrieval    */
/* ------------------------------------------------------------------ */

/**
 * Filters that narrow a retrieval query (Specification 3.1). Every filter
 * is ANDed; every query is tenant/user scoped before any filter runs
 * (SR-1 — filters can only ever narrow the caller's own partition).
 */
export interface RetrievalFilters {
  /** Restrict to these bucket IDs. */
  bucketIds?: string[];
  /** Only thoughts created at or after this ISO 8601 time. */
  createdFrom?: string;
  /** Only thoughts created at or before this ISO 8601 time. */
  createdTo?: string;
  /** Restrict to thoughts carrying a task candidate. */
  hasTask?: boolean;
  /**
   * Restrict to thoughts mentioning one of these people hints
   * (case-insensitive substring over the task assignee hint, summary, and
   * text). Deterministic in 3.1; semantic person matching is 3.3 work.
   */
  people?: string[];
  /** Restrict to thoughts linked to one of these memory record IDs. */
  memoryIds?: string[];
}

/**
 * A scoped retrieval query (FR-1). At least one of `text` or `embedding`
 * should be present for scored retrieval; with neither, the result is a
 * deterministic recency-ordered listing of the filtered partition (browse
 * mode, used by the CLI bucket-contents view).
 */
export interface RetrievalQuery {
  tenantId: string;
  userId: string;
  /** Free-text query for full-text matching. */
  text?: string;
  /** Query embedding from the configured embedder for cosine similarity. */
  embedding?: number[];
  filters?: RetrievalFilters;
  /** Maximum hits to return (adapter default applies when omitted). */
  limit?: number;
}

/**
 * One scored retrieval result (FR-2): the matched thought with its bucket,
 * the deterministic score components that produced the ranking, and the
 * exact transcript provenance (carried on the thought) so every hit can be
 * traced back to the spoken words.
 */
export interface RetrievalHit {
  thought: Thought;
  bucketId: string;
  bucketName: string;
  /** Deterministic score components — always exposed, never hidden. */
  scores: {
    /** Normalized full-text overlap 0..1 (0 when no text query). */
    text: number;
    /** Cosine similarity 0..1 (0 when either embedding is missing). */
    semantic: number;
    /** The combined score the ranking ordered by. */
    combined: number;
  };
  /** Scoring algorithm version that produced `scores`. */
  scoreVersion: string;
}

/* ------------------------------------------------------------------ */
/* Specification 5.1 — managed Microsoft 365 connection boundary       */
/* ------------------------------------------------------------------ */

/**
 * Microsoft 365 read-source types Donna can be grounded in (Phase 5).
 * Each is gated by its own Donna-side consent record — independent of the
 * Microsoft-side OAuth consent, which the TrueFoundry-managed MCP owns
 * end to end (Donna never registers an Entra app and never handles
 * Microsoft tokens).
 */
export type M365ReadSourceType = "calendar" | "mail" | "teams" | "files";

/**
 * Canonical Donna-side consent purposes for Microsoft 365 (FR-2). Reads of
 * a source type require the matching active grant; `m365.destination.*`
 * purposes gate external writes through the approval path. Records live in
 * the existing append-only ConsentStore; revocation stops new reads and
 * invalidates cached snippets.
 */
export const M365_CONSENT_PURPOSES = [
  "m365.read.calendar",
  "m365.read.mail",
  "m365.read.teams",
  "m365.read.files",
  "m365.destination.onedrive",
] as const;

export type M365ConsentPurpose = (typeof M365_CONSENT_PURPOSES)[number];

/** The consent purpose that gates reads of one M365 source type. */
export function m365ReadConsentPurpose(
  source: M365ReadSourceType,
): M365ConsentPurpose {
  switch (source) {
    case "calendar":
      return "m365.read.calendar";
    case "mail":
      return "m365.read.mail";
    case "teams":
      return "m365.read.teams";
    case "files":
      return "m365.read.files";
  }
}

/** True when the purpose belongs to the Microsoft 365 integration. */
export function isM365ConsentPurpose(purpose: string): boolean {
  return purpose.startsWith("m365.");
}

/**
 * Microsoft resource types a context snippet can be normalized from
 * (Specification 5.2). Kept deliberately coarse; the MCP tool name that
 * produced the snippet is recorded on the snippet itself.
 */
export type M365ResourceType =
  | "calendar-event"
  | "email"
  | "teams-message"
  | "file"
  | "sharepoint-item";

/**
 * One minimized excerpt of external Microsoft 365 context. Always
 * UNTRUSTED content (SR-4): a snippet is data, never an instruction, and
 * can never alter system policy or grant capabilities. Snippets live in a
 * TTL cache; promotion to durable memory is a separate visible proposal.
 */
export interface ContextSnippet {
  /** Donna-local snippet identifier (deterministic per resource+revision). */
  id: string;
  tenantId: string;
  userId: string;
  source: {
    kind: "m365";
    resourceType: M365ResourceType;
    /** Stable Microsoft/MCP resource identifier (never content). */
    resourceId: string;
    /** Source URI when the MCP exposes one (webUrl etc.). */
    uri?: string;
    /** Owner/organizer hint as reported by the source (untrusted). */
    owner?: string;
    /** The MCP read tool that produced this snippet. */
    tool: string;
  };
  /** The Donna-side consent purpose that authorized the read (FR-1). */
  consentPurpose: M365ConsentPurpose;
  /** Minimal excerpt — never the full document (SR-3). */
  excerpt: string;
  /** ISO 8601 time the source reports for the resource, when available. */
  sourceTimestamp?: string;
  /** ISO 8601 time Donna fetched the excerpt. */
  fetchedAt: string;
  /** ISO 8601 time after which the snippet must not be served. */
  expiresAt: string;
}

/** End-to-end result of one capture through the loop. */
export interface CoreLoopResult {
  capture: Capture;
  transcript: Transcript;
  items: OrganizedItem[];
  bucketsCreated: Bucket[];
  /**
   * Which assembled context influenced the organize request (Spec 2.2
   * FR-4): packet ID and source IDs only — never content.
   */
  context?: {
    packetId: string;
    sourceIds: string[];
    degraded: boolean;
  };
  metrics: {
    sttLatencyMs: number;
    organizeLatencyMs: number;
    embedLatencyMs: number;
    totalLatencyMs: number;
    /** USD, when the provider reports usage; else NaN. */
    estimatedCostUsd: number;
  };
}
