/**
 * Embedder adapter — text-embedding-3-large via the OpenAI-compatible
 * /embeddings endpoint, with Matryoshka dimension truncation.
 */
import type { Embedder } from "@donna/core";
import type { GatewayClient } from "./gateway.js";

interface EmbeddingsResponse {
  data: Array<{ embedding: number[] }>;
}

export class OpenAiCompatibleEmbedder implements Embedder {
  readonly dimensions: number;

  constructor(
    private readonly gateway: GatewayClient,
    readonly modelId: string,
    params: Record<string, unknown> = {},
  ) {
    this.dimensions = Number(params["dimensions"] ?? 1024);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.gateway.postJson<EmbeddingsResponse>(
      "/embeddings",
      {
        model: this.modelId,
        input: texts,
        dimensions: this.dimensions,
      },
      "embed",
    );
    return res.data.map((d) => d.embedding);
  }
}
