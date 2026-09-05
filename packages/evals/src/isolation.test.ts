/**
 * Eval isolation tests (Specification 4.1: FR-4, SR-3).
 *
 * The Postgres part is gated on DONNA_TEST_DATABASE_URL /
 * DONNA_TEST_ADMIN_URL like the Spec 3.2 suite: it proves the eval tenant
 * cannot read pilot-tenant rows at the DATABASE level (RLS), and skips
 * cleanly without a database.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  assertEvalDataDir,
  assertEvalScope,
  EvalIsolationError,
  EVAL_SCOPE,
} from "./isolation.js";

const here = dirname(fileURLToPath(import.meta.url));
const evalsDir = resolve(here, "..");
const repoRoot = resolve(here, "../../..");
const OPTS = { repoRoot, evalsDir };

describe("assertEvalScope (FR-4)", () => {
  it("accepts eval-prefixed scopes", () => {
    assertEvalScope(EVAL_SCOPE);
    assertEvalScope({ tenantId: "eval-tenant-2", userId: "eval-user-2" });
  });

  it("rejects pilot/user scopes", () => {
    assert.throws(
      () => assertEvalScope({ tenantId: "demo-tenant", userId: "eval-user" }),
      EvalIsolationError,
    );
    assert.throws(
      () => assertEvalScope({ tenantId: "eval-tenant", userId: "raj" }),
      EvalIsolationError,
    );
  });
});

describe("assertEvalDataDir (FR-4)", () => {
  it("accepts temp dirs and evals-package dirs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "donna-iso-test-"));
    try {
      assertEvalDataDir(dir, OPTS);
      assertEvalDataDir(join(evalsDir, "reports", "adversarial"), OPTS);
      assertEvalDataDir(join(evalsDir, ".eval-scratch", "x"), OPTS);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects the CLI pilot data dir and its parents", () => {
    assert.throws(() => assertEvalDataDir(join(repoRoot, "data"), OPTS), EvalIsolationError);
    assert.throws(() => assertEvalDataDir(join(repoRoot, "data", "demo-tenant"), OPTS), EvalIsolationError);
    assert.throws(() => assertEvalDataDir(repoRoot, OPTS), EvalIsolationError);
  });

  it("rejects arbitrary directories outside the allowed roots", () => {
    assert.throws(() => assertEvalDataDir("/var/lib/donna", OPTS), EvalIsolationError);
    assert.throws(() => assertEvalDataDir(join(repoRoot, "apps"), OPTS), EvalIsolationError);
  });
});

describe("eval tenant cannot access live tenant rows (SR-3, Postgres RLS)", () => {
  const APP_URL = process.env.DONNA_TEST_DATABASE_URL;
  const ADMIN_URL = process.env.DONNA_TEST_ADMIN_URL;
  const available = APP_URL !== undefined && ADMIN_URL !== undefined;

  it(
    "RLS denies the eval scope reads of pilot-tenant rows",
    { skip: !available },
    async () => {
      const { createPool, migrateUp, PostgresBucketStore } = await import(
        "@donna/storage-postgres"
      );
      const migrationsDir = resolve(repoRoot, "database/migrations");
      const admin = createPool({ connectionString: ADMIN_URL! });
      const app = createPool({ connectionString: APP_URL! });
      try {
        await migrateUp(admin, migrationsDir);
        const store = new PostgresBucketStore(app);
        const pilot = { tenantId: "pilot-tenant", userId: "pilot-user" };
        await store.createBucket({
          id: "pilot-bucket-1",
          ...pilot,
          name: "Pilot Bucket",
          description: "pilot data",
          centroid: [1, 0, 0],
          itemCount: 0,
          createdAt: "2026-08-01T00:00:00.000Z",
          origin: "auto",
        });
        // The eval scope must see zero pilot rows even though they exist.
        const visible = await store.listBuckets(EVAL_SCOPE.tenantId, EVAL_SCOPE.userId);
        assert.equal(visible.length, 0);
        const byName = await store.getBucketByName(
          EVAL_SCOPE.tenantId,
          EVAL_SCOPE.userId,
          "Pilot Bucket",
        );
        assert.equal(byName, undefined);
        // Cleanup under the pilot scope itself.
        const pilotBuckets = await store.listBuckets(pilot.tenantId, pilot.userId);
        assert.equal(pilotBuckets.length, 1);
      } finally {
        await admin.query("DELETE FROM buckets WHERE tenant_id = 'pilot-tenant'");
        await app.end();
        await admin.end();
      }
    },
  );
});
