/**
 * PostgreSQL pending-placement + canonical-key parity tests (Spec 6.7
 * AC-5/AC-6/AC-12). Gated on DONNA_TEST_DATABASE_URL /
 * DONNA_TEST_ADMIN_URL like the Spec 3.2 suite; without a database the
 * file-store suite covers the same semantics.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import type { PendingPlacement } from "@donna/core";
import { createPool } from "./client.js";
import { migrateDown, migrateUp } from "./migrate.js";
import { PostgresBucketStore } from "./bucket-store.pg.js";
import { PostgresPendingPlacementStore } from "./pending-store.pg.js";

const APP_URL = process.env.DONNA_TEST_DATABASE_URL;
const ADMIN_URL = process.env.DONNA_TEST_ADMIN_URL;
const MIGRATIONS_DIR = new URL("../../../database/migrations", import.meta.url)
  .pathname;
const DB_AVAILABLE = APP_URL !== undefined && ADMIN_URL !== undefined;

function pendingRecord(id: string): PendingPlacement {
  return {
    id,
    tenantId: "t-pg",
    userId: "u-pg",
    thought: {
      id: `th-${id}`,
      tenantId: "t-pg",
      userId: "u-pg",
      summary: "s",
      text: "t",
      confidence: 0.9,
      provenance: {
        captureId: "cap-pg",
        segmentIds: ["seg-0"],
        sourceText: "t",
        startSec: 0,
        endSec: 1,
      },
      versions: {
        organizerModel: "test",
        organizeSchemaVersion: "donna.organize.v2",
        organizePromptVersion: "donna.organize-prompt.v4-structured",
      },
      createdAt: "2026-09-05T00:00:00.000Z",
    },
    proposal: { mode: "new", name: "Vendor Contracts", description: "Renewals." },
    reason: "naming-invalid",
    candidates: [],
    allowlistHash: "0".repeat(64),
    createdAt: "2026-09-05T00:00:00.000Z",
    status: "pending",
  };
}

describe("PostgreSQL pending placements (Spec 6.7)", { skip: !DB_AVAILABLE }, () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  before(async () => {
    adminPool = createPool({ connectionString: ADMIN_URL! });
    appPool = createPool({ connectionString: APP_URL! });
    await migrateDown(adminPool, MIGRATIONS_DIR);
    await migrateUp(adminPool, MIGRATIONS_DIR);
  });

  after(async () => {
    await adminPool?.end();
    await appPool?.end();
  });

  it("migration 0002 is up/down reversible and refuses down with unresolved pending", async () => {
    const pending = new PostgresPendingPlacementStore(appPool);
    await pending.save(pendingRecord("pp-mig"));
    await assert.rejects(
      migrateDown(adminPool, MIGRATIONS_DIR),
      /unresolved pending/,
    );
    await pending.deleteAll("t-pg", "u-pg");
    // Full down + re-up works once resolved/exported.
    await migrateDown(adminPool, MIGRATIONS_DIR);
    await migrateUp(adminPool, MIGRATIONS_DIR);
  });

  it("canonical-name uniqueness is enforced per user (parity with file store)", async () => {
    const buckets = new PostgresBucketStore(appPool);
    await buckets.createBucket({
      id: "b-pg-1",
      tenantId: "t-pg",
      userId: "u-pg",
      name: "Vendor Contracts",
      description: "d",
      centroid: [],
      itemCount: 0,
      createdAt: "2026-09-05T00:00:00.000Z",
      origin: "auto",
    });
    await assert.rejects(
      buckets.createBucket({
        id: "b-pg-2",
        tenantId: "t-pg",
        userId: "u-pg",
        name: "vendor  contracts",
        description: "d",
        centroid: [],
        itemCount: 0,
        createdAt: "2026-09-05T00:00:00.000Z",
        origin: "auto",
      }),
    );
    // Rename to a colliding canonical key fails closed too.
    await buckets.createBucket({
      id: "b-pg-3",
      tenantId: "t-pg",
      userId: "u-pg",
      name: "Vendor Portal",
      description: "d",
      centroid: [],
      itemCount: 0,
      createdAt: "2026-09-05T00:00:00.000Z",
      origin: "auto",
    });
    await assert.rejects(
      buckets.renameBucket("t-pg", "u-pg", "b-pg-3", "vendor contracts"),
    );
  });

  it("pending placements persist, resolve idempotently, and stay scoped", async () => {
    const pending = new PostgresPendingPlacementStore(appPool);
    await pending.save(pendingRecord("pp-1"));
    const listed = await pending.list("t-pg", "u-pg", "pending");
    assert.equal(listed.length, 1);
    // RLS: another scope sees nothing.
    assert.equal((await pending.list("t-pg", "u-other")).length, 0);

    const resolution = {
      action: "create" as const,
      bucketId: "b-pg-1",
      name: "Vendor Contracts",
      audit: "user-confirmed",
    };
    const first = await pending.markResolved("t-pg", "u-pg", "pp-1", resolution, "2026-09-05T01:00:00.000Z");
    assert.equal(first.status, "resolved");
    const replay = await pending.markResolved("t-pg", "u-pg", "pp-1", resolution, "2026-09-05T01:00:00.000Z");
    assert.equal(replay.status, "resolved");
    await assert.rejects(
      pending.markResolved("t-pg", "u-pg", "pp-1", { action: "reject", audit: "user-rejected" }, "2026-09-05T01:00:00.000Z"),
      /different action/,
    );
    const removed = await pending.deleteForCapture("t-pg", "u-pg", "cap-pg");
    assert.equal(removed.removed, 1);
  });
});
