/**
 * Memory stage scorer (Specification 4.2): proposal precision, correction
 * adherence, and conflict handling — run against the REAL memory and
 * correction services with file stores in the isolated scratch dir.
 *
 * Metrics (documented in METRIC_DOCS):
 *   - memory.proposal_precision: of the candidates the system let into
 *     the quarantined proposal queue, the fraction labeled
 *     shouldEnterQueue. Synthetic secrets are materialized by this scorer
 *     at runtime — the dataset never contains even a fake secret pattern.
 *   - memory.correction_adherence: followed / applicable placements for
 *     an accepted correction (deterministic keyword applicability path).
 *   - memory.conflict_handling: a seeded same-subject contradiction
 *     produces a conflict event and explicit supersession retires the old
 *     record; a same-text restatement produces none.
 *
 * Emotion calibration lives in the emotion stage scorer (emotion.ts).
 */
import { join } from "node:path";
import type { Bucket } from "@donna/core";
import { FileBucketStore } from "@donna/buckets";
import {
  CorrectionService,
  FileConsentStore,
  FileCorrectionStore,
  FileMemoryStore,
  MemoryService,
} from "@donna/memory";
import { FileTranscriptStore, DeterministicProvenanceVerifier } from "@donna/pipeline";
import type { LoadedCase } from "../datasets.js";
import type { StageContext, StageScorer } from "../harness.js";
import type { CaseOutcome } from "../report.js";

/** Runtime materialization of synthetic secrets — never stored in git. */
const SYNTHETIC_SECRETS: Record<string, string> = {
  password: "the password is synth-eval-90210",
  "api-token": "use token sk-syntheval0000000000000000 for testing",
  "card-number": "charge 4242 4242 4242 4242 for the test order",
  "national-id": "the form lists 078-05-1120 as the identifier",
};

interface ProposalCandidate {
  text?: string;
  syntheticSecret?: string;
  kind: string;
  subject: string;
  shouldEnterQueue: boolean;
}

interface MemoryPayload {
  kind: "proposal-precision" | "correction-adherence" | "conflict-handling";
  given: {
    candidates?: ProposalCandidate[];
    correction?: {
      type: "bucket.move";
      thoughtSummary: string;
      fromBucketName: string;
      toBucketName: string;
    };
    placements?: Array<{ thoughtText: string; placedBucket: string; expect: string }>;
    existing?: { text: string; kind: string; subject: string };
    incoming?: { text: string; kind: string; subject: string };
  };
  expect: {
    minPrecision?: number;
    followed?: number;
    contradicted?: number;
    notApplicable?: number;
    conflictDetected?: boolean;
    resolvedBy?: string;
  };
}

function makeServices(scratchDir: string, caseId: string) {
  const dir = join(scratchDir, "memory", caseId);
  const memories = new FileMemoryStore(dir);
  const consents = new FileConsentStore(dir);
  const corrections = new FileCorrectionStore(dir);
  const buckets = new FileBucketStore(dir);
  const transcripts = new FileTranscriptStore(dir);
  const now = () => new Date("2026-09-03T12:00:00.000Z");
  const memory = new MemoryService({ memories, consents, now });
  // No embedder: the deterministic keyword applicability path is scored
  // here; the semantic path is exercised live in the full-loop runs.
  const correctionService = new CorrectionService({
    corrections,
    buckets,
    memory,
    transcripts,
    verifier: new DeterministicProvenanceVerifier(),
    now,
  });
  return { memory, correctionService, buckets };
}

async function scoreProposalPrecision(
  testCase: LoadedCase,
  payload: MemoryPayload,
  context: StageContext,
): Promise<CaseOutcome> {
  const { memory } = makeServices(context.scratchDir, testCase.id);
  const candidates = payload.given.candidates ?? [];
  let entered = 0;
  let enteredCorrectly = 0;
  let wronglyRefused = 0;
  const notes: string[] = [];

  for (const candidate of candidates) {
    const text = candidate.syntheticSecret !== undefined
      ? SYNTHETIC_SECRETS[candidate.syntheticSecret]!
      : candidate.text!;
    let enteredQueue = false;
    try {
      await memory.propose(
        context.scope,
        {
          layer: "semantic",
          kind: candidate.kind,
          subject: candidate.subject,
          text,
          sources: [{ kind: "explicit-statement", id: `eval-${testCase.id}`, reason: "eval" }],
        },
        { model: "eval-scorer", version: "donna.eval-memory.v1" },
      );
      enteredQueue = true;
    } catch {
      enteredQueue = false; // refused by sensitive-content screening
    }
    if (enteredQueue) {
      entered += 1;
      if (candidate.shouldEnterQueue) enteredCorrectly += 1;
    } else if (candidate.shouldEnterQueue) {
      wronglyRefused += 1;
      notes.push("clean-candidate-refused");
    }
  }

  const precision = entered === 0
    ? (candidates.every((c) => !c.shouldEnterQueue) ? 1 : 0)
    : enteredCorrectly / entered;
  if (wronglyRefused > 0) notes.push(`wrongly-refused:${wronglyRefused}`);
  return {
    caseId: testCase.id,
    scores: { "memory.proposal_precision": precision },
    hardFailures: [],
    ...(notes.length > 0 ? { notes } : {}),
  };
}

async function scoreCorrectionAdherence(
  testCase: LoadedCase,
  payload: MemoryPayload,
  context: StageContext,
): Promise<CaseOutcome> {
  const { correctionService, buckets } = makeServices(context.scratchDir, testCase.id);
  const correction = payload.given.correction!;
  const placements = payload.given.placements ?? [];

  // Set up the two buckets the correction references.
  const bucketIds = new Map<string, string>();
  for (const name of [correction.fromBucketName, correction.toBucketName]) {
    const bucket: Bucket = {
      id: `b-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      tenantId: context.scope.tenantId,
      userId: context.scope.userId,
      name,
      description: `${name} bucket`,
      centroid: [1, 0, 0],
      itemCount: 0,
      createdAt: "2026-08-01T00:00:00.000Z",
      origin: "auto",
    };
    await buckets.createBucket(bucket);
    bucketIds.set(name, bucket.id);
  }

  // The correction target exists as a real item so acceptance applies the
  // move for real (the honest path — apply() runs before acceptance).
  const thoughtId = `eval-thought-${testCase.id}`;
  await buckets.saveItem({
    thought: {
      id: thoughtId,
      tenantId: context.scope.tenantId,
      userId: context.scope.userId,
      summary: correction.thoughtSummary,
      text: correction.thoughtSummary,
      confidence: 0.9,
      provenance: {
        captureId: `eval-cap-${testCase.id}`,
        segmentIds: ["seg-0"],
        sourceText: correction.thoughtSummary,
        startSec: 0,
        endSec: 1,
      },
      versions: { organizerModel: "eval", organizeSchemaVersion: "s", organizePromptVersion: "p" },
      embedding: [1, 0, 0],
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    bucketId: bucketIds.get(correction.fromBucketName)!,
  });

  // Submit + accept the correction (accepted corrections drive adherence).
  const event = await correctionService.submit(context.scope, {
    type: "bucket.move",
    target: { kind: "thought", id: thoughtId },
    payload: {
      thoughtSummary: correction.thoughtSummary,
      fromBucketName: correction.fromBucketName,
      fromBucketId: bucketIds.get(correction.fromBucketName)!,
      toBucketName: correction.toBucketName,
      toBucketId: bucketIds.get(correction.toBucketName)!,
    },
    sources: [{ kind: "thought", id: thoughtId, reason: "eval fixture" }],
  });
  const acceptedEvent = await correctionService.accept(context.scope, event.id);

  let followed = 0;
  let contradicted = 0;
  let notApplicable = 0;
  for (const placement of placements) {
    const outcome = await correctionService.observePlacement(context.scope, {
      thoughtText: placement.thoughtText,
      placedBucketId: bucketIds.get(placement.placedBucket)!,
      examples: [
        {
          correctionId: acceptedEvent.id,
          preferredBucketId: bucketIds.get(correction.toBucketName)!,
          text: correction.thoughtSummary,
        },
      ],
    });
    if (outcome.followed + outcome.contradicted === 0) notApplicable += 1;
    followed += outcome.followed;
    contradicted += outcome.contradicted;
  }

  const expected = payload.expect;
  const applicable = followed + contradicted;
  const adherence = applicable === 0 ? undefined : followed / applicable;
  const countsMatch =
    followed === (expected.followed ?? followed) &&
    contradicted === (expected.contradicted ?? contradicted) &&
    notApplicable === (expected.notApplicable ?? notApplicable);
  return {
    caseId: testCase.id,
    scores: {
      ...(adherence !== undefined ? { "memory.correction_adherence": adherence } : {}),
      "memory.adherence_counts_match": countsMatch ? 1 : 0,
    },
    hardFailures: [],
    notes: [`followed:${followed}`, `contradicted:${contradicted}`, `not-applicable:${notApplicable}`],
  };
}

async function scoreConflictHandling(
  testCase: LoadedCase,
  payload: MemoryPayload,
  context: StageContext,
): Promise<CaseOutcome> {
  const { memory } = makeServices(context.scratchDir, testCase.id);
  const { existing, incoming } = payload.given;
  const sources = [{ kind: "explicit-statement" as const, id: `eval-${testCase.id}`, reason: "eval" }];

  const first = await memory.stateExplicit(context.scope, {
    layer: "semantic",
    kind: existing!.kind,
    subject: existing!.subject,
    text: existing!.text,
    sources,
  });
  const second = await memory.stateExplicit(context.scope, {
    layer: "semantic",
    kind: incoming!.kind,
    subject: incoming!.subject,
    text: incoming!.text,
    sources,
  });

  const conflicts = await memory.findConflicts(context.scope, second);
  const conflictDetected = conflicts.some((c) => c.id === first.id);

  let resolved = true;
  if (conflictDetected && payload.expect.resolvedBy === "supersession") {
    const next = await memory.supersede(context.scope, first.id, { text: incoming!.text });
    const remaining = await memory.findConflicts(context.scope, next);
    resolved = remaining.length === 0;
  }

  const expectedConflict = payload.expect.conflictDetected ?? false;
  const pass = conflictDetected === expectedConflict && resolved;
  return {
    caseId: testCase.id,
    scores: { "memory.conflict_handling": pass ? 1 : 0 },
    hardFailures: [],
    notes: [`conflict-detected:${conflictDetected}`, `resolved:${resolved}`],
  };
}

export function createMemoryScorer(): StageScorer {
  return {
    stage: "memory",
    async score(testCase: LoadedCase, context: StageContext): Promise<CaseOutcome[]> {
      const payload = testCase.payload as unknown as MemoryPayload;
      try {
        switch (payload.kind) {
          case "proposal-precision":
            return [await scoreProposalPrecision(testCase, payload, context)];
          case "correction-adherence":
            return [await scoreCorrectionAdherence(testCase, payload, context)];
          case "conflict-handling":
            return [await scoreConflictHandling(testCase, payload, context)];
        }
      } catch {
        return [{
          caseId: testCase.id,
          scores: {},
          hardFailures: [],
          error: { class: "product", token: "memory-scorer-failed" },
        }];
      }
    },
  };
}
