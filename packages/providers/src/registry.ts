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
import type { AnswerGenerator, Embedder, Organizer, Transcriber } from "@donna/core";
import type { GatewayClient } from "./gateway.js";
import { OpenAiCompatibleTranscriber } from "./openai-transcriber.js";
import { OpenAiCompatibleOrganizer } from "./openai-organizer.js";
import { AnthropicOrganizer } from "./anthropic-organizer.js";
import { OpenAiCompatibleEmbedder } from "./openai-embedder.js";
import { OpenAiCompatibleAnswerGenerator } from "./answer-generator.js";

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
      // Spec 5.2: cap on external M365 context snippets per packet.
      max_external_snippets: z.number().int().nonnegative(),
    })
    .default({
      max_tokens: 1200,
      max_items: 24,
      recent_captures: 3,
      max_memories: 12,
      max_bucket_summaries: 10,
      max_correction_examples: 3,
      max_external_snippets: 6,
    })
    .transform((c) => ({
      maxTokens: c.max_tokens,
      maxItems: c.max_items,
      recentCaptures: c.recent_captures,
      maxMemories: c.max_memories,
      maxBucketSummaries: c.max_bucket_summaries,
      maxCorrectionExamples: c.max_correction_examples,
      maxExternalSnippets: c.max_external_snippets,
    })),
  // Spec 3.3: hybrid retrieval ranking — versioned features/weights,
  // tunable here, never in code.
  retrieval: z
    .object({
      ranking_version: z.string().default("donna.hybrid-ranking.v1"),
      weights: z
        .object({
          text: z.number(),
          semantic: z.number(),
          bucket_affinity: z.number(),
          recency: z.number(),
          personalization: z.number(),
          task_match: z.number(),
        })
        .default({
          text: 0.3,
          semantic: 0.3,
          bucket_affinity: 0.1,
          recency: 0.1,
          personalization: 0.15,
          task_match: 0.05,
        }),
      recency_half_life_days: z.number().positive().default(30),
      candidate_limit: z.number().int().positive().default(100),
      min_score: z.number().min(0).max(1).default(0.2),
      answer: laneSchema.optional(),
      rerank: laneSchema.optional(),
    })
    .default({
      ranking_version: "donna.hybrid-ranking.v1",
      weights: {
        text: 0.3,
        semantic: 0.3,
        bucket_affinity: 0.1,
        recency: 0.1,
        personalization: 0.15,
        task_match: 0.05,
      },
      recency_half_life_days: 30,
      candidate_limit: 100,
      min_score: 0.2,
    })
    .transform((r) => ({
      rankingVersion: r.ranking_version,
      weights: {
        text: r.weights.text,
        semantic: r.weights.semantic,
        bucketAffinity: r.weights.bucket_affinity,
        recency: r.weights.recency,
        personalization: r.weights.personalization,
        taskMatch: r.weights.task_match,
      },
      recencyHalfLifeDays: r.recency_half_life_days,
      candidateLimit: r.candidate_limit,
      minScore: r.min_score,
      answer: r.answer,
      rerank: r.rerank,
    })),
  // Spec 2.3/3.3: correction adherence applicability threshold (semantic
  // path; deterministic keyword fallback when no embedder is available).
  corrections: z
    .object({
      adherence_semantic_threshold: z.number().min(0).max(1).default(0.75),
    })
    .default({ adherence_semantic_threshold: 0.75 })
    .transform((c) => ({
      adherenceSemanticThreshold: c.adherence_semantic_threshold,
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
  /** Spec 3.3 retrieval ranking configuration from models.config.yaml. */
  retrieval: ModelsConfig["retrieval"];
  /** Spec 3.3 grounded-answer generator, when the answer lane is configured. */
  answerGenerator?: AnswerGenerator;
  /** Spec 2.3/3.3 corrections tuning from models.config.yaml. */
  corrections: ModelsConfig["corrections"];
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
  const answerLane = config.retrieval.answer;
  return {
    transcriber: new OpenAiCompatibleTranscriber(gateway, t.model, t.params),
    organizer: makeOrganizer(gateway, config.stages.organize.default),
    ...(escalation !== undefined
      ? { escalationOrganizer: makeOrganizer(gateway, escalation) }
      : {}),
    embedder: new OpenAiCompatibleEmbedder(gateway, e.model, e.params),
    bucketTuning: config.buckets,
    contextBudgets: config.context,
    retrieval: config.retrieval,
    ...(answerLane !== undefined
      ? {
          answerGenerator: new OpenAiCompatibleAnswerGenerator(
            gateway,
            answerLane.model,
            answerLane.params,
          ),
        }
      : {}),
    corrections: config.corrections,
  };
}
