/**
 * Client-side tool classification for the TrueFoundry-managed Microsoft
 * 365 MCP (Specification 5.1, SR-3).
 *
 * The server exposes 48 tools (verified live 2026-09-03). Donna splits
 * them into READ tools — the only ones the context layer may invoke — and
 * WRITE/DRAFT tools, which are reachable solely through the approval path
 * (Specification 5.4). Classification is deny-by-default: a tool name
 * that is not on either list is "unknown" and denied in every mode, so a
 * server-side tool addition can never silently widen Donna's reach.
 */

/** Read-only tools the context layer may invoke (25, verified 2026-09-03). */
export const M365_READ_TOOLS: ReadonlySet<string> = new Set([
  "find_free_slots",
  "get_channel_messages",
  "get_chat_messages",
  "get_email",
  "get_event",
  "get_file",
  "get_item",
  "get_site",
  "download_file",
  "list_calendars",
  "list_channels",
  "list_chats",
  "list_emails",
  "list_events",
  "list_files",
  "list_folders",
  "list_items",
  "list_libraries",
  "list_sites",
  "list_teams",
  "search_chat_messages",
  "search_emails",
  "search_events",
  "search_files",
  "search_sharepoint",
]);

/**
 * Write/draft tools (23, verified 2026-09-03). Never invokable from the
 * context layer; the approval path allowlists individual tools explicitly.
 */
export const M365_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "accept_event",
  "add_chat_member",
  "create_chat",
  "create_draft",
  "create_event",
  "create_folder",
  "create_item",
  "decline_event",
  "delete_email",
  "delete_event",
  "delete_file",
  "move_email",
  "move_file",
  "post_channel_message",
  "reply_email",
  "send_chat_message",
  "send_email",
  "share_file",
  "update_draft",
  "update_event",
  "update_item",
  "upload_file",
  "upload_to_sharepoint",
]);

export type M365ToolClass = "read" | "write" | "unknown";

/** Classify one MCP tool name. Deny-by-default: unrecognized ⇒ "unknown". */
export function classifyM365Tool(name: string): M365ToolClass {
  if (M365_READ_TOOLS.has(name)) return "read";
  if (M365_WRITE_TOOLS.has(name)) return "write";
  return "unknown";
}

/** The allowlist for a read-only (context-layer) connection. */
export function m365ReadToolAllowlist(): ReadonlySet<string> {
  return M365_READ_TOOLS;
}
