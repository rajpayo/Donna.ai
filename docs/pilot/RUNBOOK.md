# Donna CLI pilot runbook

Specification 6.2. This runbook is the operating manual for the controlled
CLI pilot: who runs it, what scenarios to capture, how decisions and
misfires are recorded, and how a misfire becomes a shared golden case.

**Pilot owners (name before starting):**

- Onboarding owner: _the product owner_
- Support owner: _the product owner_
- Incident owner: _the product owner_
- Deletion owner: _the product owner_

**Hard rules for every participant**

- No HR, legal, financial, KYC, or payment content. Configuration rejects
  these categories at onboarding and at every settings change.
- Raw audio and transcripts never enter git, tickets, chat, or reports.
- Reports and run records use pseudonymous participant IDs only.
- Donna organizes and drafts; it is not authoritative and never acts
  autonomously. Every external write requires explicit approval.

## 1. Enrollment (per participant)

1. The product owner reads the consent script (`CONSENT_SCRIPT.md`) aloud
   and answers questions.
2. The participant runs `donna pilot explain` and reads every section.
3. The participant runs `donna pilot onboard` (interactive) and chooses
   settings. Defaults are narrow: no Microsoft 365 sources, emotion
   session-only, no emotion persistence.
4. The participant verifies with `donna pilot status` and
   `donna consent list` that the recorded consents match their choices.
5. First capture per the session checklist (`SESSION_CHECKLIST.md`).

Participant IDs are assigned by the product owner: `P-01`, `P-02`, …
Never use names, initials, or emails.

## 2. Scenario matrix

Each participant runs the core scenarios plus at least two variants.
Scenario IDs are referenced by `donna pilot run start --scenario <id>` and
in misfire reports. One run = one scenario instance.

| ID | Class | Scenario | What it exercises |
|---|---|---|---|
| SC-MEET-01 | meetings | Post-meeting debrief voice note: attendees, decisions, follow-ups | multi-thought extraction, people, tasks |
| SC-TASK-01 | tasks | Rapid-fire commitments ("remind me to…", "I owe X…") | Tasks hard rule, task extraction |
| SC-IDEA-01 | ideas | Brainstorm monologue with half-formed ideas | new-bucket creation, low-confidence placement |
| SC-FOLL-01 | follow-ups | "Follow up on…" list after a busy day | task recall, due hints |
| SC-DEC-01 | decisions | "We decided X because Y" reasoning note | decision capture, provenance |
| SC-PEOP-01 | people | People-centric note ("Priya owns the launch…") | people filters, memory proposals |
| SC-PROJ-01 | projects | Project status brain-dump across 2+ projects | bucket separation |
| SC-EMOT-01 | mixed/emotional | Frustrated or urgent venting with real content mixed in | tentative emotion, review priority, no placement bias |
| SC-MULTI-01 | multi-capture | The same meeting captured twice (before/after) | dedup behavior, bucket stability |

**Variants** (apply to any core scenario; record the variant in the run
notes):

- V-ACCENT: non-native or regionally accented speech
- V-PACE: unusually fast or slow delivery
- V-NOISE: background noise (café, keyboard, traffic)
- V-INTERRUPT: an interruption mid-capture (pause, doorbell, side remark)
- V-CORRECT: the speaker corrects themselves mid-sentence ("meet Tuesday — no, Wednesday")
- V-REPEAT: the same content captured again days later (multi-capture)

Coverage target before graduation: every core scenario adjudicated at
least once per participant, and each variant at least once across the
cohort. Small cohort slices (< 3) are suppressed in reports — that is
intended privacy behavior, not missing data.

## 3. Running a scenario

```bash
donna pilot run start --scenario SC-MEET-01      # opens the instrumented run
donna capture <recording> [--session <id>]       # one or more captures
donna pilot review                               # work the review queue
donna pilot decide accept <thought-id>           # explicit accept (Spec 6.4)
donna pilot decide move <thought-id> --to <bucket>   # explicit move (queues + links the correction)
donna corrections accept <id>
donna memory approve|reject <proposal-id>
donna retrieval-feedback <thought-id> --verdict relevant|irrelevant --query "<text>"
donna pilot decisions                            # accept/move counts + first-pass acceptance rate
donna pilot run end <run-id> --notes "V-NOISE, café"
```

The run record captures the pseudonymous participant ID, scenario ID,
config fingerprint, window capture IDs, and decision counts — never
content. Since Specification 6.4, placement decisions are EXPLICIT:
every thought surfaced in `pilot review` should receive `pilot decide
accept` or `pilot decide move`; `pilot run end` prints the window's
accept/move counts and the count of reviewed thoughts left undecided.
Since Specification 6.5, each new placement decision also records the
capture-time bucket names and descriptions that Donna actually saw. Buckets
minted by that capture are excluded mechanically, so later promotion cannot
leak the expected label into the organizer input. If rename/merge history
cannot be reversed exactly, the decision command fails clearly and asks for
history review instead of guessing.

**Decision mapping** (every explicit output decision is recorded through
the existing services):

| Decision | Command |
|---|---|
| accept placement | `donna pilot decide accept <thought-id>` (explicit since Spec 6.4; pre-6.4 accepts were implicit and are not reclassified) |
| move | `donna pilot decide move <thought-id> --to <bucket>` (wraps `donna correct move` + links the correction) + `donna corrections accept` |
| split / merge | `donna correct merge`; split: `donna correct edit-thought` + move |
| edit | `donna correct edit-thought` |
| reject placement | `donna pilot decide move` to a better bucket (or reject the correction) |
| memory approve / reject | `donna memory approve|reject` |
| retrieval relevance | `donna retrieval-feedback … --verdict …` |

## 4. Misfire triage workflow

Anything wrong — mistranscription, wrong bucket, bad memory proposal,
retrieval miss, stale context, latency, integration trouble:

```bash
donna pilot report-misfire <category> --description "<what happened>" \
    [--capture <id>] [--thought <id>] [--scenario <id>]
```

Categories: `stt`, `provenance`, `organization`, `memory`, `retrieval`,
`context`, `latency`, `integration`, `other`.

The report is private to the participant's partition and snapshots the
eval-sharing consent state at report time.

Triage (product owner, with the participant):

```bash
donna pilot misfire triage <id> --category <c> --expected "<what should have happened>"
# fix it (e.g. an accepted correction), or accept the limitation:
donna pilot misfire resolve <id> --disposition fixed --note "<what changed>" [--correction <id>]
donna pilot misfire resolve <id> --disposition accepted-limitation --note "<why>"
donna pilot misfire resolve <id> --disposition blocks-graduation --note "<what must change>"
donna pilot misfire board                    # counts, unresolved, blockers
```

Every misfire ends in exactly one disposition: **fixed**,
**accepted-limitation** (documented in the graduation report), or
**blocks-graduation** (must clear before any graduation pass).

## 5. From pilot evidence to a shared organize case (separate consent)

Since Specification 6.4, both first-pass-accepted placements and corrected
placements can become de-identified cases in the **development partition**
(`packages/evals/datasets/golden/organize/organize.dev.v1.json`) — the
envelope the tuning loop iterates against. The held-out partition
(`organize.heldout.v1.json`) is the frozen graduation-evidence set and
never receives cases directly from participants.

A decision or correction becomes a shared case ONLY when ALL hold:

1. it exists in the participant's scope — an explicit accept decision
   (`donna pilot decide accept`) or an **accepted** `bucket.move`
   correction (`donna corrections accept`);
2. the participant holds an **active** `eval-sharing` consent
   (`donna consent grant eval-sharing`) — separate from enrollment,
   checked at preview AND again at confirm (revocation between the two
   blocks the confirm);
3. the de-identified fields pass the sensitive-content screen at both
   steps.

```bash
donna pilot promote preview <decision-id|correction-id>
# shows EXACTLY the shared fields (summary text, expected bucket, scenario
# class, variant labels, capture-time bucket names+descriptions, bucket origin,
# proposed case ID, target partition) + payload hash
donna pilot promote confirm <decision-id|correction-id> --partition dev
# writes byte-identical content (hash equals the preview), bumps the dev
# envelope version, and appends one adjudication entry
```

Without consent both steps fail closed and nothing is written. Promoted
cases carry no raw audio paths, full transcripts, or
capture/tenant/user/participant IDs — the case text is the de-identified
thought summary only (product-owner resolution, 2026-09-04). Re-promoting
the same decision or correction is a no-op ("already shared").

The bucket snapshot is covered by the existing `eval-sharing` consent
(product-owner resolution, 2026-09-05), but its names and descriptions are
screened at preview, confirm, and every dataset load. `bucketOrigin: joined`
means the expected label appears in the snapshot; `minted` means it must not.
`donna evals validate` fails loudly if either invariant is broken.

**Dev → held-out promotion (product owner only).** Cases move from the
development partition to the held-out partition only as a product-owner-
gated, stratified batch with a recorded rationale
(`promoteOrganizeCasesToHeldout` in `packages/evals/src/promote-organize.ts`;
adjudicator of record: the product owner at batch review). A case never
exists in both partitions; both envelopes append adjudication entries and
bump their versions. After the first eval run against a new held-out
version, freeze it:

```bash
npm run eval:harness --workspace @donna/evals -- run organize            # held-out is the registry default
npm run eval:harness --workspace @donna/evals -- heldout-freeze --report <report.json>
```

Thereafter any hand-edit to the locked held-out content fails validation
(`donna evals validate` / `run organize` hard-fail on the mismatch). The
minimum held-out size before the next graduation attempt is **≥ 20 cases
total, ≥ 2 per core scenario class** (product-owner resolution,
2026-09-04).

**Capture-time snapshot amendment (product owner only, Specification 6.5).**
Work from a read-only source data tree or a protected copy; never write eval
artifacts into pilot storage. Dry-run first:

```bash
npm run eval:harness --workspace @donna/evals -- amend-organize-snapshots \
  --source-data <read-only-data-dir> --tenant <scope> --user <scope>
```

The command prints reconstructible/flagged counts and writes the content-free
drift report. Every flagged case must be adjudicated in one local JSON override
file before apply; no case is guessed or silently left cold. Apply is an
explicit product-owner gate:

```json
[
  {
    "caseId": "organize-pilot-…",
    "existingBuckets": [
      { "name": "Example bucket", "description": "What belongs here" }
    ],
    "bucketOrigin": "joined",
    "reason": "po-reviewed-capture-history"
  }
]
```

```bash
npm run eval:harness --workspace @donna/evals -- amend-organize-snapshots \
  --source-data <read-only-data-dir> --tenant <scope> --user <scope> \
  --adjudications <reviewed-overrides.json> --apply --product-owner-approved
```

Apply adds snapshots/origins to the existing IDs, appends one context
adjudication per case, advances held-out v2 to v3, archives the exact v2 lock,
and writes the additive-only diff proof. The product owner then runs the live
organize eval and freezes v3:

```bash
npm run eval:harness --workspace @donna/evals -- run organize
npm run eval:harness --workspace @donna/evals -- heldout-freeze --report <v3-report.json>
```

The run report shows exact gate-facing `organize.bucket_acceptance` plus the
minted/joined breakdown and non-gate `organize.bucket_name_equivalence`.
Equivalence never changes the 0.85 graduation bar.

**Legacy path.** `donna pilot misfire promote <misfire-id> --correction
<id>` still writes to the flat `corrections.v1.json` (unchanged); the two
pre-6.4 cases there were re-promoted into the development envelope under
the new mechanics (product-owner resolution, 2026-09-04).

## 6. Retention and deletion verification (weekly during the pilot)

```bash
donna retention                 # every capture's audio state
donna retention --cleanup       # deletes expired audio (7-day policy)
donna pilot export --out <file> # data portability spot-check
```

Verify: audio older than 7 days is gone; transcripts remain until the
participant deletes them; exports open and contain what the participant
expects.

## 7. Leaving the pilot

```bash
donna pilot leave --out <file> [--delete-all]
```

Exports first, revokes every consent, disconnects Microsoft 365 (cache
purged), and — with `--delete-all` — deletes captures, transcripts,
thoughts, memories, corrections, sessions, and the misfire register, then
re-lists every store and prints the zero-count verification. Consent
history and the exited profile remain as the audit trail.

## 8. Support and incidents

- Participant support / misfire help: `donna pilot report-misfire` +
  the support owner.
- Privacy incident (possible cross-user exposure, consent failure,
  unexpected content in a report): stop the pilot for the affected
  participant, record a `blocks-graduation` misfire, and notify the
  incident owner the same day. Privacy incidents are graduation-blocking
  hard failures.
