/**
 * Organizer adapter for Anthropic models (claude-sonnet-5, etc.) via the
 * gateway, using a forced tool call as the structured-output mechanism.
 */
import type { Bucket, OrganizeOutput, Organizer, Transcript } from "@donna/core";
import type { GatewayClient } from "./gateway.js";
import {
  buildOrganizePrompt,
  ORGANIZE_PROMPT_VERSION,
  ORGANIZE_SCHEMA_VERSION,
  organizeOutputSchema,
} from "./organize-schema.js";

interface AnthropicMessagesResponse {
  content: Array<{ type: string; input?: unknown; text?: string }>;
}

const ORGANIZE_TOOL = {
  name: "emit_organized_thoughts",
  description: "Emit the distilled, bucket-assigned thoughts as structured data.",
  input_schema: {
    type: "object",
    required: ["thoughts"],
    properties: {
      thoughts: {
        type: "array",
        items: {
          type: "object",
          required: ["summary", "text", "confidence", "provenance"],
          properties: {
            summary: { type: "string" },
            text: { type: "string" },
            confidence: { type: "number" },
            suggestedBucket: { type: "string" },
            newBucketName: { type: "string" },
            newBucketDescription: { type: "string" },
            task: {
              type: "object",
              required: ["title"],
              properties: {
                title: { type: "string" },
                assigneeHint: { type: "string" },
                dueHint: { type: "string" },
              },
            },
            provenance: {
              type: "object",
              required: ["segmentIds", "sourceText", "startSec", "endSec"],
              properties: {
                segmentIds: { type: "array", items: { type: "string" } },
                sourceText: { type: "string" },
                startSec: { type: "number" },
                endSec: { type: "number" },
              },
            },
          },
        },
      },
    },
  },
} as const;

export class AnthropicOrganizer implements Organizer {
  readonly schemaVersion = ORGANIZE_SCHEMA_VERSION;
  readonly promptVersion = ORGANIZE_PROMPT_VERSION;

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

    const res = await this.gateway.postJson<AnthropicMessagesResponse>(
      "/messages",
      {
        model: this.modelId,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
        tools: [ORGANIZE_TOOL],
        tool_choice: { type: "tool", name: ORGANIZE_TOOL.name },
        ...this.params,
      },
      "organize",
    );

    const toolBlock = res.content.find((b) => b.type === "tool_use");
    if (!toolBlock?.input) {
      throw new Error("Anthropic organizer returned no tool_use block");
    }
    return organizeOutputSchema.parse(toolBlock.input);
  }
}
