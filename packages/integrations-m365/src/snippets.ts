/**
 * Normalization of MCP tool results into minimal ContextSnippet records
 * (Specification 5.2).
 *
 * Every snippet is UNTRUSTED content (SR-1): normalized excerpts are data
 * for the trust-separated context packet, never instructions. Excerpts are
 * minimized (SR-3): a bounded preview plus identifiers — never a full
 * document, body, or message history.
 */
import { sha256Hex } from "@donna/core";
import type {
  ContextSnippet,
  M365ConsentPurpose,
  M365ResourceType,
} from "@donna/core";

/** Default excerpt cap in characters (SR-3). */
export const DEFAULT_EXCERPT_CHARS = 280;

// Generic MCP result parsing lives in core (mcp.ts); re-exported here so
// existing imports keep working.
export { mcpItems, mcpJsonContent, mcpTextContent } from "@donna/core";

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Graph {dateTime, timeZone} or plain ISO string → canonical ISO 8601.
 * Graph dateTimes often carry no zone suffix; re-parsing normalizes them
 * so window comparisons are reliable. Unparseable values fail closed.
 */
function graphTime(value: unknown): string | undefined {
  const direct = asString(value) ?? asString(asRecord(value)["dateTime"]);
  if (direct === undefined) return undefined;
  const parsed = new Date(direct);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** Graph {emailAddress: {name, address}} or plain string → display string. */
function graphParty(value: unknown): string | undefined {
  const direct = asString(value);
  if (direct !== undefined) return direct;
  const record = asRecord(value);
  const email = asRecord(record["emailAddress"]);
  return asString(email["name"]) ?? asString(email["address"]);
}

function cap(text: string, chars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > chars
    ? `${collapsed.slice(0, chars - 1)}…`
    : collapsed;
}

/** Deterministic snippet ID per resource + tool (stable across refetches). */
export function m365SnippetId(resourceType: M365ResourceType, resourceId: string): string {
  return `m365-${resourceType}-${sha256Hex(resourceId).slice(0, 16)}`;
}

export interface SnippetContext {
  tenantId: string;
  userId: string;
  consentPurpose: M365ConsentPurpose;
  tool: string;
  fetchedAt: string;
  expiresAt: string;
  excerptChars: number;
}

interface NormalizedFields {
  resourceId: string;
  excerpt: string;
  uri?: string;
  owner?: string;
  sourceTimestamp?: string;
}

function buildSnippet(
  resourceType: M365ResourceType,
  fields: NormalizedFields,
  ctx: SnippetContext,
): ContextSnippet {
  return {
    id: m365SnippetId(resourceType, fields.resourceId),
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    source: {
      kind: "m365",
      resourceType,
      resourceId: fields.resourceId,
      ...(fields.uri !== undefined ? { uri: fields.uri } : {}),
      ...(fields.owner !== undefined ? { owner: fields.owner } : {}),
      tool: ctx.tool,
    },
    consentPurpose: ctx.consentPurpose,
    excerpt: cap(fields.excerpt, ctx.excerptChars),
    ...(fields.sourceTimestamp !== undefined
      ? { sourceTimestamp: fields.sourceTimestamp }
      : {}),
    fetchedAt: ctx.fetchedAt,
    expiresAt: ctx.expiresAt,
  };
}

/** Calendar event → snippet (attendee/agenda context for AC-1). */
export function normalizeCalendarEvent(
  raw: unknown,
  ctx: SnippetContext,
): ContextSnippet | undefined {
  const event = asRecord(raw);
  const id = asString(event["id"]);
  if (id === undefined) return undefined;
  const subject = asString(event["subject"]) ?? "(untitled meeting)";
  const start = graphTime(event["start"]);
  const end = graphTime(event["end"]);
  const organizer = graphParty(event["organizer"]);
  const attendees = Array.isArray(event["attendees"]) ? event["attendees"].length : 0;
  const location =
    asString(asRecord(event["location"])["displayName"]) ??
    (event["onlineMeeting"] != null ? "online" : undefined);
  const preview = asString(event["bodyPreview"]);
  const parts = [
    `Meeting "${subject}"`,
    start !== undefined ? `starts ${start}` : undefined,
    end !== undefined ? `ends ${end}` : undefined,
    organizer !== undefined ? `organizer ${organizer}` : undefined,
    attendees > 0 ? `${attendees} attendee(s)` : undefined,
    location !== undefined ? `at ${location}` : undefined,
    preview !== undefined ? `agenda: ${preview}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return buildSnippet(
    "calendar-event",
    {
      resourceId: id,
      excerpt: parts.join("; "),
      ...(asString(event["webLink"]) !== undefined
        ? { uri: asString(event["webLink"])! }
        : {}),
      ...(organizer !== undefined ? { owner: organizer } : {}),
      ...(start !== undefined ? { sourceTimestamp: start } : {}),
    },
    ctx,
  );
}

/** Email message → snippet. */
export function normalizeEmail(
  raw: unknown,
  ctx: SnippetContext,
): ContextSnippet | undefined {
  const mail = asRecord(raw);
  const id = asString(mail["id"]);
  if (id === undefined) return undefined;
  const subject = asString(mail["subject"]) ?? "(no subject)";
  const from = graphParty(mail["from"]);
  const received =
    asString(mail["receivedDateTime"]) ?? asString(mail["sentDateTime"]);
  const preview = asString(mail["bodyPreview"]);
  const parts = [
    `Email "${subject}"`,
    from !== undefined ? `from ${from}` : undefined,
    received !== undefined ? `received ${received}` : undefined,
    preview !== undefined ? `preview: ${preview}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return buildSnippet(
    "email",
    {
      resourceId: id,
      excerpt: parts.join("; "),
      ...(asString(mail["webLink"]) !== undefined
        ? { uri: asString(mail["webLink"])! }
        : {}),
      ...(from !== undefined ? { owner: from } : {}),
      ...(received !== undefined ? { sourceTimestamp: received } : {}),
    },
    ctx,
  );
}

/** Teams chat/channel message → snippet. */
export function normalizeTeamsMessage(
  raw: unknown,
  ctx: SnippetContext,
): ContextSnippet | undefined {
  const message = asRecord(raw);
  const id = asString(message["id"]);
  if (id === undefined) return undefined;
  const from =
    graphParty(message["from"]) ??
    graphParty(asRecord(message["from"])["user"]) ??
    graphParty(asRecord(message["from"])["application"]);
  const created = asString(message["createdDateTime"]);
  const body =
    asString(asRecord(message["body"])["content"])?.replace(/<[^>]*>/g, " ") ??
    asString(message["bodyPreview"]);
  const parts = [
    "Teams message",
    from !== undefined ? `from ${from}` : undefined,
    created !== undefined ? `at ${created}` : undefined,
    body !== undefined ? `says: ${body}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return buildSnippet(
    "teams-message",
    {
      resourceId: id,
      excerpt: parts.join("; "),
      ...(asString(message["webUrl"]) !== undefined
        ? { uri: asString(message["webUrl"])! }
        : {}),
      ...(from !== undefined ? { owner: from } : {}),
      ...(created !== undefined ? { sourceTimestamp: created } : {}),
    },
    ctx,
  );
}

/** OneDrive file metadata → snippet (metadata only — never file content). */
export function normalizeFile(
  raw: unknown,
  ctx: SnippetContext,
): ContextSnippet | undefined {
  const file = asRecord(raw);
  const id = asString(file["id"]);
  if (id === undefined) return undefined;
  const name = asString(file["name"]) ?? "(unnamed)";
  const modified = asString(file["lastModifiedDateTime"]);
  const size = typeof file["size"] === "number" ? file["size"] : undefined;
  const parts = [
    `File "${name}"`,
    modified !== undefined ? `modified ${modified}` : undefined,
    size !== undefined ? `${size} bytes` : undefined,
  ].filter((part): part is string => part !== undefined);
  const owner =
    graphParty(asRecord(file["createdBy"])["user"]) ??
    graphParty(asRecord(file["lastModifiedBy"])["user"]);
  return buildSnippet(
    "file",
    {
      resourceId: id,
      excerpt: parts.join("; "),
      ...(asString(file["webUrl"]) !== undefined
        ? { uri: asString(file["webUrl"])! }
        : {}),
      ...(owner !== undefined ? { owner } : {}),
      ...(modified !== undefined ? { sourceTimestamp: modified } : {}),
    },
    ctx,
  );
}

/** SharePoint list item → snippet. */
export function normalizeSharePointItem(
  raw: unknown,
  ctx: SnippetContext,
): ContextSnippet | undefined {
  const item = asRecord(raw);
  const id = asString(item["id"]);
  if (id === undefined) return undefined;
  const fields = asRecord(item["fields"]);
  const title =
    asString(fields["Title"]) ?? asString(fields["title"]) ?? "(untitled item)";
  const modified = asString(item["lastModifiedDateTime"]);
  const parts = [
    `SharePoint item "${title}"`,
    modified !== undefined ? `modified ${modified}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return buildSnippet(
    "sharepoint-item",
    {
      resourceId: id,
      excerpt: parts.join("; "),
      ...(asString(item["webUrl"]) !== undefined
        ? { uri: asString(item["webUrl"])! }
        : {}),
      ...(modified !== undefined ? { sourceTimestamp: modified } : {}),
    },
    ctx,
  );
}
