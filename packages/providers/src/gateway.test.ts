import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GatewayClient,
  GatewayPrerequisiteError,
  gatewayEnvProblems,
  gatewayFromEnv,
  inspectGatewayEnv,
} from "./gateway.js";

describe("GatewayClient request timeout", () => {
  it("rejects a hung request instead of waiting forever", async () => {
    const client = new GatewayClient({
      baseUrl: "https://gateway.example",
      apiKey: "test-key",
      tenantId: "t",
      appId: "a",
      timeoutMs: 50,
    });
    const originalFetch = globalThis.fetch;
    // AbortSignal.timeout() deliberately uses an unref'ed timer in Node.
    // Keep this isolated fake-fetch test alive long enough for that timer
    // on Linux CI; a real undici request owns its own active socket handle.
    const keepAlive = setTimeout(() => undefined, 500);
    globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted", "AbortError")),
        );
      })) as typeof fetch;
    try {
      await assert.rejects(
        () => client.postJson("/chat/completions", {}, "test"),
        /abort/i,
      );
    } finally {
      clearTimeout(keepAlive);
      globalThis.fetch = originalFetch;
    }
  });
});

describe("inspectGatewayEnv", () => {
  it("classifies unset variables", () => {
    const status = inspectGatewayEnv({});
    assert.equal(status.baseUrl, "unset");
    assert.equal(status.apiKey, "unset");
  });

  it("classifies empty and whitespace values as unset", () => {
    const status = inspectGatewayEnv({
      TRUEFOUNDRY_BASE_URL: "   ",
      TRUEFOUNDRY_API_KEY: "",
    });
    assert.equal(status.baseUrl, "unset");
    assert.equal(status.apiKey, "unset");
  });

  it("classifies .env.example placeholders", () => {
    const status = inspectGatewayEnv({
      TRUEFOUNDRY_BASE_URL: "https://your-gateway.truefoundry.cloud/api/llm",
      TRUEFOUNDRY_API_KEY: "replace-me",
    });
    assert.equal(status.baseUrl, "placeholder");
    assert.equal(status.apiKey, "placeholder");
  });

  it("classifies real-looking values as configured", () => {
    const status = inspectGatewayEnv({
      TRUEFOUNDRY_BASE_URL: "https://gateway.internal.example.co/api/llm",
      TRUEFOUNDRY_API_KEY: "tfy-live-9f8e7d6c5b",
    });
    assert.equal(status.baseUrl, "configured");
    assert.equal(status.apiKey, "configured");
  });
});

describe("gatewayEnvProblems", () => {
  it("names each missing variable without values", () => {
    const problems = gatewayEnvProblems({
      baseUrl: "unset",
      apiKey: "placeholder",
    });
    assert.equal(problems.length, 2);
    assert.match(problems[0]!, /TRUEFOUNDRY_BASE_URL is not set/);
    assert.match(problems[1]!, /placeholder/);
  });

  it("is empty when both are configured", () => {
    assert.deepEqual(
      gatewayEnvProblems({ baseUrl: "configured", apiKey: "configured" }),
      [],
    );
  });
});

describe("gatewayFromEnv", () => {
  const CANARY_KEY = "tfy-canary-secret-value-12345";
  const CANARY_URL = "https://canary-host.internal.example.co/api/llm";
  let saved: Record<string, string | undefined>;

  function saveEnv(): void {
    saved = {
      TRUEFOUNDRY_BASE_URL: process.env.TRUEFOUNDRY_BASE_URL,
      TRUEFOUNDRY_API_KEY: process.env.TRUEFOUNDRY_API_KEY,
    };
  }
  function restoreEnv(): void {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  it("throws a redacted, actionable error when unset", () => {
    saveEnv();
    try {
      delete process.env.TRUEFOUNDRY_BASE_URL;
      delete process.env.TRUEFOUNDRY_API_KEY;
      assert.throws(
        () => gatewayFromEnv(),
        (err: unknown) => {
          assert.ok(err instanceof GatewayPrerequisiteError);
          assert.match(err.message, /TRUEFOUNDRY_BASE_URL is not set/);
          assert.match(err.message, /TRUEFOUNDRY_API_KEY is not set/);
          return true;
        },
      );
    } finally {
      restoreEnv();
    }
  });

  it("rejects placeholder credentials before any request", () => {
    saveEnv();
    try {
      process.env.TRUEFOUNDRY_BASE_URL =
        "https://your-gateway.truefoundry.cloud/api/llm";
      process.env.TRUEFOUNDRY_API_KEY = "replace-me";
      assert.throws(() => gatewayFromEnv(), GatewayPrerequisiteError);
    } finally {
      restoreEnv();
    }
  });

  it("never leaks credential values into the error", () => {
    saveEnv();
    try {
      process.env.TRUEFOUNDRY_BASE_URL = CANARY_URL;
      // Configured URL but placeholder key → error must not echo either value.
      process.env.TRUEFOUNDRY_API_KEY = "replace-me";
      assert.throws(
        () => gatewayFromEnv(),
        (err: unknown) => {
          const message = (err as Error).message;
          assert.ok(!message.includes(CANARY_KEY));
          assert.ok(!message.includes(CANARY_URL));
          assert.ok(!message.includes("canary-host"));
          return true;
        },
      );
    } finally {
      restoreEnv();
    }
  });

  it("builds a client when both values are configured", () => {
    saveEnv();
    try {
      process.env.TRUEFOUNDRY_BASE_URL = CANARY_URL;
      process.env.TRUEFOUNDRY_API_KEY = CANARY_KEY;
      const client = gatewayFromEnv();
      assert.ok(client);
    } finally {
      restoreEnv();
    }
  });
});
