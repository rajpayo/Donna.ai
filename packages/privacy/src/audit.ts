/**
 * Append-only, non-content audit log for privacy lifecycle operations
 * (Spec 1.3). One JSON Lines file per tenant/user partition:
 *
 *   <dataDir>/<tenant>/<user>/audit.log
 *
 * Entries carry operation, scope, identifiers, outcome, and detail tokens
 * only — never audio, transcript text, key material, or personal data
 * (SR-2).
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AuditEntry, AuditLog } from "@donna/core";

const PARTITION_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

function assertPartitionId(kind: "tenant" | "user", value: string): void {
  if (!PARTITION_ID.test(value)) {
    throw new Error(`Invalid ${kind} ID for file-backed storage`);
  }
}

export class FileAuditLog implements AuditLog {
  constructor(private readonly dataDir: string) {}

  private fileFor(tenantId: string, userId: string): string {
    assertPartitionId("tenant", tenantId);
    assertPartitionId("user", userId);
    return join(this.dataDir, tenantId, userId, "audit.log");
  }

  async append(entry: AuditEntry): Promise<void> {
    if (entry.tenantId !== undefined) assertPartitionId("tenant", entry.tenantId);
    if (entry.userId !== undefined) assertPartitionId("user", entry.userId);
    const file = this.fileFor(entry.tenantId, entry.userId);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await appendFile(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
  }

  async list(tenantId: string, userId: string): Promise<AuditEntry[]> {
    const file = this.fileFor(tenantId, userId);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AuditEntry);
  }
}
