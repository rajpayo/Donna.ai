/**
 * Employee-selected Microsoft 365 resources (Specification 5.2).
 *
 * Donna reads ONLY what this registry names (plus the consent-gated
 * calendar window). Selections are scoped per tenant/user, visible via
 * `m365 selected`, and removed by `m365 unselect` or `m365 disconnect`
 * (which purges the whole scoped partition). Selection requires the
 * matching Donna-side consent grant at selection time.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  m365ReadConsentPurpose,
  type M365ConsentPurpose,
  type M365ResourceType,
} from "@donna/core";
import { writePrivateFile } from "@donna/file-security";
import { m365ScopeDir } from "./connection.js";

/** Selectable resource categories and how each is fetched. */
export type M365SelectionType =
  | "email"
  | "calendar-event"
  | "teams-chat"
  | "teams-channel"
  | "file"
  | "sharepoint-item";

export interface M365Selection {
  /** Stable resource identifier (message/event/item/chat ID; composite for channels and SharePoint). */
  resourceId: string;
  type: M365SelectionType;
  /** Snippet resource type produced by this selection. */
  resourceType: M365ResourceType;
  /** Donna-side consent purpose that gates reads of this selection. */
  consentPurpose: M365ConsentPurpose;
  /** MCP read tool + arguments used to fetch the resource. */
  fetch: { tool: string; args: Record<string, unknown> };
  /** True when one fetch yields multiple message snippets (threads). */
  multi: boolean;
  selectedAt: string; // ISO 8601
}

/** Build the fetch plan for a selection type. Throws on invalid IDs. */
export function m365SelectionPlan(
  type: M365SelectionType,
  resourceId: string,
): Pick<M365Selection, "resourceType" | "consentPurpose" | "fetch" | "multi"> {
  const id = resourceId.trim();
  if (id === "" || id.includes("..")) {
    throw new Error("Invalid resource ID");
  }
  switch (type) {
    case "email":
      return {
        resourceType: "email",
        consentPurpose: m365ReadConsentPurpose("mail"),
        fetch: { tool: "get_email", args: { message_id: id } },
        multi: false,
      };
    case "calendar-event":
      return {
        resourceType: "calendar-event",
        consentPurpose: m365ReadConsentPurpose("calendar"),
        fetch: { tool: "get_event", args: { event_id: id } },
        multi: false,
      };
    case "teams-chat":
      return {
        resourceType: "teams-message",
        consentPurpose: m365ReadConsentPurpose("teams"),
        fetch: { tool: "get_chat_messages", args: { chat_id: id } },
        multi: true,
      };
    case "teams-channel": {
      const slash = id.indexOf("/");
      if (slash <= 0 || slash === id.length - 1) {
        throw new Error(
          "teams-channel selections use the composite ID <team-id>/<channel-id>",
        );
      }
      return {
        resourceType: "teams-message",
        consentPurpose: m365ReadConsentPurpose("teams"),
        fetch: {
          tool: "get_channel_messages",
          args: { team_id: id.slice(0, slash), channel_id: id.slice(slash + 1) },
        },
        multi: true,
      };
    }
    case "file":
      return {
        resourceType: "file",
        consentPurpose: m365ReadConsentPurpose("files"),
        fetch: { tool: "get_file", args: { item_id: id } },
        multi: false,
      };
    case "sharepoint-item": {
      const parts = id.split("/");
      if (parts.length !== 3 || parts.some((part) => part === "")) {
        throw new Error(
          "sharepoint-item selections use the composite ID <site-id>/<list-id>/<item-id>",
        );
      }
      return {
        resourceType: "sharepoint-item",
        consentPurpose: m365ReadConsentPurpose("files"),
        fetch: {
          tool: "get_item",
          args: { site_id: parts[0], list_id: parts[1], item_id: parts[2] },
        },
        multi: false,
      };
    }
  }
}

interface Scope {
  tenantId: string;
  userId: string;
}

/** Scoped file-backed selection registry. */
export class M365SelectionStore {
  constructor(private readonly dataDir: string) {}

  private fileFor(scope: Scope): string {
    return join(m365ScopeDir(this.dataDir, scope), "selections.json");
  }

  async list(scope: Scope): Promise<M365Selection[]> {
    let raw: string;
    try {
      raw = await readFile(this.fileFor(scope), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("Invalid M365 selection store data");
    }
    return parsed as M365Selection[];
  }

  private async save(scope: Scope, selections: M365Selection[]): Promise<void> {
    const file = this.fileFor(scope);
    await writePrivateFile(file, JSON.stringify(selections, null, 2));
  }

  /** Idempotent per (type, resourceId): re-selecting refreshes selectedAt. */
  async select(
    scope: Scope,
    type: M365SelectionType,
    resourceId: string,
    now: () => Date = () => new Date(),
  ): Promise<M365Selection> {
    const plan = m365SelectionPlan(type, resourceId);
    const selections = await this.list(scope);
    const existing = selections.findIndex(
      (s) => s.type === type && s.resourceId === resourceId,
    );
    const selection: M365Selection = {
      resourceId,
      type,
      ...plan,
      selectedAt: now().toISOString(),
    };
    if (existing >= 0) {
      selections[existing] = selection;
    } else {
      selections.push(selection);
    }
    await this.save(scope, selections);
    return selection;
  }

  /** Idempotent: returns true when a selection was actually removed. */
  async unselect(scope: Scope, resourceId: string): Promise<boolean> {
    const selections = await this.list(scope);
    const remaining = selections.filter((s) => s.resourceId !== resourceId);
    if (remaining.length === selections.length) return false;
    await this.save(scope, remaining);
    return true;
  }
}