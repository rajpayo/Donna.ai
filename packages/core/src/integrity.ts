/**
 * Content-integrity helpers for persisted records.
 *
 * Every persisted capture/transcript carries a SHA-256 content hash that is
 * recomputed on read; a mismatch fails closed. Hashes are computed over a
 * canonical JSON serialization (sorted keys, no whitespace) so they are
 * stable across processes and property insertion order.
 */
import { createHash } from "node:crypto";
import type { TranscriptSegment } from "./types.js";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, sortKeys(v)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

/** Hash the content that defines a transcript's meaning. */
export function hashTranscriptContent(content: {
  captureId: string;
  tenantId: string;
  userId: string;
  text: string;
  segments: TranscriptSegment[];
  language?: string;
  model: string;
}): string {
  return sha256Hex(canonicalJson(content));
}
