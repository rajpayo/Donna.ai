/**
 * STT adapter — gpt-4o-transcribe (or any catalog transcribe model) via the
 * OpenAI-compatible /audio/transcriptions endpoint.
 *
 * Timestamp strategy: the adapter first requests verbose_json segments
 * (native per-segment timestamps). Some gateway deployments — including the
 * current company catalog — serve models that reject verbose_json and return
 * plain text only. In that case the adapter falls back to silence-aware
 * local chunking (see audio-chunker.ts): each chunk is transcribed
 * separately and its [startSec, endSec] is exactly the audio window sent to
 * the model, so provenance remains truthful at chunk granularity.
 */
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Capture, Transcriber, Transcript } from "@donna/core";
import { GatewayError, type GatewayClient } from "./gateway.js";
import {
  detectSilences,
  extractChunk,
  planChunks,
  probeDurationSec,
  withChunkWorkspace,
} from "./audio-chunker.js";

interface TranscriptionVerboseJson {
  text: string;
  language?: string;
  segments?: Array<{ id: number; start: number; end: number; text: string }>;
}

interface TranscriptionJson {
  text: string;
}

/** True when the gateway says this model cannot do verbose_json. */
function isVerboseJsonUnsupported(err: unknown): boolean {
  return (
    err instanceof GatewayError &&
    err.status === 400 &&
    err.body.includes("verbose_json")
  );
}

export class OpenAiCompatibleTranscriber implements Transcriber {
  constructor(
    private readonly gateway: GatewayClient,
    readonly modelId: string,
    private readonly params: Record<string, unknown> = {},
  ) {}

  async transcribe(capture: Capture): Promise<Transcript> {
    try {
      return await this.transcribeNativeSegments(capture);
    } catch (err) {
      if (!isVerboseJsonUnsupported(err)) throw err;
      return this.transcribeChunked(capture);
    }
  }

  /** Native path: one request, model-supplied segment timestamps. */
  private async transcribeNativeSegments(capture: Capture): Promise<Transcript> {
    const audio = await readFile(capture.audioPath);
    const form = this.baseForm(audio, capture.audioPath);
    form.set("response_format", "verbose_json");
    form.set("timestamp_granularities[]", "segment");

    const res = await this.gateway.postForm<TranscriptionVerboseJson>(
      "/audio/transcriptions",
      form,
      "transcribe",
    );

    const segments = (res.segments ?? []).map((s, i) => ({
      id: `seg-${i}`,
      text: s.text,
      startSec: s.start,
      endSec: s.end,
    }));

    return {
      captureId: capture.id,
      text: res.text,
      segments,
      ...(res.language !== undefined ? { language: res.language } : {}),
      model: this.modelId,
    };
  }

  /**
   * Fallback path: chunk locally, transcribe each chunk as plain JSON,
   * and derive segment bounds from the chunk windows actually sent.
   */
  private async transcribeChunked(capture: Capture): Promise<Transcript> {
    const durationSec = await probeDurationSec(capture.audioPath);
    const silences = await detectSilences(capture.audioPath);
    const chunks = planChunks(durationSec, silences);

    return withChunkWorkspace(async (dir) => {
      const segments: Transcript["segments"] = [];
      const texts: string[] = [];

      for (const chunk of chunks) {
        const chunkPath = join(dir, `chunk-${chunk.index}.wav`);
        await extractChunk(capture.audioPath, chunk, chunkPath);
        const audio = await readFile(chunkPath);

        const form = this.baseForm(audio, basename(chunkPath));
        form.set("response_format", "json");
        const res = await this.gateway.postForm<TranscriptionJson>(
          "/audio/transcriptions",
          form,
          "transcribe",
        );

        const text = res.text.trim();
        if (text.length === 0) continue;
        texts.push(text);
        segments.push({
          id: `seg-${segments.length}`,
          text,
          startSec: chunk.startSec,
          endSec: chunk.endSec,
        });
      }

      return {
        captureId: capture.id,
        text: texts.join(" "),
        segments,
        model: this.modelId,
      };
    });
  }

  private baseForm(audio: Buffer, filename: string): FormData {
    const form = new FormData();
    form.set("file", new Blob([audio]), filename);
    form.set("model", this.modelId);
    for (const [k, v] of Object.entries(this.params)) {
      if (k !== "response_format") form.set(k, String(v));
    }
    return form;
  }
}
