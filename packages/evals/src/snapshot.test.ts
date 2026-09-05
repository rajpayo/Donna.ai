/**
 * Config snapshot tests (Specification 4.1: FR-1, SR-2).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  captureSnapshot,
  resolveSnapshotBranch,
  snapshotFingerprint,
} from "./snapshot.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const configPath = resolve(repoRoot, "models.config.yaml");

const DATASET = { name: "test.v1", version: 1, sha256: "a".repeat(64) };

describe("captureSnapshot (FR-1)", () => {
  it("records commit, config fingerprint, versions, ranking, and memory policy", async () => {
    const snapshot = await captureSnapshot({
      repoRoot,
      configPath,
      dataset: DATASET,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });
    assert.match(snapshot.commit, /^[0-9a-f]{40}$/);
    assert.notEqual(snapshot.branch, "");
    assert.notEqual(snapshot.branch, "unknown");
    assert.equal(snapshot.modelsConfig.sha256.length, 64);
    // Spec 6.7: the canonical config selects the structured v2 lane.
    assert.equal(snapshot.versions.organizePrompt, "donna.organize-prompt.v4-structured");
    assert.equal(snapshot.versions.organizeSchema, "donna.organize.v2");
    assert.equal(snapshot.versions.answerPrompt, "donna.answer-prompt.v1");
    assert.equal(snapshot.ranking.rankingVersion, "donna.hybrid-ranking.v1");
    assert.equal(snapshot.ranking.weights["text"], 0.3);
    assert.equal(snapshot.memoryPolicy.adherenceSemanticThreshold, 0.5);
    assert.equal(snapshot.bucketTuning.assignThreshold, 0.82);
    assert.equal(snapshot.capturedAt, "2026-09-03T12:00:00.000Z");
  });

  it("uses GitHub metadata for a detached-head checkout", () => {
    assert.equal(
      resolveSnapshotBranch("", "cursor/import-mvp-scaffold-b430", "1/merge"),
      "cursor/import-mvp-scaffold-b430",
    );
    assert.equal(resolveSnapshotBranch("", "", "main"), "main");
    assert.equal(resolveSnapshotBranch("", "", ""), "unknown");
  });

  it("fingerprint is stable across captures and changes with the config", async () => {
    const a = await captureSnapshot({ repoRoot, configPath, dataset: DATASET });
    const b = await captureSnapshot({ repoRoot, configPath, dataset: DATASET });
    assert.equal(snapshotFingerprint(a), snapshotFingerprint(b));

    // A different config file (e.g. a model swap) must change the fingerprint.
    const dir = await mkdtemp(join(tmpdir(), "donna-snapshot-test-"));
    try {
      const raw = await import("node:fs/promises").then((fs) =>
        fs.readFile(configPath, "utf8"),
      );
      const swapped = raw.replace("gpt-5-mini", "gpt-5-nano");
      assert.notEqual(swapped, raw);
      const altPath = join(dir, "models.config.yaml");
      await writeFile(altPath, swapped);
      const c = await captureSnapshot({ repoRoot, configPath: altPath, dataset: DATASET });
      assert.notEqual(snapshotFingerprint(a), snapshotFingerprint(c));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fingerprint changes with the dataset identity", async () => {
    const a = await captureSnapshot({ repoRoot, configPath, dataset: DATASET });
    const b = await captureSnapshot({
      repoRoot,
      configPath,
      dataset: { ...DATASET, version: 2 },
    });
    assert.notEqual(snapshotFingerprint(a), snapshotFingerprint(b));
  });

  it("contains no secret material (SR-2)", async () => {
    const snapshot = await captureSnapshot({ repoRoot, configPath, dataset: DATASET });
    const serialized = JSON.stringify(snapshot);
    assert.ok(!serialized.includes(process.env.TRUEFOUNDRY_API_KEY ?? "\0never"));
    assert.ok(!/Bearer\s/i.test(serialized));
  });
});
