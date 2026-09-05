/**
 * Specification 6.7 adapters: the v2 structured organizer and the
 * isolated bucket namer for OpenAI-compatible chat models (gpt-5-mini).
 *
 * Both validate their discriminated schemas adapter-side; the v2
 * organizer additionally rejects ID-bearing new names so a parroted
 * allowlist ID can never become a minted bucket name (FR-1/SR-2).
 * Schema/referential invalidity throws — the pipeline's single existing
 * escalation lane handles retry; there is no silent continuation.
 */
import type {
  BucketOption,
  ContextPacket,
  OrganizeOutputV2,
  OrganizerV2,
  BucketNamer,
  SessionContext,
  Transcript,
} from "@donna/core";
import type { GatewayClient } from "./gateway.js";
import {
  buildNamingPrompt,
  buildOrganizePromptV2,
  nameContainsIdReference,
  namingJsonSchema,
  namingOutputSchema,
  NAMING_SCHEMA_VERSION,
  ORGANIZE_SCHEMA_VERSION_V2,
  ORGANIZE_STRUCTURED_PROMPT_VERSION,
  organizeJsonSchemaV2,
  organizeOutputSchemaV2,
} from "./organize-schema.js";

interface ChatCompletionsResponse {
  choices: Array<{ message: { content: string } }>;
}

async function postStructured<T>(
  gateway: GatewayClient,
  modelId: string,
  params: Record<string, unknown>,
  prompt: string,
  jsonSchema: unknown,
  stage: string,
): Promise<unknown> {
  const res = await gateway.postJson<ChatCompletionsResponse>(
    "/chat/completions",
    {
      model: modelId,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_schema", json_schema: jsonSchema },
      ...params,
    },
    stage,
  );
  const content = res.choices[0]?.message.content;
  if (!content) throw new Error("Organizer returned empty content");
  // Strip nulls back to absent optionals before validating.
  return JSON.parse(content, (_k, v) => (v === null ? undefined : v));
}

export class OpenAiCompatibleOrganizerV2 implements OrganizerV2 {
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
    const raw = await postStructured(
      this.gateway,
      this.modelId,
      this.params,
      prompt,
      organizeJsonSchemaV2,
      "organize",
    );
    const output = organizeOutputSchemaV2.parse(raw);
    // FR-1/SR-2: a new-mode name must never carry an ID reference.
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

/**
 * The isolated naming-only retry adapter (FR-6). It receives immutable
 * extracted fields plus validator reasons and returns ONLY a candidate
 * name/description — it cannot modify thought, task, or provenance.
 */
export class OpenAiCompatibleBucketNamer implements BucketNamer {
  readonly schemaVersion = NAMING_SCHEMA_VERSION;

  constructor(
    private readonly gateway: GatewayClient,
    readonly modelId: string,
    private readonly params: Record<string, unknown> = {},
  ) {}

  async nameBucket(
    input: Parameters<BucketNamer["nameBucket"]>[0],
  ): Promise<{ name: string; description: string }> {
    const raw = await postStructured(
      this.gateway,
      this.modelId,
      this.params,
      buildNamingPrompt(input),
      namingJsonSchema,
      "organize-naming",
    );
    const output = namingOutputSchema.parse(raw);
    if (
      nameContainsIdReference(
        output.name,
        input.allowlist.map((option) => option.id),
      )
    ) {
      throw new Error("donna.organize-naming.v1: name carries an ID reference");
    }
    return output;
  }
}
