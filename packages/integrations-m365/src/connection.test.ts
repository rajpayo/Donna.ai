/**
 * Specification 5.1 — connection health, consent gating, and disconnect.
 *
 * Consent tests run against the real FileConsentStore through the real
 * MemoryService (AC-2) in a temp data dir. MCP traffic is scripted — no
 * network, no credentials, no Microsoft content.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { M365_CONSENT_PURPOSES } from "@donna/core";
import { FileConsentStore, FileMemoryStore, MemoryService } from "@donna/memory";
import {
  checkM365Connection,
  classifySecretEnv,
  disconnectM365,
  inspectM365McpEnv,
  m365EndpointFromEnv,
  m365McpEnvProblems,
  m365ScopeDir,
  M365ConsentError,
  requireM365Consent,
  DEFAULT_M365_MCP_ENDPOINT,
} from "./connection.js";
import { M365_READ_TOOLS, M365_WRITE_TOOLS } from "./tools.js";

const ENDPOINT = "https://gateway.test/tenant/mcp/microsoft-365/server";
const API_KEY = "test-key-not-a-secret";
const ENV = { DONNA_M365_MCP_URL: ENDPOINT, TRUEFOUNDRY_API_KEY: API_KEY };

function sse(result: unknown): string {
  return `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`;
}

const TOOLS_48 = {
  tools: [...M365_READ_TOOLS, ...M365_WRITE_TOOLS].map((name) => ({ name })),
};

/** Scripted fetch keyed on JSON-RPC method; counts requests per method. */
function scriptedFetch(
  handlers: Record<string, { status: number; body: string }>,
  counts: Record<string, number> = {},
): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method: string };
    counts[body.method] = (counts[body.method] ?? 0) + 1;
    const handler = handlers[body.method] ?? { status: 500, body: "" };
    return new Response(handler.body, { status: handler.status });
  }) as typeof fetch;
}

function happyFetch(counts: Record<string, number> = {}): typeof fetch {
  return scriptedFetch(
    {
      initialize: { status: 200, body: sse({ serverInfo: { name: "m365-mcp-server" } }) },
      "tools/list": { status: 200, body: sse(TOOLS_48) },
      "tools/call": {
        status: 200,
        body: sse({ content: [{ type: "text", text: '[{"id":"cal-1"},{"id":"cal-2"}]' }] }),
      },
    },
    counts,
  );
}

describe("checkM365Connection (Spec 5.1, FR-3, AC-1)", () => {
  it("happy path: every stage ok, tool counts, probe count — content discarded", async () => {
    const report = await checkM365Connection({ env: ENV, fetchImpl: happyFetch() });
    assert.equal(report.ok, true);
    assert.equal(report.endpointHost, "gateway.test");
    assert.equal(report.serverName, "m365-mcp-server");
    assert.deepEqual(report.tools, { total: 48, read: 25, write: 23, unknown: 0 });
    assert.equal(report.probeItemCount, 2);
    for (const stage of report.stages) assert.equal(stage.ok, true, stage.stage);
    assert.deepEqual(
      report.stages.map((s) => s.stage),
      ["endpoint-config", "gateway-auth", "mcp-initialize", "tool-discovery", "read-probe"],
    );
  });

  it("gateway 401 fails at gateway-auth and skips later stages", async () => {
    const report = await checkM365Connection({
      env: ENV,
      fetchImpl: scriptedFetch({
        initialize: { status: 401, body: "unauthorized" },
      }),
    });
    assert.equal(report.ok, false);
    const byStage = new Map(report.stages.map((s) => [s.stage, s]));
    assert.equal(byStage.get("gateway-auth")?.ok, false);
    assert.match(byStage.get("gateway-auth")!.detail, /401/);
    assert.match(byStage.get("mcp-initialize")!.detail, /skipped/);
    assert.match(byStage.get("read-probe")!.detail, /skipped/);
  });

  it("a tool-error probe fails closed with redacted detail", async () => {
    const report = await checkM365Connection({
      env: ENV,
      fetchImpl: scriptedFetch({
        initialize: { status: 200, body: sse({ serverInfo: { name: "m365-mcp-server" } }) },
        "tools/list": { status: 200, body: sse(TOOLS_48) },
        "tools/call": {
          status: 200,
          body: sse({
            isError: true,
            content: [{ type: "text", text: "downstream mailbox content that must never surface" }],
          }),
        },
      }),
    });
    assert.equal(report.ok, false);
    const probe = report.stages.find((s) => s.stage === "read-probe");
    assert.equal(probe?.ok, false);
    assert.match(probe!.detail, /redacted/);
    assert.ok(!probe!.detail.includes("mailbox content"));
  });

  it("missing credential fails at gateway-auth without any HTTP request", async () => {
    const counts: Record<string, number> = {};
    const report = await checkM365Connection({
      env: { DONNA_M365_MCP_URL: ENDPOINT },
      fetchImpl: happyFetch(counts),
    });
    assert.equal(report.ok, false);
    assert.equal(report.stages.find((s) => s.stage === "gateway-auth")?.ok, false);
    assert.equal(Object.keys(counts).length, 0);
  });

  it("invalid endpoint configuration fails before any HTTP request", async () => {
    const counts: Record<string, number> = {};
    const report = await checkM365Connection({
      env: { DONNA_M365_MCP_URL: "http://insecure.test/mcp", TRUEFOUNDRY_API_KEY: API_KEY },
      fetchImpl: happyFetch(counts),
    });
    assert.equal(report.ok, false);
    assert.equal(report.stages[0]?.stage, "endpoint-config");
    assert.equal(report.stages[0]?.ok, false);
    assert.equal(Object.keys(counts).length, 0);
  });

  it("AC-4: no credential or content appears anywhere in a failing report", async () => {
    const report = await checkM365Connection({
      env: ENV,
      fetchImpl: scriptedFetch({
        initialize: {
          status: 403,
          body: `forbidden: key ${API_KEY} rejected; trace id abc123`,
        },
      }),
    });
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes(API_KEY));
    assert.ok(!serialized.includes("abc123"));
    assert.equal(report.ok, false);
  });

  it("env inspection classifies without exposing values; default endpoint is pinned", () => {
    const status = inspectM365McpEnv({ TRUEFOUNDRY_API_KEY: "replace-me" });
    assert.equal(status.apiKey, "placeholder");
    assert.deepEqual(m365McpEnvProblems(status), [
      "TRUEFOUNDRY_API_KEY still holds the .env.example placeholder",
    ]);
    assert.equal(classifySecretEnv(undefined), "unset");
    assert.equal(classifySecretEnv("real-looking-value"), "configured");
    assert.equal(m365EndpointFromEnv({}), DEFAULT_M365_MCP_ENDPOINT);
    assert.ok(DEFAULT_M365_MCP_ENDPOINT.startsWith("https://"));
  });
});

describe("consent gating (Spec 5.1, FR-2, AC-2)", () => {
  const dirs: string[] = [];
  async function tempDataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "donna-m365-"));
    dirs.push(dir);
    return dir;
  }
  after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  function memoryService(dir: string): MemoryService {
    return new MemoryService({
      memories: new FileMemoryStore(dir),
      consents: new FileConsentStore(dir),
      now: () => new Date(),
    });
  }

  it("reads are denied without a grant, allowed with one, denied after revoke", async () => {
    const dir = await tempDataDir();
    const memory = memoryService(dir);
    const scope = { tenantId: "t1", userId: "u1" };

    await assert.rejects(
      requireM365Consent(memory, scope, "m365.read.calendar"),
      (error: unknown) => {
        assert.ok(error instanceof M365ConsentError);
        assert.equal(error.purpose, "m365.read.calendar");
        return true;
      },
    );

    await memory.grantConsent(scope, "m365.read.calendar", "test");
    await requireM365Consent(memory, scope, "m365.read.calendar");

    await memory.revokeConsent(scope, "m365.read.calendar", "test");
    await assert.rejects(
      requireM365Consent(memory, scope, "m365.read.calendar"),
      M365ConsentError,
    );
  });

  it("consent is per scope: another user partition stays denied", async () => {
    const dir = await tempDataDir();
    const memory = memoryService(dir);
    await memory.grantConsent({ tenantId: "t1", userId: "u1" }, "m365.read.mail", "test");
    await assert.rejects(
      requireM365Consent(memory, { tenantId: "t1", userId: "u2" }, "m365.read.mail"),
      M365ConsentError,
    );
    await assert.rejects(
      requireM365Consent(memory, { tenantId: "t2", userId: "u1" }, "m365.read.mail"),
      M365ConsentError,
    );
  });

  it("disconnect revokes every active m365 grant and purges the cached-snippet partition", async () => {
    const dir = await tempDataDir();
    const memory = memoryService(dir);
    const scope = { tenantId: "t1", userId: "u1" };
    await memory.grantConsent(scope, "m365.read.calendar", "test");
    await memory.grantConsent(scope, "m365.read.files", "test");
    await memory.grantConsent(scope, "emotion.persist", "test"); // unrelated grant survives

    // Seed a cached snippet partition the way 5.2 will.
    const scopeDir = m365ScopeDir(dir, scope);
    await mkdir(join(scopeDir, "snippets"), { recursive: true });
    await writeFile(join(scopeDir, "snippets", "snippet-1.json"), "{}");

    const result = await disconnectM365(memory, scope, dir);
    assert.deepEqual(
      [...result.revokedPurposes].sort(),
      ["m365.read.calendar", "m365.read.files"].sort(),
    );
    assert.equal(result.purgedCache, true);

    // Every m365 purpose is now denied; the unrelated grant is untouched.
    for (const purpose of M365_CONSENT_PURPOSES) {
      await assert.rejects(requireM365Consent(memory, scope, purpose), M365ConsentError);
    }
    assert.equal(await memory.hasConsent(scope, "emotion.persist"), true);

    // Idempotent: a second disconnect revokes nothing and finds no cache.
    const second = await disconnectM365(memory, scope, dir);
    assert.deepEqual(second.revokedPurposes, []);
    assert.equal(second.purgedCache, false);

    // Consent history is append-only: grant + revoke records both persist.
    const history = await memory.listConsents(scope);
    assert.equal(history.filter((r) => r.purpose === "m365.read.calendar").length, 2);
  });

  it("rejects path-traversing partition IDs", async () => {
    const dir = await tempDataDir();
    assert.throws(() => m365ScopeDir(dir, { tenantId: "../etc", userId: "u" }));
    assert.throws(() => m365ScopeDir(dir, { tenantId: "t", userId: "a/b" }));
  });
});
