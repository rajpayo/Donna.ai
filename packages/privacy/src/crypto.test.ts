import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  AudioDecryptionError,
  AudioKeyError,
  decryptAudio,
  encryptAudio,
  parseAudioKey,
} from "./crypto.js";

const KEY = randomBytes(32);
const PLAINTEXT = Buffer.from("donna test audio bytes \u0000\u0001\u0002", "utf8");

describe("parseAudioKey", () => {
  it("accepts base64 and hex 32-byte keys", () => {
    assert.deepEqual(parseAudioKey(KEY.toString("base64")), KEY);
    assert.deepEqual(parseAudioKey(KEY.toString("hex")), KEY);
  });

  it("rejects a missing key without echoing anything", () => {
    assert.throws(() => parseAudioKey(undefined), AudioKeyError);
    assert.throws(() => parseAudioKey("   "), AudioKeyError);
  });

  it("rejects wrong-length keys without echoing the value", () => {
    const short = Buffer.from("sixteen-bytes!!!").toString("base64");
    try {
      parseAudioKey(short);
      assert.fail("should have thrown");
    } catch (error) {
      assert.ok(error instanceof AudioKeyError);
      assert.ok(!error.message.includes(short));
    }
  });
});

describe("encryptAudio / decryptAudio", () => {
  it("round-trips audio bytes", () => {
    const encrypted = encryptAudio(KEY, PLAINTEXT);
    assert.deepEqual(decryptAudio(KEY, encrypted), PLAINTEXT);
  });

  it("produces different ciphertext for identical plaintext (random nonce)", () => {
    const a = encryptAudio(KEY, PLAINTEXT);
    const b = encryptAudio(KEY, PLAINTEXT);
    assert.notDeepEqual(a, b);
  });

  it("ciphertext never contains the plaintext", () => {
    const encrypted = encryptAudio(KEY, PLAINTEXT);
    assert.ok(!encrypted.includes(PLAINTEXT));
  });

  it("fails authentication when any region is tampered with", () => {
    const encrypted = encryptAudio(KEY, PLAINTEXT);
    const regions: Array<[number, number]> = [
      [0, 1], // version
      [1, 13], // nonce
      [13, encrypted.length - 16], // ciphertext
      [encrypted.length - 16, encrypted.length], // GCM tag
    ];
    for (const [start, end] of regions) {
      const tampered = Buffer.from(encrypted);
      tampered[start] = tampered[start]! ^ 0xff;
      if (end - start > 2) tampered[end - 1] = tampered[end - 1]! ^ 0x01;
      assert.throws(() => decryptAudio(KEY, tampered), AudioDecryptionError);
    }
  });

  it("cannot be decoded without the configured key (AC-1)", () => {
    const encrypted = encryptAudio(KEY, PLAINTEXT);
    const wrongKey = randomBytes(32);
    assert.throws(() => decryptAudio(wrongKey, encrypted), AudioDecryptionError);
  });

  it("rejects truncated payloads", () => {
    const encrypted = encryptAudio(KEY, PLAINTEXT);
    assert.throws(
      () => decryptAudio(KEY, encrypted.subarray(0, 10)),
      AudioDecryptionError,
    );
  });
});
