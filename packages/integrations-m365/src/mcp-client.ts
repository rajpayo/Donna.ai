/**
 * JSON-RPC-over-HTTP client for the TrueFoundry-managed Microsoft 365 MCP
 * (Specification 5.1).
 *
 * Protocol (verified live 2026-09-03): every call is one POST carrying a
 * single JSON-RPC 2.0 request. Requests need `Content-Type:
 * application/json` and `Accept: application/json, text/event-stream`;
 * responses arrive as an event stream whose `data: ` line holds the
 * JSON-RPC response (a plain JSON body is also accepted defensively).
 * Authentication is the existing TrueFoundry gateway credential as a
 * Bearer token — Donna never sees a Microsoft token.
 *
 * Security posture:
 *   - SR-1: the credential lives only in the Authorization header. Error
 *     messages carry stage + HTTP status + JSON-RPC code, never bodies,
 *     arguments, or credential material.
 *   - SR-2: the endpoint must be https, pinned to the configured host;
 *     credentials in the URL are rejected.
 *   - SR-3: the client-side allowlist is enforced BEFORE any request is
 *     made — a read-only connection cannot emit a write-tool call.
 *   - SR-4: tool results are returned as opaque untrusted content.
 */
import type {
  McpConnection,
  McpToolDescriptor,
  McpToolResult,
} from "@donna/core";
import { m365ReadToolAllowlist } from "./tools.js";

/** Where in the connection lifecycle a failure occurred. */
export type M365ConnectionStage =
  | "endpoint-config"
  | "gateway-auth"
  | "mcp-initialize"
  | "tool-discovery"
  | "tool-call";

/**
 * Stage-level connection failure. `message` is redacted by construction:
 * it is assembled from the stage, an HTTP status, or a JSON-RPC error
 * code — never from response bodies, request arguments, or credentials.
 */
export class M365McpError extends Error {
  constructor(
    readonly stage: M365ConnectionStage,
    message: string,
    readonly httpStatus?: number,
    readonly rpcCode?: number,
  ) {
    super(message);
    this.name = "M365McpError";
  }
}

/**
 * Client-side allowlist denial (SR-3). Raised before any network I/O when
 * a tool is not on this connection's allowlist — e.g. a write/draft tool
 * on a read-only context connection.
 */
export class M365ToolDeniedError extends Error {
  constructor(readonly tool: string) {
    super(
      `MCP tool "${tool}" is not on this connection's allowlist. ` +
        `Write/draft tools are reachable only through the approval path.`,
    );
    this.name = "M365ToolDeniedError";
  }
}

export interface M365McpClientConfig {
  /** https URL of the managed MCP server (pinned; credentials rejected). */
  endpointUrl: string;
  /** TrueFoundry gateway credential (Bearer). Never logged. */
  apiKey: string;
  /** Tools this connection may invoke. Deny-by-default. */
  allowedTools: ReadonlySet<string>;
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (default 30s). */
  timeoutMs?: number;
}

/** Parse and pin the endpoint URL (SR-2). Throws M365McpError on violation. */
export function parseM365Endpoint(endpointUrl: string): URL {
  let url: URL;
  try {
    url = new URL(endpointUrl);
  } catch {
    throw new M365McpError(
      "endpoint-config",
      "MCP endpoint is not a valid URL",
    );
  }
  if (url.protocol !== "https:") {
    throw new M365McpError(
      "endpoint-config",
      "MCP endpoint must use https (TLS validation is mandatory)",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new M365McpError(
      "endpoint-config",
      "MCP endpoint must not carry credentials in the URL",
    );
  }
  return url;
}

/** Extract the JSON-RPC response from an event-stream (or plain JSON) body. */
export function parseMcpResponseBody(body: string): unknown {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ")) {
      return JSON.parse(line.slice("data: ".length));
    }
  }
  throw new M365McpError(
    "tool-call",
    "MCP response carried no parseable data line",
  );
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message?: string };
}

/**
 * The governed connection to the managed MCP. One client instance is one
 * allowlist domain: build read-only connections for the context layer and
 * narrowly-scoped ones for the approval path.
 */
export class M365McpClient implements McpConnection {
  private readonly endpoint: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private nextId = 1;

  constructor(private readonly config: M365McpClientConfig) {
    this.endpoint = parseM365Endpoint(config.endpointUrl);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  /** Host the client is pinned to (safe for logs/reports). */
  get endpointHost(): string {
    return this.endpoint.host;
  }

  async initialize(): Promise<{ serverName: string }> {
    const result = await this.rpc("mcp-initialize", "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "donna-mvp", version: "0.1.0" },
    });
    const serverInfo = (result as { serverInfo?: { name?: unknown } } | null)
      ?.serverInfo;
    const serverName =
      serverInfo !== undefined && typeof serverInfo.name === "string"
        ? serverInfo.name
        : "unknown";
    return { serverName };
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = await this.rpc("tool-discovery", "tools/list", {});
    const tools = (result as { tools?: unknown } | null)?.tools;
    if (!Array.isArray(tools)) {
      throw new M365McpError(
        "tool-discovery",
        "MCP tools/list returned no tool array",
      );
    }
    return tools.map((tool) => ({
      name: String((tool as { name?: unknown }).name ?? ""),
      ...(((tool as { description?: unknown }).description ?? undefined) !==
      undefined
        ? { description: String((tool as { description?: unknown }).description) }
        : {}),
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<McpToolResult> {
    // SR-3: allowlist enforcement happens before ANY network I/O.
    if (!this.config.allowedTools.has(name)) {
      throw new M365ToolDeniedError(name);
    }
    const result = await this.rpc("tool-call", "tools/call", {
      name,
      arguments: args,
    });
    const envelope = result as {
      content?: unknown;
      isError?: unknown;
    } | null;
    return {
      isError: envelope?.isError === true,
      content: envelope?.content ?? envelope,
    };
  }

  private async rpc(
    stage: M365ConnectionStage,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = this.nextId++;
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Network/TLS failure — never include the underlying message, which
      // may embed the URL (and on misconfiguration, credentials).
      throw new M365McpError(
        stage,
        `MCP ${method} failed at the network/TLS layer`,
      );
    }
    if (!res.ok) {
      // 401/403 mean the gateway credential was rejected regardless of
      // which RPC stage observed it.
      const effectiveStage =
        res.status === 401 || res.status === 403 ? "gateway-auth" : stage;
      // Drain the body without reading it into any message.
      await res.arrayBuffer().catch(() => undefined);
      throw new M365McpError(
        effectiveStage,
        `MCP ${method} returned HTTP ${res.status}`,
        res.status,
      );
    }
    const body = await res.text();
    let parsed: JsonRpcResponse;
    try {
      parsed = parseMcpResponseBody(body) as JsonRpcResponse;
    } catch (error) {
      if (error instanceof M365McpError) throw error;
      throw new M365McpError(stage, `MCP ${method} returned unparseable data`);
    }
    if (parsed.error !== undefined) {
      // JSON-RPC error code only — the server message may embed content.
      throw new M365McpError(
        stage,
        `MCP ${method} returned JSON-RPC error code ${parsed.error.code}`,
        undefined,
        parsed.error.code,
      );
    }
    return parsed.result;
  }
}

/** Build a read-only context-layer connection (SR-3). */
export function m365ReadOnlyClient(
  config: Omit<M365McpClientConfig, "allowedTools">,
): M365McpClient {
  return new M365McpClient({
    ...config,
    allowedTools: m365ReadToolAllowlist(),
  });
}

/** Build an approval-path connection allowlisted to exactly `tools`. */
export function m365ApprovalPathClient(
  config: Omit<M365McpClientConfig, "allowedTools">,
  tools: readonly string[],
): M365McpClient {
  return new M365McpClient({ ...config, allowedTools: new Set(tools) });
}
