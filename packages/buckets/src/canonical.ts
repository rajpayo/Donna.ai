/**
 * Deterministic canonicalization and duplicate protection for proposed new
 * bucket names (Specification 6.7, architecture section D).
 *
 * Everything here is pure and deterministic — no model calls, no I/O. The
 * display validator REJECTS non-canonical input rather than silently
 * repairing it; the comparison key is a separate, lossy normalization used
 * only for collision detection.
 */

/** Machine-readable validator reason tokens (safe for logs/reports). */
export type NamingFailure =
  | "blank"
  | "oversized"
  | "control-characters"
  | "wrapping-quotes"
  | "sentence-punctuation"
  | "too-many-words"
  | "date-or-deadline"
  | "urgency-wording"
  | "imperative-wording"
  | "one-off-action-wording"
  | "id-shaped"
  | "not-a-topic-phrase";

export const MAX_NAME_CHARS = 60;
export const MAX_NAME_WORDS = 4;
export const MAX_DESCRIPTION_CHARS = 200;

const CONTROL_CHARS = /[\p{Cc}\p{Cf}]/u;
const SENTENCE_PUNCTUATION = /[.!?;…]/u;
const WRAPPING_QUOTES = /^["'“”‘’`].*["'“”‘’`]$/u;
const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET_REF_SHAPED = /^bucket:[0-9a-f-]{36}$/i;

/** Standalone dates, deadlines, and relative-day wording. */
const DATE_OR_DEADLINE =
  /\b(\d{1,2}[\/.-]\d{1,2}([\/.-]\d{2,4})?|\d{4}-\d{2}-\d{2}|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?|mon(day)?|tue(s|sday)?|wed(nesday)?|thu(r|rs|rsday)?|fri(day)?|sat(urday)?|sun(day)?|today|tomorrow|tonight|yesterday|next week|last week|this week|next month|by friday|by monday|eod|eow|deadline|due)\b/iu;

const URGENCY = /\b(asap|urgent|urgently|immediately|right away|priority)\b/iu;

/**
 * Imperative / one-off action openers. A durable person, project,
 * organization, or product proper name is valid; a verb-led action phrase
 * ("Ask Arjun by Friday") is not a reusable topic.
 */
const IMPERATIVE_OPENERS = new Set([
  "ask", "tell", "send", "email", "call", "ping", "message", "text",
  "remind", "follow", "followup", "schedule", "arrange", "book", "set",
  "setup", "plan", "prepare", "draft", "write", "review", "check", "verify",
  "confirm", "discuss", "talk", "meet", "sync", "share", "give", "get",
  "buy", "order", "pay", "submit", "upload", "download", "fix", "update",
  "finish", "complete", "start", "stop", "cancel", "reschedule", "chase",
  "organize", "organise", "collect", "gather", "reminder", "todo", "to-do",
  "action", "task", "note", "remember",
]);

const ONE_OFF_WORDING =
  /\b(meeting with|call with|chat with|conversation with|discussion with)\b/iu;

/**
 * Canonical display value: Unicode NFKC plus trimmed/collapsed whitespace.
 * Returns undefined when the input cannot be a display name at all.
 */
export function canonicalDisplayName(raw: string): string | undefined {
  if (CONTROL_CHARS.test(raw)) return undefined;
  const normalized = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  return normalized.length === 0 ? undefined : normalized;
}

/**
 * Validate a proposed new-bucket display name against every canonical
 * validator (FR-6). Returns every failure reason token (empty = valid).
 * Meaningful internal capitalization and acronyms (e.g. "M365") are
 * preserved; nothing here lowercases proper nouns.
 */
export function validateBucketName(raw: string): NamingFailure[] {
  const failures: NamingFailure[] = [];
  if (CONTROL_CHARS.test(raw)) {
    failures.push("control-characters");
  }
  const display = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (display.length === 0) {
    failures.push("blank");
    return failures;
  }
  if (display.length > MAX_NAME_CHARS) failures.push("oversized");
  if (WRAPPING_QUOTES.test(display)) failures.push("wrapping-quotes");
  if (SENTENCE_PUNCTUATION.test(display)) failures.push("sentence-punctuation");
  if (UUID_SHAPED.test(display) || BUCKET_REF_SHAPED.test(display)) {
    failures.push("id-shaped");
  }
  const words = display.split(" ");
  if (words.length > MAX_NAME_WORDS) failures.push("too-many-words");
  if (DATE_OR_DEADLINE.test(display)) failures.push("date-or-deadline");
  if (URGENCY.test(display)) failures.push("urgency-wording");
  if (IMPERATIVE_OPENERS.has(words[0]!.toLowerCase())) {
    failures.push("imperative-wording");
  }
  if (ONE_OFF_WORDING.test(display)) failures.push("one-off-action-wording");
  // A reusable topic noun phrase contains at least one content token that
  // is not purely punctuation/symbols.
  if (!words.some((w) => /[\p{L}\p{N}]/u.test(w))) {
    failures.push("not-a-topic-phrase");
  }
  return failures;
}

/** Validate the one-line description (non-empty, bounded, single line). */
export function validateBucketDescription(raw: string): NamingFailure[] {
  const failures: NamingFailure[] = [];
  if (CONTROL_CHARS.test(raw)) failures.push("control-characters");
  const display = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (display.length === 0) failures.push("blank");
  if (display.length > MAX_DESCRIPTION_CHARS) failures.push("oversized");
  return failures;
}

/**
 * Canonical comparison key (exact-collision detection only): NFKC, case
 * folding, punctuation/symbol folding, whitespace collapse, token
 * normalization. Two names with the same key are the same bucket topic.
 */
export function canonicalNameKey(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .join(" ");
}

/**
 * Lexical containment: true when either name's token set contains the
 * other's (e.g. "Project Atlas" vs "Project Atlas Updates"). Both sides
 * are canonical-key tokenized first.
 */
export function lexicallyContained(left: string, right: string): boolean {
  const a = canonicalNameKey(left).split(" ").filter(Boolean);
  const b = canonicalNameKey(right).split(" ").filter(Boolean);
  if (a.length === 0 || b.length === 0) return false;
  const setA = new Set(a);
  const setB = new Set(b);
  const aInB = a.every((token) => setB.has(token));
  const bInA = b.every((token) => setA.has(token));
  return aInB || bInA;
}

/** The descriptor text embedded for semantic near-duplicate comparison. */
export function bucketDescriptor(name: string, description: string): string {
  return `${canonicalDisplayName(name) ?? name} — ${description}`.trim();
}
