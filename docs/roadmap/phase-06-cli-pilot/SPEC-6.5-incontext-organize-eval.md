---
id: "6.5"
title: "In-context organize evaluation (capture-time bucket snapshots)"
phase: "06"
status: "blocked"
depends_on: ["6.4"]
---

# Specification 6.5 — In-context organize evaluation (capture-time bucket snapshots)

> **Approval (product owner, 2026-09-05):** the product owner approved this
> specification for implementation, including all five resolutions recorded
> inline under [Open questions](#open-questions-for-the-product-owner). The
> product owner instructed the implementer to use engineering and product
> judgment within the accepted product boundaries rather than follow wording
> mechanically; any material change to product behavior, privacy or consent,
> gate meaning or threshold, or architecture still requires a pause and an
> explicit product-owner decision.
>
> **Implementation blocker (2026-09-05):** the sanctioned dry run found 55
> cases reconstructible exactly and two legacy correction-derived inline
> cases whose source corrections and capture links no longer exist in the
> authorized participant scope. Per the binding ambiguity resolution, their
> snapshots/origins will not be guessed and held-out v3 will not be run until
> the product owner batch-adjudicates those two entries in
> `organize.snapshot-drift.v3.json`.

## Outcome

The organize-stage eval measures what the graduation gate intends — in-context
first-pass bucket placement — by supplying each organize case the bucket list
that actually existed at capture time, so `organize.bucket_acceptance` stops
measuring cold-start naming luck and starts measuring the placement behavior
the pilot adjudicated. Gate thresholds and gate semantics are untouched; only
the instrument's fidelity changes.

## Why this comes now

Specification 6.4 is accepted and its machinery worked: 55 pilot placements
were promoted as de-identified, adjudicated inline organize cases, and 29 of
them now sit in the frozen held-out partition. The official held-out v2 run —
`packages/evals/reports/organize/organize.heldout.v1-2026-09-04T19-45-26-493Z.json`
(dataset `organize.heldout.v1` v2, sha256 `93c9cf09…`, 32 cases, 0 errored,
0 hard failures) — measured:

- `organize.thought_coverage` 0.9688
- `organize.task_recall` 1.0
- `organize.provenance_fidelity` 1.0
- `organize.bucket_acceptance` **0.4531** — far below the 0.85 gate
  (`packages/evals/src/graduation.ts:138–146`).

That 0.4531 is an instrument artifact, not a placement-quality reading. The
organize scorer runs the organizer **cold**:

```text
packages/evals/src/scorers/organize.ts:92
    output = await options.organizer.organize(transcript, []);
```

The second argument is the existing-buckets list — hard-coded empty — and no
`ContextPacket` is passed. Yet the organizer explicitly accepts that list:
`Organizer.organize(transcript, existingBuckets, context?, session?)`
(`packages/core/src/ports.ts:75–80`), and the prompt builder renders it as the
"EXISTING BUCKETS" section (`buildOrganizePrompt`,
`packages/providers/src/organize-schema.ts:133–139`, bucket list at
`:149–153`). The production pipeline always passes the real list —
`store.listBuckets(...)` at `packages/pipeline/src/run.ts:194`, forwarded at
`run.ts:493` — plus assembled memory context.

The 55 promoted labels record the buckets Donna chose **in context** during
the live pilot: the participant's existing buckets and memory were present,
and the pilot decision register shows 55/55 explicit accepts (100% in-context
first-pass acceptance, per `pilot graduation-extras` placement counts). Cold,
the model mints different bucket names for equivalent content, so exact-match
`bucket_acceptance` (compared at `organize.ts:171–185` as
`suggestedBucket ?? newBucketName`, trimmed, lowercased) collapses to 0.4531.
The gate is reading cold-start naming, not the in-context placement it exists
to measure. Fixing the instrument is a prerequisite for any meaningful
graduation re-run; it depends on Spec 6.4's accepted promotion, partition,
adjudication, and freeze-lock machinery and is not Phase 7 work.

## Scope

- Extend the inline organize case schema
  (`packages/evals/src/datasets.ts:124–144`) with an optional per-case
  `existingBuckets` snapshot (name + description pairs, the exact
  `Pick<Bucket, "name" | "description">` shape the organizer port consumes)
  and an optional per-expected-thought `bucketOrigin: "minted" | "joined"`
  label, with loader validation rules that make label leakage a hard failure
  (SR-1).
- Change the organize scorer to pass the case's snapshot to the organizer
  (absent snapshot ⇒ today's cold behavior, byte-identical) and to score
  bucket acceptance with the minted/joined branch defined in FR-4.
- Amendment tooling that reconstructs capture-time bucket snapshots for the
  55 already-promoted cases (29 held-out + 26 pilot-promoted in dev) from
  bucket `createdAt` (`packages/core/src/types.ts:156`) versus capture
  `capturedAt` (`types.ts:16`), with rename/merge rollback through the
  timestamped correction events, one adjudication entry per amended case, and
  a drift report for the product owner.
- Going forward: the Spec 6.4 promotion flow records the bucket snapshot at
  decision/confirm time so new cases are born with their capture-time context
  (no reconstruction needed ever again).
- A held-out v3 amendment cycle that respects the freeze lock: the v2 lock
  (`organize.heldout.lock.json`, v2, sha256 `93c9cf09…`, frozen
  2026-09-04T20:00:36Z) makes any content edit a hard validation failure, so
  amendment lands only via the sanctioned version-bump → results run →
  re-freeze path (Spec 6.4 FR-9 mechanics,
  `packages/evals/src/promote-organize.ts:622–714`).
- A before/after report comparison on the SAME frozen held-out v2 case
  content: the official v2 cold run (0.4531) versus the v3 in-context run,
  with an amendment-diff artifact proving the only content change is the
  added snapshot/origin fields.
- Runbook and decision-mapping updates so the pilot procedure records
  snapshots at decision time.

## Non-goals

- No change to graduation gate thresholds or gate semantics: the 0.85
  first-pass bucket-acceptance bar stays, and the gate keeps reading
  `organize.bucket_acceptance` from organize-stage reports
  (`graduation.ts:118–193` untouched).
- No model, prompt, or bucket-tuning changes (the organizer port and prompt
  already accept the bucket list; this spec only supplies it).
- No changes to the full-loop stage; longitudinal pilot scenarios remain its
  job (see Design analysis, option B).
- No memory/retrieved-context snapshots in the case payload — bucket list
  only (product-owner resolution, 2026-09-05): the smaller de-identification
  surface is the reason, and the residual fidelity gap is recorded as a
  known limitation (see Design analysis, option C2).
- No fabrication of pilot data: reconstruction runs against real pilot
  partitions under the participants' existing consent flow; anything not
  reconstructible is flagged, never invented.
- No retroactive change to the frozen v2 envelope or its lock, and no
  re-derivation of existing case IDs (case identity stays stable across the
  amendment — see FR-6).
- No auto-graduation: product-owner sign-off stays manual.

## Design analysis (verified against the code)

### Option A — per-case bucket snapshots (RECOMMENDED)

Each organize case carries `existingBuckets`: the names+descriptions present
at capture time. The scorer passes them to the organizer
(`organize.ts:92` becomes `organize(transcript, payload.existingBuckets ?? [])`).

- **Fits the existing machinery.** The organizer port
  (`ports.ts:75–80`) and prompt (`organize-schema.ts:133–139`) already
  consume the list; no provider change. Cases stay independent,
  individually runnable, and order-free; the envelope/adjudication/
  freeze-lock mechanics from Spec 6.4 apply unchanged.
- **Reconstruction is possible today.** `Bucket.createdAt` exists
  (`types.ts:156`), decision records carry `captureId` and `decidedAt`
  (`packages/pilot/src/decisions.ts:34,42`), and captures carry
  `capturedAt` (`types.ts:16`). Existence rule: a bucket was present at
  capture time iff `bucket.createdAt <= capture.capturedAt`.
- **Known reconstruction hazard (verified):** the file bucket store keeps
  only CURRENT state — `renameBucket` overwrites the name in place
  (`packages/buckets/src/store.file.ts:215–232`) and `mergeBuckets` deletes
  the source bucket (`store.file.ts:234–254`). Naive reconstruction would
  use post-rename names and miss merged-away buckets. Mitigation: the
  correction store is append-only and timestamped, and `CorrectionType`
  includes `bucket.rename`/`bucket.merge` events, so the amendment tool
  rolls names/descriptions back through correction events newer than the
  capture. Any case whose reconstruction stays ambiguous (e.g. a merge that
  destroyed a name with no rename event) is flagged in the drift report and
  adjudicated by the product owner at batch review before the v3 run —
  never guessed, never silently excluded (product-owner resolution,
  2026-09-05).
- **The label-leak nuance (must be designed, not patched).** For the FIRST
  capture that minted a bucket, that bucket did not exist at capture time —
  the snapshot correctly excludes it. Supplying it would hand the model the
  label (trivial pass, measures nothing). Not supplying it means the model
  may mint a *different* name for equivalent content, and the exact-match
  comparison (`organize.ts:180–184`) still fails despite correct mint
  behavior. Hence the per-thought `bucketOrigin` label:
  - `joined` — the label bucket existed at capture time (it is IN the
    snapshot). Acceptance = the model placed the thought into that exact
    bucket. This is the core in-context measurement and keeps exact-match
    semantics.
  - `minted` — the label bucket was created by this capture (it is NOT in
    the snapshot; the loader hard-fails any case where it appears — SR-1).
    The honest reading of the pilot adjudication is "minting a new bucket
    with a sensible name was accepted." Acceptance requires (a) the model
    actually minted (`newBucketName` set) rather than force-joining an
    existing snapshot bucket, and (b) the minted name matches the label
    under the exact normalized comparison. A separate NON-gate diagnostic,
    `organize.bucket_name_equivalence` (deterministic, pre-registered
    normalization: case/whitespace/punctuation folding + token-set
    equality), is reported per case so the before/after report shows how
    much residual gap is naming drift versus genuine misplacement; every
    equivalence-only pass is surfaced per case in the report for
    adjudication. The product owner resolved the gate treatment on
    2026-09-05: **exact-match-only** — equivalence never feeds
    `organize.bucket_acceptance` under this specification (SR-2).
- **The trade-off the resolution weighed:** exact-match-only for minted
  labels keeps measuring some naming luck and can under-read in-context
  placement; similarity-counted-by-default lets a fuzzy threshold pass
  near-misses without adjudication — the "trivially pass" failure mode
  SR-2 forbids. The product owner chose the conservative side
  (2026-09-05): exact-match-only, with the per-case equivalence diagnostic
  as the sanctioned mitigation — the residual naming-drift gap is measured
  and visible in every report, never silently absorbed into the gate.

### Option B — longitudinal stateful organize eval (NOT recommended now)

Run a class's cases in capture order against an evolving bucket store,
mirroring the full-loop scorer's pattern (`packages/evals/src/scorers/
full-loop.ts:129` creates a real `FileBucketStore` per case; steps execute
in order at `:238–347`, so minted buckets persist to later steps).

- More faithful to the pilot in principle — but the fidelity advantage is
  partly **illusory** here: the 55 promoted cases are a CONSENTED SUBSET of
  pilot captures. Buckets minted by captures that were never promoted
  (no eval-sharing consent, misfire-excluded thoughts) are absent from the
  case set, so replaying only promoted cases reconstructs a bucket state
  the pilot never actually had. Option A's per-case snapshots reconstruct
  the TRUE state from the store's own timestamps; option B cannot.
- Cases carry no capture timestamp today (adjudication `at` is promotion
  time), so capture ordering is not recoverable from the envelopes alone.
- It couples cases: case N's model output becomes case N+1's context, so a
  gateway flake or a naming variance cascades into every later case —
  determinism and isolation get strictly worse, and the harness's simple
  sequential contract (`packages/evals/src/harness.ts:136–137`) becomes
  order-sensitive stateful replay.
- It duplicates the full-loop stage's reason to exist. If longitudinal
  pilot-derived scenarios are wanted later, they belong there as scripted
  cases — a separate specification.

### Option C — hybrid (partially absorbed into the recommendation)

- **C1 (absorbed):** Option A now; revisit longitudinal fidelity only if the
  before/after evidence shows a residual gap attributable to evolving state
  rather than naming. The full-loop stage already covers longitudinal
  mechanics, so no new instrument is built speculatively.
- **C2 (rejected for this spec — product-owner resolution, 2026-09-05):**
  snapshot the assembled `ContextPacket` (memory elements) alongside the
  bucket list. The pipeline passes it in production (`run.ts:195,493`), so
  omitting it leaves a known fidelity gap — but memory content is a much
  larger de-identification and leak surface than bucket names, and the
  label being measured is a *bucket* decision whose prompt-relevant input
  is the bucket list. The product owner confirmed bucket-list-only scope;
  the residual gap is recorded as a known limitation.

## Expected repository changes

Proposed paths only; all remain proposals until this specification is approved.

- `packages/evals/src/datasets.ts` — `organizeCaseSchema` gains optional
  `existingBuckets: Array<{ name: string; description: string }>` (per case)
  and `bucketOrigin: "minted" | "joined"` (per expected thought); loader
  validation: `joined` ⇒ the label bucket name MUST appear in the case
  snapshot; `minted` ⇒ it MUST NOT (hard validation failure — the leak
  guard); snapshot entries screened like every other text field
  (`datasets.ts:471–477` re-screen at load stays in force).
- `packages/evals/src/scorers/organize.ts` — pass
  `payload.existingBuckets ?? []` to the organizer; bucket-acceptance branch
  on `bucketOrigin` (FR-4); emit the non-gate diagnostic
  `organize.bucket_name_equivalence` for minted-label cases; absent
  snapshot/origin fields ⇒ byte-identical current behavior (the three
  pre-pilot legacy cases stay cold).
- `packages/evals/src/amend-organize-snapshots.ts` (new) — reconstruction
  tooling: per promoted case, resolve the source pilot scope's decision /
  correction record → capture `capturedAt` → snapshot = buckets with
  `createdAt <= capturedAt`, names/descriptions rolled back through
  timestamped rename/merge correction events newer than the capture; writes
  the amended case + exactly one adjudication entry per case; emits the
  drift report (ambiguous reconstructions, name drift between decision-time
  `donnaBucket`/`decidedBucket` names and reconstructed names).
- `packages/evals/src/promote-organize.ts` — the promotion source gains an
  optional `existingBuckets` snapshot + per-thought `bucketOrigin`, captured
  at decision/confirm time and included in the previewed/screened payload
  BEFORE case-ID derivation, so new case IDs cover the snapshot while
  existing IDs never change (FR-6).
- `apps/cli/src/main.ts` — `pilot decide`/`pilot promote preview|confirm`
  thread the current bucket list into the promotion source; preview renders
  the snapshot (names+descriptions) alongside the existing shared fields.
- `packages/evals/src/cli.ts` — an `amend-organize-snapshots` command
  (dev partition; held-out amendment only via the gated batch mechanics);
  the amendment-diff artifact writer (added-fields-only proof).
- `docs/pilot/RUNBOOK.md` — decision-mapping table: snapshot capture at
  decision time; the amended preview screen.
- Tests: `packages/evals/src/amend-organize-snapshots.test.ts` (new),
  scorer tests for the minted/joined branches, loader leak-guard tests,
  promotion-builder snapshot tests.

## Functional requirements

- `FR-1`: Case schema: an inline organize case MAY carry `existingBuckets`
  (name + description pairs) and each expected thought MAY carry
  `bucketOrigin: "minted" | "joined"`. Both fields are optional; a case
  without them loads and scores exactly as today (legacy cold behavior
  preserved for the three pre-pilot cases).
  End-user experience: nothing new to run — the product owner sees these as
  added JSON fields when reviewing an envelope diff; `donna evals validate`
  behaves as before on old cases.
- `FR-2`: Loader consistency rules (hard validation failures): a `joined`
  thought's label bucket name MUST appear (normalized) in the case
  snapshot; a `minted` thought's label bucket name MUST NOT appear in the
  case snapshot; a thought with a non-null bucket label and no
  `bucketOrigin` is treated as today (no origin branch applied).
  End-user experience: `donna evals validate` fails with a clear message
  naming the offending case when a snapshot leaks its label — the product
  owner sees a validation error, never a silent pass.
- `FR-3`: The organize scorer passes the case snapshot to the organizer as
  the `existingBuckets` argument (`ports.ts:75–80` shape). When the field
  is absent the call is `organize(transcript, [])` — unchanged. No
  `ContextPacket` is synthesized by the scorer in this specification.
  End-user experience: nothing new to run — the same `donna evals run
  organize` command now prints in-context acceptance; the report looks the
  same, the number finally means what the gate intends.
- `FR-4`: Bucket-acceptance scoring with origins:
  - `joined` (or no origin): unchanged exact normalized match against the
    label via `suggestedBucket ?? newBucketName`.
  - `minted`: accepted iff the model minted (`newBucketName` non-empty)
    AND the minted name equals the label under exact normalized
    comparison; a model that joins an existing snapshot bucket for a
    minted-label thought scores 0 (misjoin). The per-case diagnostic
    `organize.bucket_name_equivalence` (deterministic normalization +
    token-set equality, rule versioned in the scorer) is emitted alongside
    and never feeds `organize.bucket_acceptance`.
  - The gate metric name, aggregation, and thresholds are unchanged.
  End-user experience: the organize report gains a per-case minted/joined
  breakdown and a `bucket_name_equivalence` diagnostic next to the familiar
  metrics; the graduation report the product owner signs is unchanged in
  shape — same gates, same 0.85 bar.
- `FR-5`: Reconstruction amendment: for each of the 55 promoted cases the
  tool resolves decision/correction → capture timestamp and builds the
  snapshot by the existence rule (`bucket.createdAt <= capture.capturedAt`)
  with rename/merge rollback through timestamped correction events. Each
  amended case appends exactly one adjudication entry (change =
  `context: added capture-time bucket snapshot (N buckets)`; reason naming
  the reconstruction source). Cases whose reconstruction is ambiguous are
  NOT amended by the tool; they are listed in the drift report and
  adjudicated by the product owner at batch review before the v3 run —
  never guessed, never silently excluded (product-owner resolution,
  2026-09-05).
  End-user experience: the product owner runs `donna evals
  amend-organize-snapshots`, sees amended/flagged counts, then opens the
  drift report and adjudicates each flagged case at batch review before any
  held-out run.
- `FR-6`: Case identity stability: existing case IDs are NOT re-derived on
  amendment (adjudication history references stay valid). The deterministic
  ID rule (`promote-organize.ts:194–197`) applies only at initial
  promotion; for new promotions the snapshot is part of the payload before
  ID derivation.
  End-user experience: case IDs stay recognizable, so the product owner can
  line up the v2 and v3 reports case-by-case without a mapping table.
- `FR-7`: Going forward, `pilot decide`/`pilot promote confirm` record the
  participant's current bucket list (names+descriptions) into the promotion
  source at decision time; the preview renders the snapshot and its hash
  covers it (Spec 6.4 FR-4 preview fidelity extends to the new fields).
  End-user experience: the participant runs `pilot decide accept
  <thought-id>` exactly as today; `pilot promote preview <decision-id>`
  additionally prints the bucket names+descriptions to be shared, and
  `pilot promote confirm` prints the same payload hash shown at preview.
- `FR-8`: Held-out amendment follows the freeze-lock path only: amended
  held-out cases land via the gated batch mechanics, the envelope version
  bumps (v2 → v3), a fresh results run precedes any re-freeze, and the old
  v2 lock + v2 report remain untouched as the frozen baseline
  (`promote-organize.ts:622–714`).
  End-user experience: the product owner runs the same gated batch
  promotion, `donna evals run organize --dataset <held-out>`, and `donna
  evals heldout-freeze` commands as under Spec 6.4 — the lock file simply
  advances to v3.
- `FR-9`: The before/after comparison artifact: a diff tool output proving
  that between held-out v2 and v3 every case's `transcript`, `expected`,
  `contains`, and `meta` are byte-identical and the ONLY additions are
  `existingBuckets` / `bucketOrigin` (plus adjudication log entries and the
  version bump). The after-run report must name the same 32 case IDs.
  End-user experience: the product owner opens one committed diff artifact
  that states "only snapshot fields added" instead of eyeballing two
  envelope files side by side.
- `FR-10`: The runbook documents snapshot capture at decision time and the
  amended preview screen; pilot procedure and tooling stay in lockstep.
  End-user experience: the participant reads the same runbook decision
  table with the same commands; only the promotion preview screen shows
  more (the snapshot to be shared).

## Security, privacy, and provenance requirements

- `SR-1`: No label leakage: the loader hard-fails any case whose
  minted-label bucket name appears in its own snapshot (mechanical, at
  every load — not a convention). The amendment tool additionally asserts
  the existence rule per case (a snapshot entry with `createdAt` after the
  capture timestamp aborts that case's amendment). An automated test
  proves a leaked snapshot cannot validate.
- `SR-2`: No trivial pass: the gate-facing metric keeps exact-match
  semantics for both origins; the name-equivalence diagnostic is
  deterministic, pre-registered in this document, versioned in the scorer,
  reported per case, and never aggregated into `organize.bucket_acceptance`.
  Any future change to count equivalence toward the gate requires its own
  approved specification.
- `SR-3`: Determinism and freeze-lock compatibility: snapshots are static
  case data; given a fixed case file the scorer's organizer input is
  byte-stable (test: a recording organizer spy receives identical bucket
  lists across repeated runs). Amended held-out content moves only through
  the version-bump → results → re-freeze path; any hand-edit at a locked
  version remains a hard validation failure.
- `SR-4`: Privacy of the new fields: bucket names+descriptions are user
  content. They join the promotion payload allowlist, are rendered in the
  preview, pass `screenSensitiveContent` at preview and again at confirm,
  and are re-screened by the loader on every read (the Spec 6.4 SR-3
  mechanics extend to the new fields). The forbidden-value scan test is
  extended: tenant/user/participant/capture IDs, raw audio paths, and full
  transcript text must never appear in `existingBuckets`.
- `SR-5`: Consent: the `eval-sharing` purpose stays mandatory and
  fail-closed at preview and confirm. For the 55 EXISTING cases, the
  product owner resolved on 2026-09-05 that the existing `eval-sharing`
  consent COVERS adding bucket name+description snapshots (the product
  owner, who is the participant, confirmed these fields are within the
  de-identified fields consented to); the amendment tool needs no per-case
  re-confirmation gate for this field addition. Screening still applies to
  every added field (SR-4), and any future field addition beyond this
  class re-opens the consent question.
- `SR-6`: Provenance and adjudication: every amended case is
  reconstructible from the envelope's adjudication log alone (one entry per
  case naming the reconstruction); the drift report and the
  amendment-diff artifact are committed, content-free evidence anchors.
  Pseudonymous labeler/adjudicator IDs only.
- `SR-7`: Tenant isolation: reconstruction reads only the source
  participant's own pilot partition under the authenticated CLI scope;
  cross-partition reads remain impossible (partition guards of
  `decisions.ts:66–90` pattern). The eval harness isolation
  (`assertEvalDataDir`) is untouched.
- `SR-8`: No secrets, raw recordings, or full transcripts are written to
  the repository; reports stay git-ignored local artifacts; locks and diff
  artifacts are content-free committable anchors.

## Acceptance criteria

- `AC-1`: Schema + loader: cases with snapshots validate; a `joined` label
  missing from the snapshot fails validation; a `minted` label present in
  the snapshot fails validation (the leak guard demonstrated by test).
- `AC-2`: Scorer branches (unit tests with a scripted/recording organizer):
  joined-match passes, joined-mismatch fails, minted-exact passes,
  minted-misjoin fails, minted-different-name fails the gate metric while
  the equivalence diagnostic reports 1; a snapshot-less case invokes the
  organizer with `[]` exactly as today.
- `AC-3`: Amendment: all 55 promoted cases are either amended (snapshot +
  origin + one adjudication entry each, `donna evals validate` green) or
  listed with reasons in the drift report; every drift-report case is
  adjudicated by the product owner at batch review before the v3 run
  (never guessed, never silently excluded); existing case IDs unchanged;
  re-running the amendment is a byte-identical no-op.
- `AC-4`: Before/after: the after-run report on held-out v3 (live gateway)
  names the same 32 case IDs as the official v2 report; the committed
  amendment-diff artifact proves only the additive fields changed; the
  comparison table shows v2 cold 0.4531 versus the v3 in-context
  `organize.bucket_acceptance` on identical transcripts/labels.
- `AC-5`: Freeze path: held-out v3 frozen by a new lock after its first
  results run; a hand-edit to the locked v3 envelope fails validation live;
  the v2 lock and v2 report are untouched.
- `AC-6`: Gate untouched: `graduation-run` consuming the v3 organize report
  reads `organize.bucket_acceptance` with the same 0.85 threshold and
  records the v3 dataset name/version/sha256 in `freeze.datasets`;
  `git diff` on `packages/evals/src/graduation.ts` is empty.
- `AC-7`: Going-forward flow (synthetic scratch scope): decide → preview →
  confirm produces a case born with a snapshot and origin; the preview hash
  equals the written hash; consent revocation between preview and confirm
  fails closed.
- `AC-8`: Full existing suite stays green (baseline: 497 tests at Spec 6.4
  acceptance) with the new tests added; typecheck clean; CI deterministic
  job green (dataset validation including the leak guard runs offline).

## Verification

- Unit: loader consistency rules (both directions); scorer origin branches
  and the unchanged cold path; equivalence-diagnostic determinism;
  reconstruction existence rule, rename/merge rollback, ambiguity flagging;
  amendment idempotency; case-ID stability across amendment; preview-hash
  coverage of the snapshot.
- Integration: synthetic-participant loop — enroll (scratch scope) →
  captures that mint and join buckets → explicit decisions → promotion with
  snapshot → dev envelope diff → organize run against the snapshot cases
  (live gateway) → gated batch → held-out v3 → results run → re-freeze →
  `graduation-run` freeze linkage.
- Security: leak-guard validation failure; forbidden-value scan over every
  amended case's snapshot fields; consent fail-closed at both steps;
  cross-partition reconstruction attempts fail.
- Evaluation: `donna evals validate` over all envelopes; the official v2
  report versus the v3 report comparison; confirm the gate block is
  byte-untouched.
- Expected artifacts: test run output, the drift report, the
  amendment-diff artifact, the v3 organize stage report, the v3 lock, and a
  v2 graduation report whose freeze section names held-out v3.

## Demonstration

The product owner examines, with real pilot partitions read-only and scratch
scopes for writes:

1. The cold call today: `organize.ts:92` shown against the organizer port
   signature, and the official v2 report's 0.4531 next to the pilot
   register's 55/55 in-context accepts.
   End-user experience: the product owner reads the code pointer and the
   two numbers side by side — no command to run.
2. The leak guard: a hand-built case whose minted label appears in its
   snapshot failing `donna evals validate` live.
   End-user experience: the product owner runs `donna evals validate` on
   the leaky case and watches it fail with a message naming the case.
3. The amendment: the drift report (amended vs flagged cases), the
   batch-review adjudication of every flagged case before the v3 run, one
   amended case shown before/after with its adjudication entry, and the
   amendment-diff artifact proving additive-only change across all 32
   held-out cases.
   End-user experience: the product owner runs `donna evals
   amend-organize-snapshots`, opens the drift report, and adjudicates each
   flagged case at batch review.
4. The before/after: the v2 cold report (0.4531) and the v3 in-context
   report on the SAME case content, side by side, including the per-case
   minted/joined breakdown and the name-equivalence diagnostics.
   End-user experience: the product owner opens the two report files side
   by side — same 32 case IDs, the bucket-acceptance number now measuring
   in-context placement.
5. The freeze path: the v3 lock written after the results run, a live
   tamper failing validation, and `graduation-run` freezing the v3 dataset
   hash with the gate block untouched.
   End-user experience: the product owner runs `donna evals
   heldout-freeze`, hand-edits the locked envelope, and watches `donna
   evals run organize` refuse it — then `graduation-run` prints the same
   gate table as always.
6. The going-forward flow on a scratch scope: decision → preview showing
   the snapshot → confirm → the born-with-snapshot case.
   End-user experience: on a scratch scope the product owner types `pilot
   decide accept <thought-id>`, then `pilot promote preview <decision-id>`
   (the snapshot is listed among the shared fields), then `pilot promote
   confirm` — the printed hash matches the preview.

## Completion evidence

Implementation is complete through the pre-amendment gate but cannot move to
`in-review` until the blocker above is adjudicated.

### Commits so far

- `f812e79` — `docs: approve spec 6.5 in-context organize evaluation`
- `d43fa03` — `feat: implement spec 6.5 in-context organize evaluation`
- `423dbe5` — `fix: harden snapshot amendment and CI timeout test`

### Implemented interfaces and safety checks

- `datasets.ts`: additive `existingBuckets` and `bucketOrigin`; normalized
  joined/minted consistency and label-leak checks on every load.
- `scorers/organize.ts`: passes a fresh copy of each snapshot to the existing
  organizer port; exact-only minted/joined gate scoring; deterministic
  `token-set-v1` name-equivalence diagnostic that never feeds the gate.
- `amend-organize-snapshots.ts`: read-only source reconstruction by
  `capturedAt`/`createdAt`, inverse rename/merge replay, fail-closed ambiguity,
  product-owner override path, stable IDs, one adjudication per amended case,
  v2-lock precondition, idempotency, and a content-free additive-only proof.
- Promotion and pilot decision flow: new decisions capture the reconstructed
  bucket list before promotion; preview prints and screens names/descriptions
  and hashes the exact born-with-snapshot case. Future rename/merge correction
  records retain the minimum inverse values required for reconstruction.
- The gate block in `packages/evals/src/graduation.ts` is byte-untouched.

### Verification completed before the blocker

- Focused Spec 6.5 suites: 62/62 passed, followed by the final amendment +
  promotion rerun at 39/39 passed.
- Full local suite after the final test additions: **516 total / 515 passed /
  0 failed / 1 DB-gated skip**.
- `npm run typecheck`: clean across every workspace.
- Dataset validation: all registered envelopes green; held-out v2 lock intact
  at sha256 `93c9cf09858757653886dbfb4cd2da3d42bab70d0975a484546805b51a67146d`;
  held-out 32 cases and dev 28 cases.
- Deterministic eval check: adversarial, provenance, buckets, memory, emotion,
  retrieval, and full-loop all pass their baselines with zero hard failures.
- Synthetic scratch tests demonstrate createdAt existence filtering,
  rename/merge rollback, ambiguity blocking, product-owner override,
  additive-only amendment, byte-identical rerun, v2→v3 lock discipline,
  leak rejection, consent revoke-between-preview/confirm, and
  born-with-snapshot preview-hash equality.

### Reconstruction drift and required decision

The read-only reconstruction dry run examined 57 inline cases: 55 were exact;
two were flagged with `correction-not-found` + `capture-link-missing`:

- `organize-pilot-89ef3a098348`
- `organize-pilot-7bd4f7f0533a`

These are the two pre-6.4 correction-envelope seeds, not the three
`legacyImport` cases that are already approved to remain cold. Treating the
two seeds as additional cold cases would change the approved instrument and
gate input, so engineering judgment cannot silently choose it. The product
owner must provide each case's capture-time `existingBuckets` and
`bucketOrigin`, or explicitly revise the product ruling.

Held-out v2, its lock, and the official cold report remain unchanged. The live
v3 run, additive-diff artifact, v3 freeze, before/after metrics, graduation
linkage, final commits, and final CI result are intentionally pending this
adjudication.

### Product-owner decision

**PENDING — blocked on the two-case batch adjudication above.**

## Review gate

Implementation is forbidden while `status` is `draft`. After implementation
and verification, set `status` to `in-review` and wait for explicit product
owner acceptance before starting the next specification. Per the Phase 6
reality constraint, writes during demonstration use synthetic data and
scratch pilot scopes; real pilot partitions are read-only reconstruction
sources, and volunteer data is never fabricated.

## Open questions for the product owner

1. **Minted-label gate treatment.** This spec's default: minted-label
   thoughts count toward `organize.bucket_acceptance` only on an exact
   normalized name match (plus a correct mint decision), with the
   deterministic name-equivalence rule reported as a non-gate diagnostic.
   The alternative: let the pre-registered equivalence rule count toward
   the gate, with every equivalence-pass surfaced per case for
   adjudication. The first is conservative and may under-read naming
   variance; the second measures "sensible mint" more honestly but needs
   your adjudication cadence to stay trustworthy. Which do you want?
   - **Resolved (product owner, 2026-09-05):** **exact-match-only** — a
     minted-label thought counts toward `organize.bucket_acceptance` only on
     a correct mint decision plus an exact normalized name match. The
     pre-registered name-equivalence rule remains a non-gate diagnostic
     only (FR-4, SR-2).
2. **Consent scope for the 55 existing cases.** The amendment adds bucket
   name+description lists beyond what participants previewed at promotion
   time. Does the existing `eval-sharing` consent cover this (the fields
   are the same class of content as the already-shared labels), or must
   each participant re-confirm an amended preview before their cases are
   amended? The tool is dry-run-only on real partitions until you decide.
   - **Resolved (product owner, 2026-09-05):** the existing `eval-sharing`
     consent **covers** adding bucket name+description snapshots to the 55
     already-promoted cases — the product owner, who is the participant,
     confirmed these fields are within the de-identified fields consented
     to. No per-case re-confirmation gate is required for this field
     addition; screening still applies (SR-4/SR-5).
3. **Memory context stays out.** The production pipeline also passes the
   assembled `ContextPacket` (`run.ts:195,493`); this spec supplies only
   the bucket list, leaving a known residual fidelity gap (correction
   preferences and retrieved memories can legitimately steer placement).
   Confirm bucket-list-only is the intended scope, with memory-context
   snapshots deferred (larger de-identification surface).
   - **Resolved (product owner, 2026-09-05):** **bucket list only**.
     Memory/`ContextPacket` snapshots are deferred — the smaller
     de-identification surface is the reason — and the residual fidelity
     gap is recorded as a known limitation (Non-goals, option C2).
4. **The three pre-pilot legacy cases** have no decision records and no
   reconstructible snapshot; they stay cold (constant across the
   before/after comparison). Keep them in held-out v3 as-is, or retire them
   to a legacy-only envelope at the next version bump?
   - **Resolved (product owner, 2026-09-05):** **keep them cold** in v3 —
     no snapshot; they continue to measure cold-start placement exactly as
     before (FR-1, FR-3).
5. **Ambiguous reconstructions.** Cases whose capture-time state cannot be
   reconstructed with confidence (merge-destroyed names, missing capture
   linkage) are flagged, not guessed. Do you want them excluded from the
   amended set (they stay cold, dragging the metric), or adjudicated by you
   at batch review with the drift report as evidence before the v3 run?
   - **Resolved (product owner, 2026-09-05):** the **product owner
     adjudicates flagged cases at batch review before the v3 run**, with
     the drift report as evidence — never guessed, never silently excluded
     (FR-5, AC-3).
