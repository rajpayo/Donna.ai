/**
 * Silence-aware audio chunking for STT models without native segment
 * timestamps. The company gateway's gpt-4o-transcribe supports only
 * response_format json|text — no verbose_json, no segments.
 *
 * The chunk plan is computed from real silence detection (ffmpeg
 * silencedetect); each chunk is extracted as its own file and transcribed
 * separately, so every segment's [startSec, endSec] is exactly the audio
 * window that produced its text. Provenance stays truthful — granularity
 * is chunk-level rather than sentence-level.
 *
 * ffmpeg/ffprobe are runtime dependencies of the chunked path only.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AudioChunk {
  index: number;
  startSec: number;
  endSec: number;
}

export interface SilenceInterval {
  start: number;
  end: number;
}

export interface ChunkPlanOptions {
  /** Aim for chunks around this length. */
  targetSec?: number;
  /** Never exceed this chunk length. */
  maxSec?: number;
  /** Tail shorter than this merges into the previous chunk. */
  minTailSec?: number;
}

const DEFAULTS: Required<ChunkPlanOptions> = {
  targetSec: 25,
  maxSec: 45,
  minTailSec: 2,
};

/**
 * Pure chunk planner — unit-tested without ffmpeg.
 *
 * Splits at the silence midpoint closest to each target boundary, falling
 * back to a hard cut at maxSec when no silence exists in the window.
 * Boundaries are ordered, non-overlapping, and cover [0, durationSec].
 */
export function planChunks(
  durationSec: number,
  silences: SilenceInterval[],
  options: ChunkPlanOptions = {},
): AudioChunk[] {
  const { targetSec, maxSec, minTailSec } = { ...DEFAULTS, ...options };
  if (!(durationSec > 0)) {
    throw new Error("Audio duration must be positive");
  }
  if (durationSec <= maxSec) {
    return [{ index: 0, startSec: 0, endSec: durationSec }];
  }

  const midpoints = silences
    .map((s) => (s.start + s.end) / 2)
    .filter((m) => m > 0 && m < durationSec)
    .sort((a, b) => a - b);

  const boundaries: number[] = [];
  let cursor = 0;
  while (durationSec - cursor > maxSec) {
    const windowStart = cursor + targetSec;
    const windowEnd = cursor + maxSec;
    const candidates = midpoints.filter(
      (m) => m >= windowStart - targetSec / 2 && m <= windowEnd,
    );
    const split =
      candidates.length > 0
        ? candidates.reduce((best, m) =>
            Math.abs(m - windowStart) < Math.abs(best - windowStart) ? m : best,
          )
        : windowEnd;
    boundaries.push(split);
    cursor = split;
  }

  // Merge a tiny tail into the final chunk.
  if (boundaries.length > 0) {
    const last = boundaries[boundaries.length - 1]!;
    if (durationSec - last < minTailSec) boundaries.pop();
  }

  const edges = [0, ...boundaries, durationSec];
  return edges.slice(0, -1).map((startSec, index) => ({
    index,
    startSec,
    endSec: edges[index + 1]!,
  }));
}

export async function probeDurationSec(audioPath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    audioPath,
  ]);
  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("ffprobe could not determine audio duration");
  }
  return duration;
}

/** Detect silences via ffmpeg silencedetect (writes to stderr). */
export async function detectSilences(
  audioPath: string,
  noiseDb = -35,
  minSilenceSec = 0.4,
): Promise<SilenceInterval[]> {
  let stderr = "";
  try {
    await execFileAsync("ffmpeg", [
      "-v",
      "info",
      "-i",
      audioPath,
      "-af",
      `silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}`,
      "-f",
      "null",
      "-",
    ]);
  } catch (err) {
    // ffmpeg exits non-zero when writing to null on some builds; the
    // silencedetect output is on stderr either way.
    stderr = (err as { stderr?: string }).stderr ?? "";
    if (stderr === "") throw err;
  }
  if (stderr === "") return [];

  const silences: SilenceInterval[] = [];
  let open: number | undefined;
  for (const line of stderr.split("\n")) {
    const start = line.match(/silence_start:\s*([\d.]+)/);
    if (start) {
      open = Number.parseFloat(start[1]!);
      continue;
    }
    const end = line.match(/silence_end:\s*([\d.]+)/);
    if (end && open !== undefined) {
      silences.push({ start: open, end: Number.parseFloat(end[1]!) });
      open = undefined;
    }
  }
  return silences;
}

/** Extract [startSec, endSec] of input into outPath as 16 kHz mono wav. */
export async function extractChunk(
  inputPath: string,
  chunk: AudioChunk,
  outPath: string,
): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-ss",
    chunk.startSec.toFixed(3),
    "-i",
    inputPath,
    "-t",
    (chunk.endSec - chunk.startSec).toFixed(3),
    "-ar",
    "16000",
    "-ac",
    "1",
    outPath,
  ]);
}

/** Run `fn` with a fresh temp directory that is always removed after. */
export async function withChunkWorkspace<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "donna-chunks-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
