/**
 * Spec 6.7 FR-18: human-readable pending-placement headlines and choices.
 * Internal bucket IDs are NEVER rendered — names and descriptions only.
 */
import type { PendingPlacement } from "@donna/core";

export function pendingHeadline(record: PendingPlacement): string {
  const proposed =
    record.proposal?.mode === "new" ? record.proposal.name : undefined;
  switch (record.reason) {
    case "naming-invalid":
      return proposed !== undefined
        ? `Create new bucket ${proposed}? (name needs review)`
        : "Name needs review";
    case "possible-existing-match": {
      const existing = record.candidates.find(
        (c) => c.bucketId === record.recommendedBucketId,
      );
      return proposed !== undefined && existing !== undefined
        ? `Use ${existing.name} instead of new bucket ${proposed}?`
        : "Possible duplicate — review needed";
    }
    case "model-geometry-mismatch":
    case "new-vs-existing":
    case "middle-band": {
      const names = record.candidates.map((c) => c.name);
      const proposedPart = proposed !== undefined ? ` or new bucket ${proposed}` : "";
      return names.length > 0
        ? `Review needed: ${names.slice(0, 2).join(" or ")}${proposedPart}?`
        : "Review needed";
    }
    case "unknown-id":
    case "invalid-route":
      return "I couldn't verify that destination; choose a bucket";
  }
}

export function pendingChoices(record: PendingPlacement): string[] {
  const choices: string[] = [];
  for (const candidate of record.candidates.slice(0, 3)) {
    choices.push(`File in… ${candidate.name}`);
  }
  if (record.proposal?.mode === "new") {
    choices.push(`Create "${record.proposal.name}"`);
    choices.push("Edit name");
  }
  choices.push("Reject (file nothing)");
  return choices;
}
