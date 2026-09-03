/**
 * Pilot profile (Specification 6.1): the durable record of a volunteer's
 * enrollment and per-setting choices. One profile per tenant/user scope,
 * stored in the scoped pilot partition (`data/pilot/<tenant>/<user>/`).
 * The profile carries settings and pseudonymous identity only — never
 * captured content.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { M365ReadSourceType } from "@donna/core";
import type { PilotDataClass } from "./policy.js";

export const PILOT_PROFILE_SCHEMA = "donna.pilot-profile.v1";

export interface PilotProfile {
  schema: typeof PILOT_PROFILE_SCHEMA;
  tenantId: string;
  userId: string;
  /**
   * Pseudonymous participant handle (e.g. "P-01") chosen at enrollment.
   * Reports and run records use this — never a name or email (SR-2, 6.2).
   */
  participantId: string;
  enrolledAt: string; // ISO 8601
  /** Version of the consent wording the volunteer agreed to. */
  consentTextVersion: string;
  /** Permitted data classes (validated against exclusions, SR-3). */
  dataClasses: PilotDataClass[];
  /** Chosen Microsoft 365 read sources; narrow by default. */
  m365Sources: M365ReadSourceType[];
  /** Fixed by policy: 7. */
  audioRetentionDays: number;
  /** Durable personal memory allowed (cross-session). */
  durableMemory: boolean;
  /** Session-scoped tentative emotion inference allowed. */
  emotionInference: boolean;
  /** Persist emotional context beyond the session (separate opt-in). */
  emotionPersistence: boolean;
  status: "enrolled" | "exited";
  updatedAt: string; // ISO 8601
  exitedAt?: string; // ISO 8601
}

/** Storage port so tests can run fully in memory. */
export interface PilotProfileStore {
  get(tenantId: string, userId: string): Promise<PilotProfile | undefined>;
  save(profile: PilotProfile): Promise<void>;
}

const PARTITION_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

function assertPartitionId(kind: "tenant" | "user", value: string): void {
  if (!PARTITION_ID.test(value)) {
    throw new Error(`Invalid ${kind} ID for the pilot partition`);
  }
}

/** Directory of the scoped pilot partition (profile, misfires, runs). */
export function pilotScopeDir(
  dataDir: string,
  scope: { tenantId: string; userId: string },
): string {
  assertPartitionId("tenant", scope.tenantId);
  assertPartitionId("user", scope.userId);
  return join(dataDir, "pilot", scope.tenantId, scope.userId);
}

export class FilePilotProfileStore implements PilotProfileStore {
  constructor(private readonly dataDir: string) {}

  private fileFor(tenantId: string, userId: string): string {
    return join(pilotScopeDir(this.dataDir, { tenantId, userId }), "profile.json");
  }

  async get(tenantId: string, userId: string): Promise<PilotProfile | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.fileFor(tenantId, userId), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as PilotProfile;
    if (parsed.tenantId !== tenantId || parsed.userId !== userId) {
      throw new Error("Stored pilot profile does not match its tenant/user partition");
    }
    return parsed;
  }

  async save(profile: PilotProfile): Promise<void> {
    const file = this.fileFor(profile.tenantId, profile.userId);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(profile, null, 2) + "\n", { mode: 0o600 });
  }
}
