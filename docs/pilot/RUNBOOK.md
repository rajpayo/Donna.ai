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
donna correct move <thought-id> --to <bucket>    # explicit decisions…
donna corrections accept <id>
donna memory approve|reject <proposal-id>
donna retrieval-feedback <thought-id> --verdict relevant|irrelevant --query "<text>"
donna pilot run end <run-id> --notes "V-NOISE, café"
```

The run record captures the pseudonymous participant ID, scenario ID,
config fingerprint, window capture IDs, and decision counts — never
content.

**Decision mapping** (every explicit output decision is recorded through
the existing services):

| Decision | Command |
|---|---|
| accept placement | (implicit — no correction filed) |
| move | `donna correct move` + `donna corrections accept` |
| split / merge | `donna correct merge`; split: `donna correct edit-thought` + move |
| edit | `donna correct edit-thought` |
| reject placement | `donna correct move` to a better bucket (or reject the correction) |
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

## 5. From misfire to shared golden case (separate consent)

A misfire becomes a shared evaluation case ONLY when ALL hold:

1. the fix exists as an **accepted** correction (`donna corrections accept`);
2. the participant holds an **active** `eval-sharing` consent
   (`donna consent grant eval-sharing`) — separate from enrollment;
3. the de-identified fields pass the sensitive-content screen.

```bash
donna pilot misfire promote <misfire-id> --correction <accepted-correction-id>
```

Without consent the command fails closed and the case stays private.
Promoted cases carry no tenant/user/capture IDs — only the correction type
and the minimal before/after labels. Revoking `eval-sharing` stops further
promotions immediately (already-shared cases stay de-identified).

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
