/**
 * Specification 6.4 tests: the explicit pilot decision register (FR-1),
 * countable acceptance evidence (FR-2), run-end decision gathering (AC-1),
 * and partition isolation (SR-1).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  collectPlacementDecisions,
  DecisionNotFoundError,
  DecisionRegister,
  FilePilotDecisionStore,
  latestDecisionsPerThought,
  PilotRunBook,
  type PilotDecision,
  type PilotDecisionStore,
  type PilotRunRecord,
  type PilotRunStore,
} from "./index.js";

const SCOPE = { tenantId: "t", userId: "u" };

class MemDecisions implements PilotDecisionStore {
  records: PilotDecision[] = [];
  async list(t: string, u: string): Promise<PilotDecision[]> {
    return this.records.filter((r) => r.tenantId === t && r.userId === u);
  }
  async saveAll(t: string, u: string, records: PilotDecision[]): Promise<void> {
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

let now: Date;
let idCounter: number;
let register: DecisionRegister;
let runs: PilotRunBook;

beforeEach(() => {
  now = new Date("2026-09-04T12:00:00.000Z");
  idCounter = 0;
  const idGen = () => `id-${++idCounter}`;
  register = new DecisionRegister(new MemDecisions(), () => now, idGen);
  runs = new PilotRunBook(new MemRuns(), () => now, idGen);
});

function acceptInput(thoughtId: string, over: Record<string, unknown> = {}) {
  return {
    kind: "accept" as const,
    participantId: "P-01",
    thoughtId,
    captureId: "cap-1",
    donnaBucket: { id: "b-1", name: "Product Ideas" },
    decidedBucket: { id: "b-1", name: "Product Ideas" },
    ...over,
  };
}

describe("decision register (Spec 6.4 FR-1)", () => {
  it("records an explicit accept with every required field", async () => {
    const d = await register.record(SCOPE, acceptInput("th-1", { runId: "run-1", scenarioId: "SC-IDEA-01" }));
    assert.equal(d.schema, "donna.pilot-decision.v1");
    assert.equal(d.kind, "accept");
    assert.equal(d.participantId, "P-01");
    assert.equal(d.thoughtId, "th-1");
    assert.equal(d.captureId, "cap-1");
    assert.deepEqual(d.donnaBucket, { id: "b-1", name: "Product Ideas" });
    assert.deepEqual(d.decidedBucket, { id: "b-1", name: "Product Ideas" });
    assert.equal(d.decidedAt, now.toISOString());
    assert.equal(d.runId, "run-1");
    assert.equal(d.scenarioId, "SC-IDEA-01");
  });

  it("records a move linked to its correction", async () => {
    const d = await register.record(SCOPE, {
      kind: "move",
      participantId: "P-01",
      thoughtId: "th-2",
      captureId: "cap-1",
      donnaBucket: { id: "b-1", name: "Product Ideas" },
      decidedBucket: { id: "b-2", name: "Vendor Portal" },
      correctionId: "corr-9",
    });
    assert.equal(d.kind, "move");
    assert.equal(d.correctionId, "corr-9");
    assert.deepEqual(d.decidedBucket, { id: "b-2", name: "Vendor Portal" });
  });

  it("rejects a move without the linked correction ID", async () => {
    await assert.rejects(
      register.record(SCOPE, {
        kind: "move",
        participantId: "P-01",
        thoughtId: "th-2",
        donnaBucket: { id: "b-1", name: "Product Ideas" },
        decidedBucket: { id: "b-2", name: "Vendor Portal" },
      }),
      /correction ID/,
    );
  });

  it("rejects unknown kinds and empty thought IDs (unknown-thought handling)", async () => {
    await assert.rejects(
      register.record(SCOPE, acceptInput("th-1", { kind: "maybe" })),
      /Unknown decision kind/,
    );
    await assert.rejects(register.record(SCOPE, acceptInput("  ")), /thought ID/);
    await assert.rejects(register.get(SCOPE, "no-such-decision"), DecisionNotFoundError);
  });

  it("is append-only with latest-per-thought winning for counting", async () => {
    await register.record(SCOPE, acceptInput("th-1"));
    now = new Date("2026-09-04T12:05:00.000Z");
    await register.record(SCOPE, {
      kind: "move",
      participantId: "P-01",
      thoughtId: "th-1",
      donnaBucket: { id: "b-1", name: "Product Ideas" },
      decidedBucket: { id: "b-2", name: "Vendor Portal" },
      correctionId: "corr-1",
    });
    const all = await register.list(SCOPE);
    assert.equal(all.length, 2); // history preserved
    const latest = latestDecisionsPerThought(all);
    assert.equal(latest.length, 1);
    assert.equal(latest[0]!.kind, "move");
    const summary = await register.summarize(SCOPE);
    assert.equal(summary.total, 2);
    assert.equal(summary.accepts, 0);
    assert.equal(summary.moves, 1);
    assert.equal(summary.decidedThoughts, 1);
    assert.equal(summary.firstPassAcceptanceRate, 0);
  });

  it("summarizes accept/move counts and the first-pass acceptance rate (FR-2)", async () => {
    await register.record(SCOPE, acceptInput("th-1"));
    await register.record(SCOPE, acceptInput("th-2"));
    await register.record(SCOPE, acceptInput("th-3"));
    await register.record(SCOPE, {
      kind: "move",
      participantId: "P-01",
      thoughtId: "th-4",
      donnaBucket: { id: "b-1", name: "Product Ideas" },
      decidedBucket: { id: "b-3", name: "Tasks" },
      correctionId: "corr-4",
    });
    const summary = await register.summarize(SCOPE);
    assert.equal(summary.accepts, 3);
    assert.equal(summary.moves, 1);
    assert.equal(summary.firstPassAcceptanceRate, 0.75);
    assert.equal(summary.decisionIds.length, 4);
  });

  it("reports a null rate when no decisions exist", async () => {
    const summary = await register.summarize(SCOPE);
    assert.equal(summary.total, 0);
    assert.equal(summary.firstPassAcceptanceRate, null);
  });
});

describe("decision register file store (SR-1)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "donna-decisions-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips records through the scoped partition file", async () => {
    const store = new FilePilotDecisionStore(dir);
    const fileRegister = new DecisionRegister(store, () => now, () => "d-1");
    await fileRegister.record(SCOPE, acceptInput("th-1"));
    const listed = await store.list(SCOPE.tenantId, SCOPE.userId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, "d-1");
    // Another partition sees nothing.
    assert.deepEqual(await store.list("other-tenant", "other-user"), []);
  });

  it("rejects records whose tenant/user do not match the partition", async () => {
    const store = new FilePilotDecisionStore(dir);
    await store.saveAll(SCOPE.tenantId, SCOPE.userId, [
      {
        schema: "donna.pilot-decision.v1",
        id: "d-x",
        tenantId: "someone-else",
        userId: "u",
        participantId: "P-99",
        thoughtId: "th-1",
        kind: "accept",
        donnaBucket: { id: "b-1", name: "A" },
        decidedBucket: { id: "b-1", name: "A" },
        decidedAt: now.toISOString(),
      },
    ]);
    await assert.rejects(store.list(SCOPE.tenantId, SCOPE.userId), /partition/);
  });
});

describe("run-end placement decision gathering (Spec 6.4 FR-2, AC-1)", () => {
  it("collectPlacementDecisions counts the window, latest-per-thought, and the undecided", () => {
    const window = { startedAt: "2026-09-04T10:00:00.000Z", endedAt: "2026-09-04T11:00:00.000Z" };
    const decisions = [
      // in-window accept on th-1
      { ...decision("d-1", "th-1", "accept", "2026-09-04T10:10:00.000Z") },
      // in-window accept then move on th-2 — latest wins
      { ...decision("d-2", "th-2", "accept", "2026-09-04T10:20:00.000Z") },
      { ...decision("d-3", "th-2", "move", "2026-09-04T10:30:00.000Z") },
      // out-of-window decision — not counted in the run
      { ...decision("d-4", "th-9", "accept", "2026-09-04T09:00:00.000Z") },
    ];
    const thoughts = [
      { id: "th-1", captureId: "cap-1" },
      { id: "th-2", captureId: "cap-1" },
      { id: "th-3", captureId: "cap-1" }, // never decided
      { id: "th-9", captureId: "cap-2" }, // different capture
    ];
    const counts = collectPlacementDecisions(window, decisions, thoughts, ["cap-1"]);
    assert.equal(counts.accepts, 1);
    assert.equal(counts.moves, 1);
    assert.deepEqual(counts.decisionIds.sort(), ["d-1", "d-3"]);
    assert.deepEqual(counts.undecidedThoughtIds, ["th-3"]);
  });

  it("a decision after the window does not rescue the thought — undecided is measured at run end", () => {
    const window = { startedAt: "2026-09-04T10:00:00.000Z", endedAt: "2026-09-04T11:00:00.000Z" };
    const decisions = [decision("d-1", "th-1", "accept", "2026-09-04T11:30:00.000Z")];
    const counts = collectPlacementDecisions(
      window,
      decisions,
      [{ id: "th-1", captureId: "cap-1" }],
      ["cap-1"],
    );
    assert.equal(counts.accepts, 0); // not inside the window
    assert.deepEqual(counts.undecidedThoughtIds, ["th-1"]); // undecided at run end
  });

  it("run end records placement counts and the undecided count on the run record", async () => {
    const run = await runs.start(SCOPE, {
      participantId: "P-01",
      scenarioId: "SC-IDEA-01",
      configFingerprint: "fp",
    });
    now = new Date("2026-09-04T12:30:00.000Z");
    const ended = await runs.end(SCOPE, run.id, {
      captures: [{ id: "cap-1", capturedAt: "2026-09-04T12:10:00.000Z" }],
      corrections: [],
      memoryEvents: [],
      decisions: [
        decision("d-1", "th-1", "accept", "2026-09-04T12:15:00.000Z"),
        decision("d-2", "th-2", "move", "2026-09-04T12:20:00.000Z"),
      ],
      thoughts: [
        { id: "th-1", captureId: "cap-1" },
        { id: "th-2", captureId: "cap-1" },
        { id: "th-3", captureId: "cap-1" },
      ],
    });
    assert.equal(ended.decisions.placement?.accepts, 1);
    assert.equal(ended.decisions.placement?.moves, 1);
    assert.deepEqual(ended.decisions.placement?.undecidedThoughtIds, ["th-3"]);
  });

  it("pre-6.4 callers without decisions still end runs (no placement block)", async () => {
    const run = await runs.start(SCOPE, {
      participantId: "P-01",
      scenarioId: "SC-MEET-01",
      configFingerprint: "fp",
    });
    const ended = await runs.end(SCOPE, run.id, {
      captures: [],
      corrections: [],
      memoryEvents: [],
    });
    assert.equal(ended.decisions.placement, undefined);
  });
});

function decision(id: string, thoughtId: string, kind: "accept" | "move", decidedAt: string): PilotDecision {
  return {
    schema: "donna.pilot-decision.v1",
    id,
    tenantId: SCOPE.tenantId,
    userId: SCOPE.userId,
    participantId: "P-01",
    thoughtId,
    captureId: "cap-1",
    kind,
    donnaBucket: { id: "b-1", name: "Product Ideas" },
    decidedBucket:
      kind === "accept" ? { id: "b-1", name: "Product Ideas" } : { id: "b-2", name: "Vendor Portal" },
    ...(kind === "move" ? { correctionId: `corr-${id}` } : {}),
    decidedAt,
  };
}
