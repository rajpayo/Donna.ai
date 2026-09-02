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
  sha256Hex,
  type AudioStore,
  type AuditLog,
  type BucketStore,
  type Capture,
  type CaptureStore,
  type CoreLoop,
  type CoreLoopResult,
  type DerivationVersions,
  type Embedder,
  type EventSink,
  type OrganizeOutput,
  type Organizer,
  type Provenance,
  type ProvenanceVerifier,
  type Thought,
  type Transcriber,
  type TranscriptRecord,
  type TranscriptStore,
} from "@donna/core";
import { BucketEngine, type BucketTuning } from "@donna/buckets";
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
    const organized = await this.organizeVerified(
      transcriptRecord,
      transcript,
      buckets,
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
      if (placement.created) {
        bucketsCreated.push(placement.bucket);
        currentBuckets = [...currentBuckets, placement.bucket];
      } else {
        // Keep centroid/itemCount fresh for later thoughts in this capture.
        currentBuckets = currentBuckets.map((b) =>
          b.id === placement.bucket.id ? placement.bucket : b,
        );
      }
      items.push({ thought, bucket: placement.bucket, needsReview: placement.needsReview });
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
   * Run the default lane, escalate at most once (schema failure, all
   * low-confidence, or invalid provenance), then fail closed if provenance
   * is still invalid.
   */
  private async organizeVerified(
    transcriptRecord: TranscriptRecord,
    transcript: Parameters<Organizer["organize"]>[0],
    buckets: Parameters<Organizer["organize"]>[1],
  ): Promise<LaneOutput & { provenance: Provenance[] }> {
    let lane = await this.organizeWithEscalation(transcript, buckets);
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
  ): Promise<LaneOutput> {
    const { organizer, escalationOrganizer } = this.deps;
    try {
      const out = await organizer.organize(transcript, buckets);
      const anyConfident = out.thoughts.some(
        (t) => t.confidence >= ESCALATION_CONFIDENCE_FLOOR,
      );
      if (!anyConfident && escalationOrganizer && out.thoughts.length > 0) {
        return {
          output: await escalationOrganizer.organize(transcript, buckets),
          lane: escalationOrganizer,
          escalationUsed: true,
        };
      }
      return { output: out, lane: organizer, escalationUsed: false };
    } catch (err) {
      if (!escalationOrganizer) throw err;
      return {
        output: await escalationOrganizer.organize(transcript, buckets),
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
