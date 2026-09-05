/**
 * TTL cache for M365 context snippets (Specification 5.2).
 *
 * Snippets are cached per scope so repeated captures do not refetch the
 * same Microsoft resource within the TTL. This is a CACHE, not memory:
 * entries expire deterministically, revoked consent stops reads before
 * the cache is ever consulted (the adapter checks consent first), source
 * deletion evicts on the next fetch, and `m365 disconnect` purges the
 * whole partition. Promotion to durable memory is a separate visible
 * proposal — nothing here ever becomes durable silently.
 */
import { readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex, type ContextSnippet } from "@donna/core";
import { writePrivateFile } from "@donna/file-security";
import { m365ScopeDir } from "./connection.js";

interface Scope {
  tenantId: string;
  userId: string;
}

export class M365SnippetCache {
  constructor(
    private readonly dataDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private dirFor(scope: Scope): string {
    return join(m365ScopeDir(this.dataDir, scope), "snippets");
  }

  private fileFor(scope: Scope, snippetId: string): string {
    return join(this.dirFor(scope), `${sha256Hex(snippetId)}.json`);
  }

  private selectionFileFor(scope: Scope, selectionKey: string): string {
    return join(this.dirFor(scope), `sel-${sha256Hex(selectionKey)}.json`);
  }

  /**
   * Read a snippet. Expired entries are evicted and reported missing;
   * entries whose embedded scope does not match the partition fail closed
   * (SR-2 — a cache file can never leak across scopes).
   */
  async get(scope: Scope, snippetId: string): Promise<ContextSnippet | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.fileFor(scope, snippetId), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    const snippet = JSON.parse(raw) as ContextSnippet;
    if (snippet.tenantId !== scope.tenantId || snippet.userId !== scope.userId) {
      await this.evict(scope, snippetId);
      return undefined;
    }
    if (snippet.expiresAt <= this.now().toISOString()) {
      await this.evict(scope, snippetId);
      return undefined;
    }
    return snippet;
  }

  async put(scope: Scope, snippet: ContextSnippet): Promise<void> {
    if (snippet.tenantId !== scope.tenantId || snippet.userId !== scope.userId) {
      throw new Error("Snippet scope does not match the cache partition");
    }
    await writePrivateFile(
      this.fileFor(scope, snippet.id),
      JSON.stringify(snippet, null, 2),
    );
  }

  /** Idempotent: returns true when an entry was actually removed. */
  async evict(scope: Scope, snippetId: string): Promise<boolean> {
    try {
      await rm(this.fileFor(scope, snippetId));
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  /**
   * Selection markers remember which member snippets a multi-resource
   * selection (a Teams thread) produced, so a thread fetch is cache-first
   * within the TTL exactly like single-resource fetches.
   */
  async getSelection(
    scope: Scope,
    selectionKey: string,
  ): Promise<{ memberIds: string[] } | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.selectionFileFor(scope, selectionKey), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    const marker = JSON.parse(raw) as {
      tenantId: string;
      userId: string;
      memberIds: string[];
      expiresAt: string;
    };
    if (marker.tenantId !== scope.tenantId || marker.userId !== scope.userId) {
      await this.evictSelection(scope, selectionKey);
      return undefined;
    }
    if (marker.expiresAt <= this.now().toISOString()) {
      await this.evictSelection(scope, selectionKey);
      return undefined;
    }
    return { memberIds: marker.memberIds };
  }

  async putSelection(
    scope: Scope,
    selectionKey: string,
    memberIds: string[],
    expiresAt: string,
  ): Promise<void> {
    await writePrivateFile(
      this.selectionFileFor(scope, selectionKey),
      JSON.stringify({
        tenantId: scope.tenantId,
        userId: scope.userId,
        memberIds,
        expiresAt,
      }),
    );
  }

  /** Idempotent: returns true when a marker was actually removed. */
  async evictSelection(scope: Scope, selectionKey: string): Promise<boolean> {
    try {
      await rm(this.selectionFileFor(scope, selectionKey));
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  /** Every unexpired snippet in the scope (visibility for the employee). */
  async list(scope: Scope): Promise<ContextSnippet[]> {
    let files: string[];
    try {
      files = await readdir(this.dirFor(scope));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const snippets: ContextSnippet[] = [];
    for (const file of files) {
      if (!file.endsWith(".json") || file.startsWith("sel-")) continue;
      let raw: string;
      try {
        raw = await readFile(join(this.dirFor(scope), file), "utf8");
      } catch {
        continue;
      }
      try {
        const snippet = JSON.parse(raw) as ContextSnippet;
        if (
          snippet.tenantId === scope.tenantId &&
          snippet.userId === scope.userId &&
          snippet.expiresAt > this.now().toISOString()
        ) {
          snippets.push(snippet);
        }
      } catch {
        // Unparseable cache entries are skipped, never served.
      }
    }
    return snippets.sort((a, b) => a.id.localeCompare(b.id));
  }
}
