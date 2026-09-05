/**
 * PostgreSQL integration tests (Specification 3.2).
 *
 * These tests run against a real PostgreSQL + pgvector instance. They are
 * gated on environment configuration so machines without a database stay
 * green (the file adapters remain the test default):
 *
 *   DONNA_TEST_DATABASE_URL  — app role (non-superuser, RLS-bound)
 *   DONNA_TEST_ADMIN_URL     — migration/admin role
 *   DONNA_TEST_BACKUP_URL    — optional backup role (BYPASSRLS) for the
 *                              backup/restore test; falls back to admin.
 *
 * See database/README.md for the one-time local setup. Tests are
 * sequential (single file) and every test uses its own tenant/user
 * fixtures, so runs are isolated and repeatable.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { hashTranscriptContent, type Bucket, type Thought } from "@donna/core";
import { FileBucketStore } from "@donna/buckets";
import { FileCaptureStore, FileTranscriptStore } from "@donna/pipeline";
import { createPool } from "./client.js";
import { migrateDown, migrateUp } from "./migrate.js";
import { PostgresBucketStore } from "./bucket-store.pg.js";
import {
  PostgresCaptureStore,
  PostgresTranscriptStore,
} from "./capture-stores.pg.js";
import {
  PostgresConsentStore,
  PostgresCorrectionStore,
  PostgresMemoryStore,
} from "./memory-stores.pg.js";
import { PostgresRetrievalIndex } from "./retrieval-index.pg.js";
import { PostgresPendingPlacementStore } from "./pending-store.pg.js";
import { importFileFixtures } from "./import-file.js";
import type { PendingPlacement } from "@donna/core";

/** Spec 6.7 pending-placement fixture (scoped, minimal verified thought). */
function pendingRecord(tenantId: string, userId: string, id: string): PendingPlacement {
  return {
    id,
    tenantId,
    userId,
    thought: makeThought(tenantId, userId, `th-${id}`, "pending thought", [1, 0, 0], "2026-09-05T00:00:00.000Z", {
      provenance: {
        captureId: "cap-pg",
        segmentIds: ["seg-0"],
        sourceText: "pending thought",
        startSec: 0,
        endSec: 1,
      },
    }),
    proposal: { mode: "new", name: "Vendor Contracts", description: "Renewals." },
    reason: "naming-invalid",
    candidates: [],
    allowlistHash: "0".repeat(64),
    createdAt: "2026-09-05T00:00:00.000Z",
    status: "pending",
  };
}

const execFileAsync = promisify(execFile);

const APP_URL = process.env.DONNA_TEST_DATABASE_URL;
const ADMIN_URL = process.env.DONNA_TEST_ADMIN_URL;
const BACKUP_URL = process.env.DONNA_TEST_BACKUP_URL ?? ADMIN_URL;
const MIGRATIONS_DIR = new URL("../../../database/migrations", import.meta.url)
  .pathname;
const DB_AVAILABLE = APP_URL !== undefined && ADMIN_URL !== undefined;

let adminPool: pg.Pool;
let appPool: pg.Pool;

function captureId(): string {
  return `cap-${Math.random().toString(36).slice(2, 10)}`;
}

function makeThought(
  tenantId: string,
  userId: string,
  id: string,
  text: string,
  embedding: number[],
  createdAt = "2026-09-03T10:00:00.000Z",
  extra?: Partial<Thought>,
): Thought {
  return {
    id,
    tenantId,
    userId,
    summary: extra?.summary ?? text,
    text,
    confidence: 0.9,
    provenance: {
      captureId: extra?.provenance?.captureId ?? `cap-${id}`,
      segmentIds: ["seg-0"],
      sourceText: text,
      startSec: 0,
      endSec: 1,
    },
    versions: {
      organizerModel: "test",
      organizeSchemaVersion: "s",
      organizePromptVersion: "p",
    },
    embedding,
    createdAt,
    ...extra,
  };
}

function makeBucket(tenantId: string, userId: string, id: string, name: string): Bucket {
  return {
    id,
    tenantId,
    userId,
    name,
    description: `${name} bucket`,
    centroid: [],
    itemCount: 0,
    createdAt: "2026-09-03T09:00:00.000Z",
    origin: "auto",
  };
}

describe("PostgreSQL storage (Spec 3.2)", { skip: !DB_AVAILABLE }, () => {
  before(async () => {
    adminPool = createPool({ connectionString: ADMIN_URL! });
    appPool = createPool({ connectionString: APP_URL! });
  });

  after(async () => {
    await adminPool?.end();
    await appPool?.end();
  });

  it("AC-1: clean install, idempotent up, down, and re-up", async () => {
    await migrateDown(adminPool, MIGRATIONS_DIR);
    const first = await migrateUp(adminPool, MIGRATIONS_DIR);
    // Spec 6.7: migration 0002 (pending placements + canonical keys).
    assert.deepEqual(first.applied, [1, 2]);
    const second = await migrateUp(adminPool, MIGRATIONS_DIR);
    assert.deepEqual(second.applied, []);
    // All tables exist.
    const tables = await adminPool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const names = tables.rows.map((r) => r.tablename);
    for (const expected of [
      "captures",
      "transcripts",
      "buckets",
      "items",
      "memories",
      "memory_proposals",
      "memory_events",
      "consents",
      "corrections",
      "retrieval_index",
      "pending_placements",
      "schema_migrations",
    ]) {
      assert.ok(names.includes(expected), `missing table ${expected}`);
    }
    // pgvector is enabled.
    const ext = await adminPool.query(
      `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
    );
    assert.equal(ext.rows.length, 1);
    // Down rolls back cleanly, and re-up restores (rollback path).
    const down = await migrateDown(adminPool, MIGRATIONS_DIR);
    assert.deepEqual(down.rolledBack, [2, 1]);
    const after2 = await adminPool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    assert.deepEqual(after2.rows.map((r) => r.tablename), ["schema_migrations"]);
    await migrateUp(adminPool, MIGRATIONS_DIR);
  });

  it("FR-3: scoped CRUD round-trips across every store", async () => {
    const tenant = `t-${Math.random().toString(36).slice(2, 8)}`;
    const user = "u-1";
    const buckets = new PostgresBucketStore(appPool);
    const captures = new PostgresCaptureStore(appPool);
    const transcripts = new PostgresTranscriptStore(appPool);
    const memories = new PostgresMemoryStore(appPool);
    const consents = new PostgresConsentStore(appPool);
    const corrections = new PostgresCorrectionStore(appPool);

    const capId = captureId();
    await captures.saveCapture({
      id: capId,
      tenantId: tenant,
      userId: user,
      contentHash: "abc123",
      capturedAt: "2026-09-03T08:00:00.000Z",
    });
    const transcriptText = "review the vendor contract";
    await transcripts.saveTranscript({
      captureId: capId,
      tenantId: tenant,
      userId: user,
      text: transcriptText,
      segments: [{ id: "seg-0", text: transcriptText, startSec: 0, endSec: 2 }],
      model: "test-stt",
      contentHash: hashTranscriptContent({
        captureId: capId,
        tenantId: tenant,
        userId: user,
        text: transcriptText,
        segments: [{ id: "seg-0", text: transcriptText, startSec: 0, endSec: 2 }],
        model: "test-stt",
      }),
      createdAt: "2026-09-03T08:00:01.000Z",
    });
    await buckets.createBucket(makeBucket(tenant, user, "b-1", "Contracts"));
    await buckets.saveItem({
      thought: makeThought(tenant, user, "th-1", "review the vendor contract", [1, 0, 0], "2026-09-03T08:00:02.000Z", {
        provenance: { captureId: capId, segmentIds: ["seg-0"], sourceText: transcriptText, startSec: 0, endSec: 2 },
      }),
      bucketId: "b-1",
    });

    assert.equal((await captures.listCaptures(tenant, user)).length, 1);
    assert.equal((await transcripts.getTranscript(tenant, user, capId))?.text, transcriptText);
    assert.equal((await buckets.listBuckets(tenant, user)).length, 1);
    assert.equal((await buckets.listItems(tenant, user)).length, 1);
    assert.equal((await buckets.getItem(tenant, user, "th-1"))?.bucketId, "b-1");
    assert.equal((await buckets.listItemsByBucket(tenant, user, "b-1")).length, 1);
    assert.equal(
      (await buckets.listItemsInRange(tenant, user, { from: "2026-09-03T00:00:00.000Z" })).length,
      1,
    );
    assert.equal(
      (await buckets.listItemsInRange(tenant, user, { to: "2026-09-01T00:00:00.000Z" })).length,
      0,
    );

    await memories.saveMemory({
      id: "mem-1",
      tenantId: tenant,
      userId: user,
      layer: "semantic",
      status: "confirmed",
      origin: "explicit",
      text: "Prefers short summaries",
      kind: "preference",
      subject: "preference:summary-style",
      confidence: 1,
      sources: [{ kind: "explicit-statement", id: "cli-1", reason: "test" }],
      createdAt: "2026-09-03T08:00:03.000Z",
      updatedAt: "2026-09-03T08:00:03.000Z",
    });
    await memories.appendEvent({
      at: "2026-09-03T08:00:04.000Z",
      type: "stated",
      tenantId: tenant,
      userId: user,
      memoryId: "mem-1",
    });
    assert.equal((await memories.listMemories(tenant, user)).length, 1);
    assert.equal((await memories.listEvents(tenant, user)).length, 1);

    await consents.recordConsent({
      id: "con-1",
      tenantId: tenant,
      userId: user,
      purpose: "eval-sharing",
      granted: true,
      grantedAt: "2026-09-03T08:00:05.000Z",
      channel: "test",
    });
    assert.equal((await consents.listConsents(tenant, user)).length, 1);

    await corrections.saveCorrection({
      id: "cor-1",
      tenantId: tenant,
      userId: user,
      type: "bucket.move",
      createdAt: "2026-09-03T08:00:06.000Z",
      target: { kind: "thought", id: "th-1" },
      payload: { toBucketId: "b-1" },
      sources: [{ kind: "thought", id: "th-1", reason: "test" }],
      status: "pending",
      followedCount: 0,
      contradictedCount: 0,
    });
    assert.equal((await corrections.listCorrections(tenant, user)).length, 1);

    // markAudioDeleted is idempotent; deleteCapture cascades transcripts.
    await captures.markAudioDeleted(tenant, user, capId, "2026-09-03T09:00:00.000Z");
    await captures.markAudioDeleted(tenant, user, capId, "2026-09-03T09:00:00.000Z");
    await captures.deleteCapture(tenant, user, capId);
    assert.equal(await captures.getCapture(tenant, user, capId), undefined);
    assert.equal(await transcripts.getTranscript(tenant, user, capId), undefined);
  });

  it("AC-2/SR-1: database-enforced denial when app code omits filters", async () => {
    const tenantA = `t-a-${Math.random().toString(36).slice(2, 8)}`;
    const tenantB = `t-b-${Math.random().toString(36).slice(2, 8)}`;
    const buckets = new PostgresBucketStore(appPool);
    await buckets.createBucket(makeBucket(tenantA, "u-1", "b-secret", "Secret A"));
    await buckets.createBucket(makeBucket(tenantB, "u-1", "b-other", "Other B"));

    // 1. A raw client on the app role with NO scope context set sees
    //    nothing, even querying without any WHERE clause.
    const raw = await appPool.connect();
    try {
      await raw.query("BEGIN");
      const unscoped = await raw.query("SELECT * FROM buckets");
      assert.equal(unscoped.rows.length, 0);
      await raw.query("ROLLBACK");
    } finally {
      raw.release();
    }

    // 2. Scoped as tenant A, an intentionally faulty query with no
    //    tenant filter still cannot see tenant B's rows.
    const rawA = await appPool.connect();
    try {
      await rawA.query("BEGIN");
      await rawA.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
        [tenantA, "u-1"],
      );
      const faulty = await rawA.query("SELECT * FROM buckets");
      assert.equal(faulty.rows.length, 1);
      assert.equal(faulty.rows[0].name, "Secret A");

      // 3. Writes that disagree with the session scope are rejected by
      //    the WITH CHECK policy.
      await assert.rejects(
        rawA.query(
          `INSERT INTO buckets (tenant_id, user_id, id, name, description, origin, created_at)
           VALUES ($1, $2, 'b-evil', 'Evil', 'x', 'auto', now())`,
          [tenantB, "u-1"],
        ),
        /row-level security|row violates/i,
      );
      await rawA.query("ROLLBACK");
    } finally {
      rawA.release();
    }

    // 4. The adapter's own cross-scope reads return nothing.
    assert.equal((await buckets.listBuckets(tenantA, "u-2")).length, 0);
    assert.equal(
      await buckets.getItem(tenantB, "u-1", "th-that-lives-in-a"),
      undefined,
    );
  });

  it("AC-3: concurrent placements lose neither items nor centroid updates", async () => {
    const tenant = `t-${Math.random().toString(36).slice(2, 8)}`;
    const user = "u-1";
    const buckets = new PostgresBucketStore(appPool);
    await buckets.createBucket(makeBucket(tenant, user, "b-conc", "Concurrent"));

    // 8 concurrent saveItem calls against the same bucket — the exact
    // read-modify-write race the file store loses.
    const N = 8;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        buckets.saveItem({
          thought: makeThought(
            tenant,
            user,
            `th-c${i}`,
            `concurrent thought ${i}`,
            [i + 1, 0],
            `2026-09-03T10:0${i}:00.000Z`,
          ),
          bucketId: "b-conc",
        }),
      ),
    );

    const items = await buckets.listItems(tenant, user);
    assert.equal(items.length, N);
    const [bucket] = await buckets.listBuckets(tenant, user);
    assert.equal(bucket!.itemCount, N);
    // Exact centroid: mean of [1..8, 0] = [4.5, 0].
    assert.ok(Math.abs(bucket!.centroid[0]! - 4.5) < 1e-4);
    assert.ok(Math.abs(bucket!.centroid[1]!) < 1e-4);
  });

  it("FR-2: concurrent stats updates retry safely (version stays consistent)", async () => {
    const tenant = `t-${Math.random().toString(36).slice(2, 8)}`;
    const user = "u-1";
    const buckets = new PostgresBucketStore(appPool);
    await buckets.createBucket(makeBucket(tenant, user, "b-opt", "Optimistic"));

    // Five concurrent absolute stats writes: every one applies or
    // retries; the version reflects exactly five increments.
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        buckets.updateBucketStats(tenant, user, "b-opt", [i, 0], i),
      ),
    );
    const [bucket] = await buckets.listBuckets(tenant, user);
    const versionRow = await adminPool.query<{ version: number }>(
      `SELECT version FROM buckets WHERE tenant_id = $1 AND user_id = $2 AND id = 'b-opt'`,
      [tenant, user],
    );
    assert.equal(versionRow.rows[0]!.version, 1 + 5);
    // The final value is one of the writers' — never a torn mix.
    assert.ok([0, 1, 2, 3, 4].includes(bucket!.itemCount));
  });

  it("transcript tampering fails the integrity check on read", async () => {
    const tenant = `t-${Math.random().toString(36).slice(2, 8)}`;
    const user = "u-1";
    const captures = new PostgresCaptureStore(appPool);
    const transcripts = new PostgresTranscriptStore(appPool);
    const capId = captureId();
    await captures.saveCapture({
      id: capId,
      tenantId: tenant,
      userId: user,
      contentHash: "hash",
      capturedAt: "2026-09-03T08:00:00.000Z",
    });
    const text = "original words";
    const segments = [{ id: "seg-0", text, startSec: 0, endSec: 1 }];
    await transcripts.saveTranscript({
      captureId: capId,
      tenantId: tenant,
      userId: user,
      text,
      segments,
      model: "test-stt",
      contentHash: hashTranscriptContent({
        captureId: capId, tenantId: tenant, userId: user, text, segments, model: "test-stt",
      }),
      createdAt: "2026-09-03T08:00:01.000Z",
    });
    // Tamper directly as admin (bypasses the app path entirely).
    await adminPool.query(
      `UPDATE transcripts SET text = 'tampered words'
        WHERE tenant_id = $1 AND user_id = $2 AND capture_id = $3`,
      [tenant, user, capId],
    );
    await assert.rejects(
      transcripts.getTranscript(tenant, user, capId),
      /content-integrity/,
    );
  });

  it("AC-4: file fixtures import once without duplicates", async () => {
    const tenant = `t-${Math.random().toString(36).slice(2, 8)}`;
    const user = "u-1";
    const dataDir = await mkdtemp(join(tmpdir(), "donna-import-"));
    try {
      const fileBuckets = new FileBucketStore(dataDir);
      const fileCaptures = new FileCaptureStore(dataDir);
      const fileTranscripts = new FileTranscriptStore(dataDir);
      await fileBuckets.createBucket(makeBucket(tenant, user, "b-f", "FileBucket"));
      await fileBuckets.saveItem({
        thought: makeThought(tenant, user, "th-f1", "from the file store", [1, 0]),
        bucketId: "b-f",
      });
      await fileCaptures.saveCapture({
        id: "cap-file",
        tenantId: tenant,
        userId: user,
        contentHash: "filehash",
        capturedAt: "2026-09-03T07:00:00.000Z",
      });
      const fText = "file transcript";
      const fSegs = [{ id: "seg-0", text: fText, startSec: 0, endSec: 1 }];
      await fileTranscripts.saveTranscript({
        captureId: "cap-file",
        tenantId: tenant,
        userId: user,
        text: fText,
        segments: fSegs,
        model: "test-stt",
        contentHash: hashTranscriptContent({
          captureId: "cap-file", tenantId: tenant, userId: user, text: fText, segments: fSegs, model: "test-stt",
        }),
        createdAt: "2026-09-03T07:00:01.000Z",
      });

      const pgBuckets = new PostgresBucketStore(appPool);
      const pgCaptures = new PostgresCaptureStore(appPool);
      const pgTranscripts = new PostgresTranscriptStore(appPool);
      const source = { buckets: fileBuckets, captures: fileCaptures, transcripts: fileTranscripts };
      const target = { buckets: pgBuckets, captures: pgCaptures, transcripts: pgTranscripts };

      const first = await importFileFixtures(source, target, { tenantId: tenant, userId: user });
      assert.deepEqual(first, { buckets: 1, captures: 1, transcripts: 1, items: 1 });
      const second = await importFileFixtures(source, target, { tenantId: tenant, userId: user });
      assert.equal(second.buckets, 0); // no duplicate buckets
      assert.equal((await pgBuckets.listBuckets(tenant, user)).length, 1);
      assert.equal((await pgBuckets.listItems(tenant, user)).length, 1);
      assert.equal((await pgCaptures.listCaptures(tenant, user)).length, 1);
      // Bucket stats were recomputed from the imported items.
      const [bucket] = await pgBuckets.listBuckets(tenant, user);
      assert.equal(bucket!.itemCount, 1);
      assert.deepEqual(bucket!.centroid, [1, 0]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("retrieval projection: search, filters, deletion, rebuild (AC-5)", async () => {
    const tenant = `t-${Math.random().toString(36).slice(2, 8)}`;
    const user = "u-1";
    const buckets = new PostgresBucketStore(appPool);
    const index = new PostgresRetrievalIndex({ pool: appPool });
    await buckets.createBucket(makeBucket(tenant, user, "b-h", "Hiring"));
    await buckets.createBucket(makeBucket(tenant, user, "b-e", "Errands"));
    await buckets.saveItem({
      thought: makeThought(tenant, user, "th-h1", "interview the backend candidate", [1, 0, 0], "2026-09-01T10:00:00.000Z"),
      bucketId: "b-h",
    });
    await buckets.saveItem({
      thought: makeThought(tenant, user, "th-e1", "pick up groceries for the offsite", [0, 0, 1], "2026-09-03T10:00:00.000Z", {
        task: { title: "Pick up groceries", assigneeHint: "Meera" },
      }),
      bucketId: "b-e",
    });

    // Text search.
    let hits = await index.search({ tenantId: tenant, userId: user, text: "backend candidate" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.thought.id, "th-h1");
    assert.equal(hits[0]!.bucketName, "Hiring");
    assert.equal(hits[0]!.thought.provenance.captureId, "cap-th-h1");

    // Semantic search via pgvector.
    hits = await index.search({ tenantId: tenant, userId: user, embedding: [0, 0.05, 1] });
    assert.equal(hits[0]!.thought.id, "th-e1");
    assert.ok(hits[0]!.scores.semantic > 0.9);

    // Filters: bucket, time, task, person.
    hits = await index.search({
      tenantId: tenant, userId: user, text: "the",
      filters: { bucketIds: ["b-e"] },
    });
    assert.deepEqual(hits.map((h) => h.thought.id), ["th-e1"]);
    hits = await index.search({
      tenantId: tenant, userId: user, text: "the",
      filters: { createdFrom: "2026-09-02T00:00:00.000Z" },
    });
    assert.deepEqual(hits.map((h) => h.thought.id), ["th-e1"]);
    hits = await index.search({
      tenantId: tenant, userId: user, text: "the", filters: { hasTask: true },
    });
    assert.deepEqual(hits.map((h) => h.thought.id), ["th-e1"]);
    hits = await index.search({
      tenantId: tenant, userId: user, text: "the", filters: { people: ["meera"] },
    });
    assert.deepEqual(hits.map((h) => h.thought.id), ["th-e1"]);

    // Cross-tenant search sees nothing (RLS + explicit predicates).
    hits = await index.search({ tenantId: `${tenant}-x`, userId: user, text: "the" });
    assert.equal(hits.length, 0);

    // Rebuild is idempotent and restores deleted projection rows.
    await index.removeThought(tenant, user, "th-h1");
    assert.equal(
      (await index.search({ tenantId: tenant, userId: user, text: "backend" })).length,
      0,
    );
    const rebuilt = await index.rebuild(tenant, user);
    assert.equal(rebuilt.indexed, 2);
    assert.equal(
      (await index.search({ tenantId: tenant, userId: user, text: "backend" })).length,
      1,
    );

    // Deleting the capture's items removes the projection rows (cascade).
    await buckets.deleteItemsForCapture(tenant, user, "cap-th-h1");
    assert.equal(
      (await index.search({ tenantId: tenant, userId: user, text: "backend" })).length,
      0,
    );
  });

  it("AC-5: backup and restore preserve all scoped rows", async (t) => {
    if (BACKUP_URL === undefined) {
      t.skip("no backup URL configured");
      return;
    }
    const tenant = `t-${Math.random().toString(36).slice(2, 8)}`;
    const user = "u-1";
    const buckets = new PostgresBucketStore(appPool);
    await buckets.createBucket(makeBucket(tenant, user, "b-bak", "Backup"));
    await buckets.saveItem({
      thought: makeThought(tenant, user, "th-bak", "backup me", [1, 0]),
      bucketId: "b-bak",
    });

    const dumpDir = await mkdtemp(join(tmpdir(), "donna-backup-"));
    const dumpPath = join(dumpDir, "donna_test.sql");
    const restoreDb = `donna_restore_${Math.random().toString(36).slice(2, 8)}`;
    try {
      // The backup role (BYPASSRLS) still needs table privileges — the
      // documented backup setup grants SELECT on everything, including
      // the migrations ledger.
      const backupRole = /\/(\w+)(:.*)?@/.exec(BACKUP_URL)?.[1];
      if (backupRole !== undefined && backupRole !== "postgres") {
        await adminPool.query(
          `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${backupRole}`,
        );
        // pg_dump reads identity/serial sequence values too.
        await adminPool.query(
          `GRANT SELECT, USAGE ON ALL SEQUENCES IN SCHEMA public TO ${backupRole}`,
        );
      }
      await execFileAsync("pg_dump", [
        BACKUP_URL,
        "--no-owner",
        "--no-privileges",
        "-f",
        dumpPath,
      ]);
      await adminPool.query(`CREATE DATABASE ${restoreDb}`);
      await execFileAsync("psql", [ADMIN_URL!.replace(/\/[^/]+$/, `/${restoreDb}`), "-v", "ON_ERROR_STOP=1", "-f", dumpPath]);

      const restored = createPool({
        connectionString: ADMIN_URL!.replace(/\/[^/]+$/, `/${restoreDb}`),
      });
      try {
        const counts = await restored.query<{ c: number }>(
          `SELECT count(*)::integer AS c FROM items WHERE tenant_id = $1 AND user_id = $2`,
          [tenant, user],
        );
        assert.equal(counts.rows[0]!.c, 1);
        const bucketCounts = await restored.query<{ c: number }>(
          `SELECT count(*)::integer AS c FROM buckets WHERE tenant_id = $1 AND user_id = $2`,
          [tenant, user],
        );
        assert.equal(bucketCounts.rows[0]!.c, 1);
        // The retrieval projection survived the round trip too.
        const projection = await restored.query<{ c: number }>(
          `SELECT count(*)::integer AS c FROM retrieval_index WHERE tenant_id = $1 AND user_id = $2`,
          [tenant, user],
        );
        assert.equal(projection.rows[0]!.c, 1);
      } finally {
        await restored.end();
      }
    } finally {
      await adminPool.query(`DROP DATABASE IF EXISTS ${restoreDb}`);
      await rm(dumpDir, { recursive: true, force: true });
    }
  });

  /* ------------------ Spec 6.7: pending placements ------------------ */

  it("6.7: migration 0002 down refuses to drop unresolved pending placements", async () => {
    await migrateUp(adminPool, MIGRATIONS_DIR);
    const pending = new PostgresPendingPlacementStore(appPool);
    const tenant = `t-${Math.random().toString(36).slice(2, 8)}`;
    await pending.save(pendingRecord(tenant, "u-1", "pp-mig"));
    await assert.rejects(
      migrateDown(adminPool, MIGRATIONS_DIR, 1),
      /unresolved pending/,
    );
    await pending.deleteAll(tenant, "u-1");
    // Once resolved/exported, down to 1 and re-up both work.
    const down = await migrateDown(adminPool, MIGRATIONS_DIR, 1);
    assert.deepEqual(down.rolledBack, [2]);
    await migrateUp(adminPool, MIGRATIONS_DIR);
  });

  it("6.7: canonical-name uniqueness is enforced per user (file-store parity)", async () => {
    const buckets = new PostgresBucketStore(appPool);
    const tenant = `t-${Math.random().toString(36).slice(2, 8)}`;
    await buckets.createBucket(makeBucket(tenant, "u-1", `b-${tenant}-1`, "Vendor Contracts"));
    // Same canonical key (case/whitespace fold) fails closed.
    await assert.rejects(
      buckets.createBucket(makeBucket(tenant, "u-1", `b-${tenant}-2`, "vendor  contracts")),
    );
    // A different user in the same tenant may reuse the name (scoped).
    await buckets.createBucket(makeBucket(tenant, "u-2", `b-${tenant}-3`, "Vendor Contracts"));
    // Rename into a colliding canonical key fails closed.
    await buckets.createBucket(makeBucket(tenant, "u-1", `b-${tenant}-4`, "Vendor Portal"));
    await assert.rejects(
      buckets.renameBucket(tenant, "u-1", `b-${tenant}-4`, "vendor contracts"),
    );
  });

  it("6.7: pending placements persist, resolve idempotently, and stay RLS-scoped", async () => {
    const pending = new PostgresPendingPlacementStore(appPool);
    const tenant = `t-${Math.random().toString(36).slice(2, 8)}`;
    await pending.save(pendingRecord(tenant, "u-1", "pp-1"));
    assert.equal((await pending.list(tenant, "u-1", "pending")).length, 1);
    // RLS: another scope sees nothing.
    assert.equal((await pending.list(tenant, "u-other")).length, 0);

    const resolution = {
      action: "create" as const,
      bucketId: "b-1",
      name: "Vendor Contracts",
      audit: "user-confirmed",
    };
    const first = await pending.markResolved(tenant, "u-1", "pp-1", resolution, "2026-09-05T01:00:00.000Z");
    assert.equal(first.status, "resolved");
    // Identical replay is a no-op; a conflicting replay fails closed.
    const replay = await pending.markResolved(tenant, "u-1", "pp-1", resolution, "2026-09-05T01:00:00.000Z");
    assert.equal(replay.status, "resolved");
    await assert.rejects(
      pending.markResolved(tenant, "u-1", "pp-1", { action: "reject", audit: "user-rejected" }, "2026-09-05T01:00:00.000Z"),
      /different action/,
    );
    // Deletion propagation by capture.
    const removed = await pending.deleteForCapture(tenant, "u-1", "cap-pg");
    assert.equal(removed.removed, 1);
    assert.equal((await pending.list(tenant, "u-1")).length, 0);
  });
});
