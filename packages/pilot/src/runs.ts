/**
 * Pilot run instrumentation (Specification 6.2, FR-1): every pilot run
 * records a pseudonymous participant ID, the scenario ID from the runbook
 * matrix, the exact configuration fingerprint (the same snapshot
 * fingerprint the eval harness uses), and the explicit output decisions
 * made during the run window — accept/move/split/merge/edit/reject,
 * memory approve/reject, retrieval relevance — as COUNTED, ID-LINKED
 * events gathered from the existing correction/memory stores. Run records
 * carry IDs and counts only, never content (SR-2).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CorrectionEvent, MemoryEvent } from "@donna/core";
import { writePrivateFile } from "@donna/file-security";
import {
  collectPlacementDecisions,
  type PilotDecision,
  type PlacementDecisionCounts,
} from "./decisions.js";
import { pilotScopeDir } from "./profile.js";

export const PILOT_RUN_SCHEMA = "donna.pilot-run.v1";

export interface PilotRunRecord {
  schema: typeof PILOT_RUN_SCHEMA;
  id: string;
  tenantId: string;
  userId: string;
  /** Pseudonymous participant handle from the pilot profile. */
  participantId: string;
  /** Scenario ID from docs/pilot/RUNBOOK.md (e.g. "SC-MEET-01"). */
  scenarioId: string;
  startedAt: string; // ISO 8601
  endedAt?: string; // ISO 8601
  /**
   * The eval-harness config snapshot fingerprint at run start
   * (commit + models.config.yaml + prompt/schema/ranking versions).
   */
  configFingerprint: string;
  /** Capture IDs produced during the run window. */
  captureIds: string[];
  /** Decisions recorded during the run window, counted by kind. */
  decisions: {
    corrections: Record<string, number>;
    correctionIds: string[];
    memoryApprovals: number;
    memoryRejections: number;
    memoryEventIds: string[];
    /**
     * Explicit placement decisions (Specification 6.4, FR-2): latest-per-
     * thought accept/move counts in the window and the window-capture
     * thoughts still undecided at run end. Optional so pre-6.4 run
     * records remain readable.
     */
    placement?: PlacementDecisionCounts;
  };
  notes?: string;
}

/** Storage port so tests can run fully in memory. */
export interface PilotRunStore {
  list(tenantId: string, userId: string): Promise<PilotRunRecord[]>;
  saveAll(tenantId: string, userId: string, records: PilotRunRecord[]): Promise<void>;
}

export class FilePilotRunStore implements PilotRunStore {
  constructor(private readonly dataDir: string) {}

  private fileFor(tenantId: string, userId: string): string {
    return join(pilotScopeDir(this.dataDir, { tenantId, userId }), "runs.json");
  }

  async list(tenantId: string, userId: string): Promise<PilotRunRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.fileFor(tenantId, userId), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as PilotRunRecord[];
    if (parsed.some((r) => r.tenantId !== tenantId || r.userId !== userId)) {
      throw new Error("Stored pilot run register does not match its tenant/user partition");
    }
    return parsed;
  }

  async saveAll(tenantId: string, userId: string, records: PilotRunRecord[]): Promise<void> {
    const file = this.fileFor(tenantId, userId);
    await writePrivateFile(file, JSON.stringify(records, null, 2) + "\n");
  }
}

/**
 * The explicit output decisions made inside a run window, gathered from
 * the source-of-truth stores (corrections = accept/move/split/merge/edit/
 * reject/retrieval-relevance; memory events = approve/reject). Counts and
 * IDs only.
 */
export function collectRunDecisions(
  window: { startedAt: string; endedAt: string },
  corrections: CorrectionEvent[],
  memoryEvents: MemoryEvent[],
): PilotRunRecord["decisions"] {
  const inWindow = (at: string): boolean => at >= window.startedAt && at <= window.endedAt;
  const windowCorrections = corrections.filter((c) => inWindow(c.createdAt));
  const byType: Record<string, number> = {};
  for (const event of windowCorrections) {
    byType[event.type] = (byType[event.type] ?? 0) + 1;
  }
  const windowMemoryEvents = memoryEvents.filter((e) => inWindow(e.at));
  return {
    corrections: byType,
    correctionIds: windowCorrections.map((c) => c.id),
    memoryApprovals: windowMemoryEvents.filter((e) => e.type === "approved").length,
    memoryRejections: windowMemoryEvents.filter((e) => e.type === "rejected").length,
    memoryEventIds: windowMemoryEvents.map((e) => `${e.type}:${e.memoryId ?? e.proposalId ?? "-"}`),
  };
}

export class RunNotFoundError extends Error {
  constructor() {
    super("Pilot run does not exist in the requested tenant/user scope");
    this.name = "RunNotFoundError";
  }
}

export class PilotRunBook {
  constructor(
    private readonly store: PilotRunStore,
    private readonly now: () => Date,
    private readonly idGen: () => string,
  ) {}

  /** FR-1: open a run with its config fingerprint. One open run at a time. */
  async start(
    scope: { tenantId: string; userId: string },
    input: { participantId: string; scenarioId: string; configFingerprint: string },
  ): Promise<PilotRunRecord> {
    if (input.scenarioId.trim().length === 0) {
      throw new Error("A pilot run needs a scenario ID from docs/pilot/RUNBOOK.md");
    }
    const all = await this.store.list(scope.tenantId, scope.userId);
    const open = all.find((r) => r.endedAt === undefined);
    if (open !== undefined) {
      throw new Error(`Run ${open.id} (${open.scenarioId}) is still open — end it first: donna pilot run end ${open.id}`);
    }
    const record: PilotRunRecord = {
      schema: PILOT_RUN_SCHEMA,
      id: this.idGen(),
      tenantId: scope.tenantId,
      userId: scope.userId,
      participantId: input.participantId,
      scenarioId: input.scenarioId.trim(),
      startedAt: this.now().toISOString(),
      configFingerprint: input.configFingerprint,
      captureIds: [],
      decisions: {
        corrections: {},
        correctionIds: [],
        memoryApprovals: 0,
        memoryRejections: 0,
        memoryEventIds: [],
      },
    };
    all.push(record);
    await this.store.saveAll(scope.tenantId, scope.userId, all);
    return record;
  }

  /** Close the run, filling in window captures and gathered decisions. */
  async end(
    scope: { tenantId: string; userId: string },
    runId: string,
    gather: {
      captures: Array<{ id: string; capturedAt: string }>;
      corrections: CorrectionEvent[];
      memoryEvents: MemoryEvent[];
      /**
       * Specification 6.4: the scope's placement decisions and thoughts
       * (thought ID + capture ID), so the run record carries explicit
       * accept/move counts and the undecided-thought count (AC-1).
       */
      decisions?: PilotDecision[];
      thoughts?: Array<{ id: string; captureId?: string }>;
    },
    notes?: string,
  ): Promise<PilotRunRecord> {
    const all = await this.store.list(scope.tenantId, scope.userId);
    const record = all.find((r) => r.id === runId);
    if (record === undefined) throw new RunNotFoundError();
    if (record.endedAt !== undefined) {
      throw new Error(`Run ${runId} already ended (${record.endedAt})`);
    }
    const endedAt = this.now().toISOString();
    const window = { startedAt: record.startedAt, endedAt };
    const captureIds = gather.captures
      .filter((c) => c.capturedAt >= window.startedAt && c.capturedAt <= window.endedAt)
      .map((c) => c.id);
    const ended: PilotRunRecord = {
      ...record,
      endedAt,
      captureIds,
      decisions: {
        ...collectRunDecisions(window, gather.corrections, gather.memoryEvents),
        ...(gather.decisions !== undefined && gather.thoughts !== undefined
          ? {
              placement: collectPlacementDecisions(
                window,
                gather.decisions,
                gather.thoughts,
                captureIds,
              ),
            }
          : {}),
      },
      ...(notes !== undefined ? { notes } : {}),
    };
    await this.store.saveAll(
      scope.tenantId,
      scope.userId,
      all.map((r) => (r.id === runId ? ended : r)),
    );
    return ended;
  }

  async list(scope: { tenantId: string; userId: string }): Promise<PilotRunRecord[]> {
    return this.store.list(scope.tenantId, scope.userId);
  }

  async get(
    scope: { tenantId: string; userId: string },
    runId: string,
  ): Promise<PilotRunRecord> {
    const record = (await this.store.list(scope.tenantId, scope.userId)).find(
      (r) => r.id === runId,
    );
    if (record === undefined) throw new RunNotFoundError();
    return record;
  }
}
