/**
 * Specification 5.3 — OneDrive Markdown destination tests.
 *
 * Scripted MCP connections only — no network, no credentials, no real
 * Microsoft content. Consent runs against the real FileConsentStore
 * through the real MemoryService in a temp data dir.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type {
  Bucket,
  BucketStore,
  McpConnection,
  McpToolResult,
  Thought,
} from "@donna/core";
import { sha256Hex } from "@donna/core";
import { FileConsentStore, FileMemoryStore, MemoryService } from "@donna/memory";
import { bucketDocumentName, renderBucketMarkdown } from "@donna/destinations";
import {
  BucketNotFoundError,
  OneDriveDestinationError,
  OneDriveMarkdownDestination,
  PreviewStaleError,
} from "./onedrive-markdown.js";
import { M365ConsentError } from "./connection.js";

const SCOPE = { tenantId: "t1", userId: "u1" };
const OTHER = { tenantId: "t1", userId: "u2" };
const NOW = new Date("2026-09-03T12:00:00.000Z");

class FakeConnection implements McpConnection {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  constructor(
    private readonly handler: (
      name: string,
      args: Record<string, unknown>,
    ) => McpToolResult,
  ) {}
  async initialize(): Promise<{ serverName: string }> {
    return { serverName: "fake" };
  }
  async listTools(): Promise<Array<{ name: string }>> {
    return [];
  }
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<McpToolResult> {
    this.calls.push({ name, args });
    return this.handler(name, args);
  }
}

function ok(payload: unknown): McpToolResult {
  return { isError: false, content: [{ type: "text", text: JSON.stringify(payload) }] };
}
function err(): McpToolResult {
  return { isError: true, content: [{ type: "text", text: "server-side detail that must not leak" }] };
}

const BUCKET: Bucket = {
  id: "bucket-1",
  tenantId: SCOPE.tenantId,
  userId: SCOPE.userId,
  name: "Tasks",
  description: "Things to do",
  centroid: [],
  itemCount: 1,
  createdAt: "2026-09-01T09:00:00.000Z",
  origin: "auto",
};

function thought(id: string, text: string): Thought {
  return {
    id,
    tenantId: SCOPE.tenantId,
    userId: SCOPE.userId,
    summary: `Summary ${id}`,
    text,
    confidence: 0.9,
    provenance: { captureId: "cap-1", segmentIds: ["s1"], sourceText: text, startSec: 0, endSec: 2 },
    versions: { organizerModel: "m", organizeSchemaVersion: "v1", organizePromptVersion: "p1" },
    createdAt: "2026-09-02T10:00:00.000Z",
  };
}

class StubBucketStore implements BucketStore {
  items: Array<{ thought: Thought; bucketId: string }> = [];
  constructor(public buckets: Bucket[] = [BUCKET]) {}
  async listBuckets(t: string, u: string): Promise<Bucket[]> {
    return this.buckets.filter((b) => b.tenantId === t && b.userId === u);
  }
  async getBucketById(t: string, u: string, bucketId: string) {
    return this.buckets.find((b) => b.tenantId === t && b.userId === u && b.id === bucketId);
  }
  async getBucketByName(t: string, u: string, name: string) {
    return this.buckets.find((b) => b.tenantId === t && b.userId === u && b.name === name);
  }
  async createBucket(b: Bucket): Promise<Bucket> {
    return b;
  }
  async updateBucketStats(): Promise<void> {}
  async saveItem(): Promise<void> {}
  async listItems() {
    return this.items;
  }
  async getItem() {
    return undefined;
  }
  async listItemsByBucket(t: string, u: string, bucketId: string) {
    return this.items.filter((i) => i.bucketId === bucketId);
  }
  async listItemsInRange() {
    return [];
  }
  async deleteItemsForCapture() {
    return { removed: 0 };
  }
  async moveItem(): Promise<void> {}
  async renameBucket(): Promise<void> {}
  async mergeBuckets(): Promise<void> {}
  async updateItem(): Promise<void> {}
}

/** In-memory OneDrive: root listing, folder creation, upload/download/share. */
function fakeDrive(initial: { folders?: string[] } = {}) {
  const folders = new Set(initial.folders ?? []);
  const files = new Map<string, { name: string; parent: string; content: string }>();
  let fileSeq = 0;
  const handler = (name: string, args: Record<string, unknown>): McpToolResult => {
    if (name === "list_files") {
      if (args["folder_id"] === undefined) {
        return ok([...folders].map((n, i) => ({ id: `folder-${n}`, name: n, folder: {} })));
      }
      const parent = String(args["folder_id"]);
      return ok(
        [...files.entries()]
          .filter(([, f]) => f.parent === parent)
          .map(([id, f]) => ({ id, name: f.name })),
      );
    }
    if (name === "create_folder") {
      const folderName = String(args["name"]);
      folders.add(folderName);
      return ok({ id: `folder-${folderName}`, name: folderName, folder: {} });
    }
    if (name === "upload_file") {
      const nameArg = String(args["name"]);
      const parent = String(args["parent_id"]);
      const content = Buffer.from(String(args["content_base64"]), "base64").toString("utf8");
      const existing = [...files.entries()].find(([, f]) => f.parent === parent && f.name === nameArg);
      if (existing !== undefined) {
        existing[1].content = content;
        return ok({ id: existing[0] });
      }
      const id = `file-${fileSeq++}`;
      files.set(id, { name: nameArg, parent, content });
      return ok({ id });
    }
    if (name === "download_file") {
      const file = files.get(String(args["item_id"]));
      if (file === undefined) return err();
      return ok({
        contentType: "text/markdown",
        sizeBytes: file.content.length,
        base64: Buffer.from(file.content, "utf8").toString("base64"),
      });
    }
    if (name === "share_file") {
      return ok({
        id: `perm-${String(args["item_id"])}`,
        link: { scope: "organization", type: "view", webUrl: `https://share.test/${String(args["item_id"])}` },
      });
    }
    if (name === "get_file") {
      const file = files.get(String(args["item_id"]));
      return file === undefined ? err() : ok({ id: args["item_id"], name: file.name });
    }
    return err();
  };
  const connection = new FakeConnection(handler);
  return { connection, files, folders, handler };
}

const dirs: string[] = [];
async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "donna-od-"));
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
    now: () => NOW,
  });
}

async function consentedDestination(
  dir: string,
  connection: FakeConnection,
  buckets: StubBucketStore,
): Promise<OneDriveMarkdownDestination> {
  const memory = memoryService(dir);
  await memory.grantConsent(SCOPE, "m365.destination.onedrive", "test");
  return new OneDriveMarkdownDestination({
    connection,
    consents: memory,
    buckets,
    dataDir: dir,
    now: () => NOW,
  });
}

describe("OneDriveMarkdownDestination (Spec 5.3)", () => {
  it("preview and commit fail closed without destination consent (SR-1)", async () => {
    const dir = await tempDataDir();
    const { connection } = fakeDrive();
    const destination = new OneDriveMarkdownDestination({
      connection,
      consents: memoryService(dir),
      buckets: new StubBucketStore(),
      dataDir: dir,
      now: () => NOW,
    });
    await assert.rejects(destination.preview(SCOPE, BUCKET.id), M365ConsentError);
    await assert.rejects(
      destination.commit(SCOPE, {
        kind: "onedrive-markdown",
        target: { folder: "Donna/", documentName: "x.md" },
        content: "x",
        contentHash: sha256Hex("x"),
        noOp: false,
      }),
      M365ConsentError,
    );
    assert.equal(connection.calls.length, 0, "no MCP call without consent");
  });

  it("AC-1: preview → approve → commit creates Donna/, uploads, shares org-scoped, writes back", async () => {
    const dir = await tempDataDir();
    const buckets = new StubBucketStore();
    buckets.items.push({ thought: thought("t-1", "do the thing"), bucketId: BUCKET.id });
    const drive = fakeDrive();
    const destination = await consentedDestination(dir, drive.connection, buckets);

    const preview = await destination.preview(SCOPE, BUCKET.id);
    assert.equal(preview.target.folder, "Donna/");
    assert.equal(preview.target.documentName, bucketDocumentName(BUCKET));
    assert.equal(preview.content, renderBucketMarkdown(BUCKET, buckets.items));
    assert.equal(preview.noOp, false);
    assert.equal(preview.existingHash, undefined);

    await destination.savePendingPreview(SCOPE, BUCKET.id, preview);
    const pending = await destination.loadPendingPreview(SCOPE, BUCKET.id);
    assert.ok(pending !== undefined);

    const commit = await destination.commit(SCOPE, pending.preview);
    assert.equal(commit.noOp, false);
    assert.equal(commit.contentHash, preview.contentHash);
    assert.match(commit.link ?? "", /^https:\/\/share\.test\//);

    const tools = drive.connection.calls.map((c) => c.name);
    assert.ok(tools.includes("create_folder"), "folder created once");
    assert.ok(tools.includes("upload_file"));
    const share = drive.connection.calls.find((c) => c.name === "share_file");
    assert.equal(share?.args["scope"], "organization");

    const state = await destination.state(SCOPE, BUCKET.id);
    assert.equal(state?.status, undefined, "state written only via recordCommit");

    await destination.recordCommit(SCOPE, BUCKET.id, BUCKET.name, preview.target.documentName, commit);
    const recorded = await destination.state(SCOPE, BUCKET.id);
    assert.equal(recorded?.status, "published");
    assert.equal(recorded?.itemId, commit.itemId);
    assert.equal(recorded?.contentHash, commit.contentHash);
    assert.equal(recorded?.link, commit.link);
    assert.equal(await destination.loadPendingPreview(SCOPE, BUCKET.id), undefined, "pending cleared");
  });

  it("AC-2: re-publishing unchanged state is a byte-identical no-op (no upload)", async () => {
    const dir = await tempDataDir();
    const buckets = new StubBucketStore();
    buckets.items.push({ thought: thought("t-1", "same content"), bucketId: BUCKET.id });
    const drive = fakeDrive();
    const destination = await consentedDestination(dir, drive.connection, buckets);

    const first = await destination.commit(SCOPE, await destination.preview(SCOPE, BUCKET.id));
    await destination.recordCommit(SCOPE, BUCKET.id, BUCKET.name, bucketDocumentName(BUCKET), first);
    const uploadsAfterFirst = drive.connection.calls.filter((c) => c.name === "upload_file").length;

    const secondPreview = await destination.preview(SCOPE, BUCKET.id);
    assert.equal(secondPreview.noOp, true, "preview detects byte-identical remote");
    assert.equal(secondPreview.existingHash, secondPreview.contentHash);

    const second = await destination.commit(SCOPE, secondPreview);
    assert.equal(second.noOp, true);
    assert.equal(second.itemId, first.itemId, "same file, never a duplicate");
    assert.equal(
      drive.connection.calls.filter((c) => c.name === "upload_file").length,
      uploadsAfterFirst,
      "no upload on no-op republish",
    );
    assert.equal(drive.files.size, 1);
  });

  it("AC-2: changed state re-publishes in place under the same document name", async () => {
    const dir = await tempDataDir();
    const buckets = new StubBucketStore();
    buckets.items.push({ thought: thought("t-1", "v1"), bucketId: BUCKET.id });
    const drive = fakeDrive();
    const destination = await consentedDestination(dir, drive.connection, buckets);

    const first = await destination.commit(SCOPE, await destination.preview(SCOPE, BUCKET.id));
    await destination.recordCommit(SCOPE, BUCKET.id, BUCKET.name, bucketDocumentName(BUCKET), first);

    buckets.items.push({ thought: thought("t-2", "v2 adds an item"), bucketId: BUCKET.id });
    const secondPreview = await destination.preview(SCOPE, BUCKET.id);
    assert.equal(secondPreview.noOp, false);
    assert.notEqual(secondPreview.existingHash, secondPreview.contentHash);
    const second = await destination.commit(SCOPE, secondPreview);
    assert.equal(second.noOp, false);
    assert.equal(second.itemId, first.itemId, "overwrite in place — same item ID");
    assert.equal(drive.files.size, 1, "never a duplicate file");
    const stored = [...drive.files.values()][0]!;
    assert.match(stored.content, /v2 adds an item/);
  });

  it("commit refuses when live state no longer matches the approved preview", async () => {
    const dir = await tempDataDir();
    const buckets = new StubBucketStore();
    buckets.items.push({ thought: thought("t-1", "v1"), bucketId: BUCKET.id });
    const drive = fakeDrive();
    const destination = await consentedDestination(dir, drive.connection, buckets);

    const preview = await destination.preview(SCOPE, BUCKET.id);
    buckets.items.push({ thought: thought("t-2", "changed after approval"), bucketId: BUCKET.id });
    await assert.rejects(destination.commit(SCOPE, preview), PreviewStaleError);
    assert.equal(
      drive.connection.calls.filter((c) => c.name === "upload_file").length,
      0,
      "nothing written for a stale preview",
    );
  });

  it("AC-4: a non-organization share scope fails closed and is never recorded", async () => {
    const dir = await tempDataDir();
    const buckets = new StubBucketStore();
    buckets.items.push({ thought: thought("t-1", "x"), bucketId: BUCKET.id });
    const drive = fakeDrive();
    const memory = memoryService(dir);
    await memory.grantConsent(SCOPE, "m365.destination.onedrive", "test");
    // Corrupt the share response to an anonymous link.
    const evil = new FakeConnection((name, args) => {
      if (name === "share_file") {
        return ok({ link: { scope: "anonymous", type: "view", webUrl: "https://anon.test/x" } });
      }
      return drive.handler(name, args);
    });
    const evilDestination = new OneDriveMarkdownDestination({
      connection: evil,
      consents: memoryService(dir),
      buckets,
      dataDir: dir,
      now: () => NOW,
    });
    const preview = await evilDestination.preview(SCOPE, BUCKET.id);
    await assert.rejects(
      evilDestination.commit(SCOPE, preview),
      (error: unknown) => {
        assert.ok(error instanceof OneDriveDestinationError);
        assert.equal(error.stage, "share-scope");
        assert.ok(!error.message.includes("anon.test"));
        return true;
      },
    );
    assert.equal(await evilDestination.state(SCOPE, BUCKET.id), undefined);
  });

  it("SR-4: tool errors surface redacted (no server detail, no content)", async () => {
    const dir = await tempDataDir();
    const buckets = new StubBucketStore();
    buckets.items.push({ thought: thought("t-1", "x"), bucketId: BUCKET.id });
    const connection = new FakeConnection(() => err());
    const destination = await consentedDestination(dir, connection, buckets);
    await assert.rejects(destination.preview(SCOPE, BUCKET.id), (error: unknown) => {
      assert.ok(error instanceof OneDriveDestinationError);
      assert.ok(!error.message.includes("server-side detail"));
      return true;
    });
  });

  it("SR-2: the target folder is pinned — no API accepts another location", async () => {
    const dir = await tempDataDir();
    const drive = fakeDrive({ folders: ["Donna"] });
    const destination = await consentedDestination(dir, drive.connection, new StubBucketStore());
    const preview = await destination.preview(SCOPE, BUCKET.id);
    assert.equal(preview.target.folder, "Donna/");
    // There is no folder parameter anywhere on the public surface.
    assert.equal(Object.keys(preview.target).sort().join(","), "documentName,folder");
  });

  it("cross-scope: another partition's bucket is invisible (fail closed)", async () => {
    const dir = await tempDataDir();
    const drive = fakeDrive();
    const destination = await consentedDestination(dir, drive.connection, new StubBucketStore());
    const memory = memoryService(dir);
    await memory.grantConsent(OTHER, "m365.destination.onedrive", "test");
    await assert.rejects(destination.preview(OTHER, BUCKET.id), BucketNotFoundError);
  });

  it("existing Donna folder is reused — create_folder is not called again", async () => {
    const dir = await tempDataDir();
    const buckets = new StubBucketStore();
    buckets.items.push({ thought: thought("t-1", "x"), bucketId: BUCKET.id });
    const drive = fakeDrive({ folders: ["Donna"] });
    const destination = await consentedDestination(dir, drive.connection, buckets);
    await destination.commit(SCOPE, await destination.preview(SCOPE, BUCKET.id));
    assert.equal(
      drive.connection.calls.filter((c) => c.name === "create_folder").length,
      0,
    );
  });
});
