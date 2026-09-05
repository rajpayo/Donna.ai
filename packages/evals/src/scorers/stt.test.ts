/**
 * STT scorer unit tests (Specification 4.2): WER math, phrase
 * preservation, and the credential-absent classification.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";
import type { Transcriber } from "@donna/core";
import { createSttScorer, normalizeWords, phrasePreservation, wordErrorRate } from "./stt.js";
import type { LoadedCase } from "../datasets.js";
import type { StageContext } from "../harness.js";

describe("wordErrorRate", () => {
  it("is 0 for identical text and 1 for wholly different text", () => {
    assert.equal(wordErrorRate("the quick brown fox", "the quick brown fox"), 0);
    assert.equal(wordErrorRate("the quick brown fox", "a b c d"), 1);
  });

  it("counts substitutions, deletions, insertions over reference words", () => {
    // ref 4 words; hyp substitutes one → 1/4
    assert.equal(wordErrorRate("the quick brown fox", "the slow brown fox"), 0.25);
    // one deletion over 4 reference words → 1/4
    assert.equal(wordErrorRate("the quick brown fox", "the brown fox"), 0.25);
    // two substitutions over 4 reference words → 1/2
    assert.equal(wordErrorRate("the quick brown fox", "the quick red wolf"), 0.5);
    // insertion: 5 words vs 4 → 1/4
    assert.equal(wordErrorRate("the quick brown fox", "the quick brown fox jumps"), 0.25);
  });

  it("normalizes case and punctuation", () => {
    assert.equal(wordErrorRate("Send the deck, please.", "send the deck please"), 0);
  });
});

describe("phrasePreservation", () => {
  it("returns undefined for empty expectations (excluded from denominator)", () => {
    assert.equal(phrasePreservation([], "anything"), undefined);
  });
  it("matches case-insensitively and punctation-tolerantly", () => {
    assert.equal(phrasePreservation(["Arjun", "pricing deck"], "Send the Pricing Deck to Arjun."), 1);
    assert.equal(phrasePreservation(["Arjun", "Meera"], "send it to Arjun"), 0.5);
  });
});

describe("stt scorer", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "donna-stt-test-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const testCase = {
    id: "case-1",
    meta: {
      provenance: "synthetic",
      labeler: "labeler:test",
      consent: "not-required-synthetic",
      sensitivity: "none",
    },
    payload: {
      referenceText: "Remind me to send the pricing deck to Arjun by Thursday.",
      audio: {
        generator: "espeak-ng",
        voice: "en-us",
        speedWpm: 160,
        sha256: "0".repeat(64),
        file: "test-case.wav",
      },
      expect: {
        maxWer: 0.35,
        entities: ["Arjun", "pricing deck"],
        dates: ["Thursday"],
        tasks: ["send the pricing deck"],
      },
    },
  } as LoadedCase;

  const context = (): StageContext => ({
    scope: { tenantId: "eval-tenant", userId: "eval-user" },
    scratchDir: dir,
    snapshot: undefined as never,
  });
  const fixtureGenerator = async () => ({
    path: join(dir, "test-case.wav"),
    hashMatch: false,
  });

  it("errors external-flaky without a transcriber (never a fake pass)", async () => {
    const scorer = createSttScorer({ fixturesDir: dir });
    const [outcome] = await scorer.score(testCase, context());
    assert.equal(outcome!.error?.class, "external-flaky");
    assert.equal(outcome!.error?.token, "gateway-credentials-absent");
  });

  it("classifies an unavailable fixture generator without faking scores", async () => {
    const transcriber: Transcriber = {
      modelId: "stub-stt",
      async transcribe() {
        throw new Error("must not be called");
      },
    };
    const scorer = createSttScorer({
      transcriber,
      fixturesDir: dir,
      fixtureGenerator: async () => {
        throw new Error("fixture generator unavailable");
      },
    });
    const [outcome] = await scorer.score(testCase, context());
    assert.deepEqual(outcome!.scores, {});
    assert.equal(outcome!.error?.class, "external-flaky");
    assert.equal(outcome!.error?.token, "espeak-ng-unavailable");
  });

  it("scores WER and preservation with a stubbed transcriber", async () => {
    const transcriber: Transcriber = {
      modelId: "stub-stt",
      async transcribe() {
        return {
          captureId: "x",
          text: "Remind me to send the pricing deck to Arjun by Thursday.",
          segments: [{ id: "seg-0", text: "x", startSec: 0, endSec: 4 }],
          model: "stub-stt",
        };
      },
    };
    const scorer = createSttScorer({
      transcriber,
      fixturesDir: dir,
      fixtureGenerator,
    });
    const [outcome] = await scorer.score(testCase, context());
    assert.equal(outcome!.error, undefined);
    assert.equal(outcome!.scores["stt.wer"], 0);
    assert.equal(outcome!.scores["stt.entity_preservation"], 1);
    assert.equal(outcome!.scores["stt.date_preservation"], 1);
    assert.equal(outcome!.scores["stt.task_preservation"], 1);
    // The fixture hash deliberately mismatches here — noted, not hidden.
    assert.ok(outcome!.notes!.includes("audio-hash-mismatch"));
  });

  it("a degraded transcription reduces the expected metrics (AC-1)", async () => {
    const badTranscriber: Transcriber = {
      modelId: "stub-stt-bad",
      async transcribe() {
        return {
          captureId: "x",
          text: "something completely unrelated was said here today",
          segments: [{ id: "seg-0", text: "x", startSec: 0, endSec: 4 }],
          model: "stub-stt-bad",
        };
      },
    };
    const scorer = createSttScorer({
      transcriber: badTranscriber,
      fixturesDir: dir,
      fixtureGenerator,
    });
    const [outcome] = await scorer.score(testCase, context());
    assert.ok(outcome!.scores["stt.wer"]! > 0.5);
    assert.equal(outcome!.scores["stt.entity_preservation"], 0);
    assert.equal(outcome!.scores["stt.task_preservation"], 0);
  });
});
