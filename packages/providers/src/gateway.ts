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
  const baseUrl = process.env.TRUEFOUNDRY_BASE_URL;
  const apiKey = process.env.TRUEFOUNDRY_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error(
      "TRUEFOUNDRY_BASE_URL and TRUEFOUNDRY_API_KEY must be set (see .env.example)",
    );
  }
  return new GatewayClient({
    baseUrl,
    apiKey,
    tenantId: process.env.DONNA_TENANT_ID ?? "demo-tenant",
    appId: process.env.DONNA_APP_ID ?? "donna-mvp",
  });
}
