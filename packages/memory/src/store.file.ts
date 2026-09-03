/**
 * Scoped file adapters for private memory and consent (Specification 2.1).
 *
 * Layout under DONNA_DATA_DIR:
 *   <tenant>/<user>/memory.json    — memories, proposals, lifecycle events
 *   <tenant>/<user>/consents.json  — consent records
 *
 * Isolation rules (SR-1/SR-2): every method takes an explicit tenant/user
 * scope; identifiers are validated so a malicious ID cannot traverse the
 * tree; and every stored record whose scope does not match its partition
 * fails closed with an error instead of being served. Files are written
 * 0600 inside 0700 directories, matching the other file-backed stores.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ConsentRecord,
  ConsentStore,
  MemoryEvent,
  MemoryProposal,
  MemoryRecord,
  MemoryStore,
} from "@donna/core";

const PARTITION_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertPartitionId(kind: "tenant" | "user", value: string): void {
  if (!PARTITION_ID.test(value)) {
    throw new Error(`Invalid ${kind} ID for file-backed storage`);
  }
}

export function assertRecordId(kind: string, value: string): void {
  if (!RECORD_ID.test(value)) {
    throw new Error(`Invalid ${kind} ID for file-backed storage`);
  }
}

interface MemoryFile {
  memories: MemoryRecord[];
  proposals: MemoryProposal[];
  events: MemoryEvent[];
}

const EMPTY_MEMORY_FILE: MemoryFile = { memories: [], proposals: [], events: [] };

function assertScope(
  record: { tenantId: string; userId: string },
  tenantId: string,
  userId: string,
): void {
  if (record.tenantId !== tenantId || record.userId !== userId) {
    throw new Error("Stored record does not match its tenant/user partition");
  }
}

async function writeJson0600(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}

export class FileMemoryStore implements MemoryStore {
  constructor(private readonly dataDir: string) {}

  private fileFor(tenantId: string, userId: string): string {
    assertPartitionId("tenant", tenantId);
    assertPartitionId("user", userId);
    return join(this.dataDir, tenantId, userId, "memory.json");
  }

  private async load(tenantId: string, userId: string): Promise<MemoryFile> {
    const file = this.fileFor(tenantId, userId);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return structuredClone(EMPTY_MEMORY_FILE);
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as Partial<MemoryFile>;
    if (
      !Array.isArray(parsed.memories) ||
      !Array.isArray(parsed.proposals) ||
      !Array.isArray(parsed.events)
    ) {
      throw new Error("Invalid file-backed memory store data");
    }
    const data = parsed as MemoryFile;
    for (const record of [...data.memories, ...data.proposals, ...data.events]) {
      assertScope(record, tenantId, userId);
    }
    return data;
  }

  private async save(
    tenantId: string,
    userId: string,
    data: MemoryFile,
  ): Promise<void> {
    await writeJson0600(this.fileFor(tenantId, userId), data);
  }

  async saveMemory(record: MemoryRecord): Promise<void> {
    assertRecordId("memory", record.id);
    const data = await this.load(record.tenantId, record.userId);
    const index = data.memories.findIndex((m) => m.id === record.id);
    if (index >= 0) {
      data.memories[index] = record;
    } else {
      data.memories.push(record);
    }
    await this.save(record.tenantId, record.userId, data);
  }

  async getMemory(
    tenantId: string,
    userId: string,
    memoryId: string,
  ): Promise<MemoryRecord | undefined> {
    assertRecordId("memory", memoryId);
    const data = await this.load(tenantId, userId);
    return data.memories.find((m) => m.id === memoryId);
  }

  async listMemories(tenantId: string, userId: string): Promise<MemoryRecord[]> {
    return (await this.load(tenantId, userId)).memories;
  }

  async deleteMemory(
    tenantId: string,
    userId: string,
    memoryId: string,
  ): Promise<boolean> {
    assertRecordId("memory", memoryId);
    const data = await this.load(tenantId, userId);
    const kept = data.memories.filter((m) => m.id !== memoryId);
    if (kept.length === data.memories.length) return false;
    data.memories = kept;
    await this.save(tenantId, userId, data);
    return true;
  }

  async saveProposal(proposal: MemoryProposal): Promise<void> {
    assertRecordId("proposal", proposal.id);
    const data = await this.load(proposal.tenantId, proposal.userId);
    const index = data.proposals.findIndex((p) => p.id === proposal.id);
    if (index >= 0) {
      data.proposals[index] = proposal;
    } else {
      data.proposals.push(proposal);
    }
    await this.save(proposal.tenantId, proposal.userId, data);
  }

  async getProposal(
    tenantId: string,
    userId: string,
    proposalId: string,
  ): Promise<MemoryProposal | undefined> {
    assertRecordId("proposal", proposalId);
    const data = await this.load(tenantId, userId);
    return data.proposals.find((p) => p.id === proposalId);
  }

  async listProposals(
    tenantId: string,
    userId: string,
  ): Promise<MemoryProposal[]> {
    return (await this.load(tenantId, userId)).proposals;
  }

  async deleteProposal(
    tenantId: string,
    userId: string,
    proposalId: string,
  ): Promise<boolean> {
    assertRecordId("proposal", proposalId);
    const data = await this.load(tenantId, userId);
    const kept = data.proposals.filter((p) => p.id !== proposalId);
    if (kept.length === data.proposals.length) return false;
    data.proposals = kept;
    await this.save(tenantId, userId, data);
    return true;
  }

  async appendEvent(event: MemoryEvent): Promise<void> {
    const data = await this.load(event.tenantId, event.userId);
    data.events.push(event);
    await this.save(event.tenantId, event.userId, data);
  }

  async listEvents(tenantId: string, userId: string): Promise<MemoryEvent[]> {
    return (await this.load(tenantId, userId)).events;
  }
}

export class FileConsentStore implements ConsentStore {
  constructor(private readonly dataDir: string) {}

  private fileFor(tenantId: string, userId: string): string {
    assertPartitionId("tenant", tenantId);
    assertPartitionId("user", userId);
    return join(this.dataDir, tenantId, userId, "consents.json");
  }

  private async load(tenantId: string, userId: string): Promise<ConsentRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.fileFor(tenantId, userId), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("Invalid file-backed consent store data");
    }
    for (const record of parsed as ConsentRecord[]) {
      assertScope(record, tenantId, userId);
    }
    return parsed as ConsentRecord[];
  }

  async recordConsent(record: ConsentRecord): Promise<void> {
    assertRecordId("consent", record.id);
    const records = await this.load(record.tenantId, record.userId);
    records.push(record);
    await writeJson0600(
      this.fileFor(record.tenantId, record.userId),
      records,
    );
  }

  async listConsents(
    tenantId: string,
    userId: string,
  ): Promise<ConsentRecord[]> {
    return this.load(tenantId, userId);
  }
}
