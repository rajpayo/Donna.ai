/**
 * Session-scoped storage (Specification 2.4).
 *
 * Layout: <dataDir>/<tenant>/<user>/sessions.json — sessions, emotional
 * snapshots, and intent signals. Same isolation rules as the other
 * file-backed stores: partition-ID validation, fail-closed scope checks,
 * 0700 directories / 0600 files.
 *
 * Sessions expire: `sweepExpired` removes expired sessions and every
 * snapshot/intent bound to them. Emotional snapshots never outlive their
 * session here — durable promotion (with explicit opt-in consent) is the
 * EmotionalContextService's job, executed BEFORE the sweep deletes.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  EmotionalSnapshot,
  IntentSignal,
  Session,
} from "@donna/core";
import { writePrivateFile } from "@donna/file-security";
import { assertPartitionId, assertRecordId } from "./store.file.js";

interface SessionFile {
  sessions: Session[];
  snapshots: EmotionalSnapshot[];
  intents: IntentSignal[];
}

const EMPTY: SessionFile = { sessions: [], snapshots: [], intents: [] };

function assertScope(
  record: { tenantId: string; userId: string },
  tenantId: string,
  userId: string,
): void {
  if (record.tenantId !== tenantId || record.userId !== userId) {
    throw new Error("Stored record does not match its tenant/user partition");
  }
}

export interface SessionStore {
  saveSession(session: Session): Promise<void>;
  getSession(
    tenantId: string,
    userId: string,
    sessionId: string,
  ): Promise<Session | undefined>;
  listSessions(tenantId: string, userId: string): Promise<Session[]>;

  saveSnapshot(snapshot: EmotionalSnapshot): Promise<void>;
  getSnapshot(
    tenantId: string,
    userId: string,
    snapshotId: string,
  ): Promise<EmotionalSnapshot | undefined>;
  listSnapshots(
    tenantId: string,
    userId: string,
    sessionId?: string,
  ): Promise<EmotionalSnapshot[]>;
  deleteSnapshot(
    tenantId: string,
    userId: string,
    snapshotId: string,
  ): Promise<boolean>;

  saveIntent(signal: IntentSignal): Promise<void>;
  listIntents(
    tenantId: string,
    userId: string,
    sessionId?: string,
  ): Promise<IntentSignal[]>;

  /**
   * Remove sessions expired at `now` together with their snapshots and
   * intents. Idempotent.
   */
  sweepExpired(
    tenantId: string,
    userId: string,
    now: string,
  ): Promise<{ sessions: number; snapshots: number; intents: number }>;
}

export class FileSessionStore implements SessionStore {
  constructor(private readonly dataDir: string) {}

  private fileFor(tenantId: string, userId: string): string {
    assertPartitionId("tenant", tenantId);
    assertPartitionId("user", userId);
    return join(this.dataDir, tenantId, userId, "sessions.json");
  }

  private async load(tenantId: string, userId: string): Promise<SessionFile> {
    let raw: string;
    try {
      raw = await readFile(this.fileFor(tenantId, userId), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return structuredClone(EMPTY);
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as Partial<SessionFile>;
    if (
      !Array.isArray(parsed.sessions) ||
      !Array.isArray(parsed.snapshots) ||
      !Array.isArray(parsed.intents)
    ) {
      throw new Error("Invalid file-backed session store data");
    }
    const data = parsed as SessionFile;
    for (const record of [...data.sessions, ...data.snapshots, ...data.intents]) {
      assertScope(record, tenantId, userId);
    }
    return data;
  }

  private async save(
    tenantId: string,
    userId: string,
    data: SessionFile,
  ): Promise<void> {
    const file = this.fileFor(tenantId, userId);
    await writePrivateFile(file, JSON.stringify(data, null, 2));
  }

  async saveSession(session: Session): Promise<void> {
    assertRecordId("session", session.id);
    const data = await this.load(session.tenantId, session.userId);
    const index = data.sessions.findIndex((s) => s.id === session.id);
    if (index >= 0) data.sessions[index] = session;
    else data.sessions.push(session);
    await this.save(session.tenantId, session.userId, data);
  }

  async getSession(
    tenantId: string,
    userId: string,
    sessionId: string,
  ): Promise<Session | undefined> {
    assertRecordId("session", sessionId);
    const data = await this.load(tenantId, userId);
    return data.sessions.find((s) => s.id === sessionId);
  }

  async listSessions(tenantId: string, userId: string): Promise<Session[]> {
    return (await this.load(tenantId, userId)).sessions;
  }

  async saveSnapshot(snapshot: EmotionalSnapshot): Promise<void> {
    assertRecordId("snapshot", snapshot.id);
    const data = await this.load(snapshot.tenantId, snapshot.userId);
    const index = data.snapshots.findIndex((s) => s.id === snapshot.id);
    if (index >= 0) data.snapshots[index] = snapshot;
    else data.snapshots.push(snapshot);
    await this.save(snapshot.tenantId, snapshot.userId, data);
  }

  async getSnapshot(
    tenantId: string,
    userId: string,
    snapshotId: string,
  ): Promise<EmotionalSnapshot | undefined> {
    assertRecordId("snapshot", snapshotId);
    const data = await this.load(tenantId, userId);
    return data.snapshots.find((s) => s.id === snapshotId);
  }

  async listSnapshots(
    tenantId: string,
    userId: string,
    sessionId?: string,
  ): Promise<EmotionalSnapshot[]> {
    const data = await this.load(tenantId, userId);
    return data.snapshots.filter(
      (s) => sessionId === undefined || s.sessionId === sessionId,
    );
  }

  async deleteSnapshot(
    tenantId: string,
    userId: string,
    snapshotId: string,
  ): Promise<boolean> {
    assertRecordId("snapshot", snapshotId);
    const data = await this.load(tenantId, userId);
    const kept = data.snapshots.filter((s) => s.id !== snapshotId);
    if (kept.length === data.snapshots.length) return false;
    data.snapshots = kept;
    await this.save(tenantId, userId, data);
    return true;
  }

  async saveIntent(signal: IntentSignal): Promise<void> {
    assertRecordId("intent", signal.id);
    const data = await this.load(signal.tenantId, signal.userId);
    const index = data.intents.findIndex((s) => s.id === signal.id);
    if (index >= 0) data.intents[index] = signal;
    else data.intents.push(signal);
    await this.save(signal.tenantId, signal.userId, data);
  }

  async listIntents(
    tenantId: string,
    userId: string,
    sessionId?: string,
  ): Promise<IntentSignal[]> {
    const data = await this.load(tenantId, userId);
    return data.intents.filter(
      (s) => sessionId === undefined || s.sessionId === sessionId,
    );
  }

  async sweepExpired(
    tenantId: string,
    userId: string,
    now: string,
  ): Promise<{ sessions: number; snapshots: number; intents: number }> {
    const data = await this.load(tenantId, userId);
    const expiredSessionIds = new Set(
      data.sessions.filter((s) => s.expiresAt <= now).map((s) => s.id),
    );
    const sessions = data.sessions.filter((s) => !expiredSessionIds.has(s.id));
    const snapshots = data.snapshots.filter(
      (s) => !expiredSessionIds.has(s.sessionId) && s.expiresAt > now,
    );
    const intents = data.intents.filter(
      (s) => !expiredSessionIds.has(s.sessionId) && s.expiresAt > now,
    );
    const removed = {
      sessions: data.sessions.length - sessions.length,
      snapshots: data.snapshots.length - snapshots.length,
      intents: data.intents.length - intents.length,
    };
    if (removed.sessions + removed.snapshots + removed.intents > 0) {
      await this.save(tenantId, userId, { sessions, snapshots, intents });
    }
    return removed;
  }
}
