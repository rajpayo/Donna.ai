---
id: "6.4"
title: "Pilot decision capture and graduation-evidence promotion"
phase: "06"
status: "approved"
depends_on: ["6.3"]
---

# Specification 6.4 — Pilot decision capture and graduation-evidence promotion

> **Approval (product owner, 2026-09-04):** "I approve the Phase 6
> graduation-evidence remediation specification for implementation." The
> product owner accepted the recommended answers to all six open questions;
> the binding resolutions are recorded inline under each question in
> [Open questions](#open-questions-for-the-product-owner) below.

## Outcome

Every pilot placement review produces an explicit, countable accept/move
decision, and any consented pilot example — first-pass-accepted or corrected —
can be previewed, confirmed, and promoted as a de-identified, adjudicated case
into the versioned organize dataset that the graduation gate actually reads, so
the bucket-acceptance gate can be re-measured on pilot-grown evidence instead of
the 3-case pre-pilot set.

## Why this comes now

Specification 6.3 is accepted and its honest current-state run is **REJECTED**:
first-pass bucket acceptance measured 0.8333 < 0.85 on the pre-pilot organize
set (Phase 6 README, Spec 6.3 evidence, report hash `011e5093…`). The gate reads
`organize.bucket_acceptance` from organize-stage eval reports only
(`packages/evals/src/graduation.ts:138`, gate block 138–146), and the organize
dataset behind the CLI registry is the envelope
`packages/evals/datasets/golden/organize/organize.v1.json` (version 1, inline
`cases: []`, `legacyImport` of `../organize.v1.json`), whose three cases all
come from the pre-Phase-4 flat file
(`packages/evals/datasets/golden/organize.v1.json`: `walk-between-meetings-01`,
`post-board-call-02`, `single-task-03`).

The pilot-evidence loop that should grow this set has three verified gaps:

1. **Acceptance is implicit.** The runbook's decision-mapping table records
   "accept placement" as "(implicit — no correction filed)"
   (`docs/pilot/RUNBOOK.md:93`). `collectRunDecisions`
   (`packages/pilot/src/runs.ts:90–109`) gathers only correction and memory
   events; `CorrectionType` (`packages/core/src/types.ts:363–374`) has no
   accept type. Successful placements never become labeled, countable evidence.
2. **The only promotion path writes to a dataset the gate does not read.**
   `promoteCorrectionToGoldenCase` (`packages/evals/src/golden.ts:67–132`)
   appends to `packages/evals/datasets/golden/corrections.v1.json` (wired at
   `apps/cli/src/main.ts:1727` and `:2776`) — a flat, unversioned file with no
   envelope, no adjudication log, and no stage — and it rejects anything that
   is not a `bucket.move` correction (`golden.ts:83–87`).
3. **No preview exists.** Promotion today fires immediately after a consent
   check and screening (`golden.ts:91–108`); the participant never sees the
   exact de-identified payload before it is shared.

This is a remediation of the Phase 6 pilot-evidence loop. It depends on Spec
6.3's tooling (accepted) and is not Phase 7 work.

## Scope

- An explicit, per-thought accept/move decision event recorded during pilot
  review, stored in the participant's own pilot partition, counted into run
  records and graduation extras.
- A previewable de-identification screen for promotion: the participant sees
  the exact fields to be shared and must confirm before anything is written.
- Promotion of both first-pass-accepted examples (label = the bucket Donna
  chose) and corrected examples (label = the user's corrected bucket, model's
  original placement recorded as the "before") as new **inline cases** in
  versioned organize envelopes — never `corrections.v1.json` — with one
  adjudication log entry per promoted case via the `recordAdjudication`
  mechanics (`packages/evals/src/datasets.ts:512–525`).
- A development partition and a frozen held-out partition for the organize
  stage, with assignment, versioning, and locking rules, and a way to point
  the organize eval run (and therefore the graduation runner) at the held-out
  set.
- Dataset version/hash flow into the candidate freeze (already mechanic:
  `graduation.ts:472–477` records name/version/sha256 per stage from evidence
  reports) plus a held-out lock artifact the freeze can be checked against.
- Runbook and decision-mapping updates so the pilot procedure matches the
  tooling.

## Non-goals

- No model, prompt, or bucket-tuning changes in this specification (tuning
  against the development partition is a later, separately evidenced activity;
  tuning against the held-out set remains forbidden by Spec 6.2 scope).
- No changes to graduation gate thresholds or gate semantics
  (`graduation.ts:118–193` stays untouched).
- No Phase 7 work (no desktop, Teams, or agent-layer changes).
- No fabrication of volunteer data: all new behavior is proven with synthetic
  data and scratch pilot scopes only; cohort-sourced cases arrive only through
  the product owner's real pilot runs.
- No changes to the existing `corrections.v1.json` promotion path or its two
  existing cases (legacy compatibility; see Open questions).
- No auto-graduation: product-owner sign-off stays manual
  (`graduation.ts:357–360`, `:496–499`).
- No retroactive reclassification of pre-6.4 implicit accepts.

## Expected repository changes

Proposed paths only; all remain proposals until this specification is approved.

- `packages/pilot/src/decisions.ts` (new) — the explicit pilot decision
  register (accept/move per thought), scoped file store under
  `data/pilot/<tenant>/<user>/decisions.json`, reusing the partition guards of
  `FileMisfireRegisterStore` (`packages/pilot/src/misfires.ts:86–114`).
- `packages/evals/src/promote-organize.ts` (new) — build, preview, screen, and
  write a de-identified inline organize case plus its adjudication entry into
  a target organize envelope; reuses `recordAdjudication`
  (`datasets.ts:512–525`) and `screenSensitiveContent`
  (`packages/memory/src/screening.ts:54–63`).
- `packages/evals/datasets/golden/organize/organize.dev.v1.json` (new) —
  development-partition envelope (`stage: "organize"`, version 1, starts with
  `cases: []`, no `legacyImport`).
- `packages/evals/datasets/golden/organize/organize.heldout.v1.json` (new) —
  held-out envelope (`stage: "organize"`, version 1, `legacyImport` of
  `../organize.v1.json` so the three pre-pilot cases stay single-sourced and
  unaltered, per the envelope pattern at `datasets.ts:430–444`).
- `packages/evals/datasets/golden/organize/organize.heldout.lock.json` (new) —
  the held-out freeze lock (name, version, sha256, frozen-at, first-results
  report hash).
- `packages/evals/src/cli.ts` — a `--dataset <path>` override for
  `run <stage>` (today the dataset comes strictly from the `DATASETS` registry,
  `cli.ts:58–68` and `:209–211`), a `heldout-freeze` command that writes the
  lock, and validation that a locked held-out envelope's content hash matches
  its lock at the locked version. The registry default for `organize` is
  repointed to the held-out envelope.
- `apps/cli/src/main.ts` — new pilot commands: `pilot decide accept
  <thought-id>`, `pilot decide move <thought-id> --to <bucket>` (wrapping
  `correct move` + decision record), `pilot decisions` (counts only),
  `pilot promote preview <decision-id|correction-id>` and `pilot promote
  confirm <…> --partition dev`; run-end and graduation-extras aggregation
  extended with decision counts.
- `packages/pilot/src/runs.ts` — decision counts gathered at run end alongside
  `collectRunDecisions`.
- `docs/pilot/RUNBOOK.md` — decision-mapping table: "accept placement" becomes
  an explicit command; promotion section updated to the preview/confirm flow.
- Tests: `packages/pilot/src/decisions.test.ts`,
  `packages/evals/src/promote-organize.test.ts` (new), plus CLI/integration
  coverage.

## Functional requirements

- `FR-1`: Every thought surfaced through `pilot review`
  (`apps/cli/src/main.ts:2522–2558`) can be given an explicit decision:
  `accept` (Donna's placement stands) or `move` (routes through the existing
  correction flow and links the resulting correction ID). Each decision record
  carries: decision ID, pseudonymous participant ID, thought ID, capture ID
  when known, decision kind, Donna's bucket at decision time, the decided
  bucket, timestamp, and run/scenario linkage when a run is open. Records are
  append-only; the latest decision per thought wins for counting.
- `FR-2`: Acceptance becomes countable: run records and
  `pilot graduation-extras` report explicit accept/move counts and an
  observed first-pass acceptance rate (`accepts / (accepts + moves)`) per
  scope, counts and IDs only.
- `FR-3`: The `eval-sharing` consent purpose (`EVAL_SHARING_PURPOSE`,
  `packages/evals/src/golden.ts:21`) remains mandatory and is checked
  per promotion — once at preview and again at confirm — via
  `MemoryService.hasConsent` (`packages/memory/src/service.ts:204–206`).
  Without an active grant, both steps fail closed and nothing is written.
  Revocation between preview and confirm blocks the confirm.
- `FR-4`: Preview before promotion: `pilot promote preview` renders the exact
  de-identified case payload to be written — thought summary text, expected
  bucket label, scenario class, variant labels, proposed case ID, target
  partition — plus a SHA-256 hash of that payload. `pilot promote confirm`
  writes byte-identical content to what was previewed; the written case's
  content hash must equal the previewed hash. Raw audio, full transcripts, and
  capture/tenant/user/participant IDs are never part of the payload (field
  allowlist; see SR-3).
- `FR-5`: Corrected-example promotion: for an accepted `bucket.move`
  correction, the inline organize case's label is the user's corrected bucket
  (`expected.thoughts[].bucket = toBucketName`), and the adjudication entry's
  `change` field records the model's original placement as the before, e.g.
  `"expected.bucket: 'Product Ideas' → 'Vendor Portal'"`, with `reason` naming
  the misfire/correction linkage. Case shape must satisfy the inline organize
  case schema (`datasets.ts:124–144`).
- `FR-6`: Accepted-example promotion: for an explicit accept decision, the
  inline case's label is the bucket Donna chose at decision time, and the
  adjudication entry records a first-pass-acceptance promotion (e.g. change =
  `"new case: first-pass accepted placement 'Vendor Portal'"`).
- `FR-7`: Every promoted case appends exactly one adjudication entry via
  `recordAdjudication` mechanics, with a pseudonymous adjudicator ID
  (`datasets.ts:290–301`), and the target envelope's integer `version` is
  bumped in the same write (the loader treats version as caller-managed —
  `datasets.ts:509–511`).
- `FR-8`: Partitions: promoted cases land only in the development envelope
  (`organize.dev.v1.json`). The held-out envelope
  (`organize.heldout.v1.json`) changes only by a product-owner-gated
  dev→held-out promotion that moves selected cases (a case never exists in
  both partitions at the same version), bumps the held-out version, and
  appends adjudication entries in both envelopes.
- `FR-9`: Held-out freeze: the first eval run that produces results against a
  held-out version must be followed by `heldout-freeze`, which writes
  `organize.heldout.lock.json` (name, version, sha256, frozen-at, report hash
  of the first-results run). Thereafter, dataset validation fails if the
  held-out envelope's content hash differs from the lock at the locked
  version — held-out cases are not altered after results are known (Spec 6.3
  FR-2). A version bump requires the gated dev→held-out promotion and a new
  lock after the next results run.
- `FR-10`: The evals CLI can run the organize stage against either partition
  (`run organize [--dataset <path>]`), and the organize evidence passed to
  `graduation-run` (`packages/evals/src/cli.ts:349–403`) for a graduation
  decision must come from the held-out envelope. The v2 freeze then records
  the held-out dataset's name/version/sha256
  (`packages/evals/src/graduation.ts:472–477`), and the demonstration includes
  a check that the freeze hash matches the lock file.
- `FR-11`: Case identity is deterministic and idempotent: the promoted case ID
  derives from the de-identified payload hash (e.g.
  `organize-pilot-<sha256[:12]>`); re-promoting the same decision/correction
  is a no-op, mirroring the existing idempotency contract
  (`golden.ts:88–90`).
- `FR-12`: Promoted cases carry cohort metadata (scenario class, variant
  labels, language/accent/noise notes) through the existing case-meta fields
  (`datasets.ts:54–74`) so cohort slicing keeps working; provenance is
  `de-identified` (or `consented-volunteer` when the product owner so
  classifies) with the matching consent state, satisfying the loader's
  consent/provenance consistency checks (`datasets.ts:372–386`).

## Security, privacy, and provenance requirements

- `SR-1`: Tenant/user isolation: the decision register and all promotion
  inputs live in the participant's pilot partition
  (`data/pilot/<tenant>/<user>/`); stores reject records whose tenant/user do
  not match their partition (pattern of `misfires.ts:103–109`). Every read and
  write is scoped; the tenant/user comes from the authenticated CLI scope,
  never from flags or payloads.
- `SR-2`: Consent fail-closed: any consent-check failure, screening failure,
  or validation failure aborts promotion with nothing written and a clean
  actionable message (no stack traces), matching the existing fail-closed
  behavior verified in Spec 6.2 (`apps/cli/src/main.ts:2763–2770`). Errors and
  logs name category tokens only, never matched content
  (`packages/memory/src/screening.ts:5–9`, `:67–76`).
- `SR-3`: De-identification screening: the shared payload is built from a
  field allowlist (thought summary text, expected bucket label, scenario
  class, variant labels, case ID, partition). Every text field passes
  `screenSensitiveContent` at preview and again at confirm; the written
  envelope is re-screened at load/validate time by the existing loader check
  (`datasets.ts:471–477`). An automated test asserts forbidden values (raw
  audio paths, full transcript text, capture/tenant/user/participant IDs) never
  appear in any promoted case.
- `SR-4`: Small cohort slices (< 3) stay suppressed: promoted-case cohort
  labels flow through `buildCohortSlices`, which drops slices smaller than
  `MIN_COHORT_SIZE = 3` (`packages/evals/src/report.ts:32`, suppression at
  `:389`). The spec adds a test that a promoted-case cohort of n < 3 does not
  appear in the organize report's cohort slices.
- `SR-5`: Provenance: every promoted case declares `provenance` and `consent`
  metadata consistent with its origin, a pseudonymous `labeler` (never a real
  name, email, or initials — per the runbook's participant-ID rule), and its
  promotion is reconstructible from the envelope's adjudication log alone.
- `SR-6`: The held-out lock and freeze hashes make post-hoc alteration
  detectable; any mismatch is a hard validation failure, not a warning.
- `SR-7`: No secrets, raw recordings, or full transcripts are written to the
  repository by any new command; reports and run/decision records remain
  counts-and-IDs only (SR-2 of Specs 6.1/6.2). Graduation reports stay
  local-only artifacts (they are git-ignored — `.gitignore:14–15`); the
  decision record references the report hash, and this spec's lock file gives
  the dataset side a committable, content-free anchor.

## Acceptance criteria

- `AC-1`: In a synthetic end-to-end run, 100% of thoughts surfaced in
  `pilot review` receive an explicit accept or move decision; `pilot run end`
  output and the run record show matching decision counts; a run with
  undecided reviewed thoughts prints the undecided count.
- `AC-2`: `pilot graduation-extras` output includes accept/move counts and the
  observed first-pass acceptance rate per scope, computed from the decision
  register (demonstrated on at least two scratch scopes with known decision
  mixes).
- `AC-3`: Consent fail-closed: preview and confirm without active
  `eval-sharing` consent both fail closed with zero writes; granting consent
  enables promotion; revoking between preview and confirm makes confirm fail
  closed. All three transitions demonstrated live and covered by tests.
- `AC-4`: Preview fidelity: the payload hash shown at preview equals the
  content hash of the written case; the preview lists exactly the shared
  fields (summary text, expected bucket, scenario class, variant labels, case
  ID, partition) and nothing else.
- `AC-5`: Corrected promotion: after a synthetic `bucket.move` correction is
  accepted and promoted, the dev envelope contains an inline case whose
  expected bucket equals the corrected bucket, the adjudication log records
  the before→after change, the envelope version incremented by exactly one,
  and `donna evals validate` passes on the updated envelope.
- `AC-6`: Accepted promotion: after an explicit accept is promoted, the dev
  envelope case's expected bucket equals Donna's chosen bucket and the
  adjudication entry records a first-pass-acceptance promotion; version bumped
  by one; validation passes.
- `AC-7`: Screening: a payload containing a national-id pattern, a Luhn-valid
  card number, an API-token pattern, or a password pattern is rejected at
  preview and never written (one test per category from
  `screening.ts:12–17`).
- `AC-8`: Partition discipline: a dev→held-out gated promotion moves the case
  (absent from dev, present in held-out at the new version, adjudication
  entries in both envelopes); after `heldout-freeze`, any hand-edit to the
  locked held-out content fails validation; `run organize` against the
  held-out envelope produces a report whose dataset name/version/sha256 match
  the lock.
- `AC-9`: Freeze linkage: a `graduation-run` consuming the held-out organize
  report records the held-out dataset name/version/sha256 in
  `freeze.datasets`, and the demonstrated check shows freeze hash == lock
  hash.
- `AC-10`: Cohort suppression: an organize report over a dataset containing a
  promoted-case cohort of n < 3 shows that cohort suppressed from the slices
  section.
- `AC-11`: Idempotency: re-promoting the same decision or correction reports
  "already shared" and leaves the envelope byte-identical.
- `AC-12`: Full existing suite stays green (baseline: 455 tests at Spec 6.3
  acceptance) with the new tests added; typecheck clean.

## Verification

- Unit: decision register (record, latest-wins counting, partition mismatch
  rejection, unknown-thought handling); promotion builder (allowlist
  enforcement, deterministic case IDs, version bump + adjudication append,
  corrected vs accepted label rules); consent fail-closed at both steps;
  screening rejection per category; lock write and lock-mismatch validation
  failure; `--dataset` override plumbing.
- Integration: synthetic-participant loop — enroll (scratch scope) → capture
  (synthetic espeak-ng audio) → explicit accept + move → preview → consent
  grant → confirm → dev envelope diff → organize run against dev → gated
  dev→held-out move → held-out run → freeze → `graduation-run` showing the
  held-out dataset hash.
- Security: cross-partition read/write attempts fail; forbidden-value scan
  over every promoted case; log/error output contains category tokens only.
- Evaluation: `donna evals validate` over all envelopes; `run organize`
  against both partitions; confirm the gate still reads
  `organize.bucket_acceptance` unchanged (`graduation.ts:138–146`).
- Expected artifacts: test run output, the dev/held-out envelope diffs, the
  lock file, the organize stage reports, and a v2 graduation report whose
  freeze section names the held-out dataset version and hash.

## Demonstration

The product owner examines, on synthetic data and scratch scopes only:

1. The review flow: a capture's thoughts each receive an explicit decision;
   the decision list and run record show counts; an undecided thought is
   visibly counted.
2. The consent gate: preview and confirm attempted without `eval-sharing`
   consent fail closed; the grant, a successful promotion, and a
   revoke-then-confirm failure are shown in sequence.
3. The preview screen: the exact shared fields and payload hash, then the
   written case diffed against the preview (hash equality shown).
4. Both promotion kinds: one corrected example (before→after in the
   adjudication log) and one first-pass-accepted example, each with its
   version bump.
5. Partition mechanics: dev-only landing, the gated dev→held-out move, the
   freeze lock, and a hand-edit to the locked held-out envelope failing
   validation live.
6. The graduation linkage: `run organize --dataset <held-out>` →
   `graduation-run` → the freeze's dataset hash compared to the lock file.
7. A screening rejection demonstrated with a synthetic payload containing a
   fake national-id pattern.

## Completion evidence

Empty until implementation. Record commits, changed interfaces, test results,
metrics, demo evidence, limitations, and the product-owner decision per
EXECUTION.md.

## Review gate

Implementation is forbidden while `status` is `draft`. After implementation
and verification, set `status` to `in-review` and wait for explicit product
owner acceptance before starting the next specification. The demonstration
above is the review-gate plan; per the Phase 6 reality constraint, all
evidence is produced with synthetic data and scratch pilot scopes — volunteer
data is never fabricated, and pilot graduation is not claimed by this
specification.

## Open questions for the product owner

1. **Minimum held-out size.** The gate failed at 0.8333 on 3 cases —
   statistically thin by the Spec 6.3 evidence's own admission. What minimum
   held-out size (total and per scenario class) makes a graduation run
   meaningful — e.g. ≥ 20 cases total with ≥ 2 per core scenario class? This
   number drives how much dev→held-out promotion must happen before the next
   graduation attempt.
   - **Resolved (product owner, 2026-09-04):** the minimum held-out size
     before the next graduation attempt is **≥ 20 cases total, with ≥ 2 per
     core scenario class**.
2. **Text content of accepted examples.** The inline organize case schema
   requires a non-empty `transcript` and at least one `contains` substring per
   expected thought (`datasets.ts:124–144`), so a fully text-free case is not
   representable. For first-pass-accepted examples, is the de-identified
   thought summary text sufficient as the case `transcript` (maximally
   text-minimized), or should a fuller de-identified transcript excerpt be
   shared for tuning value? This is a privacy/utility trade-off only the
   product owner can set.
   - **Resolved (product owner, 2026-09-04):** accepted-example text is the
     **de-identified thought summary ONLY** (maximal text minimization); the
     case `transcript` field uses the summary text.
3. **Held-out seeding.** This spec seeds held-out v1 with the three pre-pilot
   cases (results already known; content frozen unaltered, which satisfies
   Spec 6.3 FR-2 literally). The alternative is an empty held-out start with
   the gate reading "no evidence" until the first gated promotion. Which do
   you want?
   - **Resolved (product owner, 2026-09-04):** **freeze the 3 pre-pilot cases
     unaltered as held-out v1** (`legacyImport` stays).
4. **Adjudicator of record.** Who is the pseudonymous adjudicator on promoted
   cases — the participant (at confirm time) or the product owner (at a batch
   review)? And is dev→held-out promotion a per-case product-owner decision or
   a stratified batch with a recorded rationale?
   - **Resolved (product owner, 2026-09-04):** the adjudicator of record is
     **the product owner at batch review**; dev→held-out promotion is a
     **stratified batch with a recorded rationale** (not per-case).
5. **Legacy corrections.v1.json cases.** Should the two existing de-identified
   `bucket.move` cases in `packages/evals/datasets/golden/corrections.v1.json`
   be re-promoted into the dev envelope under the new mechanics, or left as
   legacy-only evidence?
   - **Resolved (product owner, 2026-09-04):** the 2 existing
     `corrections.v1.json` cases **ARE re-promoted into the dev envelope**
     under the new mechanics.
6. **Dev-partition tuning authority.** Spec 6.2 forbids tuning on the held-out
   set; confirm the development partition is explicitly fair game for
   config/prompt experiments (each still evidenced by report diffs) so the
   loop has somewhere legal to iterate.
   - **Resolved (product owner, 2026-09-04):** the dev partition is
     **explicitly legal for config/prompt tuning experiments**, each evidenced
     by report diffs.
