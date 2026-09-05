import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { screenSensitiveContent, SensitiveContentError } from "./screening.js";

describe("screenSensitiveContent (SR-4)", () => {
  it("passes ordinary preference text", () => {
    assert.deepEqual(
      screenSensitiveContent("Prefers short bullet summaries in the morning"),
      [],
    );
  });

  it("rejects private key material", () => {
    const hits = screenSensitiveContent(
      "My key is -----BEGIN RSA PRIVATE KEY----- abc",
    );
    assert.deepEqual(hits.map((h) => h.category), ["private-key"]);
  });

  it("rejects API tokens and JWTs", () => {
    assert.ok(
      screenSensitiveContent("token sk-abcdefghijklmnop123456").some(
        (h) => h.category === "api-token",
      ),
    );
    assert.ok(
      screenSensitiveContent("aws key AKIAIOSFODNN7EXAMPLE").some(
        (h) => h.category === "api-token",
      ),
    );
    assert.ok(
      screenSensitiveContent(
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c",
      ).some((h) => h.category === "api-token"),
    );
  });

  it("rejects password statements", () => {
    assert.ok(
      screenSensitiveContent("My password is hunter2").some(
        (h) => h.category === "password",
      ),
    );
  });

  it("rejects Luhn-valid card numbers but not ordinary numbers", () => {
    assert.ok(
      screenSensitiveContent("card 4111 1111 1111 1111").some(
        (h) => h.category === "card-number",
      ),
    );
    assert.deepEqual(screenSensitiveContent("order 4111 1111 1111 1112 came in"), []);
    assert.deepEqual(screenSensitiveContent("budget is 12345678"), []);
  });

  it("rejects national-id-shaped identifiers", () => {
    assert.ok(
      screenSensitiveContent("ssn 123-45-6789").some(
        (h) => h.category === "national-id",
      ),
    );
  });

  it("never leaks the matched secret into the error", () => {
    const secret = "sk-supersecretvalue1234567890";
    const error = new SensitiveContentError(
      screenSensitiveContent(`my ${secret} here`).map((h) => h.category),
    );
    assert.ok(!error.message.includes(secret));
    assert.ok(error.message.includes("api-token"));
  });
});
