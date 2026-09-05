/**
 * Core-loop orchestration: capture → transcribe → organize → embed →
 * place in dynamic buckets → persist.
 *
 * Persistence and provenance rules (Specification 1.2):
 *   - The capture record is persisted first, the transcript record second,
 *   and only then may organization output be accepted — a thought can
 *   never be persisted before its capture and transcript (FR-1).
 *   - The organizer runs in two lanes: the cheap default lane first, and
 *   the escalation lane when the default throws (schema failure), returns
 *   only low-confidence thoughts, or produces provenance-invalid output.
 *   The escalation lane is used at most once per run; output that is still
 *   provenance-invalid afterward fails closed with a ProvenanceError and
 *   no thoughts are persisted.
 *   - Provenance on persisted thoughts is canonical: derived from the
 *   stored transcript segments, never trusted from model output (FR-3).
 *   - Organizer output is matched to thoughts by stable output index, not
 *   by text equality, so duplicate thought text cannot cross-wire
 *   placement suggestions.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  hashTranscriptContent,
  REVIEW_PRIORITY_THRESHOLD,
  sha256Hex,
  type AudioStore,
  type AuditLog,
  type Bucket,
  type BucketStore,
  type Capture,
  type CaptureStore,
  type ContextAssembler,
  type ContextPacket,
  type CoreLoop,
  type CoreLoopResult,
  type CorrectionObserver,
  type DerivationVersions,
  type Embedder,
  type EmotionalContext,
  type EventSink,
  type BucketNamer,
  type BucketOption,
  type OrganizeOutput,
  type OrganizeOutputV2,
  type Organizer,
  type OrganizerV2,
  type PendingPlacement,
  type PendingPlacementStore,
  type PlacementProposal,
  type Provenance,
  type ProvenanceVerifier,
  type RetrievalIndex,
  type SessionContext,
  type Thought,
  type Transcriber,
  type Transcript,
  type TranscriptRecord,
  type TranscriptStore,
} from "@donna/core";
import {
  allowlistHash,
  BucketEngine,
  StructuredBucketEngine,
  type BucketTuning,
} from "@donna/buckets";
import {
  DeterministicProvenanceVerifier,
  ProvenanceError,
} from "./provenance.js";

const ESCALATION_CONFIDENCE_FLOOR = 0.5;

export interface PipelineDeps {
  transcriber: Transcriber;
  organizer: Organizer;
  escalationOrganizer?: Organizer;
  embedder: Embedder;
  store: BucketStore;
  captures: CaptureStore;
  transcripts: TranscriptStore;
  verifier?: ProvenanceVerifier;
  bucketTuning: BucketTuning;
  events?: EventSink;
  /**
   * When present, the source audio is encrypted and retained (Spec 1.3)
   * at capture time, before transcription.
   */
  audio?: AudioStore;
  audit?: AuditLog;
  /**
   * When present, an attributed context packet (Spec 2.2) is assembled
   * before organization and handed to the organizer. If assembly itself
   * fails, the run continues in degraded mode with no packet (AC-4).
   */
  contextAssembler?: ContextAssembler;
  /**
   * When present (Spec 2.3), each placement is checked against the
   * injected correction examples to record whether the system followed
   * or contradicted a learned correction. IDs and counts only.
   */
  correctionObserver?: CorrectionObserver;
  /**
   * When present AND the capture is bound to a session (Spec 2.4), the
   * transcript is analyzed for tentative emotion/intent. The result may
   * only add a tentative prompt note and bias review priority — never
   * placement, access, or actions (SR-2). Any failure here degrades to
   * no emotional context; the core loop is unaffected (AC-4).
   */
  emotionalContext?: EmotionalContext;
  /**
   * When present (Specification 3.1), each placed item is indexed for
   * retrieval as it is persisted. The index is a rebuildable projection:
   * an indexing failure is reported via telemetry and the run continues —
   * `rebuild` from the source-of-truth store recovers it (SR-3).
   */
  retrievalIndex?: RetrievalIndex;
  /**
   * Spec 6.7: when present, the structured v2 lane runs instead of the
   * v1 name-hint path. The pipeline validates allowlist membership before
   * the engine, escalates invalid routing exactly once, invokes at most
   * one isolated naming retry, and persists unresolvable placements to
   * the pending store — never silent continuation.
   */
  organizerV2?: OrganizerV2;
  escalationOrganizerV2?: OrganizerV2;
  namer?: BucketNamer;
  pendingPlacements?: PendingPlacementStore;
  /** Spec 6.7: separate locked near-duplicate descriptor threshold. */
  nearDuplicateThreshold?: number;
}

interface LaneOutput {
  output: OrganizeOutput;
  lane: Organizer;
  escalationUsed: boolean;
}

export class DonnaPipeline implements CoreLoop {
  private readonly engine: BucketEngine;
  private readonly verifier: ProvenanceVerifier;

  constructor(private readonly deps: PipelineDeps) {
    this.engine = new BucketEngine(deps.store, deps.bucketTuning);
    this.verifier = deps.verifier ?? new DeterministicProvenanceVerifier();
  }

  async run(capture: Capture): Promise<CoreLoopResult> {
    const t0 = Date.now();
    const { transcriber, embedder, store, captures, transcripts } = this.deps;

    // FR-1: the capture record lands before anything derived from it.
    const audio = await readFile(capture.audioPath);
    await captures.saveCapture({
      id: capture.id,
      tenantId: capture.tenantId,
      userId: capture.userId,
      contentHash: sha256Hex(audio),
      capturedAt: capture.capturedAt,
      ...(capture.durationSec !== undefined
        ? { durationSec: capture.durationSec }
        : {}),
    });

    // Spec 1.3 FR-1: audio is encrypted before durable storage.
    if (this.deps.audio !== undefined) {
      await this.deps.audio.put(
        capture.tenantId,
        capture.userId,
        capture.id,
        audio,
      );
      await this.deps.audit?.append({
        at: new Date().toISOString(),
        op: "audio.store",
        tenantId: capture.tenantId,
        userId: capture.userId,
        captureId: capture.id,
        result: "ok",
        detail: `bytes=${audio.byteLength}`,
      });
    }

    const tStt = Date.now();
    const transcript = await transcriber.transcribe(capture);
    const sttLatencyMs = Date.now() - tStt;
    this.emit("stage.transcribe", capture, {
      model: transcriber.modelId,
      ms: sttLatencyMs,
    });

    // FR-1: the transcript is persisted before organization is accepted.
    const transcriptRecord: TranscriptRecord = {
      captureId: capture.id,
      tenantId: capture.tenantId,
      userId: capture.userId,
      text: transcript.text,
      segments: transcript.segments,
      ...(transcript.language !== undefined
        ? { language: transcript.language }
        : {}),
      model: transcript.model,
      contentHash: hashTranscriptContent({
        captureId: capture.id,
        tenantId: capture.tenantId,
        userId: capture.userId,
        text: transcript.text,
        segments: transcript.segments,
        ...(transcript.language !== undefined
          ? { language: transcript.language }
          : {}),
        model: transcript.model,
      }),
      createdAt: new Date().toISOString(),
    };
    await transcripts.saveTranscript(transcriptRecord);

    const tOrg = Date.now();
    const buckets = await store.listBuckets(capture.tenantId, capture.userId);
    const context = await this.assembleContext(capture, transcript.text);
    const sessionSignal = await this.analyzeSession(capture, transcript);
    const sessionContext: SessionContext | undefined =
      sessionSignal?.note !== undefined ? { note: sessionSignal.note } : undefined;

    // Spec 6.7: the structured v2 lane replaces name-hint placement with
    // allowlisted-ID routing, the deterministic decision table, and
    // durable pending review. v1 remains for rollback.
    if (this.deps.organizerV2 !== undefined) {
      return this.runStructuredPlacement({
        capture,
        transcript,
        transcriptRecord,
        buckets,
        context,
        sessionContext,
        sessionSignal,
        t0,
        sttLatencyMs,
      });
    }

    const organized = await this.organizeVerified(
      transcriptRecord,
      transcript,
      buckets,
      context,
      sessionContext,
    );
    const organizeLatencyMs = Date.now() - tOrg;
    this.emit("stage.organize", capture, {
      model: organized.lane.modelId,
      ms: organizeLatencyMs,
    });

    const versions: DerivationVersions = {
      organizerModel: organized.lane.modelId,
      organizeSchemaVersion: organized.lane.schemaVersion ?? "unknown",
      organizePromptVersion: organized.lane.promptVersion ?? "unknown",
    };

    const tEmb = Date.now();
    // Stable output indexes: thought i always corresponds to
    // output.thoughts[i], so identical text cannot cross-wire suggestions.
    const indexed = organized.output.thoughts.map((o, outputIndex) => ({
      outputIndex,
      output: o,
      thought: this.toThought(capture, o, organized.provenance[outputIndex]!, versions),
    }));
    const thoughts = indexed.map((x) => x.thought);
    const embeddings = await embedder.embed(thoughts.map((t) => t.text));
    thoughts.forEach((t, i) => {
      const e = embeddings[i];
      if (e) t.embedding = e;
    });
    const embedLatencyMs = Date.now() - tEmb;
    this.emit("stage.embed", capture, {
      model: embedder.modelId,
      ms: embedLatencyMs,
      count: thoughts.length,
    });

    const items: CoreLoopResult["items"] = [];
    const bucketsCreated: CoreLoopResult["bucketsCreated"] = [];
    let currentBuckets = buckets;
    for (const { thought, output } of indexed) {
      const placement = await this.engine.place(
        thought,
        {
          ...(output.suggestedBucket !== undefined
            ? { suggestedBucket: output.suggestedBucket }
            : {}),
          ...(output.newBucketName !== undefined
            ? { newBucketName: output.newBucketName }
            : {}),
          ...(output.newBucketDescription !== undefined
            ? { newBucketDescription: output.newBucketDescription }
            : {}),
        },
        currentBuckets,
      );
      thought.bucketId = placement.bucket.id;
      await store.saveItem({ thought, bucketId: placement.bucket.id });
      await this.indexForRetrieval(capture, thought, placement.bucket);
      await this.observeCorrectionAdherence(capture, thought, placement.bucket.id, context);
      // Spec 2.4: emotional context may bias review priority ONLY — never
      // placement, access, or actions (SR-2).
      const reviewBias =
        (sessionSignal?.reviewPriority ?? 0) >= REVIEW_PRIORITY_THRESHOLD;
      const needsReview = placement.needsReview || reviewBias;
      if (placement.created) {
        bucketsCreated.push(placement.bucket);
        currentBuckets = [...currentBuckets, placement.bucket];
      } else {
        // Keep centroid/itemCount fresh for later thoughts in this capture.
        currentBuckets = currentBuckets.map((b) =>
          b.id === placement.bucket.id ? placement.bucket : b,
        );
      }
      items.push({ thought, bucket: placement.bucket, needsReview });
    }

    this.emit("loop.complete", capture, {
      thoughts: thoughts.length,
      bucketsCreated: bucketsCreated.length,
      ms: Date.now() - t0,
    });

    return {
      capture,
      transcript,
      items,
      bucketsCreated,
      // FR-4 (Spec 2.2): record which context influenced this organize
      // request — packet ID and source IDs only, never content.
      ...(context !== undefined
        ? {
            context: {
              packetId: context.id,
              sourceIds: context.elements.map((e) => e.sourceId),
              degraded: context.degraded,
            },
          }
        : {}),
      metrics: {
        sttLatencyMs,
        organizeLatencyMs,
        embedLatencyMs,
        totalLatencyMs: Date.now() - t0,
        estimatedCostUsd: Number.NaN, // filled from gateway telemetry, not estimated here
      },
    };
  }

  /**
   * Spec 3.1: keep the retrieval projection in step with the source of
   * truth as items are placed. A failing index never breaks the core
   * loop — the projection is rebuildable from the bucket store (SR-3).
   * Telemetry carries counts only, never content (SR-2).
   */
  private async indexForRetrieval(
    capture: Capture,
    thought: Thought,
    bucket: Bucket,
  ): Promise<void> {
    const index = this.deps.retrievalIndex;
    if (index === undefined) return;
    try {
      await index.indexItem({ thought, bucketId: bucket.id }, bucket);
    } catch {
      this.emit("retrieval.index.error", capture, {});
    }
  }

  /**
   * Spec 2.3: when correction examples were injected into the context,
   * record whether this placement followed or contradicted them. The
   * observer decides applicability; telemetry carries counts only.
   */
  private async observeCorrectionAdherence(
    capture: Capture,
    thought: Thought,
    placedBucketId: string,
    context: ContextPacket | undefined,
  ): Promise<void> {
    const observer = this.deps.correctionObserver;
    if (observer === undefined || context === undefined) return;
    const examples = context.elements
      .filter((e) => e.sourceKind === "correction" && e.correction !== undefined)
      .map((e) => ({
        correctionId: e.correction!.correctionId,
        preferredBucketId: e.correction!.preferredBucketId,
        text: e.text,
      }));
    if (examples.length === 0) return;
    try {
      const outcome = await observer.observePlacement(
        { tenantId: capture.tenantId, userId: capture.userId },
        { thoughtText: thought.text, placedBucketId, examples },
      );
      if (outcome.followed + outcome.contradicted > 0) {
        this.emit("correction.adherence", capture, {
          followed: outcome.followed,
          contradicted: outcome.contradicted,
        });
      }
    } catch {
      // Adherence tracking must never break the core loop.
      this.emit("correction.adherence.error", capture, {});
    }
  }

  /**
   * Spec 2.4: analyze the transcript for tentative session emotion/intent
   * when the capture is session-bound. Any failure degrades to no
   * emotional context — the core loop is unaffected (AC-4). Telemetry
   * carries flags and counts only, never content.
   */
  private async analyzeSession(
    capture: Capture,
    transcript: Transcript,
  ): Promise<
    { note?: string; reviewPriority: number; abstained: boolean } | undefined
  > {
    const emotional = this.deps.emotionalContext;
    if (emotional === undefined || capture.session === undefined) {
      return undefined;
    }
    try {
      const signal = await emotional.analyzeAndStore(
        { tenantId: capture.tenantId, userId: capture.userId },
        capture.session,
        transcript,
      );
      if (signal !== undefined) {
        this.emit("emotion.analyzed", capture, {
          sessionId: capture.session.id,
          abstained: signal.abstained,
          notePresent: signal.note !== undefined,
          reviewPriority: signal.reviewPriority,
        });
      }
      return signal;
    } catch {
      this.emit("emotion.error", capture, { sessionId: capture.session.id });
      return undefined;
    }
  }

  /**
   * Assemble the bounded context packet for this organize request. A
   * failing assembler degrades the run to no-packet mode (the organizer
   * falls back to its legacy prompt) — organization still works (AC-4).
   * Telemetry carries IDs and counts only, never content (SR-3).
   */
  private async assembleContext(
    capture: Capture,
    transcriptText: string,
  ): Promise<ContextPacket | undefined> {
    const assembler = this.deps.contextAssembler;
    if (assembler === undefined) return undefined;
    try {
      const packet = await assembler.assemble(
        { tenantId: capture.tenantId, userId: capture.userId },
        {
          text: transcriptText,
          excludeCaptureId: capture.id,
          // Spec 5.2: anchors the consent-gated M365 calendar window.
          capturedAt: capture.capturedAt,
        },
      );
      this.emit("context.assembled", capture, {
        packetId: packet.id,
        elements: packet.totals.items,
        tokens: packet.totals.tokens,
        truncated: packet.totals.truncated,
        degraded: packet.degraded,
        ...(packet.degradedReasons.length > 0
          ? { degradedReasons: packet.degradedReasons.join(",") }
          : {}),
        sourceIds: packet.elements.map((e) => e.sourceId).join(","),
      });
      return packet;
    } catch {
      this.emit("context.degraded", capture, { reason: "assembler-failed" });
      return undefined;
    }
  }

  /**
   * Spec 6.7 structured lane: v2 organization, allowlist referential
   * validation with exactly one escalation, the deterministic decision
   * table, at most one isolated naming retry, and durable pending
   * persistence. Extraction (summary/text/task/provenance) is completed
   * and verified BEFORE routing and is never mutated by routing or naming.
   */
  private async runStructuredPlacement(args: {
    capture: Capture;
    transcript: Transcript;
    transcriptRecord: TranscriptRecord;
    buckets: Bucket[];
    context: ContextPacket | undefined;
    sessionContext: SessionContext | undefined;
    sessionSignal:
      | { note?: string; reviewPriority: number; abstained: boolean }
      | undefined;
    t0: number;
    sttLatencyMs: number;
  }): Promise<CoreLoopResult> {
    const { capture, transcript, transcriptRecord, buckets, context, sessionContext, sessionSignal, t0, sttLatencyMs } = args;
    const { embedder, store } = this.deps;
    const organizerV2 = this.deps.organizerV2!;

    const tOrg = Date.now();
    const allowlist: BucketOption[] = buckets.map((b) => ({
      id: b.id,
      name: b.name,
      description: b.description,
    }));
    const organized = await this.organizeVerifiedV2(
      transcriptRecord,
      transcript,
      allowlist,
      context,
      sessionContext,
    );
    const organizeLatencyMs = Date.now() - tOrg;
    this.emit("stage.organize", capture, {
      model: organized.lane.modelId,
      ms: organizeLatencyMs,
    });

    const versions: DerivationVersions = {
      organizerModel: organized.lane.modelId,
      organizeSchemaVersion: organized.lane.schemaVersion,
      organizePromptVersion: organized.lane.promptVersion,
    };

    const tEmb = Date.now();
    // Stable output indexes: thought i always corresponds to
    // output.thoughts[i], so identical text cannot cross-wire proposals.
    const indexed = organized.output.thoughts.map((o, outputIndex) => ({
      outputIndex,
      output: o,
      thought: this.toThought(capture, o, organized.provenance[outputIndex]!, versions),
    }));
    const thoughts = indexed.map((x) => x.thought);
    const embeddings = await embedder.embed(thoughts.map((t) => t.text));
    thoughts.forEach((t, i) => {
      const e = embeddings[i];
      if (e) t.embedding = e;
    });
    const embedLatencyMs = Date.now() - tEmb;
    this.emit("stage.embed", capture, {
      model: embedder.modelId,
      ms: embedLatencyMs,
      count: thoughts.length,
    });

    const engine = new StructuredBucketEngine(store, this.deps.bucketTuning, {
      nearDuplicateThreshold: this.deps.nearDuplicateThreshold ?? 0.9,
      embedder,
    });
    const listHash = allowlistHash(allowlist);

    const items: CoreLoopResult["items"] = [];
    const pendingPlacements: PendingPlacement[] = [];
    const bucketsCreated: CoreLoopResult["bucketsCreated"] = [];
    let currentBuckets = buckets;
    for (const { outputIndex, thought, output } of indexed) {
      // FR-3: pipeline-side allowlist validation. Still-invalid routing
      // after the single escalation reaches the engine as a null proposal
      // (pending invalid-route) or, for an unknown existing ID, fails
      // closed at the engine/store boundary (pending unknown-id).
      const invalidReason = organized.invalid.get(outputIndex);
      let proposal: PlacementProposal | null =
        invalidReason === "invalid-route" ? null : output.placement;

      let outcome = await engine.place(thought, proposal, currentBuckets);

      // FR-6: exactly one isolated naming-only retry with immutable
      // extraction/routing inputs; never a rerun of extraction or routing.
      if (outcome.kind === "naming-failed") {
        const namer = this.deps.namer;
        const firstFailures = outcome.reasons;
        if (namer !== undefined && proposal?.mode === "new") {
          this.emit("placement.naming-retry", capture, {
            reasons: firstFailures.join(","),
          });
          try {
            const renamed = await namer.nameBucket({
              summary: thought.summary,
              text: thought.text,
              ...(thought.task !== undefined ? { task: thought.task } : {}),
              allowlist: currentBuckets.map((b) => ({
                id: b.id,
                name: b.name,
                description: b.description,
              })),
              invalidReasons: firstFailures,
            });
            proposal = { mode: "new", name: renamed.name, description: renamed.description };
            outcome = await engine.place(thought, proposal, currentBuckets, {
              namingRetried: true,
            });
          } catch {
            outcome = {
              kind: "pending",
              reason: "naming-invalid",
              namingFailures: firstFailures,
              candidates: [],
            };
          }
        } else {
          outcome = {
            kind: "pending",
            reason: "naming-invalid",
            namingFailures: outcome.reasons,
            candidates: [],
          };
        }
      }

      if (outcome.kind === "naming-failed") {
        // Unreachable: a namingRetried engine call never returns
        // naming-failed. Guard so the union narrows for the filing path.
        outcome = {
          kind: "pending",
          reason: "naming-invalid",
          namingFailures: outcome.reasons,
          candidates: [],
        };
      }

      if (outcome.kind === "pending") {
        const record: PendingPlacement = {
          id: randomUUID(),
          tenantId: capture.tenantId,
          userId: capture.userId,
          thought,
          proposal,
          reason: outcome.reason,
          ...(outcome.namingFailures !== undefined
            ? { namingFailures: outcome.namingFailures }
            : {}),
          candidates: outcome.candidates,
          ...(outcome.recommendedBucketId !== undefined
            ? { recommendedBucketId: outcome.recommendedBucketId }
            : {}),
          allowlistHash: listHash,
          createdAt: new Date().toISOString(),
          status: "pending",
        };
        if (this.deps.pendingPlacements !== undefined) {
          await this.deps.pendingPlacements.save(record);
        }
        pendingPlacements.push(record);
        // FR-13: reason/category tokens and counts only — never content.
        this.emit("placement.pending", capture, {
          reason: outcome.reason,
          mode: proposal?.mode ?? "invalid",
        });
        continue;
      }

      if (outcome.proposalConflict === "tasks-override") {
        this.emit("placement.tasks-override", capture, {
          mode: proposal?.mode ?? "invalid",
        });
      }
      thought.bucketId = outcome.bucket.id;
      await store.saveItem({ thought, bucketId: outcome.bucket.id });
      await this.indexForRetrieval(capture, thought, outcome.bucket);
      await this.observeCorrectionAdherence(capture, thought, outcome.bucket.id, context);
      const reviewBias =
        (sessionSignal?.reviewPriority ?? 0) >= REVIEW_PRIORITY_THRESHOLD;
      const needsReview = outcome.needsReview || reviewBias;
      if (outcome.created) {
        bucketsCreated.push(outcome.bucket);
        currentBuckets = [...currentBuckets, outcome.bucket];
      } else {
        currentBuckets = currentBuckets.map((b) =>
          b.id === outcome.bucket.id ? outcome.bucket : b,
        );
      }
      this.emit("placement.filed", capture, {
        mode: proposal?.mode ?? "invalid",
        created: outcome.created,
      });
      items.push({ thought, bucket: outcome.bucket, needsReview });
    }

    this.emit("loop.complete", capture, {
      thoughts: thoughts.length,
      bucketsCreated: bucketsCreated.length,
      pending: pendingPlacements.length,
      ms: Date.now() - t0,
    });

    return {
      capture,
      transcript,
      items,
      bucketsCreated,
      pendingPlacements,
      ...(context !== undefined
        ? {
            context: {
              packetId: context.id,
              sourceIds: context.elements.map((e) => e.sourceId),
              degraded: context.degraded,
            },
          }
        : {}),
      metrics: {
        sttLatencyMs,
        organizeLatencyMs,
        embedLatencyMs,
        totalLatencyMs: Date.now() - t0,
        estimatedCostUsd: Number.NaN,
      },
    };
  }

  /**
   * V2 organization with the existing escalation discipline: schema
   * failure or all-low-confidence escalates once; invalid provenance
   * escalates once and then fails closed (hard blocker, SR-4); routing
   * that stays referentially invalid after the single escalation is
   * marked per thought for pending review — never silent continuation.
   */
  private async organizeVerifiedV2(
    transcriptRecord: TranscriptRecord,
    transcript: Transcript,
    allowlist: BucketOption[],
    context?: ContextPacket,
    session?: SessionContext,
  ): Promise<{
    output: OrganizeOutputV2;
    lane: OrganizerV2;
    escalationUsed: boolean;
    provenance: Provenance[];
    invalid: Map<number, "unknown-id" | "invalid-route">;
  }> {
    const run = async (
      lane: OrganizerV2,
      escalationUsed: boolean,
    ): Promise<{
      output: OrganizeOutputV2;
      lane: OrganizerV2;
      escalationUsed: boolean;
      invalid: Map<number, "unknown-id" | "invalid-route">;
    }> => {
      const output = await lane.organizeV2(transcript, allowlist, context, session);
      return {
        output,
        lane,
        escalationUsed,
        invalid: this.validateAllowlistMembership(output, allowlist),
      };
    };

    const organizer = this.deps.organizerV2!;
    const escalation = this.deps.escalationOrganizerV2;
    let lane: Awaited<ReturnType<typeof run>>;
    try {
      lane = await run(organizer, false);
      const anyConfident = lane.output.thoughts.some(
        (t) => t.confidence >= ESCALATION_CONFIDENCE_FLOOR,
      );
      if (
        escalation !== undefined &&
        lane.output.thoughts.length > 0 &&
        (!anyConfident || lane.invalid.size > 0)
      ) {
        lane = await run(escalation, true);
      }
    } catch (err) {
      if (escalation === undefined) throw err;
      lane = await run(escalation, true);
    }

    // Provenance stays a hard blocker with the existing single-escalation
    // discipline (the escalation may already be consumed above).
    let provenance = this.verifyAllV2(transcriptRecord, lane.output);
    if (!provenance.ok && escalation !== undefined && !lane.escalationUsed) {
      this.emitProvenanceFailure(transcriptRecord, provenance.failures, true);
      lane = await run(escalation, true);
      provenance = this.verifyAllV2(transcriptRecord, lane.output);
    }
    if (!provenance.ok) {
      this.emitProvenanceFailure(transcriptRecord, provenance.failures, false);
      throw new ProvenanceError(provenance.failures);
    }
    return { ...lane, provenance: provenance.canonical };
  }

  /**
   * FR-3: an existing-mode ID must be a member of the exact scoped
   * request allowlist. Unknown/stale/cross-scope IDs are marked
   * per-thought; the engine boundary revalidates and fails closed.
   */
  private validateAllowlistMembership(
    output: OrganizeOutputV2,
    allowlist: BucketOption[],
  ): Map<number, "unknown-id" | "invalid-route"> {
    const ids = new Set(allowlist.map((option) => option.id));
    const invalid = new Map<number, "unknown-id" | "invalid-route">();
    output.thoughts.forEach((thought, index) => {
      const placement = thought.placement;
      if (placement.mode === "existing" && !ids.has(placement.bucketId)) {
        invalid.set(index, "unknown-id");
      }
    });
    return invalid;
  }

  private verifyAllV2(
    transcriptRecord: TranscriptRecord,
    output: OrganizeOutputV2,
  ):
    | { ok: true; canonical: Provenance[] }
    | { ok: false; failures: Array<{ outputIndex: number; reason: string }> } {
    const canonical: Provenance[] = [];
    const failures: Array<{ outputIndex: number; reason: string }> = [];
    output.thoughts.forEach((thought, outputIndex) => {
      const result = this.verifier.verify(transcriptRecord, {
        captureId: transcriptRecord.captureId,
        segmentIds: thought.provenance.segmentIds,
      });
      if (result.ok) {
        canonical[outputIndex] = result.provenance;
      } else {
        failures.push({ outputIndex, reason: result.reason });
      }
    });
    return failures.length === 0
      ? { ok: true, canonical }
      : { ok: false, failures };
  }

  /**
   * Run the default lane, escalate at most once (schema failure, all
   * low-confidence, or invalid provenance), then fail closed if provenance
   * is still invalid.
   */
  private async organizeVerified(
    transcriptRecord: TranscriptRecord,
    transcript: Parameters<Organizer["organize"]>[0],
    buckets: Parameters<Organizer["organize"]>[1],
    context?: ContextPacket,
    session?: SessionContext,
  ): Promise<LaneOutput & { provenance: Provenance[] }> {
    let lane = await this.organizeWithEscalation(transcript, buckets, context, session);
    let provenance = this.verifyAll(transcriptRecord, lane.output);
    if (
      !provenance.ok &&
      this.deps.escalationOrganizer !== undefined &&
      !lane.escalationUsed
    ) {
      this.emitProvenanceFailure(transcriptRecord, provenance.failures, true);
      lane = {
        output: await this.deps.escalationOrganizer.organize(
          transcript,
          buckets,
          context,
          session,
        ),
        lane: this.deps.escalationOrganizer,
        escalationUsed: true,
      };
      provenance = this.verifyAll(transcriptRecord, lane.output);
    }
    if (!provenance.ok) {
      this.emitProvenanceFailure(transcriptRecord, provenance.failures, false);
      throw new ProvenanceError(provenance.failures);
    }
    return { ...lane, provenance: provenance.canonical };
  }

  private async organizeWithEscalation(
    transcript: Parameters<Organizer["organize"]>[0],
    buckets: Parameters<Organizer["organize"]>[1],
    context?: ContextPacket,
    session?: SessionContext,
  ): Promise<LaneOutput> {
    const { organizer, escalationOrganizer } = this.deps;
    try {
      const out = await organizer.organize(transcript, buckets, context, session);
      const anyConfident = out.thoughts.some(
        (t) => t.confidence >= ESCALATION_CONFIDENCE_FLOOR,
      );
      if (!anyConfident && escalationOrganizer && out.thoughts.length > 0) {
        return {
          output: await escalationOrganizer.organize(transcript, buckets, context, session),
          lane: escalationOrganizer,
          escalationUsed: true,
        };
      }
      return { output: out, lane: organizer, escalationUsed: false };
    } catch (err) {
      if (!escalationOrganizer) throw err;
      return {
        output: await escalationOrganizer.organize(transcript, buckets, context, session),
        lane: escalationOrganizer,
        escalationUsed: true,
      };
    }
  }

  private verifyAll(
    transcriptRecord: TranscriptRecord,
    output: OrganizeOutput,
  ):
    | { ok: true; canonical: Provenance[] }
    | { ok: false; failures: Array<{ outputIndex: number; reason: string }> } {
    const canonical: Provenance[] = [];
    const failures: Array<{ outputIndex: number; reason: string }> = [];
    output.thoughts.forEach((thought, outputIndex) => {
      const result = this.verifier.verify(transcriptRecord, {
        captureId: transcriptRecord.captureId,
        segmentIds: thought.provenance.segmentIds,
      });
      if (result.ok) {
        canonical[outputIndex] = result.provenance;
      } else {
        failures.push({ outputIndex, reason: result.reason });
      }
    });
    return failures.length === 0
      ? { ok: true, canonical }
      : { ok: false, failures };
  }

  private emitProvenanceFailure(
    transcriptRecord: TranscriptRecord,
    failures: Array<{ outputIndex: number; reason: string }>,
    escalating: boolean,
  ): void {
    // SR-3: identifiers, indexes, and reason tokens only — never text.
    this.deps.events?.emit({
      name: "provenance.invalid",
      tenantId: transcriptRecord.tenantId,
      userId: transcriptRecord.userId,
      attrs: {
        captureId: transcriptRecord.captureId,
        failures: failures.length,
        reasons: failures.map((f) => f.reason).join(","),
        escalating,
      },
    });
  }

  private toThought(
    capture: Capture,
    output: OrganizeOutput["thoughts"][number],
    provenance: Provenance,
    versions: DerivationVersions,
  ): Thought {
    return {
      id: randomUUID(),
      tenantId: capture.tenantId,
      userId: capture.userId,
      summary: output.summary,
      text: output.text,
      confidence: output.confidence,
      ...(output.task !== undefined ? { task: output.task } : {}),
      provenance,
      versions,
      createdAt: new Date().toISOString(),
    };
  }

  private emit(
    name: string,
    capture: Capture,
    attrs: Record<string, string | number | boolean>,
  ): void {
    this.deps.events?.emit({
      name,
      tenantId: capture.tenantId,
      userId: capture.userId,
      attrs,
    });
  }
}
