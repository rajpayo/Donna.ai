import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type {
  Bucket,
  BucketStore,
  ContextBudgets,
  CorrectionEvent,
  Embedder,
  Thought,
  TranscriptRecord,
  TranscriptStore,
} from "@donna/core";
import { DeterministicProvenanceVerifier } from "@donna/pipeline";
import { CorrectionService, type CorrectionInput } from "./corrections.js";
import { ContextAssembler } from "./context-assembler.js";
import { MemoryService, type Scope } from "./service.js";
import { FileConsentStore, FileCorrectionStore, FileMemoryStore } from "./store.file.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCOPE: Scope = { tenantId: "t", userId: "u" };
const OTHER: Scope = { tenantId: "t", userId: "other" };

/** In-memory bucket store implementing the full port. */
class MemBucketStore implements BucketStore {
  buckets: Bucket[] = [];
  items: Array<{ thought: Thought; bucketId: string }> = [];

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
  async updateBucketStats(_t: string, _u: string, id: string, centroid: number[], itemCount: number) {
    const b = this.buckets.find((x) => x.id === id);
    if (b) {
      b.centroid = centroid;
      b.itemCount = itemCount;
    }
  }
  async saveItem(item: { thought: Thought; bucketId: string }): Promise<void> {
    this.items.push(item);
  }
  async listItems(t: string, u: string) {
    return this.items.filter(
      (item) => item.thought.tenantId === t && item.thought.userId === u,
    );
  }
  async getItem(t: string, u: string, thoughtId: string) {
    return this.items.find(
      (item) =>
        item.thought.tenantId === t &&
        item.thought.userId === u &&
        item.thought.id === thoughtId,
    );
  }
  async listItemsByBucket(t: string, u: string, bucketId: string) {
    return this.items.filter(
      (item) =>
        item.thought.tenantId === t &&
        item.thought.userId === u &&
        item.bucketId === bucketId,
    );
  }
  async listItemsInRange(
    t: string,
    u: string,
    range: { from?: string; to?: string },
  ) {
    return this.items.filter((item) => {
      if (item.thought.tenantId !== t || item.thought.userId !== u) return false;
      const createdAt = item.thought.createdAt;
      if (createdAt === undefined) return false;
      if (range.from !== undefined && createdAt < range.from) return false;
      if (range.to !== undefined && createdAt > range.to) return false;
      return true;
    });
  }
  async deleteItemsForCapture() {
    return { removed: 0 };
  }
  async moveItem(_t: string, _u: string, thoughtId: string, toBucketId: string) {
    const item = this.items.find((candidate) => candidate.thought.id === thoughtId);
    if (!item) throw new Error("Thought does not exist in the requested tenant/user scope");
    if (!this.buckets.some((b) => b.id === toBucketId)) {
      throw new Error("Target bucket does not exist in the requested tenant/user scope");
    }
    item.bucketId = toBucketId;
    this.recomputeAll();
  }
  async renameBucket(_t: string, _u: string, bucketId: string, newName: string) {
    const b = this.buckets.find((x) => x.id === bucketId);
    if (!b) throw new Error("Bucket does not exist in the requested tenant/user scope");
    b.name = newName;
  }
  async mergeBuckets(_t: string, _u: string, sourceBucketId: string, targetBucketId: string) {
    for (const item of this.items) {
      if (item.bucketId === sourceBucketId) item.bucketId = targetBucketId;
    }
    this.buckets = this.buckets.filter((b) => b.id !== sourceBucketId);
    this.recomputeAll();
  }
  async updateItem(
    _t: string,
    _u: string,
    thoughtId: string,
    updates: {
      text?: string;
      summary?: string;
      task?: Thought["task"] | null;
      provenance?: Thought["provenance"];
      embedding?: number[];
    },
  ) {
    const item = this.items.find((candidate) => candidate.thought.id === thoughtId);
    if (!item) throw new Error("Thought does not exist in the requested tenant/user scope");
    if (updates.text !== undefined) item.thought.text = updates.text;
    if (updates.summary !== undefined) item.thought.summary = updates.summary;
    if (updates.task !== undefined) {
      if (updates.task === null) delete item.thought.task;
      else item.thought.task = updates.task;
    }
    if (updates.provenance !== undefined) item.thought.provenance = updates.provenance;
    if (updates.embedding !== undefined) item.thought.embedding = updates.embedding;
  }
  private recomputeAll() {
    for (const bucket of this.buckets) {
      const members = this.items.filter((item) => item.bucketId === bucket.id);
      bucket.itemCount = members.length;
      const embeddings = members
        .map((item) => item.thought.embedding)
        .filter((e): e is number[] => e !== undefined);
      bucket.centroid =
        embeddings.length === 0
          ? []
          : Array.from({ length: embeddings[0]!.length }, (_, i) =>
              embeddings.reduce((sum, e) => sum + (e[i] ?? 0), 0) / embeddings.length,
            );
    }
  }
}

class MemTranscriptStore implements TranscriptStore {
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

const stubEmbedder: Embedder = {
  modelId: "test-embedder",
  dimensions: 2,
  embed: async (texts: string[]) =>
    texts.map((text) => [text.length % 2 === 0 ? 1 : 0, text.length % 2 === 0 ? 0 : 1]),
};

function makeBucket(id: string, name: string, centroid: number[] = [1, 0]): Bucket {
  return {
    id,
    tenantId: SCOPE.tenantId,
    userId: SCOPE.userId,
    name,
    description: `${name} bucket`,
    centroid,
    itemCount: 0,
    createdAt: "2026-09-01T10:00:00.000Z",
    origin: "auto",
  };
}

function makeThought(id: string, text: string, embedding: number[] = [1, 0]): Thought {
  return {
    id,
    tenantId: SCOPE.tenantId,
    userId: SCOPE.userId,
    summary: text,
    text,
    confidence: 0.9,
    provenance: {
      captureId: "cap-1",
      segmentIds: ["seg-0"],
      sourceText: text,
      startSec: 0,
      endSec: 2,
    },
    versions: {
      organizerModel: "test",
      organizeSchemaVersion: "s",
      organizePromptVersion: "p",
    },
    embedding,
  };
}

let dir: string;
let buckets: MemBucketStore;
let transcripts: MemTranscriptStore;
let memory: MemoryService;
let corrections: CorrectionService;
let idCounter: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "donna-corr-"));
  idCounter = 0;
  const idGen = () => `corr-${++idCounter}`;
  buckets = new MemBucketStore();
  transcripts = new MemTranscriptStore();
  memory = new MemoryService({
    memories: new FileMemoryStore(dir),
    consents: new FileConsentStore(dir),
    now: () => new Date("2026-09-03T10:00:00.000Z"),
    idGen,
  });
  corrections = new CorrectionService({
    corrections: new FileCorrectionStore(dir),
    buckets,
    memory,
    transcripts,
    verifier: new DeterministicProvenanceVerifier(),
    embedder: stubEmbedder,
    now: () => new Date("2026-09-03T10:00:00.000Z"),
    idGen,
  });
});

function moveInput(thoughtId: string, toBucketId: string, summary: string, toName = "People Ops"): CorrectionInput {
  return {
    type: "bucket.move",
    target: { kind: "thought", id: thoughtId },
    payload: {
      fromBucketId: "b-random",
      fromBucketName: "Random",
      toBucketId,
      toBucketName: toName,
      thoughtSummary: summary,
    },
    sources: [{ kind: "thought", id: thoughtId, reason: "misplaced thought" }],
  };
}

describe("correction capture and review queue", () => {
  it("captures events as pending and dedupes exact duplicates", async () => {
    const first = await corrections.submit(SCOPE, moveInput("th-1", "b-people", "hire a PM"));
    const second = await corrections.submit(SCOPE, moveInput("th-1", "b-people", "hire a PM"));
    assert.equal(first.id, second.id);
    assert.equal((await corrections.reviewQueue(SCOPE)).length, 1);
  });

  it("requires at least one source", async () => {
    await assert.rejects(
      () => corrections.submit(SCOPE, { ...moveInput("th-1", "b-people", "x"), sources: [] }),
      /source/,
    );
  });

  it("reject removes from the queue without applying anything", async () => {
    buckets.buckets.push(makeBucket("b-random", "Random"), makeBucket("b-people", "People Ops"));
    buckets.items.push({ thought: makeThought("th-1", "hire a PM"), bucketId: "b-random" });
    const event = await corrections.submit(SCOPE, moveInput("th-1", "b-people", "hire a PM"));
    await corrections.reject(SCOPE, event.id);
    assert.equal((await corrections.reviewQueue(SCOPE)).length, 0);
    // FR-3: rejected corrections never influence state.
    assert.equal(buckets.items[0]?.bucketId, "b-random");
    assert.equal((await memory.listConfirmed(SCOPE, "procedural")).length, 0);
  });
});

describe("correction application (accepted only, FR-3)", () => {
  beforeEach(() => {
    buckets.buckets.push(
      makeBucket("b-random", "Random", [1, 0]),
      makeBucket("b-people", "People Ops", [0, 1]),
    );
    buckets.items.push({ thought: makeThought("th-1", "hire a PM", [1, 0]), bucketId: "b-random" });
  });

  it("bucket.move moves the item, repairs both centroids, and derives a preference", async () => {
    const event = await corrections.submit(SCOPE, moveInput("th-1", "b-people", "hire a PM"));
    await corrections.accept(SCOPE, event.id);

    assert.equal(buckets.items[0]?.bucketId, "b-people");
    const random = buckets.buckets.find((b) => b.id === "b-random")!;
    const people = buckets.buckets.find((b) => b.id === "b-people")!;
    assert.equal(random.itemCount, 0);
    assert.deepEqual(random.centroid, []);
    assert.equal(people.itemCount, 1);
    assert.deepEqual(people.centroid, [1, 0]);

    const prefs = await memory.listConfirmed(SCOPE, "procedural");
    assert.equal(prefs.length, 1);
    assert.equal(prefs[0]?.kind, "organization-preference");
    assert.ok(prefs[0]?.text.includes("People Ops"));
    assert.equal(prefs[0]?.sources[0]?.kind, "correction");
    assert.equal(prefs[0]?.sources[0]?.id, event.id);
  });

  it("acceptance is idempotent (SR-3)", async () => {
    const event = await corrections.submit(SCOPE, moveInput("th-1", "b-people", "hire a PM"));
    const first = await corrections.accept(SCOPE, event.id);
    const again = await corrections.accept(SCOPE, event.id);
    assert.equal(again.appliedAt, first.appliedAt);
    assert.equal(buckets.items.filter((i) => i.bucketId === "b-people").length, 1);
    assert.equal((await memory.listConfirmed(SCOPE, "procedural")).length, 1);
  });

  it("bucket.move OUT of Tasks clears the task candidate (product-owner decision 2026-09-03)", async () => {
    buckets.buckets.push(makeBucket("b-tasks", "Tasks", [0, 0, 1]));
    buckets.items.push({
      thought: {
        ...makeThought("th-task", "test removing email verification", [0, 0, 1]),
        task: { title: "test removing email verification" },
      },
      bucketId: "b-tasks",
    });

    const event = await corrections.submit(
      SCOPE,
      moveInput("th-task", "b-people", "test removing email verification"),
    );
    await corrections.accept(SCOPE, event.id);

    const moved = buckets.items.find((i) => i.thought.id === "th-task")!;
    assert.equal(moved.bucketId, "b-people");
    assert.equal(moved.thought.task, undefined);
  });

  it("bucket.move INTO Tasks adds a task candidate from the summary", async () => {
    buckets.buckets.push(makeBucket("b-tasks", "Tasks", [0, 0, 1]));

    const event = await corrections.submit(
      SCOPE,
      moveInput("th-1", "b-tasks", "hire a PM", "Tasks"),
    );
    await corrections.accept(SCOPE, event.id);

    const moved = buckets.items.find((i) => i.thought.id === "th-1")!;
    assert.equal(moved.bucketId, "b-tasks");
    assert.equal(moved.thought.task?.title, "hire a PM");
  });

  it("bucket.move between non-Tasks buckets leaves the task field untouched", async () => {
    const event = await corrections.submit(SCOPE, moveInput("th-1", "b-people", "hire a PM"));
    await corrections.accept(SCOPE, event.id);
    const moved = buckets.items.find((i) => i.thought.id === "th-1")!;
    assert.equal(moved.bucketId, "b-people");
    assert.equal(moved.thought.task, undefined);
  });

  it("bucket.rename renames in scope", async () => {
    const event = await corrections.submit(SCOPE, {
      type: "bucket.rename",
      target: { kind: "bucket", id: "b-random" },
      payload: { newName: "Misc" },
      sources: [{ kind: "explicit-statement", id: "cli", reason: "rename" }],
    });
    await corrections.accept(SCOPE, event.id);
    assert.equal(buckets.buckets.find((b) => b.id === "b-random")?.name, "Misc");
  });

  it("bucket.merge moves all items and removes the source bucket", async () => {
    buckets.items.push({ thought: makeThought("th-2", "hire a designer", [0, 1]), bucketId: "b-people" });
    const event = await corrections.submit(SCOPE, {
      type: "bucket.merge",
      target: { kind: "bucket", id: "b-random" },
      payload: { intoBucketId: "b-people" },
      sources: [{ kind: "explicit-statement", id: "cli", reason: "merge" }],
    });
    await corrections.accept(SCOPE, event.id);
    assert.equal(buckets.buckets.some((b) => b.id === "b-random"), false);
    const people = buckets.buckets.find((b) => b.id === "b-people")!;
    assert.equal(people.itemCount, 2);
    assert.deepEqual(people.centroid, [0.5, 0.5]);
  });

  it("thought.edit re-embeds and updates the item", async () => {
    const event = await corrections.submit(SCOPE, {
      type: "thought.edit",
      target: { kind: "thought", id: "th-1" },
      payload: { text: "hire a senior PM!!" },
      sources: [{ kind: "thought", id: "th-1", reason: "edit" }],
    });
    await corrections.accept(SCOPE, event.id);
    const item = buckets.items.find((i) => i.thought.id === "th-1")!;
    assert.equal(item.thought.text, "hire a senior PM!!");
    assert.deepEqual(item.thought.embedding, [1, 0]); // 18 chars → even → [1,0]
    assert.deepEqual(buckets.buckets.find((b) => b.id === "b-random")?.centroid, [1, 0]);
  });

  it("task.add sets the task and routes the item to Tasks", async () => {
    buckets.buckets.push(makeBucket("b-tasks", "Tasks"));
    const event = await corrections.submit(SCOPE, {
      type: "task.add",
      target: { kind: "thought", id: "th-1" },
      payload: { title: "Hire a PM" },
      sources: [{ kind: "thought", id: "th-1", reason: "re-class" }],
    });
    await corrections.accept(SCOPE, event.id);
    const item = buckets.items.find((i) => i.thought.id === "th-1")!;
    assert.equal(item.thought.task?.title, "Hire a PM");
    assert.equal(item.bucketId, "b-tasks");
  });

  it("task.remove clears the task candidate", async () => {
    buckets.items[0]!.thought.task = { title: "Hire a PM" };
    const event = await corrections.submit(SCOPE, {
      type: "task.remove",
      target: { kind: "thought", id: "th-1" },
      payload: {},
      sources: [{ kind: "thought", id: "th-1", reason: "not a task" }],
    });
    await corrections.accept(SCOPE, event.id);
    assert.equal(buckets.items[0]?.thought.task, undefined);
  });

  it("provenance.correct re-verifies against the stored transcript", async () => {
    transcripts.transcripts.push({
      captureId: "cap-1",
      tenantId: SCOPE.tenantId,
      userId: SCOPE.userId,
      text: "first. second.",
      segments: [
        { id: "seg-0", text: "first.", startSec: 0, endSec: 2 },
        { id: "seg-1", text: "second.", startSec: 2, endSec: 4 },
      ],
      model: "test",
      contentHash: "x",
      createdAt: "2026-09-01T10:00:00.000Z",
    });
    const good = await corrections.submit(SCOPE, {
      type: "provenance.correct",
      target: { kind: "thought", id: "th-1" },
      payload: { segmentIds: "seg-0, seg-1" },
      sources: [{ kind: "thought", id: "th-1", reason: "fix provenance" }],
    });
    await corrections.accept(SCOPE, good.id);
    const item = buckets.items.find((i) => i.thought.id === "th-1")!;
    assert.deepEqual(item.thought.provenance.segmentIds, ["seg-0", "seg-1"]);
    assert.equal(item.thought.provenance.sourceText, "first. second.");
    assert.equal(item.thought.provenance.endSec, 4);

    const bad = await corrections.submit(SCOPE, {
      type: "provenance.correct",
      target: { kind: "thought", id: "th-1" },
      payload: { segmentIds: "seg-99" },
      sources: [{ kind: "thought", id: "th-1", reason: "fix provenance" }],
    });
    await assert.rejects(() => corrections.accept(SCOPE, bad.id), /unknown-segment/);
  });

  it("memory.decision applies via the memory service", async () => {
    const proposal = await memory.propose(
      SCOPE,
      {
        layer: "semantic",
        kind: "preference",
        subject: "preference:x",
        text: "Prefers standups at 9",
        sources: [{ kind: "thought", id: "th-1", reason: "inferred" }],
      },
      { model: "m", version: "v" },
    );
    const event = await corrections.submit(SCOPE, {
      type: "memory.decision",
      target: { kind: "proposal", id: proposal.id },
      payload: { decision: "approve" },
      sources: [{ kind: "explicit-statement", id: "cli", reason: "decision" }],
    });
    await corrections.accept(SCOPE, event.id);
    assert.equal((await memory.listConfirmed(SCOPE)).length, 1);
  });

  it("record-only types are captured and accepted without state changes", async () => {
    const event = await corrections.submit(SCOPE, {
      type: "thought.split",
      target: { kind: "thought", id: "th-1" },
      payload: { into: "two thoughts" },
      sources: [{ kind: "thought", id: "th-1", reason: "split" }],
    });
    const accepted = await corrections.accept(SCOPE, event.id);
    assert.equal(accepted.status, "accepted");
    assert.equal(buckets.items.length, 1); // unchanged
  });
});

describe("replay determinism (FR-2) and deletion (AC-3)", () => {
  beforeEach(() => {
    buckets.buckets.push(makeBucket("b-random", "Random"), makeBucket("b-people", "People Ops"));
    buckets.items.push({ thought: makeThought("th-1", "hire a PM"), bucketId: "b-random" });
  });

  it("replaying the accepted log reproduces the derived projection", async () => {
    const first = await corrections.submit(SCOPE, moveInput("th-1", "b-people", "hire a PM"));
    await corrections.accept(SCOPE, first.id);
    const before = (await memory.listConfirmed(SCOPE, "procedural")).map((m) => ({
      subject: m.subject,
      text: m.text,
    }));

    const replayed = await corrections.replay(SCOPE);
    assert.equal(replayed.derived, 1);
    const after = (await memory.listConfirmed(SCOPE, "procedural")).map((m) => ({
      subject: m.subject,
      text: m.text,
    }));
    assert.deepEqual(after, before);
  });

  it("deleting an accepted correction removes its derived preference", async () => {
    const event = await corrections.submit(SCOPE, moveInput("th-1", "b-people", "hire a PM"));
    await corrections.accept(SCOPE, event.id);
    assert.equal((await memory.listConfirmed(SCOPE, "procedural")).length, 1);
    await corrections.deleteCorrection(SCOPE, event.id);
    assert.equal((await memory.listConfirmed(SCOPE, "procedural")).length, 0);
    assert.equal((await corrections.list(SCOPE)).length, 0);
  });

  it("a contradicting move marks the earlier correction (never rewrites it)", async () => {
    const first = await corrections.submit(SCOPE, moveInput("th-1", "b-people", "hire a PM"));
    await corrections.accept(SCOPE, first.id);
    const second = await corrections.submit(
      SCOPE,
      moveInput("th-1", "b-random", "hire a PM", "Random"),
    );
    await corrections.accept(SCOPE, second.id);

    const all = await corrections.list(SCOPE);
    const old = all.find((e) => e.id === first.id)!;
    assert.equal(old.contradictedBy, second.id);
    // Contradicted corrections leave the active example set.
    const active = await corrections.listAccepted(SCOPE);
    assert.deepEqual(active.map((e) => e.id), [second.id]);
  });
});

describe("adherence tracking (AC-2)", () => {
  /** Service with NO embedder: the deterministic keyword fallback path. */
  function keywordOnlyService(): CorrectionService {
    return new CorrectionService({
      corrections: new FileCorrectionStore(dir),
      buckets,
      memory,
      transcripts,
      verifier: new DeterministicProvenanceVerifier(),
      now: () => new Date("2026-09-03T10:00:00.000Z"),
    });
  }

  it("records followed and contradicted placements (keyword path)", async () => {
    const service = keywordOnlyService();
    buckets.buckets.push(makeBucket("b-random", "Random"), makeBucket("b-people", "People Ops"));
    buckets.items.push({ thought: makeThought("th-1", "hire a PM"), bucketId: "b-random" });
    const event = await service.submit(SCOPE, moveInput("th-1", "b-people", "hire a PM"));
    await service.accept(SCOPE, event.id);

    const example = {
      correctionId: event.id,
      preferredBucketId: "b-people",
      text: 'The user corrected: "hire a PM" belongs in "People Ops"',
    };
    const followed = await service.observePlacement(SCOPE, {
      thoughtText: "we should hire a PM soon",
      placedBucketId: "b-people",
      examples: [example],
    });
    assert.deepEqual(followed, { followed: 1, contradicted: 0 });
    const contradicted = await service.observePlacement(SCOPE, {
      thoughtText: "hire a PM",
      placedBucketId: "b-random",
      examples: [example],
    });
    assert.deepEqual(contradicted, { followed: 0, contradicted: 1 });

    const stats = await service.stats(SCOPE);
    assert.equal(stats.followed, 1);
    assert.equal(stats.contradicted, 1);
    assert.equal(stats.adherenceRate, 0.5);
  });

  it("ignores irrelevant examples and unknown corrections (keyword path)", async () => {
    const service = keywordOnlyService();
    const outcome = await service.observePlacement(SCOPE, {
      thoughtText: "unrelated words",
      placedBucketId: "b-x",
      examples: [
        { correctionId: "nope", preferredBucketId: "b-y", text: "totally different" },
      ],
    });
    assert.deepEqual(outcome, { followed: 0, contradicted: 0 });
  });

  it("keyword path undercounts paraphrases — the witnessed defect", async () => {
    const service = keywordOnlyService();
    buckets.buckets.push(makeBucket("b-growth", "Growth Experiments"), makeBucket("b-random", "Random"));
    buckets.items.push({ thought: makeThought("th-1", "test removing email verification"), bucketId: "b-random" });
    const event = await service.submit(
      SCOPE,
      moveInput("th-1", "b-growth", "test removing email verification", "Growth Experiments"),
    );
    await service.accept(SCOPE, event.id);
    const example = {
      correctionId: event.id,
      preferredBucketId: "b-growth",
      text: 'The user corrected: "test removing email verification" belongs in "Growth Experiments"',
    };
    // Zero shared keywords with the correction — the old behavior.
    const outcome = await service.observePlacement(SCOPE, {
      thoughtText: "try one-click signup",
      placedBucketId: "b-growth",
      examples: [example],
    });
    assert.deepEqual(outcome, { followed: 0, contradicted: 0 });
  });

  it("semantic path counts a paraphrased placement (Spec 3.3 fix)", async () => {
    // Embeddings: the correction text and the paraphrased placement are
    // close (both about signup-flow friction); unrelated text is not.
    const semanticEmbedder: Embedder = {
      modelId: "semantic-stub",
      dimensions: 3,
      embed: async (texts: string[]) =>
        texts.map((text) => {
          const t = text.toLowerCase();
          if (t.includes("email verification") || t.includes("one-click signup")) {
            return [1, 0.1, 0]; // same neighborhood
          }
          return [0, 0, 1];
        }),
    };
    const service = new CorrectionService({
      corrections: new FileCorrectionStore(dir),
      buckets,
      memory,
      transcripts,
      verifier: new DeterministicProvenanceVerifier(),
      embedder: semanticEmbedder,
      adherenceThreshold: 0.75,
      now: () => new Date("2026-09-03T10:00:00.000Z"),
    });
    buckets.buckets.push(makeBucket("b-growth", "Growth Experiments"), makeBucket("b-random", "Random"));
    buckets.items.push({ thought: makeThought("th-1", "test removing email verification"), bucketId: "b-random" });
    const event = await service.submit(
      SCOPE,
      moveInput("th-1", "b-growth", "test removing email verification", "Growth Experiments"),
    );
    await service.accept(SCOPE, event.id);
    const example = {
      correctionId: event.id,
      preferredBucketId: "b-growth",
      text: 'The user corrected: "test removing email verification" belongs in "Growth Experiments"',
    };

    // The paraphrase now counts as FOLLOWED — the witnessed fix.
    const followed = await service.observePlacement(SCOPE, {
      thoughtText: "try one-click signup",
      placedBucketId: "b-growth",
      examples: [example],
    });
    assert.deepEqual(followed, { followed: 1, contradicted: 0 });

    // And a paraphrased placement into the WRONG bucket counts as
    // contradicted (semantic applicability, not keyword presence).
    const contradicted = await service.observePlacement(SCOPE, {
      thoughtText: "try one-click signup",
      placedBucketId: "b-random",
      examples: [example],
    });
    assert.deepEqual(contradicted, { followed: 0, contradicted: 1 });

    // Semantically unrelated placements are still not applicable.
    const unrelated = await service.observePlacement(SCOPE, {
      thoughtText: "order more coffee pods",
      placedBucketId: "b-random",
      examples: [example],
    });
    assert.deepEqual(unrelated, { followed: 0, contradicted: 0 });
  });

  it("semantic path respects the configured threshold", async () => {
    // Cosine between [1, 0.3] and the example [1, 0.1] ≈ 0.958 — passes
    // at 0.75 but fails at 0.99.
    const embedder: Embedder = {
      modelId: "threshold-stub",
      dimensions: 2,
      embed: async (texts: string[]) =>
        texts.map((text) => (text.includes("placement") ? [1, 0.3] : [1, 0.1])),
    };
    const makeService = (threshold: number) =>
      new CorrectionService({
        corrections: new FileCorrectionStore(dir),
        buckets,
        memory,
        transcripts,
        verifier: new DeterministicProvenanceVerifier(),
        embedder,
        adherenceThreshold: threshold,
        now: () => new Date("2026-09-03T10:00:00.000Z"),
      });
    buckets.buckets.push(makeBucket("b-signup", "Signup Flow"));
    buckets.items.push({ thought: makeThought("th-1", "example text"), bucketId: "b-signup" });
    const event = await corrections.submit(
      SCOPE,
      moveInput("th-1", "b-signup", "example text", "Signup Flow"),
    );
    await corrections.accept(SCOPE, event.id);
    const example = {
      correctionId: event.id,
      preferredBucketId: "b-signup",
      text: "example text",
    };
    const loose = await makeService(0.75).observePlacement(SCOPE, {
      thoughtText: "placement text",
      placedBucketId: "b-signup",
      examples: [example],
    });
    assert.deepEqual(loose, { followed: 1, contradicted: 0 });
    const strict = await makeService(0.99).observePlacement(SCOPE, {
      thoughtText: "placement text",
      placedBucketId: "b-signup",
      examples: [example],
    });
    assert.deepEqual(strict, { followed: 0, contradicted: 0 });
  });

  it("embedder failure falls back to the deterministic keyword path", async () => {
    const failingEmbedder: Embedder = {
      modelId: "failing-stub",
      dimensions: 2,
      embed: async () => {
        throw new Error("embedder unavailable");
      },
    };
    const service = new CorrectionService({
      corrections: new FileCorrectionStore(dir),
      buckets,
      memory,
      transcripts,
      verifier: new DeterministicProvenanceVerifier(),
      embedder: failingEmbedder,
      now: () => new Date("2026-09-03T10:00:00.000Z"),
    });
    buckets.buckets.push(makeBucket("b-people", "People Ops"));
    buckets.items.push({ thought: makeThought("th-1", "hire a PM"), bucketId: "b-random" });
    const event = await service.submit(SCOPE, moveInput("th-1", "b-people", "hire a PM"));
    await service.accept(SCOPE, event.id);
    const outcome = await service.observePlacement(SCOPE, {
      thoughtText: "hire a PM soon",
      placedBucketId: "b-people",
      examples: [
        {
          correctionId: event.id,
          preferredBucketId: "b-people",
          text: 'The user corrected: "hire a PM" belongs in "People Ops"',
        },
      ],
    });
    assert.deepEqual(outcome, { followed: 1, contradicted: 0 });
  });
});

describe("personalized examples in context assembly (FR-4)", () => {
  const BUDGETS: ContextBudgets = {
    maxTokens: 1200,
    maxItems: 24,
    recentCaptures: 0,
    maxMemories: 12,
    maxBucketSummaries: 10,
    maxCorrectionExamples: 3,
      maxExternalSnippets: 6,
  };

  it("injects bounded relevant accepted corrections as untrusted examples", async () => {
    buckets.buckets.push(makeBucket("b-random", "Random"), makeBucket("b-people", "People Ops"));
    buckets.items.push({ thought: makeThought("th-1", "hire a PM"), bucketId: "b-random" });
    const accepted = await corrections.submit(SCOPE, moveInput("th-1", "b-people", "hire a PM"));
    await corrections.accept(SCOPE, accepted.id);
    // A pending correction must NOT be injected (FR-3).
    await corrections.submit(SCOPE, moveInput("th-2", "b-people", "hire a designer"));

    const asm = new ContextAssembler({
      memory,
      buckets,
      captures: {
        saveCapture: async () => {},
        getCapture: async () => undefined,
        listCaptures: async () => [],
        markAudioDeleted: async () => {},
        deleteCapture: async () => {},
      },
      transcripts,
      corrections,
      budgets: BUDGETS,
      now: () => new Date("2026-09-03T10:00:00.000Z"),
    });
    const packet = await asm.assemble(SCOPE, { text: "we need to hire a PM for the team" });
    const examples = packet.elements.filter((e) => e.sourceKind === "correction");
    assert.equal(examples.length, 1);
    assert.equal(examples[0]?.sourceId, accepted.id);
    assert.equal(examples[0]?.trust, "untrusted-retrieved");
    assert.equal(examples[0]?.correction?.preferredBucketId, "b-people");

    // Irrelevant query → no example.
    const other = await asm.assemble(SCOPE, { text: "sourdough bread recipe" });
    assert.equal(other.elements.filter((e) => e.sourceKind === "correction").length, 0);
  });
});

describe("tenant isolation (AC-3)", () => {
  it("corrections never cross scopes", async () => {
    buckets.buckets.push(makeBucket("b-random", "Random"), makeBucket("b-people", "People Ops"));
    buckets.items.push({ thought: makeThought("th-1", "hire a PM"), bucketId: "b-random" });
    const event = await corrections.submit(SCOPE, moveInput("th-1", "b-people", "hire a PM"));
    assert.equal((await corrections.reviewQueue(OTHER)).length, 0);
    await assert.rejects(() => corrections.accept(OTHER, event.id), /does not exist/);
    assert.equal((await corrections.list(OTHER)).length, 0);
  });
});

describe("retrieval projection freshness (Spec 3.3 SR-3)", () => {
  it("accepting a move correction rebuilds the index — search never serves stale bucket state", async () => {
    const { LocalRetrievalIndex } = await import("@donna/retrieval");
    const indexDir = await mkdtemp(join(tmpdir(), "donna-corr-idx-"));
    try {
      buckets.buckets.push(makeBucket("b-random", "Random"), makeBucket("b-people", "People Ops"));
      const item = { thought: makeThought("th-1", "hire a PM"), bucketId: "b-random" };
      buckets.items.push(item);
      const index = new LocalRetrievalIndex({ dataDir: indexDir, store: buckets });
      await index.indexItem(item, buckets.buckets.find((b) => b.id === "b-random")!);

      // Before the correction: the hit shows the old bucket.
      let hits = await index.search({ ...SCOPE, text: "hire a PM" });
      assert.equal(hits[0]?.bucketName, "Random");

      const service = new CorrectionService({
        corrections: new FileCorrectionStore(dir),
        buckets,
        memory,
        transcripts,
        verifier: new DeterministicProvenanceVerifier(),
        retrievalIndex: index,
        now: () => new Date("2026-09-03T10:00:00.000Z"),
      });
      const event = await service.submit(SCOPE, moveInput("th-1", "b-people", "hire a PM"));
      await service.accept(SCOPE, event.id);

      // After acceptance, the projection reflects the move.
      hits = await index.search({ ...SCOPE, text: "hire a PM" });
      assert.equal(hits[0]?.bucketName, "People Ops");
      assert.equal(hits[0]?.bucketId, "b-people");
    } finally {
      await rm(indexDir, { recursive: true, force: true });
    }
  });
});
