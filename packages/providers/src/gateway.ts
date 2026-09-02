/**
 * Thin client for the TrueFoundry AI Gateway (OpenAI-compatible).
 *
 * Every request carries x-tfy-metadata so the gateway's cost tracking can
 * break spend down by app/tenant/stage — that telemetry feeds the
 * "cost per successful core loop" metric.
 *
 * Nothing here is Donna-specific; stage adapters build on this.
 */

export interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
  tenantId: string;
  appId: string;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export class GatewayClient {
  constructor(private readonly config: GatewayConfig) {}

  private metadataHeaders(stage: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
      "x-tfy-metadata": JSON.stringify({
        app: this.config.appId,
        tenant: this.config.tenantId,
        stage,
      }),
    };
  }

  /** POST a JSON body to an OpenAI-compatible path, e.g. /chat/completions. */
  async postJson<T>(
    path: string,
    body: unknown,
    stage: string,
  ): Promise<T> {
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      method: "POST",
      headers: this.metadataHeaders(stage),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new GatewayError(
        `Gateway ${res.status} on ${path}: ${text.slice(0, 300)}`,
        res.status,
        text,
      );
    }
    return (await res.json()) as T;
  }

  /** POST multipart form data (audio transcription endpoint). */
  async postForm<T>(
    path: string,
    form: FormData,
    stage: string,
  ): Promise<T> {
    const { ["Content-Type"]: _drop, ...headers } =
      this.metadataHeaders(stage);
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new GatewayError(
        `Gateway ${res.status} on ${path}: ${text.slice(0, 300)}`,
        res.status,
        text,
      );
    }
    return (await res.json()) as T;
  }
}

export function gatewayFromEnv(): GatewayClient {
  const status = inspectGatewayEnv();
  const problems = gatewayEnvProblems(status);
  if (problems.length > 0) {
    throw new GatewayPrerequisiteError(problems);
  }
  // inspectGatewayEnv guarantees both are present and non-placeholder here.
  const baseUrl = process.env.TRUEFOUNDRY_BASE_URL!;
  const apiKey = process.env.TRUEFOUNDRY_API_KEY!;
  return new GatewayClient({
    baseUrl,
    apiKey,
    tenantId: process.env.DONNA_TENANT_ID ?? "demo-tenant",
    appId: process.env.DONNA_APP_ID ?? "donna-mvp",
  });
}

/**
 * Prerequisite inspection for the live gateway. Used to fail BEFORE any
 * gateway request with an actionable message. Values are never inspected
 * beyond placeholder classification and never included in errors, reports,
 * or logs.
 */

export type EnvVarStatus = "unset" | "placeholder" | "configured";

export interface GatewayEnvStatus {
  baseUrl: EnvVarStatus;
  apiKey: EnvVarStatus;
}

/** Thrown when gateway credentials are missing or still placeholders. */
export class GatewayPrerequisiteError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `TrueFoundry gateway prerequisites are not met:\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        `\nSet real secret-injected values in the runtime environment ` +
        `(see .env.example). Placeholder values from .env.example do not ` +
        `count as credentials.`,
    );
    this.name = "GatewayPrerequisiteError";
  }
}

/** The slice of the environment the gateway depends on. */
export interface GatewayEnv {
  TRUEFOUNDRY_BASE_URL?: string | undefined;
  TRUEFOUNDRY_API_KEY?: string | undefined;
}

const PLACEHOLDER_PATTERNS = [
  /replace-me/i,
  /your-gateway/i,
  /changeme/i,
  /placeholder/i,
  /^sk-your-/i,
  /example\.(com|org|net)/i,
];

function classifyEnvValue(value: string | undefined): EnvVarStatus {
  if (value === undefined || value.trim() === "") return "unset";
  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value))) {
    return "placeholder";
  }
  return "configured";
}

/** Classify the gateway env without exposing any value. */
export function inspectGatewayEnv(
  env: GatewayEnv = process.env,
): GatewayEnvStatus {
  return {
    baseUrl: classifyEnvValue(env.TRUEFOUNDRY_BASE_URL),
    apiKey: classifyEnvValue(env.TRUEFOUNDRY_API_KEY),
  };
}

/** Human-actionable problem list; contains variable names only, never values. */
export function gatewayEnvProblems(status: GatewayEnvStatus): string[] {
  const problems: string[] = [];
  if (status.baseUrl === "unset") {
    problems.push("TRUEFOUNDRY_BASE_URL is not set");
  } else if (status.baseUrl === "placeholder") {
    problems.push(
      "TRUEFOUNDRY_BASE_URL still holds the .env.example placeholder",
    );
  }
  if (status.apiKey === "unset") {
    problems.push("TRUEFOUNDRY_API_KEY is not set");
  } else if (status.apiKey === "placeholder") {
    problems.push(
      "TRUEFOUNDRY_API_KEY still holds the .env.example placeholder",
    );
  }
  return problems;
}
