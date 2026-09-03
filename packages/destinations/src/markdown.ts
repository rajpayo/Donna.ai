/**
 * Deterministic bucket → Markdown renderer (Specification 5.3).
 *
 * The rendered document is a pure function of bucket state: same state in,
 * same bytes out (FR-2 — re-publishing is a byte-identical no-op). There
 * are deliberately NO render timestamps in the output; time appears only
 * as per-item source capture timestamps.
 *
 * SR-3: all untrusted text (bucket name, summaries, thought text, task
 * fields) is HTML-escaped and whitespace-collapsed — no scripts, no
 * active content. Stable Donna item IDs travel as escaped HTML comments
 * so future re-renders and audits can map lines back to Donna records.
 */
import { sha256Hex, type Bucket, type Thought } from "@donna/core";

export const RENDER_VERSION = "donna.markdown-render.v1";

/** Escape embedded HTML and collapse whitespace in untrusted text. */
export function escapeMarkdownText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deterministic document name for a bucket: slugified name plus a short
 * hash of the bucket ID, so renamed or similarly-named buckets never
 * collide and re-renders always target the same file.
 */
export function bucketDocumentName(bucket: Pick<Bucket, "id" | "name">): string {
  const slug =
    bucket.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "bucket";
  return `${slug}-${sha256Hex(bucket.id).slice(0, 8)}.md`;
}

function renderItem(thought: Thought): string[] {
  const lines: string[] = [];
  lines.push(`### ${escapeMarkdownText(thought.summary)}`);
  lines.push("");
  lines.push(`<!-- donna:item ${escapeMarkdownText(thought.id)} -->`);
  const captured = thought.createdAt ?? "unknown time";
  lines.push(
    `- Captured: ${escapeMarkdownText(captured)} from capture ${escapeMarkdownText(thought.provenance.captureId)} (audio ${thought.provenance.startSec.toFixed(1)}–${thought.provenance.endSec.toFixed(1)}s)`,
  );
  if (thought.task !== undefined) {
    const assignee =
      thought.task.assigneeHint !== undefined
        ? `, assignee hint: ${escapeMarkdownText(thought.task.assigneeHint)}`
        : "";
    const due =
      thought.task.dueHint !== undefined
        ? `, due hint: ${escapeMarkdownText(thought.task.dueHint)}`
        : "";
    lines.push(`- Task: ${escapeMarkdownText(thought.task.title)} (open${assignee}${due})`);
  }
  lines.push(`- ${escapeMarkdownText(thought.text)}`);
  lines.push("");
  return lines;
}

/**
 * Render one bucket document. Items are sorted by thought ID for a stable
 * order independent of store enumeration.
 */
export function renderBucketMarkdown(
  bucket: Bucket,
  items: Array<{ thought: Thought }>,
): string {
  const lines: string[] = [];
  lines.push(`# ${escapeMarkdownText(bucket.name)}`);
  lines.push("");
  lines.push(`<!-- donna:bucket ${escapeMarkdownText(bucket.id)} -->`);
  lines.push(`<!-- ${RENDER_VERSION} — deterministic export; do not edit markers -->`);
  lines.push("");
  lines.push(
    `_${escapeMarkdownText(bucket.description)}_`,
  );
  lines.push("");
  lines.push(
    `Exported by Donna. Donna is the source of truth; this document is an approved snapshot of ${items.length} item(s).`,
  );
  lines.push("");
  const ordered = [...items].sort((a, b) => a.thought.id.localeCompare(b.thought.id));
  for (const item of ordered) {
    lines.push(...renderItem(item.thought));
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
