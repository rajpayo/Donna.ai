/**
 * File-backed ActionDraftStore (Specification 5.4).
 *
 * Scoped exactly like the memory stores: a draft is only ever read or
 * written inside its own tenant/user partition, and a stored record whose
 * scope does not match its partition fails closed. Payload and source
 * links are immutable once written; only lifecycle fields change.
 *
 * The store receives its per-scope directory from the caller so the CLI
 * can place drafts inside the M365 cache partition (purged by
 * `m365 disconnect`, SR-3 restrictive caching).
 */
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ActionDraft, ActionDraftStore } from "@donna/core";
import { writePrivateFile } from "@donna/file-security";

interface Scope {
  tenantId: string;
  userId: string;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export class FileActionDraftStore implements ActionDraftStore {
  constructor(private readonly dirFor: (scope: Scope) => string) {}

  private fileFor(scope: Scope, draftId: string): string {
    if (!SAFE_ID.test(draftId)) {
      throw new Error("Invalid draft ID");
    }
    return join(this.dirFor(scope), "drafts", `${draftId}.json`);
  }

  private assertScope(draft: ActionDraft, scope: Scope): void {
    if (draft.tenantId !== scope.tenantId || draft.userId !== scope.userId) {
      throw new Error("Draft scope does not match its partition");
    }
  }

  async saveDraft(draft: ActionDraft): Promise<void> {
    const file = this.fileFor(
      { tenantId: draft.tenantId, userId: draft.userId },
      draft.id,
    );
    await writePrivateFile(file, JSON.stringify(draft, null, 2));
  }

  async getDraft(
    tenantId: string,
    userId: string,
    draftId: string,
  ): Promise<ActionDraft | undefined> {
    const scope = { tenantId, userId };
    let raw: string;
    try {
      raw = await readFile(this.fileFor(scope, draftId), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    const draft = JSON.parse(raw) as ActionDraft;
    this.assertScope(draft, scope);
    return draft;
  }

  async listDrafts(tenantId: string, userId: string): Promise<ActionDraft[]> {
    const scope = { tenantId, userId };
    const dir = join(this.dirFor(scope), "drafts");
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const drafts: ActionDraft[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const draft = JSON.parse(await readFile(join(dir, file), "utf8")) as ActionDraft;
      this.assertScope(draft, scope);
      drafts.push(draft);
    }
    return drafts.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async deleteDraft(tenantId: string, userId: string, draftId: string): Promise<boolean> {
    try {
      await rm(this.fileFor({ tenantId, userId }, draftId));
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }
}
