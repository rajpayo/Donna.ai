import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncryptedFileAudioStore } from "./audio-store.file.js";
import { AudioDecryptionError } from "./crypto.js";

const KEY = randomBytes(32);
const AUDIO = Buffer.from("fake-but-stand-in audio bytes 0123456789");

async function withStore(
  fn: (ctx: { store: EncryptedFileAudioStore; dir: string }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "donna-audio-"));
  try {
    await fn({ store: new EncryptedFileAudioStore(dir, KEY), dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("EncryptedFileAudioStore", () => {
  it("round-trips audio within its scope", async () => {
    await withStore(async ({ store }) => {
      await store.put("tenant-a", "user-1", "cap-1", AUDIO);
      assert.deepEqual(await store.get("tenant-a", "user-1", "cap-1"), AUDIO);
      assert.equal(await store.has("tenant-a", "user-1", "cap-1"), true);
    });
  });

  it("stores only ciphertext on disk", async () => {
    await withStore(async ({ store, dir }) => {
      await store.put("tenant-a", "user-1", "cap-1", AUDIO);
      const onDisk = await readFile(
        join(dir, "tenant-a", "user-1", "audio", "cap-1.enc"),
      );
      assert.ok(!onDisk.includes(AUDIO));
      // Decoding without the key is just the raw ciphertext bytes.
      assert.notDeepEqual(onDisk, AUDIO);
    });
  });

  it("isolates scopes: another tenant/user cannot read the object", async () => {
    await withStore(async ({ store }) => {
      await store.put("tenant-a", "user-1", "cap-1", AUDIO);
      assert.equal(await store.get("tenant-b", "user-1", "cap-1"), undefined);
      assert.equal(await store.get("tenant-a", "user-2", "cap-1"), undefined);
      assert.equal(await store.has("tenant-b", "user-1", "cap-1"), false);
    });
  });

  it("rejects path traversal in tenant, user, and capture IDs (SR-3)", async () => {
    await withStore(async ({ store }) => {
      await assert.rejects(
        store.put("../tenant-b", "user-1", "cap-1", AUDIO),
        /Invalid tenant ID/,
      );
      await assert.rejects(
        store.get("tenant-a", "../user-2", "cap-1"),
        /Invalid user ID/,
      );
      await assert.rejects(
        store.get("tenant-a", "user-1", "../../secret"),
        /Invalid capture ID/,
      );
      await assert.rejects(
        store.delete("tenant-a", "user-1", "/etc/passwd"),
        /Invalid capture ID/,
      );
      await assert.rejects(
        store.has("tenant-a", "user-1", ".."),
        /Invalid capture ID/,
      );
    });
  });

  it("fails closed on tampered ciphertext", async () => {
    await withStore(async ({ store, dir }) => {
      await store.put("tenant-a", "user-1", "cap-1", AUDIO);
      const file = join(dir, "tenant-a", "user-1", "audio", "cap-1.enc");
      const tampered = await readFile(file);
      tampered[20] = tampered[20]! ^ 0xff;
      await writeFile(file, tampered);
      await assert.rejects(
        store.get("tenant-a", "user-1", "cap-1"),
        AudioDecryptionError,
      );
    });
  });

  it("delete is idempotent and reports what it removed", async () => {
    await withStore(async ({ store }) => {
      await store.put("tenant-a", "user-1", "cap-1", AUDIO);
      assert.equal(await store.delete("tenant-a", "user-1", "cap-1"), true);
      assert.equal(await store.has("tenant-a", "user-1", "cap-1"), false);
      // Replay: no failure, nothing restored.
      assert.equal(await store.delete("tenant-a", "user-1", "cap-1"), false);
      assert.equal(await store.get("tenant-a", "user-1", "cap-1"), undefined);
    });
  });

  it("cannot be read back with a different key", async () => {
    await withStore(async ({ store, dir }) => {
      await store.put("tenant-a", "user-1", "cap-1", AUDIO);
      const otherKeyStore = new EncryptedFileAudioStore(dir, randomBytes(32));
      await assert.rejects(
        otherKeyStore.get("tenant-a", "user-1", "cap-1"),
        AudioDecryptionError,
      );
    });
  });
});
