import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ConsentRecord, MemoryEvent, MemoryProposal, MemoryRecord } from "@donna/core";
import { FileConsentStore, FileMemoryStore } from "./store.file.js";

const execFileAsync = promisify(execFile);
const T = "tenant-a";
const U = "user-1";

function memory(id: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    tenantId: T,
    userId: U,
    layer: "semantic",
    status: "confirmed",
    origin: "explicit",
    text: `memory ${id}`,
    kind: "preference",
    subject: `preference:${id}`,
    confidence: 1,
    sources: [{ kind: "explicit-statement", id: "cli-1", reason: "user said so" }],
    createdAt: "2026-09-03T10:00:00.000Z",
    updatedAt: "2026-09-03T10:00:00.000Z",
    ...over,
  };
}

function proposal(id: string): MemoryProposal {
  return {
    id,
    tenantId: T,
    userId: U,
    layer: "semantic",
    text: `proposal ${id}`,
    kind: "fact",
    subject: `fact:${id}`,
    confidence: 0.6,
    sources: [{ kind: "thought", id: "th-1", captureId: "cap-1", reason: "inferred" }],
    proposedBy: { model: "gpt-5-mini", version: "donna.organize.v1" },
    createdAt: "2026-09-03T10:00:00.000Z",
    status: "pending",
  };
}

function event(type: MemoryEvent["type"]): MemoryEvent {
  return { at: "2026-09-03T10:00:00.000Z", type, tenantId: T, userId: U };
}

describe("FileMemoryStore", () => {
  let dir: string;
  let store: FileMemoryStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "donna-mem-"));
    store = new FileMemoryStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips memories, proposals, and events in scope", async () => {
    await store.saveMemory(memory("m-1"));
    await store.saveProposal(proposal("p-1"));
    await store.appendEvent(event("stated"));

    assert.equal((await store.getMemory(T, U, "m-1"))?.text, "memory m-1");
    assert.equal((await store.listMemories(T, U)).length, 1);
    assert.equal((await store.getProposal(T, U, "p-1"))?.status, "pending");
    assert.equal((await store.listProposals(T, U)).length, 1);
    assert.equal((await store.listEvents(T, U)).length, 1);
  });

  it("updates an existing memory in place by id", async () => {
    await store.saveMemory(memory("m-1"));
    await store.saveMemory(memory("m-1", { text: "updated" }));
    assert.equal((await store.listMemories(T, U)).length, 1);
    assert.equal((await store.getMemory(T, U, "m-1"))?.text, "updated");
  });

  it("deletes idempotently", async () => {
    await store.saveMemory(memory("m-1"));
    assert.equal(await store.deleteMemory(T, U, "m-1"), true);
    assert.equal(await store.deleteMemory(T, U, "m-1"), false);
    assert.equal(await store.deleteProposal(T, U, "p-x"), false);
  });

  it("writes owner-only files inside owner-only directories", async () => {
    await store.saveMemory(memory("m-1"));
    const file = join(dir, T, U, "memory.json");
    if (process.platform === "win32") {
      const [{ stdout: fileAcl }, { stdout: directoryAcl }] = await Promise.all([
        execFileAsync("icacls.exe", [file], { windowsHide: true }),
        execFileAsync("icacls.exe", [join(dir, T, U)], { windowsHide: true }),
      ]);
      assert.doesNotMatch(
        `${fileAcl}\n${directoryAcl}`,
        /Everyone|Authenticated Users|BUILTIN\\Users/i,
      );
      return;
    }
    const fileMode = (await stat(file)).mode & 0o777;
    assert.equal(fileMode, 0o600);
    const dirMode = ((await stat(join(dir, T, U))).mode & 0o777);
    assert.equal(dirMode, 0o700);
  });

  it("rejects hostile partition IDs", async () => {
    await assert.rejects(() => store.listMemories("../escape", U));
    await assert.rejects(() => store.listMemories(T, ".."));
    await assert.rejects(() => store.getMemory(T, U, "../other"));
    await assert.rejects(() => store.listMemories("", U));
  });

  it("fails closed when a stored record's scope does not match its partition", async () => {
    await store.saveMemory(memory("m-1"));
    const file = join(dir, T, U, "memory.json");
    const data = JSON.parse(await readFile(file, "utf8"));
    data.memories[0].userId = "someone-else";
    await writeFile(file, JSON.stringify(data));
    await assert.rejects(() => store.listMemories(T, U), /partition/);
  });

  it("denies cross-tenant and cross-user reads (AC-5)", async () => {
    await store.saveMemory(memory("m-1"));
    assert.equal(await store.getMemory("tenant-b", U, "m-1"), undefined);
    assert.equal(await store.getMemory(T, "user-2", "m-1"), undefined);
    assert.equal((await store.listMemories("tenant-b", U)).length, 0);
    assert.equal((await store.listMemories(T, "user-2")).length, 0);
  });

  it("rejects invalid JSON structures", async () => {
    const file = join(dir, T, U, "memory.json");
    await mkdir(join(dir, T, U), { recursive: true });
    await writeFile(file, JSON.stringify({ memories: {} }), { mode: 0o600 });
    await assert.rejects(() => store.listMemories(T, U), /Invalid/);
  });
});

describe("FileConsentStore", () => {
  let dir: string;
  let store: FileConsentStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "donna-consent-"));
    store = new FileConsentStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function consent(id: string, purpose: string): ConsentRecord {
    return {
      id,
      tenantId: T,
      userId: U,
      purpose,
      granted: true,
      grantedAt: "2026-09-03T10:00:00.000Z",
      channel: "test",
    };
  }

  it("appends consent records in scope", async () => {
    await store.recordConsent(consent("c-1", "emotion.persist"));
    await store.recordConsent(consent("c-2", "eval-sharing"));
    assert.equal((await store.listConsents(T, U)).length, 2);
    assert.equal((await store.listConsents(T, "user-2")).length, 0);
  });

  it("fails closed on scope-mismatched stored records", async () => {
    await store.recordConsent(consent("c-1", "emotion.persist"));
    const file = join(dir, T, U, "consents.json");
    const data = JSON.parse(await readFile(file, "utf8"));
    data[0].tenantId = "tenant-b";
    await writeFile(file, JSON.stringify(data));
    await assert.rejects(() => store.listConsents(T, U), /partition/);
  });
});
