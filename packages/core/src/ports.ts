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
  AuditEntry,
  Bucket,
  Capture,
  CaptureRecord,
  ConsentRecord,
  ContextPacket,
  ContextSnippet,
  CoreLoopResult,
  CorrectionEvent,
  MemoryEvent,
  MemoryProposal,
  MemoryRecord,
  Provenance,
  RetrievalHit,
  RetrievalQuery,
  SessionContext,
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
   * reuse over creation. When a `context` packet is supplied (Spec 2.2),
   * the prompt renders its attributed elements in trust-separated
   * sections; retrieved content is always data, never instruction.
   */
  organize(
    transcript: Transcript,
    existingBuckets: Array<Pick<Bucket, "name" | "description">>,
    context?: ContextPacket,
    session?: SessionContext,
  ): Promise<OrganizeOutput>;
}

/**
 * Builds the bounded, attributed context packet for one organize request
 * (Specification 2.2). Implementations select query-specific elements
 * under the configured budgets and never cross tenant/user scope (SR-2).
 */
export interface ContextAssembler {
  assemble(
    scope: { tenantId: string; userId: string },
    query: {
      text: string;
      /** The capture being organized — excluded from recent-capture context. */
      excludeCaptureId?: string;
      /**
       * ISO 8601 capture time (Spec 5.2): anchors the calendar context
       * window for external context sources. Omitted ⇒ no windowed
       * calendar fetch.
       */
      capturedAt?: string;
    },
  ): Promise<ContextPacket>;
}

/**
 * Adherence tracking (Specification 2.3): after placement, the pipeline
 * reports which injected correction examples the placement followed or
 * contradicted. Implementations decide example applicability and update
 * per-correction counters; telemetry carries IDs and counts only.
 */
export interface CorrectionObserver {
  observePlacement(
    scope: { tenantId: string; userId: string },
    observation: {
      thoughtText: string;
      placedBucketId: string;
      examples: Array<{
        correctionId: string;
        preferredBucketId: string;
        text: string;
      }>;
    },
  ): Promise<{ followed: number; contradicted: number }>;
}

export interface Embedder {
  readonly modelId: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Grounded-answer text generator (Specification 3.3). Config-selected
 * like every model. The generator has NO tools: it receives a
 * trust-separated prompt (retrieved evidence is data, never
 * instructions — SR-1) and returns free text whose claims must cite live
 * retrieval hit IDs. The retrieval layer verifies citations and fails
 * closed on unsupported or stale-cited output.
 */
export interface AnswerGenerator {
  readonly modelId: string;
  generate(prompt: string): Promise<string>;
}

/**
 * Optimistic concurrency failure (Specification 3.2): a conditional
 * write detected that the row changed underneath the caller and bounded
 * retries did not resolve the conflict. Callers may safely retry their
 * whole read-modify-write unit — no partial update was applied.
 */
export class OptimisticLockError extends Error {
  constructor(message = "Optimistic lock conflict — safe to retry") {
    super(message);
    this.name = "OptimisticLockError";
  }
}

export interface BucketStore {
  listBuckets(tenantId: string, userId: string): Promise<Bucket[]>;
  getBucketByName(
    tenantId: string,
    userId: string,
    name: string,
  ): Promise<Bucket | undefined>;
  createBucket(bucket: Bucket): Promise<Bucket>;
  /**
   * Persist the new centroid and item count after an item joins.
   * Transactional adapters (Specification 3.2) apply this as an
   * optimistic version-checked update and may throw OptimisticLockError
   * when a concurrent stats update could not be reconciled within the
   * retry bound — the caller's read-modify-write may then be retried as
   * a whole without lost updates.
   */
  updateBucketStats(
    tenantId: string,
    userId: string,
    bucketId: string,
    centroid: number[],
    itemCount: number,
  ): Promise<void>;
  saveItem(item: { thought: Thought; bucketId: string }): Promise<void>;
  /** Every persisted item in the scope (for export and deletion). */
  listItems(
    tenantId: string,
    userId: string,
  ): Promise<Array<{ thought: Thought; bucketId: string }>>;
  /**
   * Fetch one item by thought ID in scope (Specification 3.1). Returns
   * undefined when the thought does not exist in this partition — never
   * another partition's item (SR-1).
   */
  getItem(
    tenantId: string,
    userId: string,
    thoughtId: string,
  ): Promise<{ thought: Thought; bucketId: string } | undefined>;
  /**
   * Every persisted item in one bucket, in scope (Specification 3.1).
   * Fails closed when the bucket does not exist in this partition.
   */
  listItemsByBucket(
    tenantId: string,
    userId: string,
    bucketId: string,
  ): Promise<Array<{ thought: Thought; bucketId: string }>>;
  /**
   * Time-filtered read (Specification 3.1): items whose thought
   * `createdAt` falls within [from, to] (ISO 8601, inclusive bounds;
   * either bound may be omitted). Items without a `createdAt` (persisted
   * before Specification 3.1) cannot be proven in-range and are excluded
   * — fail closed.
   */
  listItemsInRange(
    tenantId: string,
    userId: string,
    range: { from?: string; to?: string },
  ): Promise<Array<{ thought: Thought; bucketId: string }>>;
  /**
   * Remove every item whose thought derives from the given capture and
   * repair affected bucket stats (item count and centroid recomputed from
   * the remaining members). Buckets themselves are kept — they are the
   * user's filing system. Returns how many items were removed.
   */
  deleteItemsForCapture(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<{ removed: number }>;
  /**
   * Move one item to another bucket (Spec 2.3 corrections). Both buckets'
   * stats are recomputed exactly from their surviving members. Fails
   * closed when the item or target bucket does not exist in the scope.
   */
  moveItem(
    tenantId: string,
    userId: string,
    thoughtId: string,
    toBucketId: string,
  ): Promise<void>;
  /** Rename a bucket in scope. Fails closed on unknown bucket. */
  renameBucket(
    tenantId: string,
    userId: string,
    bucketId: string,
    newName: string,
  ): Promise<void>;
  /**
   * Merge the source bucket into the target bucket: every item moves, the
   * target centroid is recomputed exactly, and the source bucket is
   * removed. Fails closed on unknown buckets.
   */
  mergeBuckets(
    tenantId: string,
    userId: string,
    sourceBucketId: string,
    targetBucketId: string,
  ): Promise<void>;
  /**
   * Update a thought's user-editable fields (Spec 2.3 corrections:
   * thought.edit, task.add, task.remove, provenance.correct). `task: null`
   * clears the task candidate. Embedding and bucket stats are the caller's
   * responsibility (re-embed on text change, then recompute).
   */
  updateItem(
    tenantId: string,
    userId: string,
    thoughtId: string,
    updates: {
      text?: string;
      summary?: string;
      task?: Thought["task"] | null;
      provenance?: Provenance;
      embedding?: number[];
    },
  ): Promise<void>;
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
  /**
   * Record that the capture's audio is gone (expired or deleted early).
   * Idempotent. Throws when the capture does not exist in the scope.
   */
  markAudioDeleted(
    tenantId: string,
    userId: string,
    captureId: string,
    deletedAt: string,
  ): Promise<void>;
  /** Remove the capture record itself. Idempotent. */
  deleteCapture(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<void>;
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
  /** Remove the transcript for a capture. Idempotent. */
  deleteTranscript(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<void>;
}

/**
 * Encrypted-at-rest audio storage (Spec 1.3). Implementations encrypt
 * before durable write with runtime-supplied keys; ciphertext and keys are
 * never co-located. All methods are scoped and identifier-validated so a
 * malicious capture ID cannot traverse paths or select another scope's
 * object.
 */
export interface AudioStore {
  put(
    tenantId: string,
    userId: string,
    captureId: string,
    audio: Uint8Array,
  ): Promise<void>;
  /** Decrypted audio, or undefined when absent (expired/deleted/never stored). */
  get(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<Uint8Array | undefined>;
  has(tenantId: string, userId: string, captureId: string): Promise<boolean>;
  /** Idempotent: returns true when an object was actually removed. */
  delete(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<boolean>;
}

/** Append-only, non-content audit log for privacy lifecycle operations. */
export interface AuditLog {
  append(entry: AuditEntry): Promise<void>;
  list(tenantId: string, userId: string): Promise<AuditEntry[]>;
}

/**
 * Durable store for private memory (Specification 2.1). Every method is
 * scoped: a record is only ever read or written inside its own tenant/user
 * partition, and a stored record whose scope does not match its partition
 * fails closed. There is deliberately no cross-user or cross-tenant
 * listing — personal memory is private to the employee (SR-1/SR-2).
 *
 * This is a plain persistence port: all lifecycle policy (approval,
 * supersession, expiry, source deletion) lives in the memory service.
 */
export interface MemoryStore {
  saveMemory(record: MemoryRecord): Promise<void>;
  getMemory(
    tenantId: string,
    userId: string,
    memoryId: string,
  ): Promise<MemoryRecord | undefined>;
  /** Every memory record in the scope, any layer, any status. */
  listMemories(tenantId: string, userId: string): Promise<MemoryRecord[]>;
  /** Idempotent: returns true when a record was actually removed. */
  deleteMemory(
    tenantId: string,
    userId: string,
    memoryId: string,
  ): Promise<boolean>;

  saveProposal(proposal: MemoryProposal): Promise<void>;
  getProposal(
    tenantId: string,
    userId: string,
    proposalId: string,
  ): Promise<MemoryProposal | undefined>;
  listProposals(tenantId: string, userId: string): Promise<MemoryProposal[]>;
  /** Idempotent: returns true when a record was actually removed. */
  deleteProposal(
    tenantId: string,
    userId: string,
    proposalId: string,
  ): Promise<boolean>;

  /** Append-only lifecycle events (FR-3). */
  appendEvent(event: MemoryEvent): Promise<void>;
  listEvents(tenantId: string, userId: string): Promise<MemoryEvent[]>;
}

/**
 * Durable store for consent records (Specification 2.1). Scoped exactly
 * like the memory store. Records are append-only; revocation is recorded
 * on the record, never by rewriting history.
 */
export interface ConsentStore {
  recordConsent(record: ConsentRecord): Promise<void>;
  listConsents(tenantId: string, userId: string): Promise<ConsentRecord[]>;
}

/**
 * Append-only store for correction events (Specification 2.3). Scoped
 * exactly like the memory store. Events are immutable once recorded —
 * lifecycle fields (status, appliedAt, contradictedBy, sharedAt,
 * adherence counters) are updated in place by the correction service;
 * the payload and sources never change (FR-1).
 */
export interface CorrectionStore {
  saveCorrection(event: CorrectionEvent): Promise<void>;
  getCorrection(
    tenantId: string,
    userId: string,
    correctionId: string,
  ): Promise<CorrectionEvent | undefined>;
  listCorrections(tenantId: string, userId: string): Promise<CorrectionEvent[]>;
  /** Idempotent: returns true when a record was actually removed. */
  deleteCorrection(
    tenantId: string,
    userId: string,
    correctionId: string,
  ): Promise<boolean>;
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

/**
 * Session emotion/intent context (Specification 2.4). The pipeline calls
 * this after transcription when the capture is bound to a session. The
 * result may ONLY adjust tone (a tentative prompt note), review priority,
 * and uncertainty handling — never access, permissions, or external
 * actions (SR-2). Returning undefined means no inference (disabled or
 * abstained) and the core loop proceeds unchanged (AC-4).
 */
export interface EmotionalContext {
  analyzeAndStore(
    scope: { tenantId: string; userId: string },
    session: { id: string; expiresAt: string },
    transcript: Transcript,
  ): Promise<
    | {
        /** Tentative, user-correctable note for the organizer prompt. */
        note?: string;
        /** 0..1 — used only to bias review priority. */
        reviewPriority: number;
        /** True when the analyzer declined to infer. */
        abstained: boolean;
      }
    | undefined
  >;
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

/**
 * Retrieval read model (Specification 3.1): a scoped, rebuildable
 * projection of organized items for deterministic full-text and vector
 * retrieval. The bucket store remains the source of truth; the index is
 * derived state that can be discarded and rebuilt at any time (SR-3).
 *
 * Every method is tenant/user scoped. There is deliberately no
 * cross-scope operation (SR-1).
 */
export interface RetrievalIndex {
  /**
   * Index one organized item. Idempotent per thought ID: re-indexing the
   * same thought replaces its entry (duplicate-index safety).
   */
  indexItem(
    item: { thought: Thought; bucketId: string },
    bucket: Bucket,
  ): Promise<void>;
  /** Remove one thought from the index. Idempotent. */
  removeThought(
    tenantId: string,
    userId: string,
    thoughtId: string,
  ): Promise<boolean>;
  /**
   * Remove every entry derived from a capture (deletion propagation,
   * FR-4). Idempotent.
   */
  removeCapture(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<{ removed: number }>;
  /**
   * Run a scoped query. Filters can only narrow the caller's own
   * partition (SR-1). Hits carry score components and provenance (FR-2).
   */
  search(query: RetrievalQuery): Promise<RetrievalHit[]>;
  /**
   * Discard the current index state and rebuild it from the scoped
   * source-of-truth records (SR-3). Deterministic and idempotent (FR-3):
   * rebuilding twice over the same source records yields the same index.
   */
  rebuild(
    tenantId: string,
    userId: string,
  ): Promise<{ indexed: number }>;
}

/** The composed pipeline itself. */
export interface CoreLoop {
  run(capture: Capture): Promise<CoreLoopResult>;
}

/* ------------------------------------------------------------------ */
/* Specification 5.1 — managed-MCP connection boundary                 */
/* ------------------------------------------------------------------ */

/** One tool the managed MCP server exposes. */
export interface McpToolDescriptor {
  name: string;
  description?: string;
}

/**
 * Result of one MCP tool call. `content` is UNTRUSTED data (SR-4): it can
 * never alter system policy, never request tools, and never grant new
 * capabilities. Callers normalize and minimize it before it reaches any
 * model-facing surface.
 */
export interface McpToolResult {
  isError: boolean;
  content: unknown;
}

/**
 * The governed connection boundary to the TrueFoundry-managed Microsoft
 * 365 MCP (Specification 5.1). This is the ONLY path Donna has to
 * Microsoft 365 data: Donna never registers an Entra app and never
 * handles Microsoft tokens — the managed MCP owns OAuth, token storage,
 * and refresh, and the pilot runs under the connector owner's Microsoft
 * identity until per-user OAuth is exercised per volunteer.
 *
 * Implementations enforce the client-side tool allowlist (SR-3): a
 * connection handed to the context layer is read-only and physically
 * cannot invoke write/draft tools — write tools are reachable solely
 * through the approval path (Specification 5.4).
 */
export interface McpConnection {
  /** MCP initialize handshake; resolves with the server identity. */
  initialize(): Promise<{ serverName: string }>;
  /** Discover the server's tools. */
  listTools(): Promise<McpToolDescriptor[]>;
  /**
   * Invoke one tool. Write/draft tools are denied client-side unless this
   * connection was built for the approval path with the tool explicitly
   * allowlisted. `args` may contain identifiers only for reads; they are
   * never logged.
   */
  callTool(name: string, args?: Record<string, unknown>): Promise<McpToolResult>;
}

/**
 * A governed external context source (Specification 5.1 boundary;
 * Specification 5.2 builds the Microsoft 365 adapter). Every fetch is
 * tenant/user scoped and consent-gated BEFORE any external call: without
 * an active Donna-side grant for the source type, no bytes leave the
 * machine (FR-1/FR-2). Returned snippets are untrusted content.
 */
export interface ContextSource {
  /** Stable source kind, e.g. "m365". */
  readonly kind: string;
  /**
   * Fetch minimized snippets for explicitly requested resources or a
   * calendar time window. Implementations must check the Donna-side
   * consent grant BEFORE any external call, apply ACL/scope checks and
   * TTL caching, and degrade independently per resource type
   * (FR-2/FR-4, SR-2).
   */
  fetchSnippets(
    scope: { tenantId: string; userId: string },
    request: {
      /** The consent purpose authorizing this read. */
      consentPurpose: string;
      /** Stable resource identifiers the employee selected. */
      resourceIds?: string[];
      /** Calendar window (ISO 8601, inclusive) for event context. */
      window?: { from: string; to: string };
    },
  ): Promise<ContextSnippet[]>;
}

/**
 * Collects external untrusted context snippets for one capture
 * (Specification 5.2). The ContextAssembler renders whatever it returns
 * in the untrusted-retrieved section only; a failing source contributes
 * machine-readable degraded reasons instead of snippets (FR-4), never an
 * exception that breaks organization.
 */
export interface ExternalContextCollector {
  collect(
    scope: { tenantId: string; userId: string },
    query: {
      text: string;
      /** ISO 8601 capture time; anchors the calendar window. */
      capturedAt?: string;
    },
  ): Promise<{ snippets: ContextSnippet[]; degraded: string[] }>;
}

/* ------------------------------------------------------------------ */
/* Specification 5.3 — destination preview/commit contract             */
/* ------------------------------------------------------------------ */

/**
 * What an external write WOULD do (Specification 5.3, FR-1). The exact
 * target and the exact bytes, hashed — the employee approves this, and
 * commit re-verifies the hash before anything is written.
 */
export interface DestinationPreview {
  /** Destination kind, e.g. "onedrive-markdown". */
  kind: string;
  /** Human-inspectable target description. */
  target: { folder: string; documentName: string };
  /** Exact content that would be published (UTF-8). */
  content: string;
  /** SHA-256 of content, hex. */
  contentHash: string;
  /** True when the destination already holds exactly this content. */
  noOp: boolean;
  /** Hash of the current remote content, when it exists. */
  existingHash?: string;
}

/** Result of a committed publication (FR-3 write-back payload). */
export interface DestinationCommit {
  /** External item ID assigned by the destination. */
  itemId: string;
  /** Organization-scoped share link, when the destination provides one. */
  link?: string;
  contentHash: string;
  committedAt: string; // ISO 8601
  /** True when the destination already held exactly this content. */
  noOp: boolean;
}

/**
 * Generic destination contract (Specification 5.3). EVERY external write
 * is preview → explicit approval → commit; there is no auto-publish path.
 * Implementations must: constrain targets to the authenticated user's own
 * approved locations (SR-2), escape untrusted content (SR-3), redact MCP
 * errors (SR-4), and make re-publishing unchanged state a byte-identical
 * no-op (FR-2). Donna remains the source of truth and records the
 * external item ID, link, and content hash (FR-3).
 */
export interface Destination {
  readonly kind: string;
  /** Build the exact preview for one bucket publication. */
  preview(
    scope: { tenantId: string; userId: string },
    bucketId: string,
  ): Promise<DestinationPreview>;
  /**
   * Commit EXACTLY what was previewed. Implementations re-render from
   * live state and refuse when it no longer matches the approved preview.
   */
  commit(
    scope: { tenantId: string; userId: string },
    preview: DestinationPreview,
  ): Promise<DestinationCommit>;
}
