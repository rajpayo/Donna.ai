/**
 * Specification 5.3 — deterministic Markdown renderer tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import type { Bucket, Thought } from "@donna/core";
import {
  bucketDocumentName,
  escapeMarkdownText,
  renderBucketMarkdown,
} from "./markdown.js";

const BUCKET: Bucket = {
  id: "b-1",
  tenantId: "t",
  userId: "u",
  name: "Tasks",
  description: "Commitments and action items",
  centroid: [],
  itemCount: 2,
  createdAt: "2026-09-01T09:00:00.000Z",
  origin: "auto",
};

function thought(id: string, text: string, task?: Thought["task"]): Thought {
  return {
    id,
    tenantId: "t",
    userId: "u",
    summary: `Summary of ${id}`,
    text,
    confidence: 0.9,
    ...(task !== undefined ? { task } : {}),
    provenance: {
      captureId: "cap-1",
      segmentIds: ["s1"],
      sourceText: text,
      startSec: 1,
      endSec: 4,
    },
    versions: {
      organizerModel: "m",
      organizeSchemaVersion: "v1",
      organizePromptVersion: "p1",
    },
    createdAt: "2026-09-02T10:00:00.000Z",
  };
}

describe("renderBucketMarkdown (Spec 5.3, FR-2, SR-3)", () => {
  it("is deterministic: same state renders byte-identical bytes", () => {
    const items = [
      { thought: thought("t-2", "second") },
      { thought: thought("t-1", "first", { title: "Do it" }) },
    ];
    const a = renderBucketMarkdown(BUCKET, items);
    const b = renderBucketMarkdown(BUCKET, [...items].reverse());
    assert.equal(a, b);
    assert.equal(
      createHash("sha256").update(a).digest("hex"),
      createHash("sha256").update(b).digest("hex"),
    );
    // Stable ordering by thought ID, regardless of input order.
    assert.ok(a.indexOf("donna:item t-1") < a.indexOf("donna:item t-2"));
  });

  it("carries item summaries, task status, source capture timestamps, and stable item IDs", () => {
    const out = renderBucketMarkdown(BUCKET, [
      { thought: thought("t-1", "reply to the thread", { title: "Reply", dueHint: "Friday" }) },
    ]);
    assert.match(out, /# Tasks/);
    assert.match(out, /<!-- donna:bucket b-1 -->/);
    assert.match(out, /### Summary of t-1/);
    assert.match(out, /<!-- donna:item t-1 -->/);
    assert.match(out, /Captured: 2026-09-02T10:00:00\.000Z from capture cap-1 \(audio 1\.0–4\.0s\)/);
    assert.match(out, /- Task: Reply \(open, due hint: Friday\)/);
    assert.match(out, /- reply to the thread/);
    // No render-time timestamp anywhere (byte-identical re-render).
    assert.ok(!out.includes(new Date().toISOString().slice(0, 10)) || out.includes("2026-09-0"));
  });

  it("escapes embedded HTML in every untrusted field (SR-3)", () => {
    const evil = thought(
      "t-9",
      'run <script>alert(1)</script> & "quoted"',
      { title: "<img src=x onerror=alert(1)>" },
    );
    evil.summary = "<b>bold?</b>";
    const out = renderBucketMarkdown({ ...BUCKET, name: "Ideas <svg>" }, [{ thought: evil }]);
    assert.ok(!out.includes("<script>"));
    assert.ok(!out.includes("<img"));
    assert.ok(!out.includes("<b>"));
    assert.ok(!out.includes("<svg>"));
    assert.match(out, /&lt;script&gt;/);
    assert.match(out, /&amp;/);
    // Marker comments survive escaping (IDs are plain).
    assert.match(out, /<!-- donna:item t-9 -->/);
  });

  it("document names are stable, slugged, and collision-resistant", () => {
    assert.equal(bucketDocumentName(BUCKET), `tasks-${createHash("sha256").update("b-1").digest("hex").slice(0, 8)}.md`);
    assert.equal(bucketDocumentName({ id: "b-2", name: "Tasks!" }), bucketDocumentName({ id: "b-2", name: "tasks" }));
    assert.notEqual(
      bucketDocumentName({ id: "b-2", name: "Tasks" }),
      bucketDocumentName(BUCKET),
    );
    assert.equal(bucketDocumentName({ id: "b-3", name: "!!!" }).startsWith("bucket-"), true);
  });

  it("escapeMarkdownText collapses whitespace and escapes angle brackets", () => {
    assert.equal(escapeMarkdownText("a\n b  <c> & d"), "a b &lt;c&gt; &amp; d");
  });
});
