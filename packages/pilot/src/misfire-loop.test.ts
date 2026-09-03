/**
 * Specification 6.2 tests: misfire triage → disposition → golden-case
 * linkage, the triage board, and run instrumentation (pseudonymous IDs,
 * config fingerprints, windowed decision gathering).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { CorrectionEvent, MemoryEvent } from "@donna/core";
import {
  collectRunDecisions,
  FileMisfireRegisterStore,
  FilePilotRunStore,
  MisfireNotFoundError,
  MisfireRegister,
  PilotRunBook,
  RunNotFoundError,
  type MisfireRecord,
  type MisfireRegisterStore,
  type PilotRunRecord,
  type PilotRunStore,
} from "./index.js";

class MemMisfires implements MisfireRegisterStore {
  records: MisfireRecord[] = [];
  async list(t: string, u: string): Promise<MisfireRecord[]> {
    return this.records.filter((r) => r.tenantId === t && r.userId === u);
  }
  async saveAll(t: string, u: string, records: MisfireRecord[]): Promise<void> {
    this.records = [...this.records.filter((r) => !(r.tenantId === t && r.userId === u)), ...records];
  }
}

class MemRuns implements PilotRunStore {
  records: PilotRunRecord[] = [];
  async list(t: string, u: string): Promise<PilotRunRecord[]> {
    return this.records.filter((r) => r.tenantId === t && r.userId === u);
  }
  async saveAll(t: string, u: string, records: PilotRunRecord[]): Promise<void> {
    this.records = [...this.records.filter((r) => !(r.tenantId === t && r.userId === u)), ...records];
  }
}

const SCOPE = { tenantId: "t", userId: "u" };

let now: Date;
let idCounter: number;
let register: MisfireRegister;
let runs: PilotRunBook;

beforeEach(() => {
  now = new Date("2026-09-03T12:00:00.000Z");
  idCounter = 0;
  const idGen = () => `id-${++idCounter}`;
  register = new MisfireRegister(new MemMisfires(), () => now, idGen);
  runs = new PilotRunBook(new MemRuns(), () => now, idGen);
});

async function reportedMisfire(): Promise<MisfireRecord> {
  return register.report(SCOPE, {
    category: "organization",
    description: "wrong bucket for the vendor-call thought",
    participantId: "P-01",
    consent: { evalSharing: true },
    captureId: "cap-1",
    thoughtId: "th-1",
  });
}

describe("misfire triage and disposition (Spec 6.2 FR-2)", () => {
  it("triage records category, expected behavior, and triage timestamp", async () => {
    const m = await reportedMisfire();
    const triaged = await register.triage(SCOPE, m.id, {
      category: "organization",
      expectedBehavior: "The vendor-call thought belongs in Vendor Calls",
    });
    assert.equal(triaged.status, "triaged");
    assert.equal(triaged.expectedBehavior, "The vendor-call thought belongs in Vendor Calls");
    assert.equal(triaged.triagedAt, now.toISOString());
  });

  it("resolution requires triage first and records the disposition", async () => {
    const m = await reportedMisfire();
    await assert.rejects(
      register.resolve(SCOPE, m.id, { disposition: "fixed", note: "moved" }),
      /must be triaged before resolution/,
    );
    await register.triage(SCOPE, m.id, { category: "organization", expectedBehavior: "x" });
    const resolved = await register.resolve(SCOPE, m.id, {
      disposition: "fixed",
      note: "Corrected via bucket.move; correction accepted",
      correctionId: "corr-1",
    });
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.disposition, "fixed");
    assert.equal(resolved.correctionId, "corr-1");
  });

  it("supports all three dispositions, including blocks-graduation", async () => {
    for (const disposition of ["fixed", "accepted-limitation", "blocks-graduation"] as const) {
      const m = await reportedMisfire();
      await register.triage(SCOPE, m.id, { category: "stt", expectedBehavior: "x" });
      const resolved = await register.resolve(SCOPE, m.id, { disposition, note: "n" });
      assert.equal(resolved.disposition, disposition);
    }
  });

  it("rejects unknown categories/dispositions and empty fields", async () => {
    const m = await reportedMisfire();
    await assert.rejects(
      register.triage(SCOPE, m.id, { category: "nope" as never, expectedBehavior: "x" }),
      /Unknown misfire category/,
    );
    await assert.rejects(
      register.triage(SCOPE, m.id, { category: "stt", expectedBehavior: "  " }),
      /expected behavior/,
    );
    await register.triage(SCOPE, m.id, { category: "stt", expectedBehavior: "x" });
    await assert.rejects(
      register.resolve(SCOPE, m.id, { disposition: "meh" as never, note: "n" }),
      /Unknown disposition/,
    );
    await assert.rejects(
      register.resolve(SCOPE, m.id, { disposition: "fixed", note: " " }),
      /needs a note/,
    );
    await assert.rejects(register.triage(SCOPE, "missing", { category: "stt", expectedBehavior: "x" }), MisfireNotFoundError);
  });

  it("linkGoldenCase records the consented promotion link", async () => {
    const m = await reportedMisfire();
    await register.triage(SCOPE, m.id, { category: "organization", expectedBehavior: "x" });
    await register.resolve(SCOPE, m.id, { disposition: "fixed", note: "n", correctionId: "corr-1" });
    const linked = await register.linkGoldenCase(SCOPE, m.id, {
      correctionId: "corr-1",
      goldenCaseId: "corr-1",
    });
    assert.equal(linked.goldenCaseId, "corr-1");
  });

  it("the board summarizes by category/status/disposition with blockers listed (AC-2)", async () => {
    const a = await reportedMisfire();
    const b = await reportedMisfire();
    await reportedMisfire(); // stays open
    await register.triage(SCOPE, a.id, { category: "organization", expectedBehavior: "x" });
    await register.resolve(SCOPE, a.id, { disposition: "fixed", note: "n" });
    await register.triage(SCOPE, b.id, { category: "retrieval", expectedBehavior: "y" });
    await register.resolve(SCOPE, b.id, { disposition: "blocks-graduation", note: "needs dataset growth" });
    const board = await register.summarize(SCOPE);
    assert.equal(board.total, 3);
    assert.equal(board.byCategory["organization"], 2);
    assert.equal(board.byCategory["retrieval"], 1);
    assert.equal(board.byStatus["resolved"], 2);
    assert.equal(board.byStatus["open"], 1);
    assert.equal(board.byDisposition["fixed"], 1);
    assert.equal(board.byDisposition["blocks-graduation"], 1);
    assert.deepEqual(board.blocksGraduation, [{ id: b.id, category: "retrieval" }]);
    assert.equal(board.unresolved.length, 1);
  });
});

describe("pilot run instrumentation (Spec 6.2 FR-1)", () => {
  it("a run records participant, scenario, and config fingerprint; one open run at a time", async () => {
    const run = await runs.start(SCOPE, {
      participantId: "P-01",
      scenarioId: "SC-MEET-01",
      configFingerprint: "fp-abc",
    });
    assert.equal(run.schema, "donna.pilot-run.v1");
    assert.equal(run.participantId, "P-01");
    assert.equal(run.scenarioId, "SC-MEET-01");
    assert.equal(run.configFingerprint, "fp-abc");
    assert.equal(run.endedAt, undefined);
    await assert.rejects(
      runs.start(SCOPE, { participantId: "P-01", scenarioId: "SC-TASK-01", configFingerprint: "fp" }),
      /still open/,
    );
  });

  it("start requires a scenario ID; end is terminal", async () => {
    await assert.rejects(
      runs.start(SCOPE, { participantId: "P-01", scenarioId: "  ", configFingerprint: "fp" }),
      /scenario ID/,
    );
    const run = await runs.start(SCOPE, { participantId: "P-01", scenarioId: "S", configFingerprint: "fp" });
    await runs.end(SCOPE, run.id, { captures: [], corrections: [], memoryEvents: [] });
    await assert.rejects(
      runs.end(SCOPE, run.id, { captures: [], corrections: [], memoryEvents: [] }),
      /already ended/,
    );
    await assert.rejects(
      runs.end(SCOPE, "missing", { captures: [], corrections: [], memoryEvents: [] }),
      RunNotFoundError,
    );
  });

  it("end gathers window captures and decisions (counts and IDs only)", async () => {
    const run = await runs.start(SCOPE, { participantId: "P-01", scenarioId: "SC-MIX-01", configFingerprint: "fp" });
    const inWindow = "2026-09-03T12:00:00.000Z";
    const correction = {
      id: "corr-1",
      tenantId: "t",
      userId: "u",
      type: "bucket.move",
      createdAt: inWindow,
      target: { kind: "thought", id: "th-1" },
      payload: {},
      sources: [],
      status: "accepted",
      followedCount: 0,
      contradictedCount: 0,
    } as CorrectionEvent;
    const oldCorrection = { ...correction, id: "corr-0", createdAt: "2026-09-01T00:00:00.000Z" };
    const events: MemoryEvent[] = [
      { at: inWindow, type: "approved", tenantId: "t", userId: "u", memoryId: "m-1" },
      { at: inWindow, type: "rejected", tenantId: "t", userId: "u", proposalId: "p-1" },
      { at: "2026-09-01T00:00:00.000Z", type: "approved", tenantId: "t", userId: "u", memoryId: "m-0" },
    ];
    const ended = await runs.end(SCOPE, run.id, {
      captures: [
        { id: "cap-in", capturedAt: inWindow },
        { id: "cap-out", capturedAt: "2026-09-01T00:00:00.000Z" },
      ],
      corrections: [correction, oldCorrection],
      memoryEvents: events,
    });
    assert.deepEqual(ended.captureIds, ["cap-in"]);
    assert.deepEqual(ended.decisions.corrections, { "bucket.move": 1 });
    assert.deepEqual(ended.decisions.correctionIds, ["corr-1"]);
    assert.equal(ended.decisions.memoryApprovals, 1);
    assert.equal(ended.decisions.memoryRejections, 1);
    assert.deepEqual(ended.decisions.memoryEventIds, ["approved:m-1", "rejected:p-1"]);
  });

  it("collectRunDecisions counts by correction type inside the window", () => {
    const window = { startedAt: "2026-09-03T10:00:00.000Z", endedAt: "2026-09-03T11:00:00.000Z" };
    const mk = (id: string, type: string, createdAt: string): CorrectionEvent =>
      ({
        id,
        tenantId: "t",
        userId: "u",
        type,
        createdAt,
        target: { kind: "thought", id },
        payload: {},
        sources: [],
        status: "accepted",
        followedCount: 0,
        contradictedCount: 0,
      }) as CorrectionEvent;
    const decisions = collectRunDecisions(
      window,
      [
        mk("c1", "bucket.move", "2026-09-03T10:05:00.000Z"),
        mk("c2", "bucket.move", "2026-09-03T10:06:00.000Z"),
        mk("c3", "retrieval.relevance", "2026-09-03T10:07:00.000Z"),
        mk("c4", "bucket.move", "2026-09-03T11:05:00.000Z"),
      ],
      [],
    );
    assert.deepEqual(decisions.corrections, { "bucket.move": 2, "retrieval.relevance": 1 });
    assert.deepEqual(decisions.correctionIds, ["c1", "c2", "c3"]);
  });
});

describe("file-backed 6.2 stores", () => {
  it("run and misfire stores round-trip and reject cross-partition data", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "donna-pilot-62-"));
    const runStore = new FilePilotRunStore(dir);
    const book = new PilotRunBook(runStore, () => now, () => "run-1");
    await book.start(SCOPE, { participantId: "P-01", scenarioId: "SC-1", configFingerprint: "fp" });
    assert.equal((await runStore.list("t", "u")).length, 1);
    assert.equal((await runStore.list("t", "other")).length, 0);

    const misfireStore = new FileMisfireRegisterStore(dir);
    const reg = new MisfireRegister(misfireStore, () => now, () => "m-1");
    await reg.report(SCOPE, {
      category: "stt",
      description: "x",
      participantId: "P-01",
      consent: { evalSharing: false },
    });
    assert.equal((await misfireStore.list("t", "u")).length, 1);
    assert.equal((await misfireStore.list("t", "other")).length, 0);
  });
});
