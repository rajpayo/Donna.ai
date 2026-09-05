/**
 * Draft executors (Specification 5.4): the ONLY code paths that can turn
 * an approved draft into an MCP call. Executors are wired by code with
 * fixed minimal allowlists and are never exposed to LLM prompts (SR-2).
 *
 * In this phase:
 *   - email-draft → REAL managed-MCP `create_draft`: creates an Outlook
 *     DRAFT in the connector owner's mailbox. It can never send —
 *     send_email/reply_email are not on the connection's allowlist and
 *     the client denies them before any I/O (Spec 5.1, SR-3).
 *   - teams-message, calendar-proposal, file-publication → SANDBOX:
 *     post/send/create are real external mutations and stay gated for
 *     the later agent approval runtime; the sandbox commit records the
 *     intended action with no external side effect.
 *   - task-action → UNAVAILABLE: the managed MCP exposes no Planner /
 *     To Do tools (verified in the 48-tool list 2026-09-03); the
 *     capability report says so instead of pretending.
 */
import type { ActionDraft, DraftExecutor, McpConnection } from "@donna/core";
import { mcpJsonContent } from "@donna/core";

/** Redacted executor failure — stage + classification only, never content. */
export class DraftCommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftCommitError";
  }
}

/** Real executor: Outlook draft creation via the managed MCP. */
export class McpEmailDraftExecutor implements DraftExecutor {
  readonly type = "email-draft" as const;
  readonly capability = "mcp-live" as const;
  readonly capabilityNote =
    "Creates an Outlook DRAFT via the managed MCP (create_draft). Never sends.";

  constructor(private readonly connection: McpConnection) {}

  async commit(draft: ActionDraft): Promise<{ externalId?: string; note?: string }> {
    if (draft.payload.type !== "email-draft") {
      throw new DraftCommitError("draft type mismatch");
    }
    const { to, cc, subject, body } = draft.payload;
    // Managed-MCP create_draft schema (verified live 2026-09-03):
    // to/cc are string arrays; body is { content, contentType }.
    const result = await this.connection.callTool("create_draft", {
      to,
      ...(cc !== undefined && cc.length > 0 ? { cc } : {}),
      subject,
      body: { content: body, contentType: "text" },
    });
    if (result.isError) {
      throw new DraftCommitError("create_draft returned an error result (detail redacted)");
    }
    const payload = mcpJsonContent(result.content);
    const id =
      payload !== null && typeof payload === "object"
        ? (payload as { id?: unknown }).id
        : undefined;
    return {
      ...(typeof id === "string" ? { externalId: id } : {}),
      note: "outlook-draft-created",
    };
  }
}

/** Sandbox executor: records the intended mutation; performs none. */
export class SandboxDraftExecutor implements DraftExecutor {
  readonly capability = "sandbox" as const;
  constructor(
    readonly type: "teams-message" | "calendar-proposal" | "file-publication",
    readonly capabilityNote: string,
  ) {}
  async commit(draft: ActionDraft): Promise<{ externalId?: string; note?: string }> {
    if (draft.payload.type !== this.type) {
      throw new DraftCommitError("draft type mismatch");
    }
    return { note: "sandbox-noop: no external mutation performed (gated for the agent approval runtime)" };
  }
}

/** Unavailable executor: the managed MCP has no tools for this action. */
export class UnavailableDraftExecutor implements DraftExecutor {
  readonly capability = "unavailable" as const;
  constructor(
    readonly type: "task-action",
    readonly capabilityNote: string,
  ) {}
  async commit(): Promise<{ externalId?: string; note?: string }> {
    throw new DraftCommitError(this.capabilityNote);
  }
}

/**
 * The capability report for every intended Microsoft action (Spec 5.4
 * scope: "sandbox destination adapters or capability reports for each
 * intended Microsoft action").
 */
export function draftCapabilityReport(
  executors: ReadonlyArray<Pick<DraftExecutor, "type" | "capability" | "capabilityNote">>,
): Array<{ type: string; capability: string; note: string }> {
  return executors.map((e) => ({
    type: e.type,
    capability: e.capability,
    note: e.capabilityNote,
  }));
}
