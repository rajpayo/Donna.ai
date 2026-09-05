import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RetrievalHit } from "@donna/core";
import {
  applyReranker,
  DeterministicReranker,
  type Reranker,
} from "./reranker.js";
import type { HybridHit } from "./hybrid-search.js";

function hit(id: string): HybridHit {
  const base: RetrievalHit = {
    thought: {
      id,
      tenantId: "t",
      userId: "u",
      summary: id,
      text: id,
      confidence: 0.9,
      provenance: {
        captureId: "cap",
        segmentIds: ["seg-0"],
        sourceText: id,
        startSec: 0,
        endSec: 1,
      },
      versions: {
        organizerModel: "test",
        organizeSchemaVersion: "s",
        organizePromptVersion: "p",
      },
      createdAt: "2026-09-01T00:00:00.000Z",
    },
    bucketId: "b",
    bucketName: "B",
    scores: { text: 1, semantic: 0, combined: 1 },
    scoreVersion: "test",
  };
  return {
    ...base,
    features: {
      text: 1,
      semantic: 0,
      bucketAffinity: 0,
      recency: 0,
      personalization: 0,
      taskMatch: 0,
    },
    weights: {
      text: 0.3,
      semantic: 0.3,
      bucketAffinity: 0.1,
      recency: 0.1,
      personalization: 0.15,
      taskMatch: 0.05,
    },
    rankingVersion: "donna.hybrid-ranking.v1",
  };
}

describe("reranker permutation contract (SR-2)", () => {
  it("the deterministic reranker is the identity", async () => {
    const hits = [hit("a"), hit("b")];
    const result = await applyReranker(new DeterministicReranker(), "q", hits);
    assert.equal(result.reranked, true);
    assert.deepEqual(result.hits.map((h) => h.thought.id), ["a", "b"]);
  });

  it("a valid reordering is accepted", async () => {
    const reranker: Reranker = {
      modelId: "stub",
      rerank: async (_q, hits) => [...hits].reverse(),
    };
    const result = await applyReranker(reranker, "q", [hit("a"), hit("b")]);
    assert.equal(result.reranked, true);
    assert.deepEqual(result.hits.map((h) => h.thought.id), ["b", "a"]);
  });

  it("a reranker that adds or drops hits fails closed to the deterministic order", async () => {
    const adding: Reranker = {
      modelId: "stub",
      rerank: async (_q, hits) => [...hits, hit("injected")],
    };
    const input = [hit("a"), hit("b")];
    const added = await applyReranker(adding, "q", input);
    assert.equal(added.reranked, false);
    assert.deepEqual(added.hits.map((h) => h.thought.id), ["a", "b"]);

    const dropping: Reranker = {
      modelId: "stub",
      rerank: async (_q, hits) => hits.slice(1),
    };
    const dropped = await applyReranker(dropping, "q", input);
    assert.equal(dropped.reranked, false);
    assert.deepEqual(dropped.hits.map((h) => h.thought.id), ["a", "b"]);
  });

  it("a throwing reranker fails closed to the deterministic order", async () => {
    const broken: Reranker = {
      modelId: "stub",
      rerank: async () => {
        throw new Error("reranker unavailable");
      },
    };
    const result = await applyReranker(broken, "q", [hit("a")]);
    assert.equal(result.reranked, false);
    assert.deepEqual(result.hits.map((h) => h.thought.id), ["a"]);
  });
});
