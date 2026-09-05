/**
 * Deterministic provenance verification (Specification 1.2).
 *
 * The organizer LLM PROPOSES source segments; this verifier decides. A
 * proposal is accepted only when every cited segment ID exists in the
 * stored transcript for the SAME capture, the list is non-empty and free
 * of duplicates, and every referenced segment has finite, ordered bounds.
 * On acceptance the canonical sourceText/startSec/endSec are derived from
 * the stored segments — model-generated text and bounds are discarded.
 *
 * Rejection reasons are stable machine-readable tokens so telemetry and
 * tests can assert on them without inspecting source text (SR-3).
 */
import type {
  ProvenanceVerification,
  ProvenanceVerifier,
  TranscriptRecord,
  TranscriptSegment,
} from "@donna/core";

export const PROVENANCE_REJECTIONS = {
  crossCapture: "cross-capture-reference",
  empty: "empty-segment-references",
  duplicate: "duplicate-segment-references",
  unknown: "unknown-segment-reference",
  invalidBounds: "invalid-segment-bounds",
  emptySource: "empty-source-text",
} as const;

export class DeterministicProvenanceVerifier implements ProvenanceVerifier {
  verify(
    transcript: TranscriptRecord,
    proposal: { captureId: string; segmentIds: string[] },
  ): ProvenanceVerification {
    if (proposal.captureId !== transcript.captureId) {
      return { ok: false, reason: PROVENANCE_REJECTIONS.crossCapture };
    }
    if (proposal.segmentIds.length === 0) {
      return { ok: false, reason: PROVENANCE_REJECTIONS.empty };
    }
    if (new Set(proposal.segmentIds).size !== proposal.segmentIds.length) {
      return { ok: false, reason: PROVENANCE_REJECTIONS.duplicate };
    }

    const byId = new Map(transcript.segments.map((s) => [s.id, s]));
    const referenced: TranscriptSegment[] = [];
    for (const id of proposal.segmentIds) {
      const segment = byId.get(id);
      if (segment === undefined) {
        return { ok: false, reason: PROVENANCE_REJECTIONS.unknown };
      }
      referenced.push(segment);
    }

    for (const segment of referenced) {
      if (
        !Number.isFinite(segment.startSec) ||
        !Number.isFinite(segment.endSec) ||
        segment.startSec < 0 ||
        segment.endSec < segment.startSec
      ) {
        return { ok: false, reason: PROVENANCE_REJECTIONS.invalidBounds };
      }
    }

    // Canonicalize: cite segments in time order, derive the source window
    // and text from the stored segments alone.
    const ordered = [...referenced].sort((a, b) => a.startSec - b.startSec);
    const sourceText = ordered
      .map((s) => s.text.trim())
      .filter((t) => t.length > 0)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (sourceText.length === 0) {
      return { ok: false, reason: PROVENANCE_REJECTIONS.emptySource };
    }

    const first = ordered[0]!;
    const last = ordered[ordered.length - 1]!;
    return {
      ok: true,
      provenance: {
        captureId: transcript.captureId,
        segmentIds: ordered.map((s) => s.id),
        sourceText,
        startSec: first.startSec,
        endSec: last.endSec,
      },
    };
  }
}

/** Thrown when organizer output remains provenance-invalid after the
 * single permitted escalation. The run fails closed: no thoughts persist. */
export class ProvenanceError extends Error {
  constructor(
    readonly failures: Array<{ outputIndex: number; reason: string }>,
  ) {
    super(
      `Organizer output failed deterministic provenance verification: ` +
        failures
          .map((f) => `thought#${f.outputIndex} (${f.reason})`)
          .join(", "),
    );
    this.name = "ProvenanceError";
  }
}
