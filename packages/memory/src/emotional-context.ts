/**
 * Session emotion and intent context (Specification 2.4).
 *
 * Donna may tentatively infer urgency, frustration, uncertainty, or
 * positive tone DURING the current session to adjust tone, review
 * priority, and uncertainty handling — never access, permissions, or
 * external actions (SR-2). The analyzer is deliberately deterministic and
 * confidence-capped (heuristic v1): it abstains when evidence is weak,
 * labels every inference as inferred with model/version (FR-1), and never
 * claims to know how the employee feels.
 *
 * Privacy rules:
 *   - Snapshots and intent signals are session-scoped and are deleted
 *     automatically at session expiry (FR-2, AC-1).
 *   - Durable promotion requires a separate explicit opt-in: an active
 *     "emotion.persist" consent record. Persisting without it fails
 *     closed (SR-3). Revocation stops future promotion immediately.
 *   - The user can correct, disable, or delete emotional context at any
 *     time (FR-3); disabling leaves the core loop fully functional
 *     (AC-4).
 */
import { randomUUID } from "node:crypto";
import { REVIEW_PRIORITY_THRESHOLD } from "@donna/core";
import type {
  EmotionalContext as EmotionalContextPort,
  EmotionalSnapshot,
  EmotionLabel,
  IntentSignal,
  Session,
  Transcript,
  TranscriptSegment,
} from "@donna/core";
import { MemoryService, type Scope } from "./service.js";
import type { SessionStore } from "./session-store.js";

export { REVIEW_PRIORITY_THRESHOLD };

/** Consent purposes used by this module. */
export const EMOTION_INFERENCE_PURPOSE = "emotion.inference";
export const EMOTION_PERSIST_PURPOSE = "emotion.persist";

/** Analyzer identity recorded on every inference (FR-1). */
export const EMOTION_MODEL = "heuristic";
export const EMOTION_VERSION = "donna.emotion-heuristic.v1";

/**
 * Confidence is capped well below certainty: these are guesses about
 * emotional state from text only, and the product copy must stay
 * tentative (AC-5).
 */
export const EMOTION_MAX_CONFIDENCE = 0.7;
export const INTENT_MAX_CONFIDENCE = 0.6;

const MARKERS: Record<EmotionLabel, string[]> = {
  urgency: [
    "asap",
    "urgent",
    "urgently",
    "immediately",
    "right away",
    "deadline",
    "by friday",
    "by tomorrow",
    "end of day",
    "tonight",
    "before noon",
    "this morning",
  ],
  frustration: [
    "frustrated",
    "frustrating",
    "annoying",
    "annoyed",
    "ridiculous",
    "fed up",
    "ugh",
    "again and again",
    "still not",
    "keeps failing",
    "sick of",
  ],
  uncertainty: [
    "maybe",
    "not sure",
    "might",
    "perhaps",
    "i think",
    "unsure",
    "i guess",
    "probably",
    "not certain",
  ],
  positive: ["great", "excited", "love", "awesome", "fantastic", "happy", "well done"],
};

const INTENT_MARKERS: Array<{ intent: string; markers: string[] }> = [
  {
    intent: "delegating",
    markers: ["remind me", "we need to", "i have to", "send", "schedule", "call", "email"],
  },
  { intent: "deciding", markers: ["should we", "which", "decide", "option", "trade-off"] },
  { intent: "planning", markers: ["plan", "roadmap", "next week", "next quarter", "quarter"] },
];

export interface EmotionAnalysis {
  labels: Array<{ label: EmotionLabel; confidence: number }>;
  abstained: boolean;
  /** Segment IDs that contained markers. */
  evidence: string[];
  intent: string;
  intentConfidence: number;
  intentEvidence: string[];
}

function confidenceFor(hits: number): number {
  if (hits === 0) return 0;
  return Math.min(EMOTION_MAX_CONFIDENCE, 0.4 + 0.15 * (hits - 1));
}

/**
 * Deterministic heuristic analysis of one transcript. Pure function —
 * the calibration evals (packages/evals) run it directly. Abstains when
 * no label clears the evidence bar.
 */
export function analyzeTranscript(
  segments: TranscriptSegment[],
): EmotionAnalysis {
  const labels: Array<{ label: EmotionLabel; confidence: number }> = [];
  const evidence = new Set<string>();
  for (const [label, markers] of Object.entries(MARKERS) as Array<
    [EmotionLabel, string[]]
  >) {
    let hits = 0;
    for (const segment of segments) {
      const text = segment.text.toLowerCase();
      const segmentHit = markers.some((marker) => text.includes(marker));
      if (segmentHit) {
        hits += 1;
        evidence.add(segment.id);
      }
    }
    const confidence = confidenceFor(hits);
    if (confidence >= 0.4) labels.push({ label, confidence });
  }
  labels.sort((a, b) => b.confidence - a.confidence || a.label.localeCompare(b.label));

  // Intent: first matching family wins; frustration-heavy text with no
  // action markers reads as venting; otherwise default to capturing.
  let intent = "capturing";
  let intentConfidence = 0.3;
  const intentEvidence: string[] = [];
  const frustration = labels.find((l) => l.label === "frustration");
  outer: for (const family of INTENT_MARKERS) {
    for (const segment of segments) {
      const text = segment.text.toLowerCase();
      if (family.markers.some((marker) => text.includes(marker))) {
        intent = family.intent;
        intentConfidence = INTENT_MAX_CONFIDENCE;
        intentEvidence.push(segment.id);
        break outer;
      }
    }
  }
  if (intent === "capturing" && frustration !== undefined) {
    intent = "venting";
    intentConfidence = 0.5;
    intentEvidence.push(...evidence);
  }

  return {
    labels,
    abstained: labels.length === 0,
    evidence: [...evidence].sort(),
    intent,
    intentConfidence,
    intentEvidence,
  };
}

/** Tentative, uncertainty-aware phrasing for the organizer prompt (AC-5). */
export function tentativeNote(
  labels: Array<{ label: EmotionLabel; confidence: number }>,
): string | undefined {
  const top = labels[0];
  if (top === undefined) return undefined;
  const phrasing: Record<EmotionLabel, string> = {
    urgency:
      "the speaker may be in a hurry — prefer concise phrasing and make sure time-sensitive items are flagged for review",
    frustration:
      "the speaker may be frustrated — keep the tone calm and route outputs through review rather than acting confident",
    uncertainty:
      "the speaker may be unsure — prefer lower confidence scores and route borderline items to review",
    positive:
      "the speaker may be in a positive mood — no change needed beyond a warm, concise tone",
  };
  return (
    `Tentative session guess (confidence ${top.confidence.toFixed(2)}, inferred from word choice — ` +
    `may be wrong, the user can correct or disable it): ${phrasing[top.label]}.`
  );
}

export interface EmotionalContextDeps {
  sessions: SessionStore;
  memory: MemoryService;
  now: () => Date;
  idGen?: () => string;
}

export class SnapshotNotFoundError extends Error {
  constructor() {
    super("Emotional snapshot does not exist in the requested tenant/user scope");
    this.name = "SnapshotNotFoundError";
  }
}

export class SessionNotFoundError extends Error {
  constructor() {
    super("Session does not exist in the requested tenant/user scope");
    this.name = "SessionNotFoundError";
  }
}

export class EmotionalContextService implements EmotionalContextPort {
  private readonly idGen: () => string;

  constructor(private readonly deps: EmotionalContextDeps) {
    this.idGen = deps.idGen ?? randomUUID;
  }

  /* ---------------------------- sessions ------------------------------ */

  async startSession(scope: Scope, ttlSec: number): Promise<Session> {
    const now = this.deps.now();
    const session: Session = {
      id: this.idGen(),
      tenantId: scope.tenantId,
      userId: scope.userId,
      startedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSec * 1000).toISOString(),
    };
    await this.deps.sessions.saveSession(session);
    return session;
  }

  /**
   * Session end (FR-2): working memory expires with the session (Spec 2.1
   * FR-4); emotional snapshots are promoted to durable private memory ONLY
   * with an active emotion.persist consent, otherwise deleted (SR-3);
   * intent signals are always session-only.
   */
  async endSession(
    scope: Scope,
    sessionId: string,
  ): Promise<{ promoted: number; deleted: number; workingRemoved: number }> {
    const session = await this.deps.sessions.getSession(
      scope.tenantId,
      scope.userId,
      sessionId,
    );
    if (session === undefined) throw new SessionNotFoundError();

    const workingRemoved = (
      await this.deps.memory.expireSession(scope, sessionId)
    ).removed;

    const snapshots = await this.deps.sessions.listSnapshots(
      scope.tenantId,
      scope.userId,
      sessionId,
    );
    const mayPersist = await this.deps.memory.hasConsent(scope, EMOTION_PERSIST_PURPOSE);
    let promoted = 0;
    let deleted = 0;
    for (const snapshot of snapshots) {
      if (mayPersist && !snapshot.abstained && snapshot.labels.length > 0) {
        const top = snapshot.labels[0]!;
        await this.deps.memory.stateExplicit(scope, {
          layer: "episodic",
          kind: "emotional-context",
          subject: `emotion:${snapshot.sessionId}`,
          text:
            `In a past session Donna tentatively inferred possible ${top.label} ` +
            `(confidence ${top.confidence.toFixed(2)}, unverified, user-correctable).`,
          confidence: top.confidence,
          sources: [
            {
              kind: "session",
              id: snapshot.sessionId,
              reason: "session emotional context promoted under explicit emotion.persist consent",
            },
          ],
        });
        promoted += 1;
      }
      await this.deps.sessions.deleteSnapshot(scope.tenantId, scope.userId, snapshot.id);
      deleted += 1;
    }

    const now = this.deps.now().toISOString();
    await this.deps.sessions.saveSession({ ...session, endedAt: now, expiresAt: now });
    await this.deps.sessions.sweepExpired(scope.tenantId, scope.userId, now);
    return { promoted, deleted, workingRemoved };
  }

  /* ---------------------------- inference ----------------------------- */

  /** Default: session-only inference is on unless explicitly disabled. */
  async isEnabled(scope: Scope): Promise<boolean> {
    const records = await this.deps.memory.listConsents(scope);
    const forPurpose = records.filter((r) => r.purpose === EMOTION_INFERENCE_PURPOSE);
    const latest = forPurpose[forPurpose.length - 1];
    return latest === undefined || latest.granted;
  }

  async disable(scope: Scope, channel = "unknown"): Promise<void> {
    await this.deps.memory.denyConsent(scope, EMOTION_INFERENCE_PURPOSE, channel);
  }

  async enable(scope: Scope, channel = "unknown"): Promise<void> {
    await this.deps.memory.grantConsent(scope, EMOTION_INFERENCE_PURPOSE, channel);
  }

  /**
   * Pipeline hook (FR-1): analyze the transcript, store the session-scoped
   * snapshot and intent signal, and return the tentative note + review
   * priority. Returns undefined when disabled — the core loop proceeds
   * unchanged (AC-4).
   */
  async analyzeAndStore(
    scope: Scope,
    session: { id: string; expiresAt: string },
    transcript: Transcript,
  ): Promise<
    { note?: string; reviewPriority: number; abstained: boolean } | undefined
  > {
    if (!(await this.isEnabled(scope))) return undefined;
    const stored = await this.deps.sessions.getSession(
      scope.tenantId,
      scope.userId,
      session.id,
    );
    if (stored === undefined) throw new SessionNotFoundError();

    const analysis = analyzeTranscript(transcript.segments);
    const now = this.deps.now().toISOString();
    const snapshot: EmotionalSnapshot = {
      id: this.idGen(),
      tenantId: scope.tenantId,
      userId: scope.userId,
      sessionId: session.id,
      labels: analysis.labels,
      abstained: analysis.abstained,
      evidence: analysis.evidence,
      model: EMOTION_MODEL,
      version: EMOTION_VERSION,
      correctionState: "uncorrected",
      createdAt: now,
      expiresAt: session.expiresAt,
    };
    await this.deps.sessions.saveSnapshot(snapshot);
    const signal: IntentSignal = {
      id: this.idGen(),
      tenantId: scope.tenantId,
      userId: scope.userId,
      sessionId: session.id,
      intent: analysis.intent,
      confidence: analysis.intentConfidence,
      evidence: analysis.intentEvidence,
      model: EMOTION_MODEL,
      version: EMOTION_VERSION,
      correctionState: "uncorrected",
      createdAt: now,
      expiresAt: session.expiresAt,
    };
    await this.deps.sessions.saveIntent(signal);

    const reviewPriority = analysis.labels[0]?.confidence ?? 0;
    const note = tentativeNote(analysis.labels);
    return {
      ...(note !== undefined ? { note } : {}),
      reviewPriority,
      abstained: analysis.abstained,
    };
  }

  /* --------------------------- user controls -------------------------- */

  async listSnapshots(scope: Scope, sessionId?: string): Promise<EmotionalSnapshot[]> {
    return this.deps.sessions.listSnapshots(scope.tenantId, scope.userId, sessionId);
  }

  async listIntents(scope: Scope, sessionId?: string): Promise<IntentSignal[]> {
    return this.deps.sessions.listIntents(scope.tenantId, scope.userId, sessionId);
  }

  /**
   * FR-3: the user corrects an inference ("no, I wasn't frustrated").
   * Their labels replace the inferred ones; the event is recorded on the
   * snapshot, never hidden.
   */
  async correct(
    scope: Scope,
    snapshotId: string,
    labels: Array<{ label: EmotionLabel; confidence: number }>,
  ): Promise<EmotionalSnapshot> {
    const snapshot = await this.deps.sessions.getSnapshot(
      scope.tenantId,
      scope.userId,
      snapshotId,
    );
    if (snapshot === undefined) throw new SnapshotNotFoundError();
    const corrected: EmotionalSnapshot = {
      ...snapshot,
      labels,
      abstained: labels.length === 0,
      correctionState: "corrected",
    };
    await this.deps.sessions.saveSnapshot(corrected);
    return corrected;
  }

  /** FR-3: the user confirms an inference was accurate. */
  async confirm(scope: Scope, snapshotId: string): Promise<EmotionalSnapshot> {
    const snapshot = await this.deps.sessions.getSnapshot(
      scope.tenantId,
      scope.userId,
      snapshotId,
    );
    if (snapshot === undefined) throw new SnapshotNotFoundError();
    const confirmed: EmotionalSnapshot = { ...snapshot, correctionState: "confirmed" };
    await this.deps.sessions.saveSnapshot(confirmed);
    return confirmed;
  }

  /** FR-3: the user deletes an inference outright. Idempotent. */
  async deleteSnapshot(scope: Scope, snapshotId: string): Promise<void> {
    await this.deps.sessions.deleteSnapshot(scope.tenantId, scope.userId, snapshotId);
  }
}
