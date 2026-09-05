import assert from "node:assert/strict";
import { it } from "node:test";
import { MeteredGatewayClient } from "./scripted.js";

it("normalizes OpenAI and Anthropic token usage without estimating cost", async () => {
  const client = new MeteredGatewayClient({
    baseUrl: "https://gateway.example",
    apiKey: "test",
    tenantId: "eval",
    appId: "eval",
  });
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async () => {
    call += 1;
    return new Response(
      JSON.stringify(
        call === 1
          ? { usage: { prompt_tokens: 10, completion_tokens: 4, cost_usd: 0.01 } }
          : { usage: { input_tokens: 7, output_tokens: 3 } },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    await client.postJson("/", {}, "organize");
    await client.postJson("/", {}, "organize");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(client.usage[0], {
    stage: "organize",
    promptTokens: 10,
    completionTokens: 4,
    totalTokens: 14,
    costUsd: 0.01,
  });
  assert.deepEqual(client.usage[1], {
    stage: "organize",
    promptTokens: 7,
    completionTokens: 3,
    totalTokens: 10,
  });
  assert.deepEqual(client.totals(), {
    promptTokens: 17,
    completionTokens: 7,
    costUsd: 0.01,
  });
});
