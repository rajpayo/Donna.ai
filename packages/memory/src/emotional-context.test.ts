import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transcript } from "@donna/core";
import {
  analyzeTranscript,
  EmotionalContextService,
  EMOTION_MAX_CONFIDENCE,
  EMOTION_PERSIST_PURPOSE,
  EMOTION_VERSION,
  tentativeNote,
} from "./emotional-context.js";
import { FileSessionStore } from "./session-store.js";
import { MemoryService, type Scope } from "./service.js";
import { FileConsentStore, FileMemoryStore } from "./store.file.js";

const SCOPE: Scope = { tenantId: "t", userId: "u" };
const OTHER: Scope = { tenantId: "t", userId: "other" };

const FRUSTRATED: Transcript = {
  captureId: "cap-1",
  text: "This is ridiculous, the pipeline keeps failing.",
  segments: [
    { id: "seg-0", text: "This is ridiculous, the pipeline keeps failing.", startSec: 0, endSec: 3 },
  ],
  model: "test",
};

const NEUTRAL: Transcript = {
  captureId: "cap-2",
  text: "The vendor renewal covers twelve seats.",
  segments: [
    { id: "seg-0", text: "The vendor renewal covers twelve seats.", startSec: 0, endSec: 3 },
  ],
  model: "test",
};

let dir: string;
let now: Date;
let memory: MemoryService;
let sessions: FileSessionStore;
let emotion: EmotionalContextService;
let idCounter: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "donna-emo-"));
  now = new Date("2026-09-03T10:00:00.000Z");
  idCounter = 0;
  const idGen = () => `id-${++idCounter}`;
  memory = new MemoryService({
    memories: new FileMemoryStore(dir),
    consents: new FileConsentStore(dir),
    now: () => now,
    idGen,
  });
  sessions = new FileSessionStore(dir);
  emotion = new EmotionalContextService({
    sessions,
    memory,
    now: () => now,
    idGen,
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function startSession(ttlSec = 3600) {
  return emotion.startSession(SCOPE, ttlSec);
}

describe("heuristic analyzer (FR-1)", () => {
  it("labels clear frustration with capped confidence and evidence", () => {
    const result = analyzeTranscript(FRUSTRATED.segments);
    assert.equal(result.abstained, false);
    const frustration = result.labels.find((l) => l.label === "frustration");
    assert.ok(frustration);
    assert.ok(frustration.confidence <= EMOTION_MAX_CONFIDENCE);
    assert.deepEqual(result.evidence, ["seg-0"]);
  });

  it("abstains on marker-free input", () => {
    const result = analyzeTranscript(NEUTRAL.segments);
    assert.equal(result.abstained, true);
    assert.equal(result.labels.length, 0);
  });

  it("produces tentative notes only for actual labels", () => {
    assert.equal(tentativeNote([]), undefined);
    const note = tentativeNote([{ label: "urgency", confidence: 0.55 }]);
    assert.ok(note?.includes("may be"));
    assert.ok(note?.includes("may be wrong"));
    assert.ok(note?.includes("0.55"));
  });
});

describe("session-scoped inference and storage", () => {
  it("stores a labeled snapshot + intent with model/version and expiry (FR-1)", async () => {
    const session = await startSession();
    const signal = await emotion.analyzeAndStore(SCOPE, session, FRUSTRATED);
    assert.ok(signal);
    assert.equal(signal.abstained, false);
    assert.ok(signal.note?.includes("frustrated"));
    assert.ok(signal.reviewPriority >= 0.4);

    const snapshots = await emotion.listSnapshots(SCOPE, session.id);
    assert.equal(snapshots.length, 1);
    const snapshot = snapshots[0]!;
    assert.equal(snapshot.sessionId, session.id);
    assert.equal(snapshot.model, "heuristic");
    assert.equal(snapshot.version, EMOTION_VERSION);
    assert.equal(snapshot.correctionState, "uncorrected");
    assert.equal(snapshot.expiresAt, session.expiresAt);
    assert.ok(snapshot.labels[0]!.confidence <= EMOTION_MAX_CONFIDENCE);

    const intents = await emotion.listIntents(SCOPE, session.id);
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.intent, "venting");
  });

  it("records abstention transparently when nothing is inferred", async () => {
    const session = await startSession();
    const signal = await emotion.analyzeAndStore(SCOPE, session, NEUTRAL);
    assert.equal(signal?.abstained, true);
    assert.equal(signal?.note, undefined);
    assert.equal(signal?.reviewPriority, 0);
    const snapshots = await emotion.listSnapshots(SCOPE, session.id);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.abstained, true);
  });

  it("requires an existing session (fail closed)", async () => {
    await assert.rejects(
      () =>
        emotion.analyzeAndStore(
          SCOPE,
          { id: "no-such-session", expiresAt: now.toISOString() },
          FRUSTRATED,
        ),
      /Session does not exist/,
    );
  });
});

describe("default expiry (AC-1, FR-2, SR-3)", () => {
  it("session end without opt-in leaves no durable emotional record", async () => {
    const session = await startSession();
    await emotion.analyzeAndStore(SCOPE, session, FRUSTRATED);
    // Working memory bound to the same session expires with it too.
    await memory.addWorking(SCOPE, session.id, session.expiresAt, {
      kind: "scratch",
      subject: "scratch:x",
      text: "session note",
      sources: [{ kind: "session", id: session.id, reason: "live session" }],
    });

    const result = await emotion.endSession(SCOPE, session.id);
    assert.equal(result.promoted, 0);
    assert.equal(result.deleted, 1);
    assert.equal(result.workingRemoved, 1);

    assert.equal((await emotion.listSnapshots(SCOPE)).length, 0);
    assert.equal((await emotion.listIntents(SCOPE)).length, 0);
    assert.equal((await memory.listConfirmed(SCOPE)).length, 0);
    assert.equal((await memory.listAll(SCOPE)).length, 0);
  });

  it("expired sessions are swept automatically", async () => {
    const session = await startSession(60);
    await emotion.analyzeAndStore(SCOPE, session, FRUSTRATED);
    now = new Date("2026-09-03T12:00:00.000Z"); // past expiry
    const removed = await sessions.sweepExpired(SCOPE.tenantId, SCOPE.userId, now.toISOString());
    assert.equal(removed.sessions, 1);
    assert.equal(removed.snapshots, 1);
    assert.equal(removed.intents, 1);
    assert.equal((await emotion.listSnapshots(SCOPE)).length, 0);
  });
});

describe("opt-in persistence and revocation (AC-2, SR-3)", () => {
  it("promotes a tentative durable memory only with active consent", async () => {
    const session = await startSession();
    await emotion.analyzeAndStore(SCOPE, session, FRUSTRATED);
    await memory.grantConsent(SCOPE, EMOTION_PERSIST_PURPOSE, "test");

    const result = await emotion.endSession(SCOPE, session.id);
    assert.equal(result.promoted, 1);
    assert.equal(result.deleted, 1); // session copy still removed

    const durable = await memory.listConfirmed(SCOPE, "episodic");
    assert.equal(durable.length, 1);
    assert.equal(durable[0]?.kind, "emotional-context");
    assert.ok(durable[0]?.text.includes("tentatively"));
    assert.ok(durable[0]?.text.includes("unverified"));
    assert.equal(durable[0]?.sources[0]?.kind, "session");
  });

  it("revoked consent fails closed at session end", async () => {
    const session = await startSession();
    await emotion.analyzeAndStore(SCOPE, session, FRUSTRATED);
    await memory.grantConsent(SCOPE, EMOTION_PERSIST_PURPOSE, "test");
    await memory.revokeConsent(SCOPE, EMOTION_PERSIST_PURPOSE, "test");

    const result = await emotion.endSession(SCOPE, session.id);
    assert.equal(result.promoted, 0);
    assert.equal((await memory.listAll(SCOPE)).length, 0);
  });

  it("never promotes abstained snapshots even with consent", async () => {
    const session = await startSession();
    await emotion.analyzeAndStore(SCOPE, session, NEUTRAL);
    await memory.grantConsent(SCOPE, EMOTION_PERSIST_PURPOSE, "test");
    const result = await emotion.endSession(SCOPE, session.id);
    assert.equal(result.promoted, 0);
    assert.equal((await memory.listAll(SCOPE)).length, 0);
  });
});

describe("user controls (FR-3)", () => {
  it("correct replaces the inferred labels", async () => {
    const session = await startSession();
    await emotion.analyzeAndStore(SCOPE, session, FRUSTRATED);
    const snapshot = (await emotion.listSnapshots(SCOPE))[0]!;
    const corrected = await emotion.correct(SCOPE, snapshot.id, [
      { label: "urgency", confidence: 0.9 },
    ]);
    assert.equal(corrected.correctionState, "corrected");
    assert.deepEqual(corrected.labels, [{ label: "urgency", confidence: 0.9 }]);
  });

  it("correct to empty means 'no strong emotion'", async () => {
    const session = await startSession();
    await emotion.analyzeAndStore(SCOPE, session, FRUSTRATED);
    const snapshot = (await emotion.listSnapshots(SCOPE))[0]!;
    const corrected = await emotion.correct(SCOPE, snapshot.id, []);
    assert.equal(corrected.abstained, true);
    assert.equal(corrected.correctionState, "corrected");
  });

  it("confirm and delete work in scope", async () => {
    const session = await startSession();
    await emotion.analyzeAndStore(SCOPE, session, FRUSTRATED);
    const snapshot = (await emotion.listSnapshots(SCOPE))[0]!;
    const confirmed = await emotion.confirm(SCOPE, snapshot.id);
    assert.equal(confirmed.correctionState, "confirmed");
    await emotion.deleteSnapshot(SCOPE, snapshot.id);
    assert.equal((await emotion.listSnapshots(SCOPE)).length, 0);
    await emotion.deleteSnapshot(SCOPE, snapshot.id); // idempotent
  });

  it("disabled mode returns no inference and stores nothing (AC-4)", async () => {
    await emotion.disable(SCOPE, "test");
    const session = await startSession();
    const signal = await emotion.analyzeAndStore(SCOPE, session, FRUSTRATED);
    assert.equal(signal, undefined);
    assert.equal((await emotion.listSnapshots(SCOPE)).length, 0);
    await emotion.enable(SCOPE, "test");
    const second = await emotion.analyzeAndStore(SCOPE, session, FRUSTRATED);
    assert.ok(second !== undefined);
  });
});

describe("scope isolation (SR-1)", () => {
  it("snapshots never cross users", async () => {
    const session = await startSession();
    await emotion.analyzeAndStore(SCOPE, session, FRUSTRATED);
    assert.equal((await emotion.listSnapshots(OTHER)).length, 0);
    const snapshot = (await emotion.listSnapshots(SCOPE))[0]!;
    await assert.rejects(() => emotion.correct(OTHER, snapshot.id, []), /does not exist/);
  });
});
