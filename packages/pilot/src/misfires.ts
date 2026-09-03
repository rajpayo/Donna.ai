/**
 * Misfire register (Specifications 6.1/6.2): the private, scoped record of
 * everything a participant reports as wrong — bad transcription, wrong
 * bucket, bad memory proposal, retrieval miss, latency, integration
 * trouble. Reports live in the reporter's own pilot partition
 * (`data/pilot/<tenant>/<user>/misfires.json`); nothing leaves the
 * partition except through the separately-consented de-identified golden
 * promotion path (Specification 2.3 / 6.2).
 *
 * Each report snapshots the reporter's eval-sharing consent state at
 * report time so triage always knows whether the case may ever leave the
 * partition (Specification 6.1: the reporting path feeds the eval
 * pipeline WITH consent state).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pilotScopeDir } from "./profile.js";

export const MISFIRE_CATEGORIES = [
  "stt",
  "provenance",
  "organization",
  "memory",
  "retrieval",
  "context",
  "latency",
  "integration",
  "other",
] as const;
export type MisfireCategory = (typeof MISFIRE_CATEGORIES)[number];

export const MISFIRE_DISPOSITIONS = [
  "fixed",
  "accepted-limitation",
  "blocks-graduation",
] as const;
export type MisfireDisposition = (typeof MISFIRE_DISPOSITIONS)[number];

export interface MisfireRecord {
  id: string;
  tenantId: string;
  userId: string;
  /** Pseudonymous reporter handle from the pilot profile. */
  participantId: string;
  reportedAt: string; // ISO 8601
  category: MisfireCategory;
  /** Reporter-authored description; screened before any shared promotion. */
  description: string;
  /** Optional links to the records the report is about. */
  captureId?: string;
  thoughtId?: string;
  correctionId?: string;
  /** Scenario ID when the report came from a scripted pilot run (6.2). */
  scenarioId?: string;
  /** Consent snapshot at report time — promotion fails closed without it. */
  consent: { evalSharing: boolean };
  status: "open" | "triaged" | "resolved";
  /** What should have happened (filled at triage, 6.2). */
  expectedBehavior?: string;
  triagedAt?: string;
  disposition?: MisfireDisposition;
  dispositionNote?: string;
  resolvedAt?: string;
  /** Set when the case was promoted to a shared golden case (consented). */
  goldenCaseId?: string;
}

export interface MisfireReportInput {
  category: MisfireCategory;
  description: string;
  participantId: string;
  consent: { evalSharing: boolean };
  captureId?: string;
  thoughtId?: string;
  correctionId?: string;
  scenarioId?: string;
}

/** Storage port so tests can run fully in memory. */
export interface MisfireRegisterStore {
  list(tenantId: string, userId: string): Promise<MisfireRecord[]>;
  saveAll(tenantId: string, userId: string, records: MisfireRecord[]): Promise<void>;
}

export class FileMisfireRegisterStore implements MisfireRegisterStore {
  constructor(private readonly dataDir: string) {}

  private fileFor(tenantId: string, userId: string): string {
    return join(pilotScopeDir(this.dataDir, { tenantId, userId }), "misfires.json");
  }

  async list(tenantId: string, userId: string): Promise<MisfireRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.fileFor(tenantId, userId), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as MisfireRecord[];
    if (
      parsed.some((r) => r.tenantId !== tenantId || r.userId !== userId)
    ) {
      throw new Error("Stored misfire register does not match its tenant/user partition");
    }
    return parsed;
  }

  async saveAll(tenantId: string, userId: string, records: MisfireRecord[]): Promise<void> {
    const file = this.fileFor(tenantId, userId);
    await mkdir(pilotScopeDir(this.dataDir, { tenantId, userId }), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(file, JSON.stringify(records, null, 2) + "\n", { mode: 0o600 });
  }
}

export class MisfireRegister {
  constructor(
    private readonly store: MisfireRegisterStore,
    private readonly now: () => Date,
    private readonly idGen: () => string,
  ) {}

  async report(
    scope: { tenantId: string; userId: string },
    input: MisfireReportInput,
  ): Promise<MisfireRecord> {
    if (!MISFIRE_CATEGORIES.includes(input.category)) {
      throw new Error(
        `Unknown misfire category "${input.category}". Known: ${MISFIRE_CATEGORIES.join(", ")}`,
      );
    }
    if (input.description.trim().length === 0) {
      throw new Error("A misfire report needs a description");
    }
    const record: MisfireRecord = {
      id: this.idGen(),
      tenantId: scope.tenantId,
      userId: scope.userId,
      participantId: input.participantId,
      reportedAt: this.now().toISOString(),
      category: input.category,
      description: input.description,
      ...(input.captureId !== undefined ? { captureId: input.captureId } : {}),
      ...(input.thoughtId !== undefined ? { thoughtId: input.thoughtId } : {}),
      ...(input.correctionId !== undefined ? { correctionId: input.correctionId } : {}),
      ...(input.scenarioId !== undefined ? { scenarioId: input.scenarioId } : {}),
      consent: { evalSharing: input.consent.evalSharing },
      status: "open",
    };
    const all = await this.store.list(scope.tenantId, scope.userId);
    all.push(record);
    await this.store.saveAll(scope.tenantId, scope.userId, all);
    return record;
  }

  async list(
    scope: { tenantId: string; userId: string },
  ): Promise<MisfireRecord[]> {
    return this.store.list(scope.tenantId, scope.userId);
  }
}
