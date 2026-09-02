/**
 * Organizer adapter for OpenAI-compatible chat models (gpt-5-mini, etc.)
 * using JSON-schema structured outputs.
 */
import type { Bucket, OrganizeOutput, Organizer, Transcript } from "@donna/core";
import type { GatewayClient } from "./gateway.js";
import {
  buildOrganizePrompt,
  organizeJsonSchema,
  organizeOutputSchema,
} from "./organize-schema.js";

interface ChatCompletionsResponse {
  choices: Array<{ message: { content: string } }>;
}

export class OpenAiCompatibleOrganizer implements Organizer {
  constructor(
    private readonly gateway: GatewayClient,
    readonly modelId: string,
    private readonly params: Record<string, unknown> = {},
  ) {}

  async organize(
    transcript: Transcript,
    existingBuckets: Array<Pick<Bucket, "name" | "description">>,
  ): Promise<OrganizeOutput> {
    const prompt = buildOrganizePrompt(
      transcript.text,
      transcript.segments,
      existingBuckets,
    );

    const res = await this.gateway.postJson<ChatCompletionsResponse>(
      "/chat/completions",
      {
        model: this.modelId,
        messages: [{ role: "user", content: prompt }],
        response_format: {
          type: "json_schema",
          json_schema: organizeJsonSchema,
        },
        ...this.params,
      },
      "organize",
    );

    const content = res.choices[0]?.message.content;
    if (!content) throw new Error("Organizer returned empty content");

    // Strip nulls back to absent optionals before validating.
    const raw = JSON.parse(content, (_k, v) => (v === null ? undefined : v));
    return organizeOutputSchema.parse(raw);
  }
}
