/**
 * Pilot policy (Specification 6.1): the fixed product rules of the
 * controlled CLI pilot.
 *
 *   - Permitted data classes are a closed set matching the approved
 *     scenario matrix. HR, legal, financial, KYC, and payment content is
 *     excluded from the pilot and rejected by configuration (SR-3) with a
 *     clear message.
 *   - Every consent decision is recorded under a versioned consent text
 *     (PILOT_CONSENT_TEXT_VERSION) in the channel field of the append-only
 *     ConsentStore, so exactly what the volunteer agreed to is auditable.
 *   - Enrolled users get redacted CLI output by default (SR-2): verbatim
 *     transcript text is never printed to a shared terminal unless the
 *     user passes an explicit per-invocation flag.
 *   - The plain-language explanations below are the reviewed user-facing
 *     privacy and uncertainty language (AC-3). Change them only with a
 *     consent-text version bump.
 */

/** Version of the consent wording shown at onboarding. */
export const PILOT_CONSENT_TEXT_VERSION = "pilot-consent.v1";

/** Fixed audio retention for the pilot (encrypted, then auto-deleted). */
export const PILOT_AUDIO_RETENTION_DAYS = 7;

/** Canonical pilot consent purposes (recorded in the ConsentStore). */
export const PILOT_ENROLL_PURPOSE = "pilot.enroll";
export const PILOT_AUDIO_RETENTION_PURPOSE = "pilot.audio-retention-7d";
export const PILOT_DURABLE_MEMORY_PURPOSE = "pilot.memory.durable";
export const PILOT_DATA_CLASS_PURPOSE_PREFIX = "pilot.data-class.";

export function pilotDataClassPurpose(dataClass: string): string {
  return `${PILOT_DATA_CLASS_PURPOSE_PREFIX}${dataClass}`;
}

/**
 * The closed set of content classes the pilot permits. Mirrors the
 * approved scenario matrix (Specification 6.2).
 */
export const PILOT_DATA_CLASSES = [
  "meetings",
  "tasks",
  "ideas",
  "follow-ups",
  "decisions",
  "people",
  "projects",
] as const;
export type PilotDataClass = (typeof PILOT_DATA_CLASSES)[number];

/** Sensitive categories the pilot excludes (SR-3). */
export const EXCLUDED_DATA_CATEGORIES = [
  "hr",
  "legal",
  "financial",
  "kyc",
  "payment",
] as const;
export type ExcludedDataCategory = (typeof EXCLUDED_DATA_CATEGORIES)[number];

/**
 * Token-level aliases that map onto an excluded category. Matching is on
 * whole tokens (or adjacent token pairs) of the normalized input, so
 * "payment-processing" and "human resources" are caught without substring
 * false positives ("legalize" is not "legal").
 */
const EXCLUDED_TOKENS: Record<string, ExcludedDataCategory> = {
  hr: "hr",
  personnel: "hr",
  recruiting: "hr",
  recruitment: "hr",
  payroll: "hr",
  disciplinary: "hr",
  legal: "legal",
  contract: "legal",
  contracts: "legal",
  compliance: "legal",
  litigation: "legal",
  financial: "financial",
  financials: "financial",
  finance: "financial",
  accounting: "financial",
  bookkeeping: "financial",
  invoice: "financial",
  invoices: "financial",
  kyc: "kyc",
  payment: "payment",
  payments: "payment",
  billing: "payment",
  payout: "payment",
};

/** Two-word phrases that map onto an excluded category. */
const EXCLUDED_PHRASES: Record<string, ExcludedDataCategory> = {
  "human resources": "hr",
  "know your customer": "kyc",
  "credit card": "payment",
  "bank transfer": "payment",
};

export class ExcludedCategoryError extends Error {
  constructor(
    readonly rejected: Array<{ input: string; category: ExcludedDataCategory }>,
  ) {
    super(
      "The pilot excludes HR, legal, financial, KYC, and payment content. " +
        `Rejected: ${rejected.map((r) => `"${r.input}" (${r.category})`).join(", ")}. ` +
        "Remove these categories and try again. Permitted data classes: " +
        PILOT_DATA_CLASSES.join(", ") +
        ".",
    );
    this.name = "ExcludedCategoryError";
  }
}

export class UnknownDataClassError extends Error {
  constructor(readonly unknown: string[]) {
    super(
      `Unknown data class(es): ${unknown.map((u) => `"${u}"`).join(", ")}. ` +
        "The pilot permits exactly: " +
        PILOT_DATA_CLASSES.join(", ") +
        ".",
    );
    this.name = "UnknownDataClassError";
  }
}

/**
 * Validate a requested data-class list against pilot policy (SR-3).
 * Excluded sensitive categories are rejected with a clear message;
 * anything outside the closed permitted set is rejected too. Returns the
 * normalized permitted classes, de-duplicated, in canonical order.
 */
export function validatePilotDataClasses(inputs: string[]): PilotDataClass[] {
  const excluded: Array<{ input: string; category: ExcludedDataCategory }> = [];
  const unknown: string[] = [];
  const accepted = new Set<PilotDataClass>();
  for (const raw of inputs) {
    const normalized = raw.trim().toLowerCase();
    if (normalized.length === 0) continue;
    const tokens = normalized.split(/[^a-z0-9]+/).filter((t) => t.length > 0);
    const pairs = tokens.slice(0, -1).map((t, i) => `${t} ${tokens[i + 1]}`);
    const hit = [...tokens, ...pairs]
      .map((t) => EXCLUDED_TOKENS[t] ?? EXCLUDED_PHRASES[t])
      .find((c) => c !== undefined);
    if (hit !== undefined) {
      excluded.push({ input: raw, category: hit });
      continue;
    }
    if ((PILOT_DATA_CLASSES as readonly string[]).includes(normalized)) {
      accepted.add(normalized as PilotDataClass);
    } else {
      unknown.push(raw);
    }
  }
  if (excluded.length > 0) throw new ExcludedCategoryError(excluded);
  if (unknown.length > 0) throw new UnknownDataClassError(unknown);
  return PILOT_DATA_CLASSES.filter((c) => accepted.has(c));
}

/**
 * Organizer-confidence floor for the pilot review queue (FR-2 review
 * surface): thoughts persisted with a self-reported confidence below this
 * are listed as review candidates. A pilot UI policy constant — model
 * selection stays in models.config.yaml.
 */
export const PILOT_REVIEW_CONFIDENCE_THRESHOLD = 0.75;

/* ------------------------------------------------------------------ */
/* Plain-language explanations (AC-3: product-owner reviewed wording)  */
/* ------------------------------------------------------------------ */

export interface PilotExplanation {
  title: string;
  body: string;
}

export const PILOT_EXPLANATIONS: PilotExplanation[] = [
  {
    title: "What Donna is (and is not)",
    body:
      "Donna is a pilot assistant that turns your voice notes into organized, " +
      "searchable thoughts. Donna ORGANIZES and DRAFTS — it is not " +
      "authoritative, it can be wrong, and it does not act on your behalf. " +
      "Nothing is sent, posted, published, or changed outside Donna without " +
      "your explicit approval each time.",
  },
  {
    title: "What Donna stores about you",
    body:
      "Donna stores, under your own private partition: (1) your voice " +
      "recordings, encrypted, for exactly 7 days — then they are " +
      "automatically and permanently deleted; (2) text transcripts of those " +
      "recordings, until you delete them; (3) the organized thoughts Donna " +
      "distills, each linked back to the exact words it came from; and " +
      "(4) personal memories — only ones you stated yourself or explicitly " +
      "approved. You can inspect, correct, export, or delete all of it at " +
      "any time.",
  },
  {
    title: "What your employer and admins CANNOT see",
    body:
      "Your Donna memory is private to you. It is not an employer-visible " +
      "psychological or performance profile: no manager, admin, or IT " +
      "operator can browse your transcripts, thoughts, or memories. Pilot " +
      "reports use pseudonymous IDs and suppress small groups. Your raw " +
      "audio and transcripts never enter git, reports, or shared evaluation " +
      "data — sharing any correction as an evaluation example requires your " +
      "separate explicit consent, and only after de-identification.",
  },
  {
    title: "Emotional context (optional and tentative)",
    body:
      "If you allow it, Donna makes tentative guesses about tone (for " +
      "example urgency or frustration) from word choice. These guesses are " +
      "often wrong, are shown to you labeled as guesses, are correctable, " +
      "and by default live only for the work session and then disappear. " +
      "Keeping them beyond a session is a separate opt-in you can revoke " +
      "at any time.",
  },
  {
    title: "Microsoft 365 context (your choice, per source)",
    body:
      "You choose exactly which Microsoft 365 sources Donna may read " +
      "(calendar, selected emails, Teams threads, files). Donna never " +
      "ingests your whole mailbox or history, and Microsoft sign-in is " +
      "handled by the company platform — Donna never sees your Microsoft " +
      "password or tokens. Disconnecting revokes access and purges cached " +
      "snippets.",
  },
  {
    title: "What the pilot excludes",
    body:
      "Do not capture HR, legal, financial, KYC, or payment content during " +
      "the pilot. Configuration rejects these categories.",
  },
  {
    title: "Leaving the pilot",
    body:
      "You can leave at any time: Donna exports everything it holds about " +
      "you to a file you choose, revokes every consent, disconnects " +
      "Microsoft 365, and — if you ask — deletes your captures, transcripts, " +
      "thoughts, and memories, then verifies the deletion. Your consent " +
      "history is kept as an audit trail of what you agreed to.",
  },
  {
    title: "When something goes wrong",
    body:
      "Use `donna pilot report-misfire` to privately report a bad " +
      "transcription, wrong bucket, bad memory, or anything else. Reports " +
      "stay in your private partition and feed the improvement loop only " +
      "with your consent.",
  },
];

/* ------------------------------------------------------------------ */
/* Redaction (SR-2)                                                    */
/* ------------------------------------------------------------------ */

/** True when this scope's CLI output should default to redacted. */
export function pilotRedactionActive(
  profile: { status: "enrolled" | "exited" } | undefined,
): boolean {
  return profile?.status === "enrolled";
}

/**
 * Render possibly-sensitive text for the terminal. When `show` is false
 * the content is replaced by a length-only placeholder — never a prefix,
 * so even the first words cannot be shoulder-surfed.
 */
export function redactContent(text: string, show: boolean): string {
  if (show) return text;
  return `[redacted — ${text.length} chars; re-run with --show-transcripts to view]`;
}
