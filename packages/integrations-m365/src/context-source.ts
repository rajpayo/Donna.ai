/**
 * Microsoft 365 ContextSource (Specification 5.2): scoped, consented,
 * minimized read context over the managed MCP.
 *
 * Reads happen only for:
 *   - the calendar window around a capture (m365.read.calendar), and
 *   - resources the employee explicitly selected (m365 selected), each
 *     gated by its source-type consent.
 *
 * Guarantees:
 *   - FR-1: every snippet records its source, tool, and consent purpose.
 *   - FR-2: selection and TTL state are visible (m365 selected/snippets).
 *   - FR-3: source deletion or permission loss evicts and excludes the
 *     snippet on the next fetch; TTL expiry excludes it from the cache.
 *   - FR-4: calendar and each selection type degrade independently —
 *     failures contribute machine-readable degraded tokens, never
 *     exceptions that break organization.
 *   - SR-1: results are untrusted content; nothing here changes policy.
 *   - SR-2: consent and scope checks run BEFORE any content can reach a
 *     model-facing surface; the cache re-verifies embedded scope.
 *   - SR-3: excerpts are minimized previews, never full documents.
 */
import type {
  ContextSnippet,
  ContextSource,
  ExternalContextCollector,
  McpConnection,
} from "@donna/core";
import { requireM365Consent, type M365ConsentGate } from "./connection.js";
import { M365SelectionStore, type M365Selection } from "./selections.js";
import { M365SnippetCache } from "./snippet-cache.js";
import {
  DEFAULT_EXCERPT_CHARS,
  m365SnippetId,
  mcpItems,
  mcpJsonContent,
  normalizeCalendarEvent,
  normalizeEmail,
  normalizeFile,
  normalizeSharePointItem,
  normalizeTeamsMessage,
  type SnippetContext,
} from "./snippets.js";

interface Scope {
  tenantId: string;
  userId: string;
}

export interface M365ContextSourceDeps {
  /** Read-only MCP connection (write tools are unreachable through it). */
  connection: McpConnection;
  /** Donna-side consent gate (the existing ConsentStore service). */
  consents: M365ConsentGate;
  dataDir: string;
  now?: () => Date;
  /** Snippet TTL in ms (default 15 minutes). */
  snippetTtlMs?: number;
  /** Excerpt cap in characters (default 280, SR-3). */
  excerptChars?: number;
  /** Calendar window around the capture time (defaults: -4h / +12h). */
  calendarWindowBeforeMs?: number;
  calendarWindowAfterMs?: number;
  /** Events listed before the window filter is applied (default 25). */
  calendarTop?: number;
  /** Messages fetched per selected Teams thread (default 5). */
  teamsMessagesPerThread?: number;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export class M365ContextSource implements ContextSource, ExternalContextCollector {
  readonly kind = "m365";
  private readonly selections: M365SelectionStore;
  private readonly cache: M365SnippetCache;
  private readonly now: () => Date;

  constructor(private readonly deps: M365ContextSourceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.selections = new M365SelectionStore(deps.dataDir);
    this.cache = new M365SnippetCache(deps.dataDir, this.now);
  }

  /** Exposed for the CLI: selection registry + cache visibility. */
  get selectionStore(): M365SelectionStore {
    return this.selections;
  }

  get snippetCache(): M365SnippetCache {
    return this.cache;
  }

  private snippetContext(
    scope: Scope,
    consentPurpose: ContextSnippet["consentPurpose"],
    tool: string,
  ): SnippetContext {
    const fetched = this.now();
    return {
      tenantId: scope.tenantId,
      userId: scope.userId,
      consentPurpose,
      tool,
      fetchedAt: fetched.toISOString(),
      expiresAt: new Date(
        fetched.getTime() + (this.deps.snippetTtlMs ?? DEFAULT_TTL_MS),
      ).toISOString(),
      excerptChars: this.deps.excerptChars ?? DEFAULT_EXCERPT_CHARS,
    };
  }

  /**
   * Low-level consented fetch (ContextSource port). Resource reads are
   * restricted to IDs the employee selected; the calendar window path
   * lists events and filters to the window client-side (the managed MCP
   * exposes no window parameters).
   */
  async fetchSnippets(
    scope: Scope,
    request: {
      consentPurpose: ContextSnippet["consentPurpose"];
      resourceIds?: string[];
      window?: { from: string; to: string };
    },
  ): Promise<ContextSnippet[]> {
    // Consent gate first — no bytes leave the machine without a grant.
    await requireM365Consent(this.deps.consents, scope, request.consentPurpose);

    if (request.window !== undefined) {
      return this.calendarWindow(scope, request.window);
    }

    const selections = await this.selections.list(scope);
    const wanted = new Set(request.resourceIds ?? []);
    const snippets: ContextSnippet[] = [];
    for (const selection of selections) {
      if (!wanted.has(selection.resourceId)) continue;
      if (selection.consentPurpose !== request.consentPurpose) continue;
      snippets.push(...(await this.fetchSelection(scope, selection)));
    }
    return snippets;
  }

  /**
   * Assemble-facing collection (FR-4): the calendar window and every
   * selection type are gathered independently; failures degrade to
   * machine-readable tokens instead of breaking organization.
   */
  async collect(
    scope: Scope,
    query: { text: string; capturedAt?: string },
  ): Promise<{ snippets: ContextSnippet[]; degraded: string[] }> {
    const snippets: ContextSnippet[] = [];
    const degraded: string[] = [];

    // --- calendar window around the capture ---
    if (query.capturedAt !== undefined) {
      try {
        const captured = new Date(query.capturedAt).getTime();
        const before = this.deps.calendarWindowBeforeMs ?? 4 * 3600_000;
        const after = this.deps.calendarWindowAfterMs ?? 12 * 3600_000;
        snippets.push(
          ...(await this.fetchSnippets(scope, {
            consentPurpose: "m365.read.calendar",
            window: {
              from: new Date(captured - before).toISOString(),
              to: new Date(captured + after).toISOString(),
            },
          })),
        );
      } catch (error) {
        degraded.push(
          error instanceof Error && error.name === "M365ConsentError"
            ? "m365-calendar-not-consented"
            : "m365-calendar-unavailable",
        );
      }
    }

    // --- explicitly selected resources, one failure domain per selection ---
    let selections: M365Selection[] = [];
    try {
      selections = await this.selections.list(scope);
    } catch {
      degraded.push("m365-selections-unavailable");
    }
    for (const selection of selections) {
      try {
        snippets.push(...(await this.fetchSelection(scope, selection)));
      } catch (error) {
        degraded.push(
          error instanceof Error && error.name === "M365ConsentError"
            ? `m365-selection-not-consented:${selection.type}`
            : `m365-selection-unavailable:${selection.type}`,
        );
      }
    }

    return { snippets, degraded };
  }

  /** Calendar events overlapping [from, to], consent-gated and cached. */
  private async calendarWindow(
    scope: Scope,
    window: { from: string; to: string },
  ): Promise<ContextSnippet[]> {
    const ctx = this.snippetContext(scope, "m365.read.calendar", "list_events");
    const result = await this.deps.connection.callTool("list_events", {
      top: this.deps.calendarTop ?? 25,
    });
    if (result.isError) {
      throw new Error("list_events returned an error result");
    }
    const events = mcpItems(mcpJsonContent(result.content));
    const snippets: ContextSnippet[] = [];
    for (const raw of events) {
      const snippet = normalizeCalendarEvent(raw, ctx);
      if (snippet === undefined) continue;
      const start = snippet.sourceTimestamp;
      if (start === undefined) continue;
      // Window overlap: event starts before the window ends and the
      // snippet's source time falls inside or adjacent to the capture.
      if (start < window.from || start > window.to) continue;
      await this.cache.put(scope, snippet);
      snippets.push(snippet);
    }
    return snippets;
  }

  /**
   * Fetch one selection, cache-first within the TTL: single resources key
   * on their deterministic snippet ID; threads key on a selection marker
   * listing member snippet IDs. On refetch (post-TTL), a missing or
   * errored resource evicts its cached snippets (FR-3).
   */
  private async fetchSelection(
    scope: Scope,
    selection: M365Selection,
  ): Promise<ContextSnippet[]> {
    await requireM365Consent(this.deps.consents, scope, selection.consentPurpose);

    const selectionKey = `${selection.type}:${selection.resourceId}`;
    if (selection.multi) {
      const marker = await this.cache.getSelection(scope, selectionKey);
      if (marker !== undefined) {
        const members: ContextSnippet[] = [];
        for (const memberId of marker.memberIds) {
          const cached = await this.cache.get(scope, memberId);
          if (cached !== undefined) members.push(cached);
        }
        return members;
      }
    } else {
      const cached = await this.cache.get(
        scope,
        m365SnippetId(selection.resourceType, selection.resourceId),
      );
      if (cached !== undefined) return [cached];
    }

    const args = { ...selection.fetch.args };
    if (selection.multi) {
      args["top"] = this.deps.teamsMessagesPerThread ?? 5;
    }

    const ctx = this.snippetContext(scope, selection.consentPurpose, selection.fetch.tool);
    const result = await this.deps.connection.callTool(selection.fetch.tool, args);
    if (result.isError) {
      // Source deleted or permission lost: evict and contribute nothing.
      await this.evictSelection(scope, selection);
      throw new Error(`${selection.fetch.tool} returned an error result`);
    }
    const payload = mcpJsonContent(result.content);
    const normalize = (
      raw: unknown,
    ): ContextSnippet | undefined => {
      switch (selection.resourceType) {
        case "calendar-event":
          return normalizeCalendarEvent(raw, ctx);
        case "email":
          return normalizeEmail(raw, ctx);
        case "teams-message":
          return normalizeTeamsMessage(raw, ctx);
        case "file":
          return normalizeFile(raw, ctx);
        case "sharepoint-item":
          return normalizeSharePointItem(raw, ctx);
      }
    };

    const raws = selection.multi ? mcpItems(payload) : [payload];
    const snippets: ContextSnippet[] = [];
    for (const raw of raws) {
      const snippet = normalize(raw);
      if (snippet === undefined) continue;
      await this.cache.put(scope, snippet);
      snippets.push(snippet);
    }
    if (selection.multi) {
      await this.cache.putSelection(
        scope,
        selectionKey,
        snippets.map((s) => s.id),
        ctx.expiresAt,
      );
    }
    return snippets;
  }

  /** Evict every cached snippet (and marker) a selection produced. */
  private async evictSelection(scope: Scope, selection: M365Selection): Promise<void> {
    const selectionKey = `${selection.type}:${selection.resourceId}`;
    if (selection.multi) {
      const marker = await this.cache.getSelection(scope, selectionKey);
      if (marker !== undefined) {
        for (const memberId of marker.memberIds) {
          await this.cache.evict(scope, memberId);
        }
      }
      await this.cache.evictSelection(scope, selectionKey);
      return;
    }
    await this.cache.evict(
      scope,
      m365SnippetId(selection.resourceType, selection.resourceId),
    );
  }
}
