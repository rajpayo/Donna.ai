/**
 * Organizer adapter for OpenAI-compatible chat models (gpt-5-mini, etc.)
 * using JSON-schema structured outputs.
 */
import type {
  Bucket,
  ContextPacket,
  OrganizeOutput,
  Organizer,
  SessionContext,
  Transcript,
} from "@donna/core";
import type { GatewayClient } from "./gateway.js";
import {
  buildOrganizePrompt,
  ORGANIZE_PROMPT_VERSION,
  ORGANIZE_SCHEMA_VERSION,
  type OrganizePromptVersion,
  organizeJsonSchema,
  organizeOutputSchema,
} from "./organize-schema.js";

interface ChatCompletionsResponse {
  choices: Array<{ message: { content: string } }>;
}

export class OpenAiCompatibleOrganizer implements Organizer {
  readonly schemaVersion = ORGANIZE_SCHEMA_VERSION;

  constructor(
    private readonly gateway: GatewayClient,
    readonly modelId: string,
    private readonly params: Record<string, unknown> = {},
    readonly promptVersion: OrganizePromptVersion = ORGANIZE_PROMPT_VERSION,
  ) {}

  async organize(
    transcript: Transcript,
    existingBuckets: Array<Pick<Bucket, "name" | "description">>,
    context?: ContextPacket,
    session?: SessionContext,
  ): Promise<OrganizeOutput> {
    const prompt = buildOrganizePrompt(
      transcript.text,
      transcript.segments,
      existingBuckets,
      context,
      session,
      this.promptVersion,
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
