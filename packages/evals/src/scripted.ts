/**
 * Scripted adapters and gateway metering (Specification 4.2).
 *
 * Deterministic mode runs the REAL pipeline/stores/engines with scripted
 * model adapters, so the plumbing (provenance, placement, memory,
 * corrections, retrieval indexing) is evaluated exactly, offline, and
 * reproducibly. Live mode swaps in the gateway-backed adapters from
 * models.config.yaml — model quality is then measured end to end.
 *
 * ScriptedEmbedder is a deterministic bag-of-words hashing embedder:
 * texts sharing content tokens land near each other, so the bucket
 * engine's cosine thresholds behave sensibly without any model calls.
 *
 * MeteredGatewayClient wraps the real gateway client and records the
 * usage each response reports (tokens, and cost when the gateway provides
 * it). Cost is NEVER estimated — when the gateway reports no usage, the
 * metrics record missing, per the documented missing-data behavior.
 */
import { createHash } from "node:crypto";
import type {
  Embedder,
  OrganizeOutput,
  Organizer,
  Transcriber,
  Transcript,
} from "@donna/core";
import { GatewayClient } from "@donna/providers";

/* ------------------------------------------------------------------ */
/* Scripted embedder                                                   */
/* ------------------------------------------------------------------ */

export class ScriptedEmbedder implements Embedder {
  readonly modelId = "scripted-bow-hash";
  readonly dimensions: number;
  private readonly dims: number;

  constructor(dims = 256) {
    this.dims = dims;
    this.dimensions = dims;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = new Array<number>(this.dims).fill(0);
      const tokens = text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 2);
      for (const token of tokens) {
        const digest = createHash("sha256").update(token).digest();
        vector[digest[0]! % this.dims]! += 1;
        vector[digest[1]! % this.dims]! += 0.5; // second byte reduces collisions
      }
      const norm = Math.sqrt(vector.reduce((a, b) => a + b * b, 0)) || 1;
      return vector.map((x) => x / norm);
    });
  }
}

/* ------------------------------------------------------------------ */
/* Scripted transcriber                                                */
/* ------------------------------------------------------------------ */

/** Replays a fixed transcript per capture ID (deterministic full-loop mode). */
export class ScriptedTranscriber implements Transcriber {
  readonly modelId = "scripted-transcriber";

  constructor(
    private readonly scripts: Map<string, { text: string; durationSec: number }>,
  ) {}

  async transcribe(capture: { id: string }): Promise<Transcript> {
    const script = this.scripts.get(capture.id);
    if (script === undefined) {
      throw new Error(`No scripted transcript for capture ${capture.id}`);
    }
    return {
      captureId: capture.id,
      text: script.text,
      segments: [
        { id: "seg-0", text: script.text, startSec: 0, endSec: script.durationSec },
      ],
      language: "en",
      model: this.modelId,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Scripted organizer                                                  */
/* ------------------------------------------------------------------ */

export interface ScriptedThought {
  summary: string;
  text: string;
  confidence: number;
  suggestedBucket?: string;
  newBucketName?: string;
  newBucketDescription?: string;
  task?: { title: string; assigneeHint?: string; dueHint?: string };
}

/**
 * Replays scripted organizer outputs per capture ID. Provenance cites the
 * single scripted segment; the pipeline's verifier canonicalizes it, so
 * persisted thoughts carry real provenance.
 */
export class ScriptedOrganizer implements Organizer {
  readonly modelId = "scripted-organizer";
  readonly schemaVersion = "donna.organize.v1";
  readonly promptVersion = "scripted-replay";

  constructor(private readonly scripts: Map<string, ScriptedThought[]>) {}

  async organize(transcript: Transcript): Promise<OrganizeOutput> {
    const thoughts = this.scripts.get(transcript.captureId);
    if (thoughts === undefined) {
      throw new Error(`No scripted organizer output for capture ${transcript.captureId}`);
    }
    const segment = transcript.segments[0]!;
    return {
      thoughts: thoughts.map((t) => ({
        summary: t.summary,
        text: t.text,
        confidence: t.confidence,
        ...(t.suggestedBucket !== undefined ? { suggestedBucket: t.suggestedBucket } : {}),
        ...(t.newBucketName !== undefined ? { newBucketName: t.newBucketName } : {}),
        ...(t.newBucketDescription !== undefined
          ? { newBucketDescription: t.newBucketDescription }
          : {}),
        ...(t.task !== undefined ? { task: t.task } : {}),
        provenance: {
          segmentIds: [segment.id],
          sourceText: segment.text,
          startSec: segment.startSec,
          endSec: segment.endSec,
        },
      })),
    };
  }
}

/* ------------------------------------------------------------------ */
/* Gateway metering                                                    */
/* ------------------------------------------------------------------ */

export interface UsageRecord {
  stage: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** USD, only when the gateway reports a cost field. Never estimated. */
  costUsd?: number;
}

interface UsagePayload {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Anthropic-compatible usage names. */
  input_tokens?: number;
  output_tokens?: number;
  cost?: number;
  cost_usd?: number;
}

/**
 * A GatewayClient that records per-call usage. Adapters are unchanged —
 * they receive this client transparently (ports/adapters preserved).
 */
export class MeteredGatewayClient extends GatewayClient {
  readonly usage: UsageRecord[] = [];

  override async postJson<T>(path: string, body: unknown, stage: string): Promise<T> {
    const res = await super.postJson<T>(path, body, stage);
    this.record(stage, res);
    return res;
  }

  override async postForm<T>(path: string, form: FormData, stage: string): Promise<T> {
    const res = await super.postForm<T>(path, form, stage);
    this.record(stage, res);
    return res;
  }

  private record(stage: string, res: unknown): void {
    const usage = (res as { usage?: UsagePayload } | null)?.usage;
    if (usage === undefined || usage === null) return;
    const record: UsageRecord = { stage };
    const prompt = usage.prompt_tokens ?? usage.input_tokens;
    const completion = usage.completion_tokens ?? usage.output_tokens;
    if (prompt !== undefined) record.promptTokens = prompt;
    if (completion !== undefined) record.completionTokens = completion;
    if (usage.total_tokens !== undefined) {
      record.totalTokens = usage.total_tokens;
    } else if (prompt !== undefined || completion !== undefined) {
      record.totalTokens = (prompt ?? 0) + (completion ?? 0);
    }
    const cost = usage.cost_usd ?? usage.cost;
    if (cost !== undefined) record.costUsd = cost;
    this.usage.push(record);
  }

  totals(): { promptTokens: number; completionTokens: number; costUsd: number | null } {
    let promptTokens = 0;
    let completionTokens = 0;
    let costUsd: number | null = null;
    for (const record of this.usage) {
      promptTokens += record.promptTokens ?? 0;
      completionTokens += record.completionTokens ?? 0;
      if (record.costUsd !== undefined) {
        costUsd = (costUsd ?? 0) + record.costUsd;
      }
    }
    return { promptTokens, completionTokens, costUsd };
  }
}
