/**
 * Sensitive-content screening for durable memory (Specification 2.1 SR-4).
 *
 * Model-generated memory proposals are screened BEFORE they are persisted:
 * secrets, credentials, and regulated identifiers are rejected as durable
 * model-generated memory. The screener is deterministic and reports only
 * category tokens — never the matched text — so a rejected proposal cannot
 * leak the very secret it contained into logs or errors.
 */

/** Machine-readable categories of rejected content. */
export type SensitiveCategory =
  | "private-key"
  | "api-token"
  | "password"
  | "card-number"
  | "national-id";

export interface ScreeningHit {
  category: SensitiveCategory;
}

const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const API_TOKEN =
  /\b(sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/;
const PASSWORD = /\b(password|passwd|pwd)\s*(?:is|=|:)\s*\S+/i;
const NATIONAL_ID = /\b\d{3}-\d{2}-\d{4}\b/;

/** Luhn check over 13–19 digits (spaces/dashes stripped). */
function looksLikeCardNumber(text: string): boolean {
  const candidates = text.match(/\b(?:\d[ -]?){13,19}\b/g) ?? [];
  for (const candidate of candidates) {
    const digits = candidate.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (double) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      double = !double;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

/**
 * Screen text that a model wants to persist as durable memory. Returns the
 * list of violated categories (empty when the text is clean).
 */
export function screenSensitiveContent(text: string): ScreeningHit[] {
  const hits: ScreeningHit[] = [];
  if (PRIVATE_KEY.test(text)) hits.push({ category: "private-key" });
  if (API_TOKEN.test(text)) hits.push({ category: "api-token" });
  if (PASSWORD.test(text)) hits.push({ category: "password" });
  if (looksLikeCardNumber(text)) hits.push({ category: "card-number" });
  if (NATIONAL_ID.test(text)) hits.push({ category: "national-id" });
  return hits;
}

/**
 * Thrown when model-generated memory content fails SR-4 screening. The
 * message names categories only — never the matched content.
 */
export class SensitiveContentError extends Error {
  constructor(readonly categories: SensitiveCategory[]) {
    super(
      "Model-generated memory rejected by sensitive-content screening: " +
        categories.join(", "),
    );
    this.name = "SensitiveContentError";
  }
}
