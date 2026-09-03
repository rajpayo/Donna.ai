#!/usr/bin/env node
/**
 * Regenerate the synthetic STT fixtures (Specification 4.1/4.2).
 *
 * Reads the transcribe dataset (datasets/golden/transcribe/transcribe.v1.json),
 * synthesizes each case's referenceText with espeak-ng into
 * fixtures/audio/ (gitignored — audio NEVER enters git, only the
 * reference text and the SHA-256 hashes do), and verifies the generated
 * bytes against the hashes recorded in the dataset.
 *
 *   node fixtures/generate-stt-fixtures.mjs           # generate + verify
 *   node fixtures/generate-stt-fixtures.mjs --print   # also print hashes
 *
 * Exit code 0 when every fixture regenerates byte-identically (or the
 * dataset records `sha256: "unverified"`); 1 on any mismatch, so a local
 * espeak-ng version change is loud, never silent.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const datasetPath = join(here, "../datasets/golden/transcribe/transcribe.v1.json");
const audioDir = join(here, "audio");

const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
await mkdir(audioDir, { recursive: true });

let mismatches = 0;
for (const testCase of dataset.cases) {
  const { voice, speedWpm, sha256, file } = testCase.audio;
  const outPath = join(audioDir, file);
  await execFileAsync("espeak-ng", [
    "-v", voice,
    "-s", String(speedWpm),
    "-w", outPath,
    testCase.referenceText,
  ]);
  const bytes = await readFile(outPath);
  const actual = createHash("sha256").update(bytes).digest("hex");
  const expected = sha256;
  const match = actual === expected;
  if (!match) mismatches += 1;
  console.log(
    `${match ? "ok" : "MISMATCH"}  ${testCase.id}  ${file}  sha256=${actual}` +
      (match ? "" : ` (dataset records ${expected})`),
  );
}

if (mismatches > 0) {
  console.error(
    `\n${mismatches} fixture(s) differ from the recorded hashes. If the local ` +
      `espeak-ng version changed intentionally, update the dataset hashes and ` +
      `bump the dataset version with an adjudication entry.`,
  );
  process.exit(1);
}
console.log(`\n${dataset.cases.length} fixtures regenerated and verified.`);
