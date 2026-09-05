# Specification 6.6 fresh P-00 graduation matrix

This runbook starts only after the mechanical winner and its canonical
prompt/config are committed with a clean tree. Validation-v3 and the private
full-context diagnostic are not graduation evidence.

## Before recording

1. Confirm the current CLI scope is the consenting P-00 pilot scope without
   printing its tenant, user, or participant identifiers.
2. Confirm active `eval-sharing` consent and the normal seven-day encrypted
   audio retention policy.
3. Keep raw recordings and pilot state under the existing private Donna data
   directory. Never copy them into this repository.
4. Record the winner commit and do not change model, prompt, temperature,
   thresholds, labels, scorer, or datasets after the fresh envelope produces a
   result.

End-user experience: the product owner sees the normal consent status and a
clean winner commit before speaking any fresh scenario.

## Nine fresh recordings

Record one new short capture for each class. The words must be the product
owner's real, current content; do not read fabricated fixtures.

1. `meetings` — meeting observation or preparation.
2. `tasks` — a commitment with an owner and deadline.
3. `ideas` — a durable idea with no action commitment.
4. `follow-ups` — a follow-up request or promise.
5. `decisions` — a decision and its supporting detail.
6. `people` — a durable people/relationship note.
7. `projects` — a named project/product update.
8. `mixed-emotional` — mixed content with tentative emotional wording.
9. `multi-capture` — a later capture that should reuse an earlier bucket.

For each recording:

```powershell
npm run capture -- capture "<private-audio-path>"
npm run capture -- pilot review
npm run capture -- pilot decide accept "<thought-id>"
# or, when Donna's placement is wrong:
npm run capture -- pilot decide move "<thought-id>" --to "<correct-bucket>"
npm run capture -- pilot promote preview "<decision-id>"
npm run capture -- pilot promote confirm "<decision-id>" --partition dev
```

Repeat `pilot decide` and preview/confirm for every atomic thought. Use the
normal correction/adjudication commands when a thought must be split, merged,
or edited before promotion.

End-user experience: after each capture the product owner reviews every
thought, records an explicit accept/move decision, sees the exact
de-identified fields in the promotion preview, and confirms only matching
content.

## Batch adjudication and envelope construction

After all nine recordings:

- batch-adjudicate promoted development cases as product owner;
- retain at least 20 fresh atomic cases, at least 2 in every class;
- retain a non-empty minted-label slice;
- screen every shared text field and bucket snapshot;
- include only summary-minimized, bucket-list-only case data;
- preserve consent, provenance, and adjudication records;
- use new opaque case IDs;
- do not inspect dev/validation expected labels while authoring fresh labels;
- do not run an organizer against the fresh envelope yet.

End-user experience: the product owner sees class counts, screening/consent
status, and the exact de-identified envelope, with `NO RESULTS YET`.

## Freeze, one final run, and graduation

From the repository root, after the fresh envelope is committed and the tree
is clean:

```powershell
npm run eval:harness --workspace @donna/evals -- organize-experiment freeze-fresh `
  --plan packages/evals/experiments/organize/6.6/plan.json `
  --selection packages/evals/experiments/organize/6.6/selection.json `
  --dataset "<fresh-envelope>"

npm run eval:harness --workspace @donna/evals -- organize-experiment final `
  --plan packages/evals/experiments/organize/6.6/plan.json `
  --selection packages/evals/experiments/organize/6.6/selection.json `
  --dataset "<fresh-envelope>"
```

The freeze command must report all nine classes, at least 20 total cases, at
least 2 per class, a non-empty minted slice, zero case-ID/content overlap, and
`NO RESULTS YET`. The final command permits one winner run only. Use
`--retry-external` exactly once only when attempt 1 is classified entirely as
external gateway/network failure with zero product errors and zero hard
failures.

End-user experience: the product owner sees one frozen unseen exam, one valid
winner result (or one preserved infrastructure retry), then the unchanged
graduation gates plus the separate minted exact-name barrier. Phase 7 remains
blocked pending V-REPEAT, retention/export evidence, a complete report, and
explicit signature.
