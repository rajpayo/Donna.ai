/**
 * Explicit pilot placement decisions (Specification 6.4, FR-1/FR-2): every
 * thought surfaced through `pilot review` can receive an explicit,
 * countable decision — `accept` (Donna's placement stands) or `move`
 * (routes through the existing correction flow and links the resulting
 * correction ID). This replaces the runbook's pre-6.4 "implicit accept"
 * with labeled, countable evidence.
 *
 * Records live in the participant's own pilot partition
 * (`data/pilot/<tenant>/<user>/decisions.json`), reusing the partition
 * guards of `FileMisfireRegisterStore`. They are append-only; the latest
 * decision per thought wins for counting. Records carry IDs, bucket
 * labels, and timestamps only — never transcript text (SR-2).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateFile } from "@donna/file-security";
import { pilotScopeDir } from "./profile.js";

export const PILOT_DECISION_SCHEMA = "donna.pilot-decision.v1";

export const DECISION_KINDS = ["accept", "move"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export interface PilotDecision {
  schema: typeof PILOT_DECISION_SCHEMA;
  id: string;
  tenantId: string;
  userId: string;
  /** Pseudonymous participant handle from the pilot profile. */
  participantId: string;
  thoughtId: string;
  /** Capture the thought came from, when known. */
  captureId?: string;
  kind: DecisionKind;
  /** Donna's bucket placement at decision time. */
  donnaBucket: { id: string; name: string };
  /** The decided bucket (accept: Donna's; move: the corrected bucket). */
  decidedBucket: { id: string; name: string };
  /** Move decisions link the resulting correction event (FR-1). */
  correctionId?: string;
  decidedAt: string; // ISO 8601
  /** Run/scenario linkage when a pilot run was open at decision time. */
  runId?: string;
  scenarioId?: string;
}

export interface PilotDecisionInput {
  kind: DecisionKind;
  participantId: string;
  thoughtId: string;
  captureId?: string;
  donnaBucket: { id: string; name: string };
  decidedBucket: { id: string; name: string };
  correctionId?: string;
  runId?: string;
  scenarioId?: string;
}

/** Storage port so tests can run fully in memory. */
export interface PilotDecisionStore {
  list(tenantId: string, userId: string): Promise<PilotDecision[]>;
  saveAll(tenantId: string, userId: string, records: PilotDecision[]): Promise<void>;
}

export class FilePilotDecisionStore implements PilotDecisionStore {
  constructor(private readonly dataDir: string) {}

  private fileFor(tenantId: string, userId: string): string {
    return join(pilotScopeDir(this.dataDir, { tenantId, userId }), "decisions.json");
  }

  async list(tenantId: string, userId: string): Promise<PilotDecision[]> {
    let raw: string;
    try {
      raw = await readFile(this.fileFor(tenantId, userId), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as PilotDecision[];
    if (
      parsed.some((r) => r.tenantId !== tenantId || r.userId !== userId)
    ) {
      throw new Error("Stored decision register does not match its tenant/user partition");
    }
    return parsed;
  }

  async saveAll(tenantId: string, userId: string, records: PilotDecision[]): Promise<void> {
    const file = this.fileFor(tenantId, userId);
    await writePrivateFile(file, JSON.stringify(records, null, 2) + "\n");
  }
}

export class DecisionNotFoundError extends Error {
  constructor() {
    super("Decision does not exist in the requested tenant/user scope");
    this.name = "DecisionNotFoundError";
  }
}

/**
 * Latest-decision-per-thought view (FR-1): the register is append-only,
 * but counting always reflects each thought's LATEST decision.
 */
export function latestDecisionsPerThought(decisions: PilotDecision[]): PilotDecision[] {
  const byThought = new Map<string, PilotDecision>();
  const sorted = [...decisions].sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
  for (const decision of sorted) {
    byThought.set(decision.thoughtId, decision);
  }
  return [...byThought.values()];
}

export interface DecisionSummary {
  /** Total decision records (append-only history length). */
  total: number;
  /** Latest-per-thought counts. */
  accepts: number;
  moves: number;
  /** Distinct thoughts with at least one decision. */
  decidedThoughts: number;
  /** accepts / (accepts + moves) over latest-per-thought; null when none. */
  firstPassAcceptanceRate: number | null;
  /** IDs of the latest decision per thought (IDs only, SR-2). */
  decisionIds: string[];
}

export class DecisionRegister {
  constructor(
    private readonly store: PilotDecisionStore,
    private readonly now: () => Date,
    private readonly idGen: () => string,
  ) {}

  /**
   * Record an explicit placement decision (FR-1). Append-only: a later
   * decision on the same thought supersedes earlier ones for counting,
   * but history is never rewritten.
   */
  async record(
    scope: { tenantId: string; userId: string },
    input: PilotDecisionInput,
  ): Promise<PilotDecision> {
    if (!DECISION_KINDS.includes(input.kind)) {
      throw new Error(
        `Unknown decision kind "${input.kind}". Known: ${DECISION_KINDS.join(", ")}`,
      );
    }
    if (input.thoughtId.trim().length === 0) {
      throw new Error("A placement decision needs a thought ID");
    }
    if (input.participantId.trim().length === 0) {
      throw new Error("A placement decision needs the pseudonymous participant ID");
    }
    if (input.kind === "move" && input.correctionId === undefined) {
      throw new Error("A move decision links the resulting correction ID");
    }
    const record: PilotDecision = {
      schema: PILOT_DECISION_SCHEMA,
      id: this.idGen(),
      tenantId: scope.tenantId,
      userId: scope.userId,
      participantId: input.participantId,
      thoughtId: input.thoughtId,
      ...(input.captureId !== undefined ? { captureId: input.captureId } : {}),
      kind: input.kind,
      donnaBucket: input.donnaBucket,
      decidedBucket: input.decidedBucket,
      ...(input.correctionId !== undefined ? { correctionId: input.correctionId } : {}),
      decidedAt: this.now().toISOString(),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.scenarioId !== undefined ? { scenarioId: input.scenarioId } : {}),
    };
    const all = await this.store.list(scope.tenantId, scope.userId);
    all.push(record);
    await this.store.saveAll(scope.tenantId, scope.userId, all);
    return record;
  }

  async list(
    scope: { tenantId: string; userId: string },
  ): Promise<PilotDecision[]> {
    return this.store.list(scope.tenantId, scope.userId);
  }

  async get(
    scope: { tenantId: string; userId: string },
    decisionId: string,
  ): Promise<PilotDecision> {
    const record = (await this.store.list(scope.tenantId, scope.userId)).find(
      (r) => r.id === decisionId,
    );
    if (record === undefined) throw new DecisionNotFoundError();
    return record;
  }

  /**
   * Countable acceptance evidence (FR-2): latest-per-thought accept/move
   * counts and the observed first-pass acceptance rate. Counts and IDs
   * only (SR-2).
   */
  async summarize(scope: { tenantId: string; userId: string }): Promise<DecisionSummary> {
    const all = await this.store.list(scope.tenantId, scope.userId);
    const latest = latestDecisionsPerThought(all);
    const accepts = latest.filter((d) => d.kind === "accept").length;
    const moves = latest.filter((d) => d.kind === "move").length;
    return {
      total: all.length,
      accepts,
      moves,
      decidedThoughts: latest.length,
      firstPassAcceptanceRate:
        accepts + moves > 0 ? accepts / (accepts + moves) : null,
      decisionIds: latest.map((d) => d.id),
    };
  }
}

/**
 * The placement decisions made inside a run window (Specification 6.4,
 * FR-2): latest-per-thought accept/move counts over decisions taken in
 * the window, plus the window-capture thoughts still undecided at run
 * end. Counts and IDs only (SR-2).
 */
export interface PlacementDecisionCounts {
  accepts: number;
  moves: number;
  /** Latest-per-thought decision IDs made inside the window. */
  decisionIds: string[];
  /** Window-capture thoughts with no decision at run end (IDs only). */
  undecidedThoughtIds: string[];
}

export function collectPlacementDecisions(
  window: { startedAt: string; endedAt: string },
  decisions: PilotDecision[],
  thoughts: Array<{ id: string; captureId?: string }>,
  windowCaptureIds: string[],
): PlacementDecisionCounts {
  const inWindow = (at: string): boolean => at >= window.startedAt && at <= window.endedAt;
  const latest = latestDecisionsPerThought(decisions.filter((d) => inWindow(d.decidedAt)));
  const decidedByEnd = new Set(
    decisions.filter((d) => d.decidedAt <= window.endedAt).map((d) => d.thoughtId),
  );
  const captureSet = new Set(windowCaptureIds);
  return {
    accepts: latest.filter((d) => d.kind === "accept").length,
    moves: latest.filter((d) => d.kind === "move").length,
    decisionIds: latest.map((d) => d.id),
    undecidedThoughtIds: thoughts
      .filter(
        (t) =>
          t.captureId !== undefined &&
          captureSet.has(t.captureId) &&
          !decidedByEnd.has(t.id),
      )
      .map((t) => t.id),
  };
}
