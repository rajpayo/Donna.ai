/**
 * Authenticated encryption for audio at rest (Spec 1.3, SR-1).
 *
 * AES-256-GCM with a fresh 96-bit random nonce per object. On-disk format:
 *
 *   version (1 byte, 0x01) || nonce (12 bytes) || ciphertext || GCM tag (16 B)
 *
 * The key comes from runtime secret management (DONNA_AUDIO_KEY) as a
 * base64- or hex-encoded 32-byte value. Keys are never written beside the
 * ciphertext and never logged; loadAudioKey validates without echoing.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = 0x01;
const NONCE_BYTES = 12;
export const AUDIO_KEY_BYTES = 32;

export class AudioKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioKeyError";
  }
}

export class AudioDecryptionError extends Error {
  constructor() {
    super(
      "Encrypted audio failed authentication or could not be decoded with the configured key",
    );
    this.name = "AudioDecryptionError";
  }
}

/** Parse and validate a base64/hex 32-byte key. Never logs the value. */
export function parseAudioKey(raw: string | undefined): Buffer {
  if (raw === undefined || raw.trim() === "") {
    throw new AudioKeyError(
      "DONNA_AUDIO_KEY is not set — provide a base64- or hex-encoded 32-byte key from runtime secret management",
    );
  }
  const trimmed = raw.trim();
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, "hex");
  } else {
    try {
      key = Buffer.from(trimmed, "base64");
    } catch {
      throw new AudioKeyError(
        "DONNA_AUDIO_KEY is not valid base64/hex — expected a 32-byte key",
      );
    }
  }
  if (key.length !== AUDIO_KEY_BYTES) {
    throw new AudioKeyError(
      `DONNA_AUDIO_KEY must decode to ${AUDIO_KEY_BYTES} bytes (got ${key.length})`,
    );
  }
  return key;
}

export function encryptAudio(key: Buffer, plaintext: Uint8Array): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), nonce, ciphertext, tag]);
}

export function decryptAudio(key: Buffer, payload: Uint8Array): Buffer {
  if (payload.length < 1 + NONCE_BYTES + 16) {
    throw new AudioDecryptionError();
  }
  const buffer = Buffer.from(payload);
  if (buffer[0] !== VERSION) {
    throw new AudioDecryptionError();
  }
  const nonce = buffer.subarray(1, 1 + NONCE_BYTES);
  const tag = buffer.subarray(buffer.length - 16);
  const ciphertext = buffer.subarray(1 + NONCE_BYTES, buffer.length - 16);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new AudioDecryptionError();
  }
}
