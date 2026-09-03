import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type {
  ConsentRecord,
  ConsentStore,
  MemoryEvent,
  MemoryProposal,
  MemoryRecord,
  MemoryStore,
} from "@donna/core";
import {
  MemoryNotFoundError,
  MemoryService,
  SensitiveContentError,
  type Scope,
} from "./service.js";

/** In-memory stores implementing the scoped ports. */
class MemStore implements MemoryStore {
  memories: MemoryRecord[] = [];
  proposals: MemoryProposal[] = [];
  events: MemoryEvent[] = [];

  async saveMemory(record: MemoryRecord): Promise<void> {
    const i = this.memories.findIndex((m) => m.id === record.id);
    if (i >= 0) this.memories[i] = record;
    else this.memories.push(record);
  }
  async getMemory(t: string, u: string, id: string): Promise<MemoryRecord | undefined> {
    return this.memories.find(
      (m) => m.tenantId === t && m.userId === u && m.id === id,
    );
  }
  async listMemories(t: string, u: string): Promise<MemoryRecord[]> {
    return this.memories.filter((m) => m.tenantId === t && m.userId === u);
  }
  async deleteMemory(t: string, u: string, id: string): Promise<boolean> {
    const before = this.memories.length;
    this.memories = this.memories.filter(
      (m) => !(m.tenantId === t && m.userId === u && m.id === id),
    );
    return this.memories.length < before;
  }
  async saveProposal(proposal: MemoryProposal): Promise<void> {
    const i = this.proposals.findIndex((p) => p.id === proposal.id);
    if (i >= 0) this.proposals[i] = proposal;
    else this.proposals.push(proposal);
  }
  async getProposal(t: string, u: string, id: string): Promise<MemoryProposal | undefined> {
    return this.proposals.find(
      (p) => p.tenantId === t && p.userId === u && p.id === id,
    );
  }
  async listProposals(t: string, u: string): Promise<MemoryProposal[]> {
    return this.proposals.filter((p) => p.tenantId === t && p.userId === u);
  }
  async deleteProposal(t: string, u: string, id: string): Promise<boolean> {
    const before = this.proposals.length;
    this.proposals = this.proposals.filter(
      (p) => !(p.tenantId === t && p.userId === u && p.id === id),
    );
    return this.proposals.length < before;
  }
  async appendEvent(event: MemoryEvent): Promise<void> {
    this.events.push(event);
  }
  async listEvents(t: string, u: string): Promise<MemoryEvent[]> {
    return this.events.filter((e) => e.tenantId === t && e.userId === u);
  }
}

class MemConsents implements ConsentStore {
  records: ConsentRecord[] = [];
  async recordConsent(record: ConsentRecord): Promise<void> {
    this.records.push(record);
  }
  async listConsents(t: string, u: string): Promise<ConsentRecord[]> {
    return this.records.filter((r) => r.tenantId === t && r.userId === u);
  }
}

const SCOPE: Scope = { tenantId: "t", userId: "u" };
const OTHER: Scope = { tenantId: "t", userId: "other" };

const SRC = { kind: "explicit-statement" as const, id: "cli-1", reason: "user said so" };

let now: Date;
let store: MemStore;
let consents: MemConsents;
let service: MemoryService;
let idCounter: number;

beforeEach(() => {
  now = new Date("2026-09-03T10:00:00.000Z");
  store = new MemStore();
  consents = new MemConsents();
  idCounter = 0;
  service = new MemoryService({
    memories: store,
    consents,
    now: () => now,
    idGen: () => `id-${++idCounter}`,
  });
});

describe("memory layers (AC-1)", () => {
  it("creates and separates all four layers", async () => {
    await service.addWorking(SCOPE, "sess-1", "2026-09-03T11:00:00.000Z", {
      kind: "scratch",
      subject: "scratch:note",
      text: "current call context",
      sources: [{ kind: "session", id: "sess-1", reason: "live session" }],
    });
    await service.stateExplicit(SCOPE, {
      layer: "episodic",
      kind: "decision",
      subject: "decision:vendor",
      text: "Chose Acme as the vendor on 2026-09-01",
      sources: [{ kind: "thought", id: "th-1", captureId: "cap-1", reason: "decision captured" }],
    });
    await service.stateExplicit(SCOPE, {
      layer: "semantic",
      kind: "preference",
      subject: "preference:summary-style",
      text: "Prefers short bullet summaries",
      sources: [SRC],
    });
    await service.stateExplicit(SCOPE, {
      layer: "procedural",
      kind: "organization-preference",
      subject: "bucket:hiring",
      text: "Hiring thoughts go to the People bucket",
      sources: [{ kind: "correction", id: "corr-1", reason: "user moved a thought" }],
    });

    assert.equal((await service.listConfirmed(SCOPE, "working")).length, 1);
    assert.equal((await service.listConfirmed(SCOPE, "episodic")).length, 1);
    assert.equal((await service.listConfirmed(SCOPE, "semantic")).length, 1);
    assert.equal((await service.listConfirmed(SCOPE, "procedural")).length, 1);
    assert.equal((await service.listConfirmed(SCOPE)).length, 4);
  });

  it("requires a source and non-empty text for every memory (FR-2)", async () => {
    await assert.rejects(
      () =>
        service.stateExplicit(SCOPE, {
          layer: "semantic",
          kind: "fact",
          subject: "fact:x",
          text: "no source",
          sources: [],
        }),
      /source/,
    );
    await assert.rejects(
      () =>
        service.stateExplicit(SCOPE, {
          layer: "semantic",
          kind: "fact",
          subject: "fact:x",
          text: "   ",
          sources: [SRC],
        }),
      /empty/,
    );
  });
});

describe("proposal lifecycle (FR-1, AC-3)", () => {
  const inferred = {
    layer: "semantic" as const,
    kind: "preference",
    subject: "preference:meeting-time",
    text: "Prefers morning meetings",
    sources: [{ kind: "thought" as const, id: "th-9", captureId: "cap-9", reason: "recurring theme" }],
  };

  it("proposals are quarantined until visibly approved", async () => {
    const proposal = await service.propose(SCOPE, inferred, {
      model: "gpt-5-mini",
      version: "donna.organize.v1",
    });
    assert.equal(proposal.status, "pending");
    assert.equal((await service.listConfirmed(SCOPE)).length, 0);
    assert.equal((await service.listPendingProposals(SCOPE)).length, 1);

    const memory = await service.approve(SCOPE, proposal.id);
    assert.equal(memory.status, "confirmed");
    assert.equal(memory.origin, "approved");
    assert.equal((await service.listConfirmed(SCOPE)).length, 1);
    assert.equal((await service.listPendingProposals(SCOPE)).length, 0);
  });

  it("a rejected proposal never becomes servable memory (AC-3)", async () => {
    const proposal = await service.propose(SCOPE, inferred, {
      model: "gpt-5-mini",
      version: "donna.organize.v1",
    });
    await service.reject(SCOPE, proposal.id);
    assert.equal((await service.listConfirmed(SCOPE)).length, 0);
    assert.equal((await service.listPendingProposals(SCOPE)).length, 0);
    await assert.rejects(() => service.approve(SCOPE, proposal.id), /rejected/);
    await assert.rejects(() => service.reject(SCOPE, proposal.id), /rejected/);
  });

  it("records provenance and reason on every durable memory (AC-2)", async () => {
    const proposal = await service.propose(SCOPE, inferred, {
      model: "gpt-5-mini",
      version: "donna.organize.v1",
    });
    const memory = await service.approve(SCOPE, proposal.id);
    assert.equal(memory.sources.length, 1);
    assert.equal(memory.sources[0]?.id, "th-9");
    assert.equal(memory.sources[0]?.reason, "recurring theme");
    assert.equal(memory.confidence, 0.5);
  });

  it("rejects model-generated memory containing secrets (SR-4)", async () => {
    await assert.rejects(
      () =>
        service.propose(
          SCOPE,
          { ...inferred, text: "API key sk-abcdefghijklmnop123456" },
          { model: "gpt-5-mini", version: "donna.organize.v1" },
        ),
      (error: unknown) => {
        assert.ok(error instanceof SensitiveContentError);
        assert.ok(!error.message.includes("sk-abcdefghijklmnop123456"));
        return true;
      },
    );
    assert.equal((await service.listPendingProposals(SCOPE)).length, 0);
  });
});

describe("conflict and supersession (FR-3)", () => {
  const base = {
    layer: "semantic" as const,
    kind: "preference",
    subject: "preference:summary-style",
    sources: [SRC],
  };

  it("records a conflict event instead of silently overwriting", async () => {
    const first = await service.stateExplicit(SCOPE, {
      ...base,
      text: "Prefers short bullet summaries",
    });
    const second = await service.stateExplicit(SCOPE, {
      ...base,
      text: "Prefers long narrative summaries",
    });
    // Both remain confirmed; nothing was overwritten.
    assert.equal((await service.listConfirmed(SCOPE)).length, 2);
    const events = await store.listEvents(SCOPE.tenantId, SCOPE.userId);
    const conflict = events.find((e) => e.type === "conflict");
    assert.equal(conflict?.memoryId, second.id);
    assert.equal(conflict?.detail, `with=${first.id}`);
  });

  it("supersede retires the old record and confirms the replacement", async () => {
    const first = await service.stateExplicit(SCOPE, {
      ...base,
      text: "Prefers short bullet summaries",
    });
    const next = await service.supersede(SCOPE, first.id, {
      text: "Prefers long narrative summaries",
    });
    assert.equal(next.status, "confirmed");
    assert.equal(next.subject, first.subject);

    const retired = await store.getMemory(SCOPE.tenantId, SCOPE.userId, first.id);
    assert.equal(retired?.status, "superseded");
    assert.equal(retired?.supersededBy, next.id);
    // The serving view shows only the replacement.
    const served = await service.listConfirmed(SCOPE);
    assert.equal(served.length, 1);
    assert.equal(served[0]?.id, next.id);
    const events = await store.listEvents(SCOPE.tenantId, SCOPE.userId);
    assert.ok(
      events.some(
        (e) => e.type === "superseded" && e.memoryId === first.id && e.detail === `by=${next.id}`,
      ),
    );
  });

  it("refuses to supersede a non-confirmed memory", async () => {
    const first = await service.stateExplicit(SCOPE, { ...base, text: "one" });
    const next = await service.supersede(SCOPE, first.id, { text: "two" });
    await assert.rejects(
      () => service.supersede(SCOPE, first.id, { text: "three" }),
      /superseded/,
    );
    assert.ok(next.id !== first.id);
  });
});

describe("TTL and sessions (FR-4)", () => {
  it("working memory expires with the session", async () => {
    await service.addWorking(SCOPE, "sess-1", "2026-09-03T11:00:00.000Z", {
      kind: "scratch",
      subject: "scratch:a",
      text: "session note",
      sources: [{ kind: "session", id: "sess-1", reason: "live session" }],
    });
    await service.addWorking(SCOPE, "sess-2", "2026-09-03T11:00:00.000Z", {
      kind: "scratch",
      subject: "scratch:b",
      text: "other session note",
      sources: [{ kind: "session", id: "sess-2", reason: "live session" }],
    });
    const result = await service.expireSession(SCOPE, "sess-1");
    assert.equal(result.removed, 1);
    const remaining = await service.listConfirmed(SCOPE, "working");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.sessionId, "sess-2");
  });

  it("working memory requires an expiry", async () => {
    await assert.rejects(
      () =>
        service.stateExplicit(SCOPE, {
          layer: "working",
          kind: "scratch",
          subject: "scratch:x",
          text: "no expiry",
          sources: [SRC],
        }),
      /expiry/,
    );
  });

  it("sweep removes expired working memory and retires expired durable memory", async () => {
    await service.addWorking(SCOPE, "sess-1", "2026-09-03T10:30:00.000Z", {
      kind: "scratch",
      subject: "scratch:a",
      text: "short-lived",
      sources: [{ kind: "session", id: "sess-1", reason: "live session" }],
    });
    const durable = await service.stateExplicit(SCOPE, {
      layer: "episodic",
      kind: "theme",
      subject: "theme:launch",
      text: "Launch prep dominated the week",
      sources: [SRC],
      expiresAt: "2026-09-03T10:30:00.000Z",
    });
    now = new Date("2026-09-03T12:00:00.000Z");
    const first = await service.sweepExpired(SCOPE);
    assert.deepEqual(first, { removed: 1, expired: 1 });
    assert.equal((await service.listConfirmed(SCOPE)).length, 0);
    const retired = await store.getMemory(SCOPE.tenantId, SCOPE.userId, durable.id);
    assert.equal(retired?.status, "expired");
    // Idempotent replay.
    const second = await service.sweepExpired(SCOPE);
    assert.deepEqual(second, { removed: 0, expired: 0 });
  });

  it("unexpired memories keep being served", async () => {
    await service.stateExplicit(SCOPE, {
      layer: "semantic",
      kind: "preference",
      subject: "preference:x",
      text: "durable",
      sources: [SRC],
      expiresAt: "2026-09-04T10:00:00.000Z",
    });
    const result = await service.sweepExpired(SCOPE);
    assert.deepEqual(result, { removed: 0, expired: 0 });
    assert.equal((await service.listConfirmed(SCOPE)).length, 1);
  });
});

describe("forget and export (SR-3)", () => {
  it("forget removes the memory and records the event", async () => {
    const memory = await service.stateExplicit(SCOPE, {
      layer: "semantic",
      kind: "preference",
      subject: "preference:x",
      text: "forget me",
      sources: [SRC],
    });
    await service.forget(SCOPE, memory.id);
    assert.equal((await service.listAll(SCOPE)).length, 0);
    await service.forget(SCOPE, memory.id); // idempotent
    const events = await store.listEvents(SCOPE.tenantId, SCOPE.userId);
    assert.ok(events.some((e) => e.type === "forgotten" && e.memoryId === memory.id));
  });

  it("export contains only the requesting scope's data", async () => {
    await service.stateExplicit(SCOPE, {
      layer: "semantic",
      kind: "preference",
      subject: "preference:x",
      text: "mine",
      sources: [SRC],
    });
    await service.stateExplicit(OTHER, {
      layer: "semantic",
      kind: "preference",
      subject: "preference:x",
      text: "someone else's",
      sources: [SRC],
    });
    await service.grantConsent(SCOPE, "emotion.persist", "test");

    const bundle = await service.exportAll(SCOPE);
    assert.equal(bundle.schema, "donna.memory-export.v1");
    assert.equal(bundle.memories.length, 1);
    assert.equal(bundle.memories[0]?.text, "mine");
    assert.equal(bundle.consents.length, 1);
    assert.ok(!JSON.stringify(bundle).includes("someone else's"));
  });
});

describe("source deletion propagation (AC-4)", () => {
  it("removes sole-source memories and unlinks multi-source ones", async () => {
    const sole = await service.stateExplicit(SCOPE, {
      layer: "episodic",
      kind: "decision",
      subject: "decision:a",
      text: "decided from capture 1",
      sources: [{ kind: "thought", id: "th-1", captureId: "cap-1", reason: "captured" }],
    });
    const multi = await service.stateExplicit(SCOPE, {
      layer: "semantic",
      kind: "fact",
      subject: "fact:b",
      text: "seen in two captures",
      sources: [
        { kind: "thought", id: "th-1", captureId: "cap-1", reason: "first" },
        { kind: "thought", id: "th-2", captureId: "cap-2", reason: "second" },
      ],
    });
    await service.propose(
      SCOPE,
      {
        layer: "semantic",
        kind: "fact",
        subject: "fact:c",
        text: "pending inference from capture 1",
        sources: [{ kind: "thought", id: "th-1", captureId: "cap-1", reason: "inferred" }],
      },
      { model: "gpt-5-mini", version: "donna.organize.v1" },
    );

    const result = await service.removeSource(SCOPE, {
      kind: "capture",
      id: "cap-1",
      captureId: "cap-1",
    });
    assert.deepEqual(result, {
      memoriesRemoved: 1,
      sourcesUnlinked: 1,
      proposalsRemoved: 1,
    });

    assert.equal(
      await store.getMemory(SCOPE.tenantId, SCOPE.userId, sole.id),
      undefined,
    );
    const surviving = await store.getMemory(SCOPE.tenantId, SCOPE.userId, multi.id);
    assert.equal(surviving?.sources.length, 1);
    assert.equal(surviving?.sources[0]?.id, "th-2");
    assert.equal((await service.listPendingProposals(SCOPE)).length, 0);
  });
});

describe("consent lifecycle", () => {
  it("grant, active check, and revoke", async () => {
    assert.equal(await service.hasConsent(SCOPE, "emotion.persist"), false);
    await service.grantConsent(SCOPE, "emotion.persist", "cli:consent grant");
    assert.equal(await service.hasConsent(SCOPE, "emotion.persist"), true);
    await service.revokeConsent(SCOPE, "emotion.persist");
    assert.equal(await service.hasConsent(SCOPE, "emotion.persist"), false);
    // Revocation is idempotent and history is preserved.
    await service.revokeConsent(SCOPE, "emotion.persist");
    assert.equal((await service.listConsents(SCOPE)).length, 2);
  });

  it("consent is scoped per user", async () => {
    await service.grantConsent(SCOPE, "emotion.persist", "test");
    assert.equal(await service.hasConsent(OTHER, "emotion.persist"), false);
  });
});

describe("scope isolation (AC-5)", () => {
  it("operations in one scope never touch another", async () => {
    const memory = await service.stateExplicit(SCOPE, {
      layer: "semantic",
      kind: "preference",
      subject: "preference:x",
      text: "private to u",
      sources: [SRC],
    });
    // Forget is idempotent and scoped: the other user's call is a no-op.
    await service.forget(OTHER, memory.id);
    assert.ok(
      (await store.getMemory(SCOPE.tenantId, SCOPE.userId, memory.id)) !== undefined,
    );
    await assert.rejects(
      () => service.supersede(OTHER, memory.id, { text: "x" }),
      MemoryNotFoundError,
    );
    assert.equal((await service.listAll(OTHER)).length, 0);
    assert.equal((await service.listConfirmed(OTHER)).length, 0);
  });
});
