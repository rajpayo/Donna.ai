/**
 * Core-loop orchestration: capture → transcribe → organize → embed →
 * place in dynamic buckets → persist.
 *
 * The organizer runs in two lanes: the cheap default lane first, and the
 * escalation lane when the default throws (schema failure) or returns only
 * low-confidence thoughts. This is where model routing lives — and nowhere
 * else.
 */
import { randomUUID } from "node:crypto";
import type {
  BucketStore,
  Capture,
  CoreLoop,
  CoreLoopResult,
  Embedder,
  EventSink,
  OrganizeOutput,
  Organizer,
  Thought,
  Transcriber,
} from "@donna/core";
import { BucketEngine, type BucketTuning } from "@donna/buckets";

const ESCALATION_CONFIDENCE_FLOOR = 0.5;

export interface PipelineDeps {
  transcriber: Transcriber;
  organizer: Organizer;
  escalationOrganizer?: Organizer;
  embedder: Embedder;
  store: BucketStore;
  bucketTuning: BucketTuning;
  events?: EventSink;
}

export class DonnaPipeline implements CoreLoop {
  private readonly engine: BucketEngine;

  constructor(private readonly deps: PipelineDeps) {
    this.engine = new BucketEngine(deps.store, deps.bucketTuning);
  }

  async run(capture: Capture): Promise<CoreLoopResult> {
    const t0 = Date.now();
    const { transcriber, organizer, embedder, store } = this.deps;

    const tStt = Date.now();
    const transcript = await transcriber.transcribe(capture);
    const sttLatencyMs = Date.now() - tStt;
    this.emit("stage.transcribe", capture, {
      model: transcriber.modelId,
      ms: sttLatencyMs,
    });

    const tOrg = Date.now();
    const buckets = await store.listBuckets(capture.tenantId, capture.userId);
    const output = await this.organizeWithEscalation(transcript, buckets);
    const organizeLatencyMs = Date.now() - tOrg;
    this.emit("stage.organize", capture, { ms: organizeLatencyMs });

    const tEmb = Date.now();
    const thoughts = await this.toThoughts(capture, output);
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
    for (const thought of thoughts) {
      const suggestion = output.thoughts.find(
        (o) => o.text === thought.text,
      );
      const placement = await this.engine.place(
        thought,
        {
          ...(suggestion?.suggestedBucket !== undefined
            ? { suggestedBucket: suggestion.suggestedBucket }
            : {}),
          ...(suggestion?.newBucketName !== undefined
            ? { newBucketName: suggestion.newBucketName }
            : {}),
          ...(suggestion?.newBucketDescription !== undefined
            ? { newBucketDescription: suggestion.newBucketDescription }
            : {}),
        },
        currentBuckets,
      );
      thought.bucketId = placement.bucket.id;
      await store.saveItem({ thought, bucketId: placement.bucket.id });
      if (placement.created) {
        bucketsCreated.push(placement.bucket);
        currentBuckets = [...currentBuckets, placement.bucket];
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

  private async organizeWithEscalation(
    transcript: Parameters<Organizer["organize"]>[0],
    buckets: Parameters<Organizer["organize"]>[1],
  ): Promise<OrganizeOutput> {
    const { organizer, escalationOrganizer } = this.deps;
    try {
      const out = await organizer.organize(transcript, buckets);
      const anyConfident = out.thoughts.some(
        (t) => t.confidence >= ESCALATION_CONFIDENCE_FLOOR,
      );
      if (!anyConfident && escalationOrganizer && out.thoughts.length > 0) {
        return await escalationOrganizer.organize(transcript, buckets);
      }
      return out;
    } catch (err) {
      if (!escalationOrganizer) throw err;
      return escalationOrganizer.organize(transcript, buckets);
    }
  }

  private async toThoughts(
    capture: Capture,
    output: OrganizeOutput,
  ): Promise<Thought[]> {
    return output.thoughts.map((o) => ({
      id: randomUUID(),
      tenantId: capture.tenantId,
      userId: capture.userId,
      summary: o.summary,
      text: o.text,
      confidence: o.confidence,
      ...(o.task !== undefined ? { task: o.task } : {}),
      provenance: { captureId: capture.id, ...o.provenance },
    }));
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
