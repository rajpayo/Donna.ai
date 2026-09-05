/**
 * Specification 6.7 adapter: the v2 structured organizer for Anthropic
 * models via the gateway, using a forced tool call as the
 * structured-output mechanism. Config-selected only; 6.7 runs no Sonnet
 * lane — this adapter exists for contract parity and rollback symmetry.
 */
import type {
  BucketOption,
  ContextPacket,
  OrganizeOutputV2,
  OrganizerV2,
  SessionContext,
  Transcript,
} from "@donna/core";
import type { GatewayClient } from "./gateway.js";
import {
  buildOrganizePromptV2,
  nameContainsIdReference,
  ORGANIZE_SCHEMA_VERSION_V2,
  ORGANIZE_STRUCTURED_PROMPT_VERSION,
  organizeOutputSchemaV2,
} from "./organize-schema.js";

interface AnthropicMessagesResponse {
  content: Array<{ type: string; input?: unknown; text?: string }>;
}

const ORGANIZE_TOOL_V2 = {
  name: "emit_organized_thoughts_v2",
  description:
    "Emit the distilled thoughts as structured data, each with exactly one placement branch.",
  input_schema: {
    type: "object",
    required: ["thoughts"],
    properties: {
      thoughts: {
        type: "array",
        items: {
          type: "object",
          required: ["summary", "text", "confidence", "provenance", "placement"],
          properties: {
            summary: { type: "string" },
            text: { type: "string" },
            confidence: { type: "number" },
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
            placement: {
              anyOf: [
                {
                  type: "object",
                  required: ["mode", "bucketId"],
                  properties: {
                    mode: { type: "string", enum: ["existing"] },
                    bucketId: { type: "string" },
                  },
                },
                {
                  type: "object",
                  required: ["mode", "name", "description"],
                  properties: {
                    mode: { type: "string", enum: ["new"] },
                    name: { type: "string" },
                    description: { type: "string" },
                  },
                },
              ],
            },
          },
        },
      },
    },
  },
} as const;

export class AnthropicOrganizerV2 implements OrganizerV2 {
  readonly schemaVersion = ORGANIZE_SCHEMA_VERSION_V2;
  readonly promptVersion = ORGANIZE_STRUCTURED_PROMPT_VERSION;

  constructor(
    private readonly gateway: GatewayClient,
    readonly modelId: string,
    private readonly params: Record<string, unknown> = {},
  ) {}

  async organizeV2(
    transcript: Transcript,
    allowlist: BucketOption[],
    context?: ContextPacket,
    session?: SessionContext,
  ): Promise<OrganizeOutputV2> {
    const prompt = buildOrganizePromptV2(
      transcript.text,
      transcript.segments,
      allowlist,
      context,
      session,
    );
    const res = await this.gateway.postJson<AnthropicMessagesResponse>(
      "/messages",
      {
        model: this.modelId,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
        tools: [ORGANIZE_TOOL_V2],
        tool_choice: { type: "tool", name: ORGANIZE_TOOL_V2.name },
        ...this.params,
      },
      "organize",
    );
    const toolBlock = res.content.find((b) => b.type === "tool_use");
    if (!toolBlock?.input) {
      throw new Error("Anthropic organizer returned no tool_use block");
    }
    const output = organizeOutputSchemaV2.parse(toolBlock.input);
    const ids = allowlist.map((option) => option.id);
    for (const thought of output.thoughts) {
      if (
        thought.placement.mode === "new" &&
        nameContainsIdReference(thought.placement.name, ids)
      ) {
        throw new Error("donna.organize.v2: new-bucket name carries an ID reference");
      }
    }
    return output;
  }
}
