/**
 * Generic helpers for reading MCP tool results (the `McpToolResult`
 * envelope from ports.ts). Transport-shaped, integration-agnostic:
 * extract the first text item, parse it as JSON when possible, unwrap
 * Graph-style list payloads. Results are always untrusted content (SR-4)
 * — these helpers shape data, never interpret it as instructions.
 */

/** Extract the first text content item of an MCP tool result. */
export function mcpTextContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  return first?.type === "text" && typeof first.text === "string"
    ? first.text
    : undefined;
}

/** Parse the JSON payload of an MCP tool result, when it is JSON. */
export function mcpJsonContent(content: unknown): unknown {
  const text = mcpTextContent(content);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Unwrap a Graph-style payload: array, { value: [...] }, or first array prop. */
export function mcpItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload !== null && typeof payload === "object") {
    for (const value of Object.values(payload)) {
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}
