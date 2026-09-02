/**
 * STT adapter — gpt-4o-transcribe (or any catalog transcribe model) via the
 * OpenAI-compatible /audio/transcriptions endpoint.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Capture, Transcriber, Transcript } from "@donna/core";
import type { GatewayClient } from "./gateway.js";

interface TranscriptionVerboseJson {
  text: string;
  language?: string;
  segments?: Array<{ id: number; start: number; end: number; text: string }>;
}

export class OpenAiCompatibleTranscriber implements Transcriber {
  constructor(
    private readonly gateway: GatewayClient,
    readonly modelId: string,
    private readonly params: Record<string, unknown> = {},
  ) {}

  async transcribe(capture: Capture): Promise<Transcript> {
    const audio = await readFile(capture.audioPath);
    const form = new FormData();
    form.set(
      "file",
      new Blob([audio]), basename(capture.audioPath),
    );
    form.set("model", this.modelId);
    // verbose_json gives us per-segment timestamps — required for provenance.
    form.set("response_format", "verbose_json");
    form.set("timestamp_granularities[]", "segment");
    for (const [k, v] of Object.entries(this.params)) {
      if (k !== "response_format") form.set(k, String(v));
    }

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
}
