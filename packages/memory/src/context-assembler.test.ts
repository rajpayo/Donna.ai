import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type {
  Bucket,
  BucketStore,
  CaptureRecord,
  CaptureStore,
  ContextBudgets,
  MemoryRecord,
  TranscriptRecord,
  TranscriptStore,
} from "@donna/core";
import { ContextAssembler, estimateTokens, relevanceScore } from "./context-assembler.js";
import { MemoryService, type Scope } from "./service.js";
import { FileConsentStore, FileMemoryStore } from "./store.file.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCOPE: Scope = { tenantId: "t", userId: "u" };
const OTHER: Scope = { tenantId: "t", userId: "other" };

const BUDGETS: ContextBudgets = {
  maxTokens: 1200,
  maxItems: 24,
  recentCaptures: 3,
  maxMemories: 12,
  maxBucketSummaries: 10,
  maxCorrectionExamples: 3,
};

class StubBucketStore implements BucketStore {
  buckets: Bucket[] = [];
  async listBuckets(t: string, u: string): Promise<Bucket[]> {
    return this.buckets.filter((b) => b.tenantId === t && b.userId === u);
  }
  async getBucketByName(t: string, u: string, name: string) {
    return this.buckets.find(
      (b) => b.tenantId === t && b.userId === u && b.name === name,
    );
  }
  async createBucket(bucket: Bucket): Promise<Bucket> {
    this.buckets.push(bucket);
    return bucket;
  }
  async updateBucketStats(): Promise<void> {}
  async saveItem(): Promise<void> {}
  async listItems(): Promise<Array<{ thought: never; bucketId: string }>> {
    return [];
  }
  async deleteItemsForCapture(): Promise<{ removed: number }> {
    return { removed: 0 };
  }
  async moveItem(): Promise<void> {
    throw new Error("not used in assembler tests");
  }
  async renameBucket(): Promise<void> {
    throw new Error("not used in assembler tests");
  }
  async mergeBuckets(): Promise<void> {
    throw new Error("not used in assembler tests");
  }
  async updateItem(): Promise<void> {
    throw new Error("not used in assembler tests");
  }
}

class StubCaptureStore implements CaptureStore {
  captures: CaptureRecord[] = [];
  async saveCapture(record: CaptureRecord): Promise<void> {
    this.captures.push(record);
  }
  async getCapture(t: string, u: string, id: string) {
    return this.captures.find(
      (c) => c.tenantId === t && c.userId === u && c.id === id,
    );
  }
  async listCaptures(t: string, u: string) {
    return this.captures
      .filter((c) => c.tenantId === t && c.userId === u)
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }
  async markAudioDeleted(): Promise<void> {}
  async deleteCapture(t: string, u: string, id: string) {
    this.captures = this.captures.filter(
      (c) => !(c.tenantId === t && c.userId === u && c.id === id),
    );
  }
}

class StubTranscriptStore implements TranscriptStore {
  transcripts: TranscriptRecord[] = [];
  async saveTranscript(record: TranscriptRecord): Promise<void> {
    this.transcripts.push(record);
  }
  async getTranscript(t: string, u: string, captureId: string) {
    return this.transcripts.find(
      (r) => r.tenantId === t && r.userId === u && r.captureId === captureId,
    );
  }
  async deleteTranscript(): Promise<void> {}
}

function bucket(id: string, name: string, description: string): Bucket {
  return {
    id,
    tenantId: SCOPE.tenantId,
    userId: SCOPE.userId,
    name,
    description,
    centroid: [1, 0],
    itemCount: 2,
    createdAt: "2026-09-01T10:00:00.000Z",
    origin: "auto",
  };
}

function capture(id: string, capturedAt: string): CaptureRecord {
  return {
    id,
    tenantId: SCOPE.tenantId,
    userId: SCOPE.userId,
    contentHash: "abc",
    capturedAt,
  };
}

function transcript(captureId: string, text: string): TranscriptRecord {
  return {
    captureId,
    tenantId: SCOPE.tenantId,
    userId: SCOPE.userId,
    text,
    segments: [],
    model: "test",
    contentHash: "abc",
    createdAt: "2026-09-01T10:00:00.000Z",
  };
}

let dir: string;
let memoryService: MemoryService;
let bucketStore: StubBucketStore;
let captureStore: StubCaptureStore;
let transcriptStore: StubTranscriptStore;
let idCounter: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "donna-ctx-"));
  idCounter = 0;
  const ids = () => `id-${++idCounter}`;
  memoryService = new MemoryService({
    memories: new FileMemoryStore(dir),
    consents: new FileConsentStore(dir),
    now: () => new Date("2026-09-03T10:00:00.000Z"),
    idGen: ids,
  });
  bucketStore = new StubBucketStore();
  captureStore = new StubCaptureStore();
  transcriptStore = new StubTranscriptStore();
});

function assembler(budgets: ContextBudgets = BUDGETS): ContextAssembler {
  return new ContextAssembler({
    memory: memoryService,
    buckets: bucketStore,
    captures: captureStore,
    transcripts: transcriptStore,
    budgets,
    now: () => new Date("2026-09-03T10:00:00.000Z"),
    idGen: () => "packet-1",
  });
}

async function stateMemory(
  text: string,
  origin: "explicit" | "approved",
  over: { kind?: string; subject?: string } = {},
): Promise<MemoryRecord> {
  const input = {
    layer: "semantic" as const,
    kind: over.kind ?? "preference",
    subject: over.subject ?? `preference:${text.slice(0, 16)}`,
    text,
    sources: [{ kind: "explicit-statement" as const, id: "cli", reason: "test" }],
  };
  if (origin === "explicit") {
    return memoryService.stateExplicit(SCOPE, input);
  }
  const proposal = await memoryService.propose(SCOPE, input, {
    model: "gpt-5-mini",
    version: "test",
  });
  return memoryService.approve(SCOPE, proposal.id);
}

describe("ContextAssembler selection (FR-1, FR-3)", () => {
  it("includes relevant confirmed memories and excludes irrelevant inferred ones", async () => {
    await stateMemory("Prefers short bullet summaries", "explicit");
    await stateMemory("Vendor contract with Acme needs review", "approved", {
      kind: "fact",
      subject: "fact:vendor",
    });
    await stateMemory("Recipe for sourdough bread", "approved", {
      kind: "fact",
      subject: "fact:bread",
    });

    const packet = await assembler().assemble(SCOPE, {
      text: "review the Acme vendor contract",
    });
    const texts = packet.elements.map((e) => e.text);
    assert.ok(texts.includes("Prefers short bullet summaries")); // explicit: always eligible
    assert.ok(texts.includes("Vendor contract with Acme needs review")); // relevant inferred
    assert.ok(!texts.includes("Recipe for sourdough bread")); // irrelevant inferred
  });

  it("never serves pending or rejected proposals as context (AC-3 of Spec 2.1)", async () => {
    await memoryService.propose(
      SCOPE,
      {
        layer: "semantic",
        kind: "preference",
        subject: "preference:vendor",
        text: "vendor pending proposal",
        sources: [{ kind: "thought", id: "th-1", reason: "inferred" }],
      },
      { model: "m", version: "v" },
    );
    const packet = await assembler().assemble(SCOPE, { text: "vendor contract" });
    assert.equal(packet.elements.length, 0);
  });

  it("includes bucket summaries and recent capture excerpts with source IDs and freshness", async () => {
    bucketStore.buckets.push(bucket("b-1", "Tasks", "Commitments and actions"));
    captureStore.captures.push(
      capture("cap-old", "2026-09-01T09:00:00.000Z"),
      capture("cap-new", "2026-09-02T09:00:00.000Z"),
    );
    transcriptStore.transcripts.push(
      transcript("cap-old", "older note about hiring"),
      transcript("cap-new", "newer note about the launch"),
    );

    const packet = await assembler().assemble(SCOPE, { text: "anything" });
    const bucketEl = packet.elements.find((e) => e.sourceKind === "bucket");
    assert.equal(bucketEl?.sourceId, "b-1");
    assert.equal(bucketEl?.asOf, "2026-09-01T10:00:00.000Z");
    const captureEls = packet.elements.filter((e) => e.sourceKind === "capture");
    assert.equal(captureEls.length, 2);
    // Recency order is not guaranteed inside the packet (priority sort), but
    // both must carry their IDs and freshness.
    assert.ok(captureEls.every((e) => e.asOf.startsWith("2026-09-0")));
  });

  it("excludes the capture currently being organized", async () => {
    captureStore.captures.push(capture("cap-current", "2026-09-02T09:00:00.000Z"));
    transcriptStore.transcripts.push(transcript("cap-current", "this very note"));
    const packet = await assembler().assemble(SCOPE, {
      text: "this very note",
      excludeCaptureId: "cap-current",
    });
    assert.equal(packet.elements.length, 0);
  });

  it("never includes another user's records (SR-2)", async () => {
    await memoryService.stateExplicit(OTHER, {
      layer: "semantic",
      kind: "preference",
      subject: "preference:x",
      text: "other user's private preference",
      sources: [{ kind: "explicit-statement", id: "cli", reason: "test" }],
    });
    const packet = await assembler().assemble(SCOPE, {
      text: "private preference",
    });
    assert.equal(packet.elements.length, 0);
    assert.equal(packet.tenantId, SCOPE.tenantId);
    assert.equal(packet.userId, SCOPE.userId);
  });
});

describe("ContextAssembler budgets (FR-2, AC-1)", () => {
  it("truncates deterministically under the token budget", async () => {
    for (let i = 0; i < 6; i++) {
      await stateMemory(`vendor preference number ${i} with some length`, "explicit", {
        subject: `preference:${i}`,
      });
    }
    const tight = { ...BUDGETS, maxTokens: estimateTokens("vendor preference number 0 with some length") * 2 };
    const first = await assembler(tight).assemble(SCOPE, { text: "vendor" });
    const second = await assembler(tight).assemble(SCOPE, { text: "vendor" });
    assert.ok(first.totals.tokens <= tight.maxTokens);
    assert.equal(first.totals.items, 2);
    assert.equal(first.totals.truncated, 4);
    // Deterministic: identical inputs produce identical packets.
    assert.deepEqual(
      first.elements.map((e) => e.sourceId),
      second.elements.map((e) => e.sourceId),
    );
  });

  it("confirmed explicit settings outrank inferred memory under pressure (FR-3)", async () => {
    await stateMemory("explicit vendor setting", "explicit", {
      subject: "preference:vendor",
    });
    await stateMemory("inferred vendor note", "approved", {
      kind: "fact",
      subject: "fact:vendor",
    });
    const tight = { ...BUDGETS, maxTokens: estimateTokens("explicit vendor setting") };
    const packet = await assembler(tight).assemble(SCOPE, { text: "vendor" });
    assert.equal(packet.totals.items, 1);
    assert.equal(packet.elements[0]?.text, "explicit vendor setting");
    assert.equal(packet.elements[0]?.trust, "trusted-user-settings");
  });

  it("honours the item cap", async () => {
    for (let i = 0; i < 5; i++) {
      await stateMemory(`vendor item ${i}`, "explicit", { subject: `preference:${i}` });
    }
    const tight = { ...BUDGETS, maxItems: 2 };
    const packet = await assembler(tight).assemble(SCOPE, { text: "vendor" });
    assert.equal(packet.totals.items, 2);
    assert.equal(packet.totals.truncated, 3);
  });
});

describe("ContextAssembler deletion and degradation (SR-4, AC-4)", () => {
  it("a forgotten memory never reappears in later packets", async () => {
    const memory = await stateMemory("vendor preference to forget", "explicit", {
      subject: "preference:vendor",
    });
    const before = await assembler().assemble(SCOPE, { text: "vendor" });
    assert.equal(before.elements.length, 1);
    await memoryService.forget(SCOPE, memory.id);
    const after = await assembler().assemble(SCOPE, { text: "vendor" });
    assert.equal(after.elements.length, 0);
  });

  it("an expired memory never reappears in later packets", async () => {
    let now = new Date("2026-09-03T10:00:00.000Z");
    const svc = new MemoryService({
      memories: new FileMemoryStore(dir),
      consents: new FileConsentStore(dir),
      now: () => now,
      idGen: () => `exp-${++idCounter}`,
    });
    await svc.stateExplicit(SCOPE, {
      layer: "semantic",
      kind: "preference",
      subject: "preference:shortlived",
      text: "short-lived vendor preference",
      sources: [{ kind: "explicit-statement", id: "cli", reason: "test" }],
      expiresAt: "2026-09-03T11:00:00.000Z",
    });
    const asm = new ContextAssembler({
      memory: svc,
      buckets: bucketStore,
      captures: captureStore,
      transcripts: transcriptStore,
      budgets: BUDGETS,
      now: () => now,
    });
    assert.equal(
      (await asm.assemble(SCOPE, { text: "vendor" })).elements.length,
      1,
    );
    now = new Date("2026-09-03T12:00:00.000Z");
    assert.equal(
      (await asm.assemble(SCOPE, { text: "vendor" })).elements.length,
      0,
    );
  });

  it("degrades deterministically when the memory store is unavailable", async () => {
    bucketStore.buckets.push(bucket("b-1", "Tasks", "Commitments"));
    const failingMemory = {
      listConfirmed: async (): Promise<MemoryRecord[]> => {
        throw new Error("disk gone");
      },
    };
    const asm = new ContextAssembler({
      memory: failingMemory,
      buckets: bucketStore,
      captures: captureStore,
      transcripts: transcriptStore,
      budgets: BUDGETS,
      now: () => new Date("2026-09-03T10:00:00.000Z"),
      idGen: () => "packet-1",
    });
    const packet = await asm.assemble(SCOPE, { text: "anything" });
    assert.equal(packet.degraded, true);
    assert.deepEqual(packet.degradedReasons, ["memories-unavailable"]);
    // Buckets still assembled — organization can proceed.
    assert.equal(packet.elements.length, 1);
    assert.equal(packet.elements[0]?.sourceKind, "bucket");
  });
});

describe("relevance scoring", () => {
  it("is deterministic and symmetric in expectation", () => {
    assert.ok(relevanceScore("vendor contract review", "vendor contract with Acme") >= 2);
    assert.equal(relevanceScore("vendor contract", "sourdough bread"), 0);
  });
});
