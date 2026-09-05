/**
 * Canonicalization and validator fixtures (Specification 6.7 AC-5):
 * Unicode/whitespace/punctuation, proper nouns/acronyms, dates, urgency,
 * imperatives, one-off wording, blank/oversized/control/ID input, exact
 * collisions, and lexical near-duplicates.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bucketDescriptor,
  canonicalDisplayName,
  canonicalNameKey,
  lexicallyContained,
  validateBucketDescription,
  validateBucketName,
} from "./canonical.js";

describe("canonical display name (NFKC + whitespace, no silent repair)", () => {
  it("normalizes unicode and collapses whitespace", () => {
    assert.equal(canonicalDisplayName("  Vendor   Contracts "), "Vendor Contracts");
    assert.equal(canonicalDisplayName("Ｍ365 Migration"), "M365 Migration");
  });
  it("rejects control characters rather than repairing them", () => {
    assert.equal(canonicalDisplayName("VendorContracts"), undefined);
    assert.equal(canonicalDisplayName("Vendor\nContracts"), undefined);
  });
  it("rejects blank input", () => {
    assert.equal(canonicalDisplayName("   "), undefined);
  });
});

describe("validateBucketName (FR-6)", () => {
  it("accepts concise reusable topic phrases", () => {
    for (const name of ["Hiring", "Vendor Contracts", "Product Ideas", "Investor Updates"]) {
      assert.deepEqual(validateBucketName(name), [], name);
    }
  });
  it("preserves proper nouns and acronyms without lowercasing", () => {
    assert.deepEqual(validateBucketName("M365 Migration"), []);
    assert.deepEqual(validateBucketName("Project Atlas"), []);
    assert.deepEqual(validateBucketName("Priya"), []);
  });
  it("rejects imperative / one-off action wording", () => {
    assert.ok(validateBucketName("Ask Arjun by Friday").includes("imperative-wording"));
    assert.ok(validateBucketName("Send the deck").includes("imperative-wording"));
    assert.ok(validateBucketName("Meeting with Tushar").includes("one-off-action-wording"));
  });
  it("rejects dates, deadlines, and urgency", () => {
    assert.ok(validateBucketName("Friday Deliverables").includes("date-or-deadline"));
    assert.ok(validateBucketName("2026-09-05 Notes").includes("date-or-deadline"));
    assert.ok(validateBucketName("Due Diligence").includes("date-or-deadline"));
    assert.ok(validateBucketName("ASAP Fixes").includes("urgency-wording"));
  });
  it("rejects sentence punctuation and wrapping quotes", () => {
    assert.ok(validateBucketName("Launch readiness.").includes("sentence-punctuation"));
    assert.ok(validateBucketName("What about hiring?").includes("sentence-punctuation"));
    assert.ok(validateBucketName('"Vendor Contracts"').includes("wrapping-quotes"));
  });
  it("rejects blank, oversized, control, and ID-shaped input", () => {
    assert.ok(validateBucketName("   ").includes("blank"));
    assert.ok(
      validateBucketName("A".repeat(61)).includes("oversized"),
    );
    assert.ok(validateBucketName("Vendor\u0002Contracts").includes("control-characters"));
    assert.ok(
      validateBucketName("bucket:45ce0675-1234-1234-1234-123456789abc").includes("id-shaped"),
    );
    assert.ok(
      validateBucketName("45ce0675-1234-1234-1234-123456789abc").includes("id-shaped"),
    );
  });
  it("rejects names over four words", () => {
    assert.ok(validateBucketName("One Two Three Four Five").includes("too-many-words"));
    assert.deepEqual(validateBucketName("One Two Three Four"), []);
  });
});

describe("validateBucketDescription", () => {
  it("requires a bounded single line", () => {
    assert.deepEqual(validateBucketDescription("Vendor paperwork and renewals."), []);
    assert.ok(validateBucketDescription("  ").includes("blank"));
    assert.ok(validateBucketDescription("x".repeat(201)).includes("oversized"));
  });
});

describe("canonicalNameKey + lexical containment (FR-7)", () => {
  it("folds case, punctuation, and whitespace into one key", () => {
    assert.equal(canonicalNameKey("Vendor  Contracts"), canonicalNameKey("vendor contracts"));
    assert.equal(canonicalNameKey("Project-Atlas!"), canonicalNameKey("project atlas"));
    assert.notEqual(canonicalNameKey("Vendor Contracts"), canonicalNameKey("Vendor Portal"));
  });
  it("detects containment in either direction", () => {
    assert.ok(lexicallyContained("Project Atlas", "Project Atlas Updates"));
    assert.ok(lexicallyContained("Vendor Contracts", "Contracts Vendor"));
    assert.ok(!lexicallyContained("Vendor Contracts", "Vendor Portal"));
    assert.ok(!lexicallyContained("", "Vendor Contracts"));
  });
  it("builds the semantic comparison descriptor from name + description", () => {
    assert.equal(
      bucketDescriptor("Vendor Contracts", "Renewals and paperwork."),
      "Vendor Contracts — Renewals and paperwork.",
    );
  });
});
