/**
 * STT stage scorer (Specification 4.2): word error rate plus
 * entity/task/date preservation.
 *
 * Fixtures are synthetic espeak-ng recordings with known scripts — git
 * holds only the reference text and the audio SHA-256 (never audio). The
 * scorer regenerates the fixture via fixtures/generate-stt-fixtures.mjs
 * semantics (same espeak-ng invocation) and verifies the hash before
 * transcribing; a hash mismatch is a case note, not a silent pass.
 *
 * Metrics (all documented in METRIC_DOCS):
 *   - stt.wer: Levenshtein word distance / reference words, after
 *     normalization (lowercase, punctuation stripped, whitespace
 *     collapsed). Lower is better; the case passes at ≤ expect.maxWer.
 *   - stt.entity_preservation / stt.date_preservation / stt.task_preservation:
 *     fraction of the expected phrases present in the hypothesis
 *     (normalized substring match).
 *
 * This stage needs the live gateway (the transcriber is a model). Without
 * credentials every case errors as external-flaky — never a fake pass.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Transcriber } from "@donna/core";
import type { LoadedCase } from "../datasets.js";
import type { StageContext, StageScorer } from "../harness.js";
import type { CaseOutcome } from "../report.js";

const execFileAsync = promisify(execFile);

interface TranscribePayload {
  referenceText: string;
  audio: {
    generator: "espeak-ng";
    voice: string;
    speedWpm: number;
    sha256: string;
    file: string;
  };
  expect: {
    maxWer: number;
    entities: string[];
    dates: string[];
    tasks: string[];
  };
}

/** Number words ↔ digits, so "three percent" matches "3 percent". */
const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15",
  sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20",
};

/**
 * Normalize for fair comparison: case, punctuation, whitespace, percent
 * sign (→ " percent"), and number words (→ digits). Standard WER
 * normalization — STT models legitimately choose digits over words.
 */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/%/g, " percent")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => NUMBER_WORDS[w] ?? w);
}

/** Word error rate: Levenshtein word distance / reference word count. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  // Standard DP edit distance over word sequences.
  const rows = ref.length + 1;
  const cols = hyp.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () =>
    new Array<number>(cols).fill(0),
  );
  for (let i = 0; i < rows; i++) dp[i]![0] = i;
  for (let j = 0; j < cols; j++) dp[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const substitution = dp[i - 1]![j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      dp[i]![j] = Math.min(substitution, dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1);
    }
  }
  return dp[ref.length]![hyp.length]! / ref.length;
}

/** Fraction of expected phrases present in the hypothesis (normalized). */
export function phrasePreservation(expected: string[], hypothesis: string): number | undefined {
  if (expected.length === 0) return undefined; // excluded from the denominator
  const normalizedHyp = normalizeWords(hypothesis).join(" ");
  const present = expected.filter((phrase) =>
    normalizedHyp.includes(normalizeWords(phrase).join(" ")),
  );
  return present.length / expected.length;
}

/** Regenerate the espeak-ng fixture and verify its recorded hash. */
async function ensureFixture(
  payload: TranscribePayload,
  audioDir: string,
): Promise<{ path: string; hashMatch: boolean }> {
  await mkdir(audioDir, { recursive: true });
  const path = join(audioDir, payload.audio.file);
  await execFileAsync("espeak-ng", [
    "-v", payload.audio.voice,
    "-s", String(payload.audio.speedWpm),
    "-w", path,
    payload.referenceText,
  ]);
  const bytes = await readFile(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { path, hashMatch: sha256 === payload.audio.sha256 };
}

export interface SttScorerOptions {
  /** The configured transcriber (live gateway). Undefined → external-flaky. */
  transcriber?: Transcriber;
  /** Directory fixtures are regenerated into (must be isolated). */
  fixturesDir: string;
}

export function createSttScorer(options: SttScorerOptions): StageScorer {
  return {
    stage: "transcribe",
    cohortKeys: ["accent", "noise", "language"],
    async score(testCase: LoadedCase, context: StageContext): Promise<CaseOutcome[]> {
      const payload = testCase.payload as unknown as TranscribePayload;
      if (options.transcriber === undefined) {
        return [{
          caseId: testCase.id,
          scores: {},
          hardFailures: [],
          error: { class: "external-flaky", token: "gateway-credentials-absent" },
        }];
      }

      const started = Date.now();
      let fixture;
      try {
        fixture = await ensureFixture(payload, options.fixturesDir);
      } catch {
        return [{
          caseId: testCase.id,
          scores: {},
          hardFailures: [],
          error: { class: "external-flaky", token: "espeak-ng-unavailable" },
        }];
      }

      try {
        const transcript = await options.transcriber.transcribe({
          id: `eval-stt-${testCase.id}`,
          tenantId: context.scope.tenantId,
          userId: context.scope.userId,
          audioPath: fixture.path,
          capturedAt: new Date().toISOString(),
        });
        const hypothesis = transcript.text;
        const wer = wordErrorRate(payload.referenceText, hypothesis);
        const scores: Record<string, number> = { "stt.wer": wer };
        const entity = phrasePreservation(payload.expect.entities, hypothesis);
        const date = phrasePreservation(payload.expect.dates, hypothesis);
        const task = phrasePreservation(payload.expect.tasks, hypothesis);
        if (entity !== undefined) scores["stt.entity_preservation"] = entity;
        if (date !== undefined) scores["stt.date_preservation"] = date;
        if (task !== undefined) scores["stt.task_preservation"] = task;
        const notes = [`maxWer:${payload.expect.maxWer}`, `wer-pass:${wer <= payload.expect.maxWer}`];
        if (!fixture.hashMatch) notes.push("audio-hash-mismatch");
        return [{
          caseId: testCase.id,
          scores,
          hardFailures: [],
          latencyMs: Date.now() - started,
          notes,
        }];
      } catch (error) {
        // Gateway/network failures are external-flaky; a malformed response
        // from an otherwise healthy gateway is a product error.
        const message = (error as Error).message;
        const isGateway = /Gateway \d|fetch|ECONN|ETIMEDOUT|network/i.test(message);
        return [{
          caseId: testCase.id,
          scores: {},
          hardFailures: [],
          error: {
            class: isGateway ? "external-flaky" : "product",
            token: isGateway ? "gateway-request-failed" : "transcriber-output-invalid",
          },
          latencyMs: Date.now() - started,
        }];
      }
    },
  };
}
