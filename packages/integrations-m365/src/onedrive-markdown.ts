/**
 * OneDrive Markdown destination (Specification 5.3) over the managed MCP.
 *
 * Publishes approved bucket content as Markdown documents in the
 * employee's own OneDrive `Donna/` folder — one document per bucket:
 *
 *   - FR-1: preview shows the exact folder, document name, and rendered
 *     content (hash) before commit; commit re-renders and refuses when
 *     live state no longer matches the approved preview.
 *   - FR-2: content is a deterministic function of bucket state;
 *     re-publishing unchanged state is a byte-identical no-op (remote
 *     content is downloaded and hashed), changes overwrite the SAME file
 *     in place (verified live: upload_file keeps the item ID). No
 *     duplicate files, ever.
 *   - FR-3: Donna stays source of truth; write-back state (item ID,
 *     organization link, content hash) is recorded per bucket.
 *   - SR-1: preview AND commit require active m365.destination.onedrive
 *     consent; the CLI adds the explicit approval step.
 *   - SR-2: the target is hard-pinned to the drive-root `Donna/` folder —
 *     there is no API to select any other location.
 *   - SR-3: rendered by @donna/destinations with HTML escaped.
 *   - SR-4: MCP errors surface as redacted stage/status tokens only.
 *   - AC-4: share links are organization-scoped; the response scope is
 *     verified and anything else fails closed.
 */
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  sha256Hex,
  type BucketStore,
  type Destination,
  type DestinationCommit,
  type DestinationPreview,
  type McpConnection,
} from "@donna/core";
import { bucketDocumentName, renderBucketMarkdown } from "@donna/destinations";
import { writePrivateFile } from "@donna/file-security";
import {
  m365ScopeDir,
  requireM365Consent,
  type M365ConsentGate,
} from "./connection.js";
import { mcpItems, mcpJsonContent } from "./snippets.js";

const DESTINATION_CONSENT = "m365.destination.onedrive" as const;

/** The MCP tools this destination needs — the approval-path allowlist. */
export const ONEDRIVE_DESTINATION_TOOLS = [
  "list_files",
  "create_folder",
  "get_file",
  "download_file",
  "upload_file",
  "share_file",
] as const;

export class BucketNotFoundError extends Error {
  constructor() {
    super("Bucket does not exist in the requested tenant/user scope");
    this.name = "BucketNotFoundError";
  }
}

/** Live bucket state changed since the approved preview — re-preview. */
export class PreviewStaleError extends Error {
  constructor() {
    super(
      "Bucket state changed since the approved preview. Preview again before approving.",
    );
    this.name = "PreviewStaleError";
  }
}

/** Redacted destination failure: stage + classification token only (SR-4). */
export class OneDriveDestinationError extends Error {
  constructor(
    readonly stage:
      | "list"
      | "ensure-folder"
      | "download"
      | "upload"
      | "share"
      | "share-scope",
    detail: string,
  ) {
    super(`${stage}: ${detail}`);
    this.name = "OneDriveDestinationError";
  }
}

/** Donna-side write-back record for one published bucket (FR-3). */
export interface OneDriveDestinationState {
  bucketId: string;
  bucketName: string;
  documentName: string;
  itemId?: string;
  link?: string;
  contentHash?: string;
  publishedAt?: string;
  status: "published" | "error";
  /** Redacted error token, when status is "error". */
  error?: string;
}

interface Scope {
  tenantId: string;
  userId: string;
}

interface DriveItem {
  id: string;
  name?: string;
  folder?: unknown;
}

export interface OneDriveMarkdownDestinationDeps {
  /** Approval-path MCP connection allowlisted to ONEDRIVE_DESTINATION_TOOLS. */
  connection: McpConnection;
  consents: M365ConsentGate;
  buckets: BucketStore;
  dataDir: string;
  now?: () => Date;
  /** Drive-root folder name (default "Donna"). The ONLY target folder. */
  folderName?: string;
}

export class OneDriveMarkdownDestination implements Destination {
  readonly kind = "onedrive-markdown";
  private readonly now: () => Date;
  private readonly folderName: string;

  constructor(private readonly deps: OneDriveMarkdownDestinationDeps) {
    this.now = deps.now ?? (() => new Date());
    this.folderName = deps.folderName ?? "Donna";
  }

  private stateDir(scope: Scope): string {
    return join(m365ScopeDir(this.deps.dataDir, scope), "destinations");
  }

  private stateFile(scope: Scope, bucketId: string): string {
    return join(this.stateDir(scope), `${sha256Hex(bucketId)}.json`);
  }

  /** Recorded write-back state for one bucket, when present. */
  async state(scope: Scope, bucketId: string): Promise<OneDriveDestinationState | undefined> {
    try {
      return JSON.parse(
        await readFile(this.stateFile(scope, bucketId), "utf8"),
      ) as OneDriveDestinationState;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  private async saveState(scope: Scope, state: OneDriveDestinationState): Promise<void> {
    await writePrivateFile(
      this.stateFile(scope, state.bucketId),
      JSON.stringify(state, null, 2),
    );
  }

  /** Pending (approved-awaiting) preview record for the two-step CLI. */
  async savePendingPreview(scope: Scope, bucketId: string, preview: DestinationPreview): Promise<void> {
    await writePrivateFile(
      join(this.stateDir(scope), `pending-${sha256Hex(bucketId)}.json`),
      JSON.stringify({ bucketId, preview, previewedAt: this.now().toISOString() }, null, 2),
    );
  }

  async loadPendingPreview(
    scope: Scope,
    bucketId: string,
  ): Promise<{ bucketId: string; preview: DestinationPreview; previewedAt: string } | undefined> {
    try {
      return JSON.parse(
        await readFile(join(this.stateDir(scope), `pending-${sha256Hex(bucketId)}.json`), "utf8"),
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async clearPendingPreview(scope: Scope, bucketId: string): Promise<void> {
    await rm(join(this.stateDir(scope), `pending-${sha256Hex(bucketId)}.json`), {
      force: true,
    });
  }

  /* ------------------------------ internals ------------------------------ */

  private async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.deps.connection.callTool(tool, args);
    if (result.isError) {
      throw new OneDriveDestinationError(
        tool === "list_files" ? "list" : tool === "download_file" ? "download" : tool === "upload_file" ? "upload" : tool === "share_file" ? "share" : "ensure-folder",
        "tool returned an error result (detail redacted)",
      );
    }
    return mcpJsonContent(result.content);
  }

  private async listChildren(folderId?: string): Promise<DriveItem[]> {
    const payload = await this.call("list_files", {
      top: 200,
      ...(folderId !== undefined ? { folder_id: folderId } : {}),
    });
    return mcpItems(payload) as DriveItem[];
  }

  /** Find the drive-root Donna folder; create it only when missing. */
  private async ensureFolder(): Promise<{ id: string; created: boolean }> {
    const root = await this.listChildren();
    const existing = root.find(
      (item) => item.name === this.folderName && item.folder !== undefined,
    );
    if (existing !== undefined) return { id: existing.id, created: false };
    const created = (await this.call("create_folder", {
      name: this.folderName,
    })) as { id?: string } | undefined;
    if (created?.id === undefined) {
      throw new OneDriveDestinationError("ensure-folder", "no folder ID returned");
    }
    return { id: created.id, created: true };
  }

  /** Existing document item + content hash, when present. */
  private async existingDocument(
    folderId: string,
    documentName: string,
  ): Promise<{ itemId: string; contentHash: string } | undefined> {
    const children = await this.listChildren(folderId);
    const doc = children.find((item) => item.name === documentName);
    if (doc === undefined) return undefined;
    const downloaded = (await this.call("download_file", { item_id: doc.id })) as
      | { base64?: string }
      | undefined;
    if (downloaded?.base64 === undefined) {
      throw new OneDriveDestinationError("download", "no content returned");
    }
    const bytes = Buffer.from(downloaded.base64, "base64");
    return { itemId: doc.id, contentHash: sha256Hex(new Uint8Array(bytes)) };
  }

  private async render(
    scope: Scope,
    bucketId: string,
  ): Promise<{
    content: string;
    contentHash: string;
    documentName: string;
    bucketName: string;
    itemCount: number;
  }> {
    const buckets = await this.deps.buckets.listBuckets(scope.tenantId, scope.userId);
    const target = buckets.find((b) => b.id === bucketId);
    if (target === undefined) throw new BucketNotFoundError();
    const items = await this.deps.buckets.listItemsByBucket(scope.tenantId, scope.userId, bucketId);
    const content = renderBucketMarkdown(target, items);
    return {
      content,
      contentHash: sha256Hex(content),
      documentName: bucketDocumentName(target),
      bucketName: target.name,
      itemCount: items.length,
    };
  }

  /* ------------------------------- contract ------------------------------ */

  async preview(scope: Scope, bucketId: string): Promise<DestinationPreview> {
    await requireM365Consent(this.deps.consents, scope, DESTINATION_CONSENT);
    const { content, contentHash, documentName } = await this.render(scope, bucketId);
    let existingHash: string | undefined;
    try {
      const root = await this.listChildren();
      const folder = root.find(
        (item) => item.name === this.folderName && item.folder !== undefined,
      );
      if (folder !== undefined) {
        existingHash = (await this.existingDocument(folder.id, documentName))?.contentHash;
      }
    } catch (error) {
      if (error instanceof OneDriveDestinationError) throw error;
      throw new OneDriveDestinationError("list", "state probe failed (detail redacted)");
    }
    return {
      kind: this.kind,
      target: { folder: `${this.folderName}/`, documentName },
      content,
      contentHash,
      noOp: existingHash === contentHash,
      ...(existingHash !== undefined ? { existingHash } : {}),
    };
  }

  async commit(scope: Scope, preview: DestinationPreview): Promise<DestinationCommit> {
    await requireM365Consent(this.deps.consents, scope, DESTINATION_CONSENT);
    if (preview.kind !== this.kind) {
      throw new OneDriveDestinationError("upload", "preview kind mismatch");
    }
    // Approval integrity: live state must still render to the approved hash.
    const bucketId = await this.bucketIdForDocument(scope, preview.target.documentName);
    const rendered = await this.render(scope, bucketId);
    if (
      rendered.contentHash !== preview.contentHash ||
      rendered.content !== preview.content
    ) {
      throw new PreviewStaleError();
    }
    try {
      const folder = await this.ensureFolder();
      const existing = await this.existingDocument(folder.id, preview.target.documentName);
      const committedAt = this.now().toISOString();
      if (existing !== undefined && existing.contentHash === preview.contentHash) {
        // FR-2: byte-identical re-publish — no upload, no duplicate.
        const link = await this.ensureLink(scope, preview, existing.itemId);
        return { itemId: existing.itemId, ...(link !== undefined ? { link } : {}), contentHash: preview.contentHash, committedAt, noOp: true };
      }
      const uploaded = (await this.call("upload_file", {
        name: preview.target.documentName,
        content_base64: Buffer.from(preview.content, "utf8").toString("base64"),
        parent_id: folder.id,
        content_type: "text/markdown",
      })) as { id?: string } | undefined;
      if (uploaded?.id === undefined) {
        throw new OneDriveDestinationError("upload", "no item ID returned");
      }
      const link = await this.ensureLink(scope, preview, uploaded.id, true);
      return { itemId: uploaded.id, ...(link !== undefined ? { link } : {}), contentHash: preview.contentHash, committedAt, noOp: false };
    } catch (error) {
      if (error instanceof OneDriveDestinationError || error instanceof PreviewStaleError) {
        throw error;
      }
      throw new OneDriveDestinationError("upload", "commit failed (detail redacted)");
    }
  }

  /**
   * Organization-scoped share link (AC-4): the request pins
   * scope="organization" and the RESPONSE scope is verified — anything
   * else fails closed and is never recorded.
   */
  private async ensureLink(
    scope: Scope,
    preview: DestinationPreview,
    itemId: string,
    force = false,
  ): Promise<string | undefined> {
    const bucketId = await this.bucketIdForDocument(scope, preview.target.documentName);
    const prior = await this.state(scope, bucketId);
    if (!force && prior?.link !== undefined && prior.itemId === itemId) {
      return prior.link;
    }
    const shared = (await this.call("share_file", {
      item_id: itemId,
      link_type: "view",
      scope: "organization",
    })) as { link?: { scope?: string; webUrl?: string } } | undefined;
    const linkScope = shared?.link?.scope;
    if (linkScope !== "organization") {
      throw new OneDriveDestinationError(
        "share-scope",
        `share link scope must be organization (got ${linkScope === undefined ? "none" : "other"})`,
      );
    }
    return shared?.link?.webUrl;
  }

  private async bucketIdForDocument(scope: Scope, documentName: string): Promise<string> {
    const buckets = await this.deps.buckets.listBuckets(scope.tenantId, scope.userId);
    const match = buckets.find((b) => bucketDocumentName(b) === documentName);
    if (match === undefined) throw new BucketNotFoundError();
    return match.id;
  }

  /** Record the write-back state after a successful commit (FR-3). */
  async recordCommit(
    scope: Scope,
    bucketId: string,
    bucketName: string,
    documentName: string,
    commit: DestinationCommit,
  ): Promise<void> {
    await this.saveState(scope, {
      bucketId,
      bucketName,
      documentName,
      itemId: commit.itemId,
      ...(commit.link !== undefined ? { link: commit.link } : {}),
      contentHash: commit.contentHash,
      publishedAt: commit.committedAt,
      status: "published",
    });
    await this.clearPendingPreview(scope, bucketId);
  }

  /** Record a redacted failure for visibility (never content). */
  async recordError(scope: Scope, bucketId: string, bucketName: string, documentName: string, errorToken: string): Promise<void> {
    await this.saveState(scope, { bucketId, bucketName, documentName, status: "error", error: errorToken });
  }
}
