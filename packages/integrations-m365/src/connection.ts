/**
 * Connection health, consent gating, and disconnect for the managed
 * Microsoft 365 MCP (Specification 5.1).
 *
 * Stage-level health reporting (FR-3): endpoint configuration, gateway
 * authentication, MCP initialize, tool discovery, and one read-only probe
 * are reported individually with redacted detail — counts, hosts, and
 * classification tokens only, never credentials or Microsoft content
 * (SR-1, AC-4). The read probe discards content; only a count leaves it.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  M365_CONSENT_PURPOSES,
  type M365ConsentPurpose,
} from "@donna/core";
import {
  M365McpClient,
  M365McpError,
  parseM365Endpoint,
  type M365ConnectionStage,
} from "./mcp-client.js";
import { classifyM365Tool } from "./tools.js";

/**
 * The managed MCP endpoint Donna pilots against (verified live
 * 2026-09-03). Overridable via DONNA_M365_MCP_URL for environment moves;
 * https is mandatory and credentials in the URL are rejected (SR-2).
 */
export const DEFAULT_M365_MCP_ENDPOINT =
  "https://eu.gateway.truefoundry.ai/payoneer-corp/mcp/microsoft-365/server";

/**
 * Identity model for the pilot: every MCP call runs under the Microsoft
 * authorization of the account that connected the MCP in TrueFoundry (the
 * connector owner) until per-user OAuth is exercised per volunteer.
 */
export const M365_IDENTITY_NOTE =
  "Pilot identity: MCP calls run under the connector owner's Microsoft " +
  "identity (the account that connected the MCP in TrueFoundry). " +
  "TrueFoundry owns the Entra app, OAuth configuration, token storage, " +
  "and refresh; Donna never registers an Entra app and never handles " +
  "Microsoft tokens.";

export type M365EnvVarStatus = "unset" | "placeholder" | "configured";

const PLACEHOLDER_PATTERNS = [
  /replace-me/i,
  /your-gateway/i,
  /changeme/i,
  /placeholder/i,
  /^sk-your-/i,
  /example\.(com|org|net)/i,
];

/** Classify a secret-holding env var without exposing its value. */
export function classifySecretEnv(value: string | undefined): M365EnvVarStatus {
  if (value === undefined || value.trim() === "") return "unset";
  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value))) {
    return "placeholder";
  }
  return "configured";
}

export interface M365McpEnvStatus {
  endpoint: "default" | "override";
  endpointOk: boolean;
  apiKey: M365EnvVarStatus;
}

/** Inspect the M365 MCP environment. Values never leave this function. */
export function inspectM365McpEnv(
  env: { DONNA_M365_MCP_URL?: string | undefined; TRUEFOUNDRY_API_KEY?: string | undefined } = process.env,
): M365McpEnvStatus {
  const endpoint = env.DONNA_M365_MCP_URL;
  let endpointOk = true;
  if (endpoint !== undefined && endpoint.trim() !== "") {
    try {
      parseM365Endpoint(endpoint);
    } catch {
      endpointOk = false;
    }
  }
  return {
    endpoint: endpoint !== undefined && endpoint.trim() !== "" ? "override" : "default",
    endpointOk,
    apiKey: classifySecretEnv(env.TRUEFOUNDRY_API_KEY),
  };
}

/** Human-actionable problems; variable names only, never values. */
export function m365McpEnvProblems(status: M365McpEnvStatus): string[] {
  const problems: string[] = [];
  if (!status.endpointOk) {
    problems.push("DONNA_M365_MCP_URL is not a valid https URL");
  }
  if (status.apiKey === "unset") {
    problems.push("TRUEFOUNDRY_API_KEY is not set");
  } else if (status.apiKey === "placeholder") {
    problems.push("TRUEFOUNDRY_API_KEY still holds the .env.example placeholder");
  }
  return problems;
}

export function m365EndpointFromEnv(
  env: { DONNA_M365_MCP_URL?: string | undefined } = process.env,
): string {
  const override = env.DONNA_M365_MCP_URL;
  return override !== undefined && override.trim() !== ""
    ? override
    : DEFAULT_M365_MCP_ENDPOINT;
}

/* --------------------------- status probe --------------------------- */

export interface M365StageResult {
  stage: M365ConnectionStage | "read-probe";
  ok: boolean;
  /** Redacted detail: counts, host, classification tokens only. */
  detail: string;
}

export interface M365StatusReport {
  ok: boolean;
  endpointHost: string;
  stages: M365StageResult[];
  serverName?: string;
  tools?: { total: number; read: number; write: number; unknown: number };
  /** Result count of the read probe (content discarded), when it ran. */
  probeItemCount?: number;
}

export interface M365StatusDeps {
  env?: { DONNA_M365_MCP_URL?: string | undefined; TRUEFOUNDRY_API_KEY?: string | undefined };
  fetchImpl?: typeof fetch;
  /** Read tool used as the probe (default list_calendars). */
  probeTool?: string;
  timeoutMs?: number;
}

/**
 * Count items in a successful MCP tool result without surfacing content.
 * Returns undefined when the shape is not a recognizable list.
 */
function countResultItems(content: unknown): number | undefined {
  if (!Array.isArray(content)) return undefined;
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (first?.type !== "text" || typeof first.text !== "string") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(first.text);
    if (Array.isArray(parsed)) return parsed.length;
    if (parsed !== null && typeof parsed === "object") {
      for (const value of Object.values(parsed)) {
        if (Array.isArray(value)) return value.length;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * End-to-end connection health: endpoint config → gateway credential
 * preflight → MCP initialize → tool discovery → one read-only probe.
 * Fails closed at the first broken stage; later stages are reported as
 * skipped. No Microsoft content is retained anywhere in the report.
 */
export async function checkM365Connection(
  deps: M365StatusDeps = {},
): Promise<M365StatusReport> {
  const env = deps.env ?? process.env;
  const endpointUrl = m365EndpointFromEnv(env);
  const stages: M365StageResult[] = [];
  const fail = (
    stage: M365StageResult["stage"],
    detail: string,
  ): M365StatusReport => {
    stages.push({ stage, ok: false, detail });
    for (const later of ["gateway-auth", "mcp-initialize", "tool-discovery", "read-probe"] as const) {
      if (!stages.some((s) => s.stage === later)) {
        stages.push({ stage: later, ok: false, detail: "skipped (earlier stage failed)" });
      }
    }
    let host = "unresolved";
    try {
      host = parseM365Endpoint(endpointUrl).host;
    } catch {
      // host stays "unresolved"
    }
    return { ok: false, endpointHost: host, stages };
  };

  // Stage 1: endpoint configuration (SR-2).
  let endpointHost: string;
  try {
    endpointHost = parseM365Endpoint(endpointUrl).host;
  } catch (error) {
    return fail(
      "endpoint-config",
      error instanceof M365McpError ? error.message : "invalid endpoint",
    );
  }
  stages.push({ stage: "endpoint-config", ok: true, detail: endpointHost });

  // Stage 2: gateway credential preflight (names only, never values).
  const envStatus = inspectM365McpEnv(env);
  const problems = m365McpEnvProblems(envStatus).filter((p) =>
    p.startsWith("TRUEFOUNDRY_API_KEY"),
  );
  if (problems.length > 0) {
    return { ...fail("gateway-auth", problems.join("; ")), endpointHost };
  }
  stages.push({ stage: "gateway-auth", ok: true, detail: "credential configured" });

  const client = new M365McpClient({
    endpointUrl,
    apiKey: env.TRUEFOUNDRY_API_KEY!,
    allowedTools: new Set([deps.probeTool ?? "list_calendars"]),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
  });

  // Stage 3: MCP initialize.
  let serverName: string;
  try {
    ({ serverName } = await client.initialize());
  } catch (error) {
    if (error instanceof M365McpError) {
      return { ...fail(error.stage, error.message), endpointHost };
    }
    return { ...fail("mcp-initialize", "initialize failed"), endpointHost };
  }
  stages.push({ stage: "mcp-initialize", ok: true, detail: `server ${serverName}` });

  // Stage 4: tool discovery.
  let tools: M365StatusReport["tools"];
  try {
    const descriptors = await client.listTools();
    const counts = { total: descriptors.length, read: 0, write: 0, unknown: 0 };
    for (const descriptor of descriptors) {
      counts[classifyM365Tool(descriptor.name)] += 1;
    }
    tools = counts;
  } catch (error) {
    if (error instanceof M365McpError) {
      return { ...fail(error.stage, error.message), endpointHost, serverName };
    }
    return { ...fail("tool-discovery", "tools/list failed"), endpointHost, serverName };
  }
  stages.push({
    stage: "tool-discovery",
    ok: true,
    detail: `${tools!.total} tools (${tools!.read} read, ${tools!.write} write, ${tools!.unknown} unknown)`,
  });

  // Stage 5: one read-only probe; content is discarded, only a count is kept.
  const probeTool = deps.probeTool ?? "list_calendars";
  try {
    const result = await client.callTool(probeTool, {});
    if (result.isError) {
      // Tool-side errors may embed Microsoft content — classify, never echo.
      return {
        ...fail(
          "read-probe",
          `${probeTool} returned an error result (detail redacted — check the ` +
            `connector's Microsoft authorization in TrueFoundry)`,
        ),
        endpointHost,
        serverName,
        tools,
      };
    }
    const probeItemCount = countResultItems(result.content);
    stages.push({
      stage: "read-probe",
      ok: true,
      detail:
        probeItemCount !== undefined
          ? `${probeTool} ok (${probeItemCount} item(s), content discarded)`
          : `${probeTool} ok (content discarded)`,
    });
    return {
      ok: true,
      endpointHost,
      stages,
      serverName,
      tools,
      ...(probeItemCount !== undefined ? { probeItemCount } : {}),
    };
  } catch (error) {
    if (error instanceof M365McpError) {
      return { ...fail(error.stage, error.message), endpointHost, serverName, tools };
    }
    return { ...fail("read-probe", "probe failed"), endpointHost, serverName, tools };
  }
}

/* --------------------------- consent gating -------------------------- */

/**
 * The slice of the consent service the integration needs. The existing
 * MemoryService satisfies it structurally.
 */
export interface M365ConsentGate {
  hasConsent(
    scope: { tenantId: string; userId: string },
    purpose: string,
  ): Promise<boolean>;
  revokeConsent(
    scope: { tenantId: string; userId: string },
    purpose: string,
    channel?: string,
  ): Promise<void>;
}

/** Raised when an M365 read/write is attempted without an active grant. */
export class M365ConsentError extends Error {
  constructor(readonly purpose: string) {
    super(
      `No active Donna-side consent for "${purpose}". ` +
        `Grant it explicitly (donna consent grant ${purpose}); ` +
        `Microsoft-side OAuth consent does not imply Donna consent.`,
    );
    this.name = "M365ConsentError";
  }
}

/**
 * Fail-closed consent gate (FR-1/FR-2): every M365 read or destination
 * path calls this BEFORE any MCP request. Revocation takes effect on the
 * very next call because the store is append-only latest-wins.
 */
export async function requireM365Consent(
  gate: M365ConsentGate,
  scope: { tenantId: string; userId: string },
  purpose: M365ConsentPurpose,
): Promise<void> {
  if (!(await gate.hasConsent(scope, purpose))) {
    throw new M365ConsentError(purpose);
  }
}

/* ----------------------------- disconnect ---------------------------- */

/** Reject partition IDs that could traverse the data directory. */
export function assertM365PartitionId(kind: "tenant" | "user", id: string): void {
  if (
    id.length === 0 ||
    id.includes("/") ||
    id.includes("\\") ||
    id === "." ||
    id === ".."
  ) {
    throw new Error(`Invalid ${kind} ID for the M365 cache partition`);
  }
}

/** Per-scope directory for M365 cached state (snippets land here in 5.2). */
export function m365ScopeDir(
  dataDir: string,
  scope: { tenantId: string; userId: string },
): string {
  assertM365PartitionId("tenant", scope.tenantId);
  assertM365PartitionId("user", scope.userId);
  return join(dataDir, "m365", scope.tenantId, scope.userId);
}

export interface M365DisconnectResult {
  /** Consent purposes that had an active grant and were revoked. */
  revokedPurposes: M365ConsentPurpose[];
  /** True when a cached-snippet partition existed and was removed. */
  purgedCache: boolean;
}

/**
 * Disconnect (Specification 5.1): Donna stops calling the MCP — every
 * m365.* consent grant is revoked so all read/destination paths fail
 * closed on their consent gate — and the scoped cached-snippet partition
 * is purged. Append-only consent history is preserved. Idempotent.
 */
export async function disconnectM365(
  gate: M365ConsentGate,
  scope: { tenantId: string; userId: string },
  dataDir: string,
  channel = "cli:m365 disconnect",
): Promise<M365DisconnectResult> {
  const revokedPurposes: M365ConsentPurpose[] = [];
  for (const purpose of M365_CONSENT_PURPOSES) {
    if (await gate.hasConsent(scope, purpose)) {
      await gate.revokeConsent(scope, purpose, channel);
      revokedPurposes.push(purpose);
    }
  }
  const scopeDir = m365ScopeDir(dataDir, scope);
  let purgedCache = false;
  try {
    await rm(scopeDir, { recursive: true });
    purgedCache = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  return { revokedPurposes, purgedCache };
}
