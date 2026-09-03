/**
 * Specification 5.1 — McpClient transport and allowlist boundary tests.
 *
 * All tests run against a scripted fetch — no network, no credentials,
 * no Microsoft content. Fixtures carry tool names and counts only.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  M365McpClient,
  M365McpError,
  M365ToolDeniedError,
  m365ApprovalPathClient,
  m365ReadOnlyClient,
  parseM365Endpoint,
  parseMcpResponseBody,
} from "./mcp-client.js";
import { classifyM365Tool, M365_READ_TOOLS, M365_WRITE_TOOLS } from "./tools.js";

const ENDPOINT = "https://gateway.test/tenant/mcp/microsoft-365/server";
const API_KEY = "test-key-not-a-secret";

interface RecordedRequest {
  method: string;
  params?: Record<string, unknown>;
  authorization?: string;
}

/** Build a fetch that answers JSON-RPC methods with scripted results. */
function scriptedFetch(
  handlers: Record<
    string,
    | { result: unknown }
    | { error: { code: number; message: string } }
    | { httpStatus: number; body: string }
  >,
  recorded?: RecordedRequest[],
): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
    };
    recorded?.push({
      method: body.method,
      ...(body.params !== undefined ? { params: body.params } : {}),
      ...(init?.headers !== undefined
        ? {
            authorization: String(
              (init.headers as Record<string, string>)["Authorization"] ?? "",
            ),
          }
        : {}),
    });
    const handler = handlers[body.method];
    if (handler === undefined) {
      return new Response("no handler", { status: 500 });
    }
    if ("httpStatus" in handler) {
      return new Response(handler.body, { status: handler.httpStatus });
    }
    const payload =
      "error" in handler
        ? { jsonrpc: "2.0", id: body.id, error: handler.error }
        : { jsonrpc: "2.0", id: body.id, result: handler.result };
    return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;
}

const TOOL_NAMES_48 = [
  ...[...M365_READ_TOOLS].sort(),
  ...[...M365_WRITE_TOOLS].sort(),
];

function toolsListResult(names: string[] = TOOL_NAMES_48) {
  return { tools: names.map((name) => ({ name, description: `${name} tool` })) };
}

describe("M365McpClient transport (Spec 5.1)", () => {
  it("initialize parses the event-stream response and returns the server name", async () => {
    const client = m365ReadOnlyClient({
      endpointUrl: ENDPOINT,
      apiKey: API_KEY,
      fetchImpl: scriptedFetch({
        initialize: { result: { serverInfo: { name: "m365-mcp-server" } } },
      }),
    });
    const { serverName } = await client.initialize();
    assert.equal(serverName, "m365-mcp-server");
  });

  it("tools/list returns descriptors; classification counts 25 read / 23 write / 0 unknown", async () => {
    const client = m365ReadOnlyClient({
      endpointUrl: ENDPOINT,
      apiKey: API_KEY,
      fetchImpl: scriptedFetch({ "tools/list": { result: toolsListResult() } }),
    });
    const tools = await client.listTools();
    assert.equal(tools.length, 48);
    const counts = { read: 0, write: 0, unknown: 0 };
    for (const tool of tools) counts[classifyM365Tool(tool.name)] += 1;
    assert.deepEqual(counts, { read: 25, write: 23, unknown: 0 });
  });

  it("unknown server tools are classified unknown (deny-by-default)", () => {
    assert.equal(classifyM365Tool("send_as_user"), "unknown");
    assert.equal(classifyM365Tool("list_events"), "read");
    assert.equal(classifyM365Tool("create_draft"), "write");
  });

  it("tools/call returns opaque content and isError", async () => {
    const client = m365ReadOnlyClient({
      endpointUrl: ENDPOINT,
      apiKey: API_KEY,
      fetchImpl: scriptedFetch({
        "tools/call": {
          result: { content: [{ type: "text", text: "[]" }], isError: false },
        },
      }),
    });
    const result = await client.callTool("list_calendars", {});
    assert.equal(result.isError, false);
    assert.ok(Array.isArray(result.content));
  });

  it("sends the Bearer credential in the Authorization header and JSON-RPC shape", async () => {
    const recorded: RecordedRequest[] = [];
    const client = m365ReadOnlyClient({
      endpointUrl: ENDPOINT,
      apiKey: API_KEY,
      fetchImpl: scriptedFetch(
        { initialize: { result: { serverInfo: { name: "s" } } } },
        recorded,
      ),
    });
    await client.initialize();
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.method, "initialize");
    assert.equal(recorded[0]!.authorization, `Bearer ${API_KEY}`);
  });
});

describe("M365McpClient response parsing (Spec 5.1)", () => {
  it("parses a plain JSON body defensively", () => {
    const parsed = parseMcpResponseBody(
      JSON.stringify({ jsonrpc: "2.0", id: 7, result: { ok: true } }),
    ) as { result: { ok: boolean } };
    assert.equal(parsed.result.ok, true);
  });

  it("selects the data line amid event-stream noise", () => {
    const parsed = parseMcpResponseBody(
      ": ping\n\nevent: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"n\":2}}\n\n",
    ) as { result: { n: number } };
    assert.equal(parsed.result.n, 2);
  });

  it("fails closed on a body with no data line", () => {
    assert.throws(() => parseMcpResponseBody("event: message\n\n"), M365McpError);
  });
});

describe("M365McpClient endpoint pinning (Spec 5.1, SR-2)", () => {
  it("rejects non-https endpoints", () => {
    assert.throws(
      () => parseM365Endpoint("http://gateway.test/mcp"),
      (error: unknown) =>
        error instanceof M365McpError && error.stage === "endpoint-config",
    );
  });

  it("rejects credentials embedded in the URL", () => {
    assert.throws(
      () => parseM365Endpoint("https://user:pass@gateway.test/mcp"),
      M365McpError,
    );
  });

  it("rejects unparseable endpoints", () => {
    assert.throws(() => parseM365Endpoint("not a url"), M365McpError);
  });

  it("accepts the pinned https endpoint and exposes only its host", () => {
    const url = parseM365Endpoint(ENDPOINT);
    assert.equal(url.host, "gateway.test");
  });
});

describe("M365McpClient stage-level redacted errors (Spec 5.1, FR-3, SR-1)", () => {
  it("maps HTTP 401 to the gateway-auth stage with status only", async () => {
    const client = m365ReadOnlyClient({
      endpointUrl: ENDPOINT,
      apiKey: API_KEY,
      fetchImpl: scriptedFetch({
        initialize: { httpStatus: 401, body: "unauthorized: bad gateway key" },
      }),
    });
    await assert.rejects(client.initialize(), (error: unknown) => {
      assert.ok(error instanceof M365McpError);
      assert.equal(error.stage, "gateway-auth");
      assert.equal(error.httpStatus, 401);
      assert.ok(!error.message.includes("bad gateway key"));
      assert.ok(!error.message.includes(API_KEY));
      return true;
    });
  });

  it("keeps the method's stage for non-auth HTTP failures", async () => {
    const client = m365ReadOnlyClient({
      endpointUrl: ENDPOINT,
      apiKey: API_KEY,
      fetchImpl: scriptedFetch({
        "tools/list": { httpStatus: 500, body: "stacktrace with internals" },
      }),
    });
    await assert.rejects(client.listTools(), (error: unknown) => {
      assert.ok(error instanceof M365McpError);
      assert.equal(error.stage, "tool-discovery");
      assert.equal(error.httpStatus, 500);
      assert.ok(!error.message.includes("stacktrace"));
      return true;
    });
  });

  it("reports JSON-RPC errors by code only — the server message is never echoed", async () => {
    const client = m365ReadOnlyClient({
      endpointUrl: ENDPOINT,
      apiKey: API_KEY,
      fetchImpl: scriptedFetch({
        "tools/call": {
          error: { code: -32001, message: `secret content ${API_KEY} leaked` },
        },
      }),
    });
    await assert.rejects(client.callTool("get_email", { id: "x" }), (error: unknown) => {
      assert.ok(error instanceof M365McpError);
      assert.equal(error.stage, "tool-call");
      assert.equal(error.rpcCode, -32001);
      assert.ok(!error.message.includes("secret content"));
      assert.ok(!error.message.includes(API_KEY));
      return true;
    });
  });

  it("network failures never leak the URL or credential", async () => {
    const failingFetch = (async () => {
      throw new TypeError(
        `fetch failed connecting to ${ENDPOINT} with key ${API_KEY}`,
      );
    }) as typeof fetch;
    const client = m365ReadOnlyClient({
      endpointUrl: ENDPOINT,
      apiKey: API_KEY,
      fetchImpl: failingFetch,
    });
    await assert.rejects(client.initialize(), (error: unknown) => {
      assert.ok(error instanceof M365McpError);
      assert.ok(!error.message.includes(ENDPOINT));
      assert.ok(!error.message.includes(API_KEY));
      return true;
    });
  });
});

describe("M365McpClient tool allowlist (Spec 5.1, SR-3, AC-3)", () => {
  it("a read-only connection denies write tools BEFORE any request", async () => {
    const recorded: RecordedRequest[] = [];
    const client = m365ReadOnlyClient({
      endpointUrl: ENDPOINT,
      apiKey: API_KEY,
      fetchImpl: scriptedFetch({}, recorded),
    });
    for (const writeTool of ["send_email", "create_draft", "post_channel_message", "share_file"]) {
      await assert.rejects(
        client.callTool(writeTool, {}),
        (error: unknown) => {
          assert.ok(error instanceof M365ToolDeniedError);
          assert.equal(error.tool, writeTool);
          return true;
        },
      );
    }
    // No network I/O happened for any denied call.
    assert.equal(recorded.length, 0);
  });

  it("a read-only connection denies unknown tools (deny-by-default)", async () => {
    const recorded: RecordedRequest[] = [];
    const client = m365ReadOnlyClient({
      endpointUrl: ENDPOINT,
      apiKey: API_KEY,
      fetchImpl: scriptedFetch({}, recorded),
    });
    await assert.rejects(client.callTool("brand_new_admin_tool", {}), M365ToolDeniedError);
    assert.equal(recorded.length, 0);
  });

  it("the approval-path connection invokes only its explicit allowlist", async () => {
    const client = m365ApprovalPathClient(
      {
        endpointUrl: ENDPOINT,
        apiKey: API_KEY,
        fetchImpl: scriptedFetch({
          "tools/call": { result: { content: [{ type: "text", text: "{}" }] } },
        }),
      },
      ["create_draft"],
    );
    const ok = await client.callTool("create_draft", { subject: "s" });
    assert.equal(ok.isError, false);
    // Even the approval path cannot touch tools outside its allowlist.
    await assert.rejects(client.callTool("send_email", {}), M365ToolDeniedError);
    await assert.rejects(client.callTool("list_events", {}), M365ToolDeniedError);
  });
});
