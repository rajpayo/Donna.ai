import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planChunks } from "./audio-chunker.js";

describe("planChunks", () => {
  it("returns a single chunk for short audio", () => {
    assert.deepEqual(planChunks(20, []), [
      { index: 0, startSec: 0, endSec: 20 },
    ]);
    assert.deepEqual(planChunks(45, []), [
      { index: 0, startSec: 0, endSec: 45 },
    ]);
  });

  it("rejects non-positive durations", () => {
    assert.throws(() => planChunks(0, []), /positive/);
    assert.throws(() => planChunks(-5, []), /positive/);
  });

  it("splits at the silence midpoint nearest each target boundary", () => {
    // 90s of audio with silences at 24-26s and 49-51s midpoints 25, 50.
    const chunks = planChunks(90, [
      { start: 24, end: 26 },
      { start: 49, end: 51 },
    ]);
    assert.equal(chunks.length, 3);
    assert.deepEqual(chunks[0], { index: 0, startSec: 0, endSec: 25 });
    assert.deepEqual(chunks[1], { index: 1, startSec: 25, endSec: 50 });
    assert.deepEqual(chunks[2], { index: 2, startSec: 50, endSec: 90 });
  });

  it("hard-cuts at maxSec when no silence exists in the window", () => {
    const chunks = planChunks(100, []);
    assert.equal(chunks.length, 3);
    assert.deepEqual(chunks[0], { index: 0, startSec: 0, endSec: 45 });
    assert.deepEqual(chunks[1], { index: 1, startSec: 45, endSec: 90 });
    assert.deepEqual(chunks[2], { index: 2, startSec: 90, endSec: 100 });
  });

  it("merges a tiny tail into the previous chunk", () => {
    // 46s total: first split would leave a 1s tail — merge it.
    const chunks = planChunks(46, []);
    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0], { index: 0, startSec: 0, endSec: 46 });
  });

  it("produces ordered, non-overlapping, full-coverage chunks", () => {
    const silences = [
      { start: 10, end: 10.5 },
      { start: 30, end: 31 },
      { start: 55, end: 55.4 },
      { start: 80, end: 81 },
    ];
    const chunks = planChunks(120, silences);
    assert.equal(chunks[0]!.startSec, 0);
    assert.equal(chunks[chunks.length - 1]!.endSec, 120);
    for (let i = 1; i < chunks.length; i++) {
      assert.equal(chunks[i]!.startSec, chunks[i - 1]!.endSec);
      assert.ok(chunks[i]!.endSec > chunks[i]!.startSec);
    }
    for (const c of chunks) {
      assert.ok(c.endSec - c.startSec <= 45.0001, `chunk ${c.index} too long`);
    }
  });

  it("ignores silences outside the audio bounds", () => {
    // 50s > 45s max, and neither out-of-bounds silence may be used, so the
    // split falls back to a hard cut at maxSec.
    const chunks = planChunks(50, [
      { start: -5, end: -1 },
      { start: 200, end: 210 },
    ]);
    assert.deepEqual(chunks, [
      { index: 0, startSec: 0, endSec: 45 },
      { index: 1, startSec: 45, endSec: 50 },
    ]);
  });
});
