/**
 * Server-side (Donna-side) validation for action draft payloads
 * (Specification 5.4, FR-3). Invalid recipients, targets, or content are
 * rejected BEFORE a draft exists — an invalid draft can never reach the
 * approval path. Payload content remains untrusted data; validation only
 * shapes it, never executes it.
 */
import type { ActionDraftPayload } from "@donna/core";

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const MAX_SUBJECT = 255;
const MAX_TITLE = 255;
const MAX_BODY = 32_000;
const MAX_TEAMS_TEXT = 8_000;

function validateEmails(values: string[], field: string, problems: string[]): void {
  for (const value of values) {
    if (!EMAIL_RE.test(value)) {
      problems.push(`${field} contains an invalid address`);
    }
  }
}

function isIso(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

/** Returns the list of validation problems (empty = valid). */
export function validateDraftPayload(payload: ActionDraftPayload): string[] {
  const problems: string[] = [];
  switch (payload.type) {
    case "email-draft": {
      if (!Array.isArray(payload.to) || payload.to.length === 0) {
        problems.push("to must name at least one recipient");
      } else {
        validateEmails(payload.to, "to", problems);
      }
      if (payload.cc !== undefined) validateEmails(payload.cc, "cc", problems);
      if (payload.subject.trim() === "" || payload.subject.length > MAX_SUBJECT) {
        problems.push(`subject must be 1..${MAX_SUBJECT} characters`);
      }
      if (payload.body.trim() === "" || payload.body.length > MAX_BODY) {
        problems.push(`body must be 1..${MAX_BODY} characters`);
      }
      break;
    }
    case "teams-message": {
      const target = payload.target;
      const hasChat = "chatId" in target && target.chatId.trim() !== "";
      const hasChannel =
        "teamId" in target &&
        target.teamId.trim() !== "" &&
        target.channelId.trim() !== "";
      if (!hasChat && !hasChannel) {
        problems.push("target must be a chatId or a teamId/channelId pair");
      }
      if (payload.text.trim() === "" || payload.text.length > MAX_TEAMS_TEXT) {
        problems.push(`text must be 1..${MAX_TEAMS_TEXT} characters`);
      }
      break;
    }
    case "calendar-proposal": {
      if (payload.title.trim() === "" || payload.title.length > MAX_TITLE) {
        problems.push(`title must be 1..${MAX_TITLE} characters`);
      }
      if (!isIso(payload.start) || !isIso(payload.end)) {
        problems.push("start and end must be ISO 8601 timestamps");
      } else if (payload.start >= payload.end) {
        problems.push("start must be before end");
      }
      if (payload.attendees !== undefined) {
        validateEmails(payload.attendees, "attendees", problems);
      }
      break;
    }
    case "file-publication": {
      if (payload.bucketId.trim() === "") {
        problems.push("bucketId must name the bucket to publish");
      }
      break;
    }
    case "task-action": {
      if (payload.title.trim() === "" || payload.title.length > MAX_TITLE) {
        problems.push(`title must be 1..${MAX_TITLE} characters`);
      }
      break;
    }
  }
  return problems;
}
