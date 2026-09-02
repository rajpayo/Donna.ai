import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptRecord } from "@donna/core";
import {
  DeterministicProvenanceVerifier,
  PROVENANCE_REJECTIONS,
} from "./provenance.js";

const VERIFIER = new DeterministicProvenanceVerifier();

function transcriptRecord(
  segments: TranscriptRecord["segments"],
  captureId = "capture-1",
): TranscriptRecord {
  return {
    captureId,
    tenantId: "tenant-a",
    userId: "user-1",
    text: segments.map((s) => s.text).join(" "),
    segments,
    model: "gpt-4o-transcribe",
    contentHash: "not-checked-by-verifier",
    createdAt: "2026-09-02T00:00:00.000Z",
  };
}

const THREE_SEGMENTS = transcriptRecord([
  { id: "seg-0", text: "first idea", startSec: 0, endSec: 2.5 },
  { id: "seg-1", text: "second idea", startSec: 2.5, endSec: 5 },
  { id: "seg-2", text: "a promise to send the deck", startSec: 5, endSec: 9 },
]);

describe("DeterministicProvenanceVerifier", () => {
  it("accepts a valid proposal and canonicalizes from stored segments", () => {
    const result = VERIFIER.verify(THREE_SEGMENTS, {
      captureId: "capture-1",
      segmentIds: ["seg-0", "seg-1"],
    });
    assert.ok(result.ok);
    assert.deepEqual(result.provenance, {
      captureId: "capture-1",
      segmentIds: ["seg-0", "seg-1"],
      sourceText: "first idea second idea",
      startSec: 0,
      endSec: 5,
    });
  });

  it("derives canonical bounds and text, ignoring model-supplied values", () => {
    // The verifier never sees model-supplied sourceText/startSec/endSec;
    // the canonical output comes from the stored segments alone.
    const result = VERIFIER.verify(THREE_SEGMENTS, {
      captureId: "capture-1",
      segmentIds: ["seg-2"],
    });
    assert.ok(result.ok);
    assert.equal(result.provenance.sourceText, "a promise to send the deck");
    assert.equal(result.provenance.startSec, 5);
    assert.equal(result.provenance.endSec, 9);
  });

  it("re-orders out-of-order segment citations into time order", () => {
    const result = VERIFIER.verify(THREE_SEGMENTS, {
      captureId: "capture-1",
      segmentIds: ["seg-2", "seg-0"],
    });
    assert.ok(result.ok);
    assert.deepEqual(result.provenance.segmentIds, ["seg-0", "seg-2"]);
    assert.equal(result.provenance.startSec, 0);
    assert.equal(result.provenance.endSec, 9);
    assert.equal(result.provenance.sourceText, "first idea a promise to send the deck");
  });

  it("rejects empty segment references", () => {
    const result = VERIFIER.verify(THREE_SEGMENTS, {
      captureId: "capture-1",
      segmentIds: [],
    });
    assert.ok(!result.ok);
    assert.equal(result.reason, PROVENANCE_REJECTIONS.empty);
  });

  it("rejects unknown segment IDs", () => {
    const result = VERIFIER.verify(THREE_SEGMENTS, {
      captureId: "capture-1",
      segmentIds: ["seg-0", "seg-99"],
    });
    assert.ok(!result.ok);
    assert.equal(result.reason, PROVENANCE_REJECTIONS.unknown);
  });

  it("rejects duplicate segment references", () => {
    const result = VERIFIER.verify(THREE_SEGMENTS, {
      captureId: "capture-1",
      segmentIds: ["seg-1", "seg-1"],
    });
    assert.ok(!result.ok);
    assert.equal(result.reason, PROVENANCE_REJECTIONS.duplicate);
  });

  it("rejects references to a different capture (cross-capture)", () => {
    const otherCapture = transcriptRecord(
      [{ id: "seg-0", text: "other capture words", startSec: 0, endSec: 3 }],
      "capture-2",
    );
    // Segment IDs that exist in capture-2 but are claimed for capture-1's
    // transcript are simply unknown there.
    const wrongTranscript = VERIFIER.verify(THREE_SEGMENTS, {
      captureId: "capture-1",
      segmentIds: ["seg-0"],
    });
    assert.ok(wrongTranscript.ok); // seg-0 exists in capture-1 too

    const mismatch = VERIFIER.verify(otherCapture, {
      captureId: "capture-1",
      segmentIds: ["seg-0"],
    });
    assert.ok(!mismatch.ok);
    assert.equal(mismatch.reason, PROVENANCE_REJECTIONS.crossCapture);
  });

  it("rejects non-finite or unordered stored segment bounds", () => {
    const nanBounds = transcriptRecord([
      { id: "seg-0", text: "broken", startSec: Number.NaN, endSec: 1 },
    ]);
    const reversed = transcriptRecord([
      { id: "seg-0", text: "broken", startSec: 5, endSec: 2 },
    ]);
    for (const record of [nanBounds, reversed]) {
      const result = VERIFIER.verify(record, {
        captureId: "capture-1",
        segmentIds: ["seg-0"],
      });
      assert.ok(!result.ok);
      assert.equal(result.reason, PROVENANCE_REJECTIONS.invalidBounds);
    }
  });

  it("rejects proposals whose referenced segments carry no text", () => {
    const blank = transcriptRecord([
      { id: "seg-0", text: "   ", startSec: 0, endSec: 1 },
    ]);
    const result = VERIFIER.verify(blank, {
      captureId: "capture-1",
      segmentIds: ["seg-0"],
    });
    assert.ok(!result.ok);
    assert.equal(result.reason, PROVENANCE_REJECTIONS.emptySource);
  });
});
