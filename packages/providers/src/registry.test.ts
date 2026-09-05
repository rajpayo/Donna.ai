import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GatewayClient } from "./gateway.js";
import { loadModelsConfig, resolveStack } from "./registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const candidateDir = resolve(
  here,
  "../../evals/experiments/organize/6.6/candidates",
);

describe("config-driven organizer prompt selection", () => {
  it("resolves A0 and B without candidate/model branches", async () => {
    const gateway = new GatewayClient({
      baseUrl: "https://gateway.invalid",
      apiKey: "unused",
      tenantId: "eval",
      appId: "eval",
    });
    const [a0, b] = await Promise.all([
      loadModelsConfig(resolve(candidateDir, "A0.models.config.yaml")),
      loadModelsConfig(resolve(candidateDir, "B.models.config.yaml")),
    ]);
    const a0Organizer = resolveStack(gateway, a0).organizer;
    const bOrganizer = resolveStack(gateway, b).organizer;
    assert.equal(a0Organizer.modelId, "gpt-5-mini");
    assert.equal(a0Organizer.promptVersion, "donna.organize-prompt.v2");
    assert.equal(bOrganizer.modelId, "gpt-5-mini");
    assert.equal(bOrganizer.promptVersion, "donna.organize-prompt.v3-quality");
  });
});
