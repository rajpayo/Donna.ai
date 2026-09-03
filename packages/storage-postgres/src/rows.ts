/**
 * Row ↔ domain mappers (Specification 3.2). JSONB columns carry the
 * nested domain structures verbatim (segments, provenance, versions,
 * task, sources, payload, target); scalar columns map snake_case ↔
 * camelCase. Timestamps map timestamptz ↔ ISO 8601 strings.
 */
import type {
  Bucket,
  CaptureRecord,
  ConsentRecord,
  CorrectionEvent,
  MemoryEvent,
  MemoryProposal,
  MemoryRecord,
  Thought,
  TranscriptRecord,
} from "@donna/core";
import { isoString, parseVector } from "./client.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export function bucketFromRow(row: any): Bucket {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    centroid: parseVector(row.centroid) ?? [],
    itemCount: row.item_count,
    createdAt: isoString(row.created_at)!,
    origin: row.origin,
  };
}

export function thoughtFromRow(row: any): Thought {
  const createdAt = isoString(row.created_at);
  return {
    id: row.thought_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    summary: row.summary,
    text: row.text,
    confidence: row.confidence,
    ...(row.task !== null && row.task !== undefined ? { task: row.task } : {}),
    provenance: row.provenance,
    versions: row.versions,
    ...(parseVector(row.embedding) !== undefined
      ? { embedding: parseVector(row.embedding) }
      : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

export function captureFromRow(row: any): CaptureRecord {
  const audioDeletedAt = isoString(row.audio_deleted_at);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    contentHash: row.content_hash,
    capturedAt: isoString(row.captured_at)!,
    ...(row.duration_sec !== null && row.duration_sec !== undefined
      ? { durationSec: row.duration_sec }
      : {}),
    ...(audioDeletedAt !== undefined ? { audioDeletedAt } : {}),
  };
}

export function transcriptFromRow(row: any): TranscriptRecord {
  return {
    captureId: row.capture_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    text: row.text,
    segments: row.segments,
    ...(row.language !== null && row.language !== undefined
      ? { language: row.language }
      : {}),
    model: row.model,
    contentHash: row.content_hash,
    createdAt: isoString(row.created_at)!,
  };
}

export function memoryFromRow(row: any): MemoryRecord {
  const expiresAt = isoString(row.expires_at);
  const supersededAt = isoString(row.superseded_at);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    layer: row.layer,
    status: row.status,
    origin: row.origin,
    text: row.text,
    kind: row.kind,
    subject: row.subject,
    confidence: row.confidence,
    sources: row.sources,
    createdAt: isoString(row.created_at)!,
    updatedAt: isoString(row.updated_at)!,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(row.session_id !== null && row.session_id !== undefined
      ? { sessionId: row.session_id }
      : {}),
    ...(row.superseded_by !== null && row.superseded_by !== undefined
      ? { supersededBy: row.superseded_by }
      : {}),
    ...(supersededAt !== undefined ? { supersededAt } : {}),
  };
}

export function proposalFromRow(row: any): MemoryProposal {
  const resolvedAt = isoString(row.resolved_at);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    layer: row.layer,
    text: row.text,
    kind: row.kind,
    subject: row.subject,
    confidence: row.confidence,
    sources: row.sources,
    proposedBy: row.proposed_by,
    createdAt: isoString(row.created_at)!,
    status: row.status,
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
  };
}

export function memoryEventFromRow(row: any): MemoryEvent {
  return {
    at: isoString(row.at)!,
    type: row.type,
    tenantId: row.tenant_id,
    userId: row.user_id,
    ...(row.memory_id !== null && row.memory_id !== undefined
      ? { memoryId: row.memory_id }
      : {}),
    ...(row.proposal_id !== null && row.proposal_id !== undefined
      ? { proposalId: row.proposal_id }
      : {}),
    ...(row.detail !== null && row.detail !== undefined
      ? { detail: row.detail }
      : {}),
  };
}

export function consentFromRow(row: any): ConsentRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    purpose: row.purpose,
    granted: row.granted,
    grantedAt: isoString(row.granted_at)!,
    channel: row.channel,
  };
}

export function correctionFromRow(row: any): CorrectionEvent {
  const resolvedAt = isoString(row.resolved_at);
  const appliedAt = isoString(row.applied_at);
  const sharedAt = isoString(row.shared_at);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    type: row.type,
    createdAt: isoString(row.created_at)!,
    target: row.target,
    payload: row.payload,
    sources: row.sources,
    status: row.status,
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
    ...(appliedAt !== undefined ? { appliedAt } : {}),
    ...(row.contradicted_by !== null && row.contradicted_by !== undefined
      ? { contradictedBy: row.contradicted_by }
      : {}),
    ...(sharedAt !== undefined ? { sharedAt } : {}),
    followedCount: row.followed_count,
    contradictedCount: row.contradicted_count,
  };
}
