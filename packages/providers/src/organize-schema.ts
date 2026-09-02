/**
 * The structured-output contract for the Organize stage, plus the prompt.
 *
 * Schema validity is a hard requirement: the pipeline validates every
 * response against this and routes failures to the escalation lane.
 */
import { z } from "zod";
import type { OrganizeOutput } from "@donna/core";

/**
 * Contract versions attached to every derived thought (Spec 1.2 FR-4).
 * Bump when the structured-output schema or the prompt template changes so
 * stored thoughts record exactly what produced them.
 */
export const ORGANIZE_SCHEMA_VERSION = "donna.organize.v1";
export const ORGANIZE_PROMPT_VERSION = "donna.organize-prompt.v1";

export const organizeOutputSchema = z.object({
  thoughts: z.array(
    z.object({
      summary: z.string().min(1),
      text: z.string().min(1),
      confidence: z.number().min(0).max(1),
      suggestedBucket: z.string().optional(),
      newBucketName: z.string().optional(),
      newBucketDescription: z.string().optional(),
      task: z
        .object({
          title: z.string().min(1),
          assigneeHint: z.string().optional(),
          dueHint: z.string().optional(),
        })
        .optional(),
      provenance: z.object({
        segmentIds: z.array(z.string()),
        sourceText: z.string().min(1),
        startSec: z.number(),
        endSec: z.number(),
      }),
    }),
  ),
}) satisfies z.ZodType<OrganizeOutput>;

/** JSON Schema form, for OpenAI-style response_format. */
export const organizeJsonSchema = {
  name: "donna_organize",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["thoughts"],
    properties: {
      thoughts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "summary",
            "text",
            "confidence",
            "suggestedBucket",
            "newBucketName",
            "newBucketDescription",
            "task",
            "provenance",
          ],
          properties: {
            summary: { type: "string" },
            text: { type: "string" },
            confidence: { type: "number" },
            suggestedBucket: { type: ["string", "null"] },
            newBucketName: { type: ["string", "null"] },
            newBucketDescription: { type: ["string", "null"] },
            task: {
              type: ["object", "null"],
              additionalProperties: false,
              required: ["title", "assigneeHint", "dueHint"],
              properties: {
                title: { type: "string" },
                assigneeHint: { type: ["string", "null"] },
                dueHint: { type: ["string", "null"] },
              },
            },
            provenance: {
              type: "object",
              additionalProperties: false,
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

export function buildOrganizePrompt(
  transcriptText: string,
  segments: Array<{ id: string; startSec: number; endSec: number; text: string }>,
  existingBuckets: Array<{ name: string; description: string }>,
): string {
  const bucketList =
    existingBuckets.length > 0
      ? existingBuckets
          .map((b) => `- "${b.name}": ${b.description}`)
          .join("\n")
      : "(none yet — this user's mind is a blank page)";

  const segmentList = segments
    .map((s) => `[${s.id} ${s.startSec.toFixed(1)}-${s.endSec.toFixed(1)}s] ${s.text}`)
    .join("\n");

  return `You are the organization engine for a voice-first notes product used by busy executives, founders, and managers.

The user spoke a stream of messy, possibly mixed thoughts. Your job: distill the stream into ATOMIC thoughts and place each one where it belongs.

Rules:
1. Split mixed content — one thought per item. Never bundle two unrelated ideas.
2. Prefer an EXISTING bucket when one genuinely fits (set "suggestedBucket"). Buckets are the user's mental filing system; do not create near-duplicates.
3. If nothing fits, propose "newBucketName" (short, human, e.g. "Hiring", "Product Ideas", "Investor Updates") plus a one-line "newBucketDescription". A thought that is a commitment or action for someone MUST land in a "Tasks" bucket — reuse it if present, create it if not.
4. If a thought contains a commitment, promise, or action item, fill "task" with a clean title and any assignee/due hints actually stated. Do not invent assignees or dates.
5. Every thought must carry provenance: the segment IDs it came from and the verbatim source text.
6. Set "confidence" honestly — low confidence routes the item to human review, which is cheap; a wrong confident sort destroys trust, which is expensive.
7. Never log, echo, or editorialise beyond the schema. Output JSON only.

EXISTING BUCKETS:
${bucketList}

TRANSCRIPT SEGMENTS:
${segmentList}

FULL TEXT:
${transcriptText}`;
}
