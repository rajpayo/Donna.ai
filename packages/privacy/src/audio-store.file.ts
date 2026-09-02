/**
 * Encrypted file-backed audio store (Spec 1.3).
 *
 * Layout: <dataDir>/<tenant>/<user>/audio/<captureId>.enc
 *
 * Audio is encrypted with AES-256-GCM BEFORE the durable write (FR-1); the
 * key lives only in process memory from runtime secret management, never
 * beside the ciphertext. Tenant/user/capture identifiers are validated so
 * a malicious ID cannot traverse the tree or select another scope's object
 * (SR-3). All deletes are idempotent.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AudioStore } from "@donna/core";
import { decryptAudio, encryptAudio } from "./crypto.js";

const PARTITION_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const CAPTURE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertPartitionId(kind: "tenant" | "user", value: string): void {
  if (!PARTITION_ID.test(value)) {
    throw new Error(`Invalid ${kind} ID for file-backed storage`);
  }
}

export function assertCaptureId(value: string): void {
  if (!CAPTURE_ID.test(value)) {
    throw new Error("Invalid capture ID for file-backed storage");
  }
}

export class EncryptedFileAudioStore implements AudioStore {
  /**
   * @param dataDir root of the Donna data directory.
   * @param key 32-byte AES key from runtime secret management; held in
   *   memory only, never written to disk or logs.
   */
  constructor(
    private readonly dataDir: string,
    private readonly key: Buffer,
  ) {}

  private fileFor(tenantId: string, userId: string, captureId: string): string {
    assertPartitionId("tenant", tenantId);
    assertPartitionId("user", userId);
    assertCaptureId(captureId);
    return join(this.dataDir, tenantId, userId, "audio", `${captureId}.enc`);
  }

  async put(
    tenantId: string,
    userId: string,
    captureId: string,
    audio: Uint8Array,
  ): Promise<void> {
    const file = this.fileFor(tenantId, userId, captureId);
    const ciphertext = encryptAudio(this.key, audio);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, ciphertext, { mode: 0o600 });
  }

  async get(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<Uint8Array | undefined> {
    const file = this.fileFor(tenantId, userId, captureId);
    let ciphertext: Buffer;
    try {
      ciphertext = await readFile(file);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    return decryptAudio(this.key, ciphertext);
  }

  async has(tenantId: string, userId: string, captureId: string): Promise<boolean> {
    const file = this.fileFor(tenantId, userId, captureId);
    try {
      await readFile(file);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  async delete(
    tenantId: string,
    userId: string,
    captureId: string,
  ): Promise<boolean> {
    const file = this.fileFor(tenantId, userId, captureId);
    const existed = await this.has(tenantId, userId, captureId);
    await rm(file, { force: true });
    return existed;
  }
}
