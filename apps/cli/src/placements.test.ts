/**
 * CLI placement-review tests (Specification 6.7 AC-8): the exact
 * user-facing states render with human names only — no internal bucket ID
 * ever appears in captured stdout — and resolve actions are idempotent
 * across a simulated restart.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { PendingPlacement } from "@donna/core";
import { FilePendingPlacementStore } from "@donna/buckets";
import { pendingChoices, pendingHeadline } from "./placements.js";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(here, "main.ts");

function record(overrides: Partial<PendingPlacement> = {}): PendingPlacement {
  return {
    id: "pp-test-1",
    tenantId: "demo-tenant",
    userId: "demo-user",
    thought: {
      id: "th-1",
      tenantId: "demo-tenant",
      userId: "demo-user",
      summary: "Renew the Acme vendor contract",
      text: "Renew the Acme vendor contract",
      confidence: 0.9,
      provenance: {
        captureId: "c-1",
        segmentIds: ["seg-0"],
        sourceText: "Renew the Acme vendor contract",
        startSec: 0,
        endSec: 2,
      },
      versions: {
        organizerModel: "test",
        organizeSchemaVersion: "donna.organize.v2",
        organizePromptVersion: "donna.organize-prompt.v4-structured",
      },
      embedding: [1, 0, 0],
      createdAt: "2026-09-05T00:00:00.000Z",
    },
    proposal: { mode: "new", name: "Vendor Contracts", description: "Vendor paperwork." },
    reason: "naming-invalid",
    candidates: [],
    allowlistHash: "0".repeat(64),
    createdAt: "2026-09-05T00:00:00.000Z",
    status: "pending",
    ...overrides,
  };
}

describe("placement headlines (FR-18)", () => {
  it("renders the exact user-facing states with names only", () => {
    assert.equal(
      pendingHeadline(record()),
      "Create new bucket Vendor Contracts? (name needs review)",
    );
    assert.equal(
      pendingHeadline(record({ reason: "unknown-id", proposal: null })),
      "I couldn't verify that destination; choose a bucket",
    );
    assert.equal(
      pendingHeadline(
        record({
          reason: "model-geometry-mismatch",
          proposal: { mode: "existing", bucketId: "b-secret-uuid" },
          candidates: [
            { bucketId: "b-secret-uuid", name: "Project Atlas", similarity: 0.9 },
            { bucketId: "b-other-uuid", name: "Product Ideas", similarity: 0.4 },
          ],
        }),
      ),
      "Review needed: Project Atlas or Product Ideas?",
    );
    assert.equal(
      pendingHeadline(
        record({
          reason: "possible-existing-match",
          recommendedBucketId: "b-secret-uuid",
          candidates: [{ bucketId: "b-secret-uuid", name: "Project Atlas", similarity: 0.9 }],
        }),
      ),
      "Use Project Atlas instead of new bucket Vendor Contracts?",
    );
  });

  it("choices never contain internal IDs", () => {
    const choices = pendingChoices(
      record({
        candidates: [{ bucketId: "b-secret-uuid", name: "Project Atlas", similarity: 0.9 }],
      }),
    );
    for (const choice of choices) {
      assert.ok(!choice.includes("b-secret-uuid"));
    }
    assert.ok(choices.some((c) => c.startsWith("File in… Project Atlas")));
    assert.ok(choices.some((c) => c.includes('Create "Vendor Contracts"')));
    assert.ok(choices.some((c) => c.startsWith("Reject")));
  });
});

describe("donna review placements (AC-6/AC-8, end-to-end)", () => {
  it("lists pending after restart, resolves idempotently, and prints no bucket IDs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "donna-cli-"));
    // Seed one pending record (a prior capture left it unresolved).
    await new FilePendingPlacementStore(dataDir).save(record());

    const env = { ...process.env, DONNA_DATA_DIR: dataDir };
    const list = await execFileAsync(
      process.execPath,
      ["--import", "tsx", cliPath, "review", "placements"],
      { env },
    );
    assert.ok(list.stdout.includes("Create new bucket Vendor Contracts?"));
    assert.ok(list.stdout.includes("Renew the Acme vendor contract"));
    assert.ok(!/b-[a-z0-9-]*uuid/i.test(list.stdout));

    // Resolve: create. The mint is validated and filed once.
    const resolved = await execFileAsync(
      process.execPath,
      ["--import", "tsx", cliPath, "review", "placements", "resolve", "pp-test-1", "--create"],
      { env },
    );
    assert.ok(resolved.stdout.includes("Created new bucket Vendor Contracts — filed"));

    // Replay: idempotent, no duplicate.
    const replay = await execFileAsync(
      process.execPath,
      ["--import", "tsx", cliPath, "review", "placements", "resolve", "pp-test-1", "--create"],
      { env },
    );
    assert.ok(replay.stdout.includes("Already filed in Vendor Contracts"));

    // Queue is empty afterward.
    const empty = await execFileAsync(
      process.execPath,
      ["--import", "tsx", cliPath, "review", "placements"],
      { env },
    );
    assert.ok(empty.stdout.includes("No pending placements"));
  });

  it("reject creates nothing and replays safely", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "donna-cli-"));
    await new FilePendingPlacementStore(dataDir).save(record({ id: "pp-test-2" }));
    const env = { ...process.env, DONNA_DATA_DIR: dataDir };
    const rejected = await execFileAsync(
      process.execPath,
      ["--import", "tsx", cliPath, "review", "placements", "resolve", "pp-test-2", "--reject"],
      { env },
    );
    assert.ok(rejected.stdout.includes("Rejected — nothing was created or filed."));
    const replay = await execFileAsync(
      process.execPath,
      ["--import", "tsx", cliPath, "review", "placements", "resolve", "pp-test-2", "--reject"],
      { env },
    );
    assert.ok(replay.stdout.includes("Already rejected"));
  });
});
