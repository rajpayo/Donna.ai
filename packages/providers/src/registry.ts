/**
 * Model registry — reads models.config.yaml and instantiates the adapters.
 *
 * This is the single integration point that makes models swappable:
 * the rest of the system only ever sees core ports. Add a new provider
 * adapter file, reference it here, and any catalog model can be wired in
 * from config.
 */
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import type { Embedder, Organizer, Transcriber } from "@donna/core";
import type { GatewayClient } from "./gateway.js";
import { OpenAiCompatibleTranscriber } from "./openai-transcriber.js";
import { OpenAiCompatibleOrganizer } from "./openai-organizer.js";
import { AnthropicOrganizer } from "./anthropic-organizer.js";
import { OpenAiCompatibleEmbedder } from "./openai-embedder.js";

const laneSchema = z.object({
  provider: z.enum(["openai-compatible", "anthropic"]),
  model: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
});

const configSchema = z.object({
  version: z.number(),
  stages: z.object({
    transcribe: z.object({ default: laneSchema, escalation: laneSchema.optional() }),
    organize: z.object({ default: laneSchema, escalation: laneSchema.optional() }),
    embed: z.object({ default: laneSchema }),
    tts: z.object({ default: laneSchema }).optional(),
  }),
  buckets: z
    .object({
      assign_threshold: z.number().default(0.82),
      create_threshold: z.number().default(0.65),
    })
    .default({ assign_threshold: 0.82, create_threshold: 0.65 }),
  // Spec 2.2: context assembly budgets — configurable here, never in code.
  context: z
    .object({
      max_tokens: z.number().int().positive(),
      max_items: z.number().int().positive(),
      recent_captures: z.number().int().nonnegative(),
      max_memories: z.number().int().nonnegative(),
      max_bucket_summaries: z.number().int().nonnegative(),
      max_correction_examples: z.number().int().nonnegative(),
    })
    .default({
      max_tokens: 1200,
      max_items: 24,
      recent_captures: 3,
      max_memories: 12,
      max_bucket_summaries: 10,
      max_correction_examples: 3,
    })
    .transform((c) => ({
      maxTokens: c.max_tokens,
      maxItems: c.max_items,
      recentCaptures: c.recent_captures,
      maxMemories: c.max_memories,
      maxBucketSummaries: c.max_bucket_summaries,
      maxCorrectionExamples: c.max_correction_examples,
    })),
});

export type ModelsConfig = z.infer<typeof configSchema>;
export type Lane = z.infer<typeof laneSchema>;

export async function loadModelsConfig(path: string): Promise<ModelsConfig> {
  const raw = await readFile(path, "utf8");
  return configSchema.parse(parse(raw));
}

export interface ResolvedStack {
  transcriber: Transcriber;
  organizer: Organizer;
  escalationOrganizer?: Organizer;
  embedder: Embedder;
  bucketTuning: ModelsConfig["buckets"];
  /** Spec 2.2 context assembly budgets from models.config.yaml. */
  contextBudgets: ModelsConfig["context"];
}

function makeOrganizer(gateway: GatewayClient, lane: Lane): Organizer {
  switch (lane.provider) {
    case "openai-compatible":
      return new OpenAiCompatibleOrganizer(gateway, lane.model, lane.params);
    case "anthropic":
      return new AnthropicOrganizer(gateway, lane.model, lane.params);
  }
}

export function resolveStack(
  gateway: GatewayClient,
  config: ModelsConfig,
): ResolvedStack {
  const t = config.stages.transcribe.default;
  const e = config.stages.embed.default;
  const escalation = config.stages.organize.escalation;
  return {
    transcriber: new OpenAiCompatibleTranscriber(gateway, t.model, t.params),
    organizer: makeOrganizer(gateway, config.stages.organize.default),
    ...(escalation !== undefined
      ? { escalationOrganizer: makeOrganizer(gateway, escalation) }
      : {}),
    embedder: new OpenAiCompatibleEmbedder(gateway, e.model, e.params),
    bucketTuning: config.buckets,
    contextBudgets: config.context,
  };
}
