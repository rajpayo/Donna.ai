# Phase 6 — Controlled CLI pilot

Status: `not-started`

## Objective

Validate Donna with the product owner and a small consenting employee cohort in
real work patterns, using the CLI and measured evidence before investing in
desktop, Teams, or action-taking agents.

## Entry conditions

- Phases 1–5 are accepted, except an explicitly waived non-critical destination
  that does not affect capture, memory, retrieval, consent, or safety.
- Internal TrueFoundry use and Microsoft scopes are approved.
- Pilot onboarding, support, incident, and deletion owners are named.

## Specification order

### Specification 6.1 — Pilot onboarding, consent, and review experience

Status: `draft`

Depends on: Phase 5 accepted

#### Outcome

A volunteer can understand Donna's boundaries, enroll intentionally, configure
context/memory choices, capture safely, review uncertain output, and leave the
pilot with their data exported or deleted.

#### Scope

- Add CLI onboarding for identity, permitted data classes, Microsoft sources,
  audio retention, durable memory, and optional emotional-context persistence.
- Require affirmative consent; defaults keep emotion session-only and Microsoft
  source selection narrow.
- Add commands for capture status, low-confidence review, memory proposals,
  corrections, retrieval feedback, export, source disconnect, and deletion.
- Explain that Donna prepares organization and drafts but is not authoritative
  and does not yet act autonomously.
- Provide a private support/misfire reporting path.

#### Non-goals

- Broad company enrollment, HR/legal/financial data, or hidden admin access.

#### Expected repository changes

- [`apps/cli/src/main.ts`](../../../apps/cli/src/main.ts)
- onboarding and consent documentation
- pilot-safe configuration and redacted telemetry

#### Requirements

- `FR-1`: Enrollment records versioned consent before processing personal data.
- `FR-2`: The employee can inspect and change each optional source/memory
  setting.
- `FR-3`: Exit revokes source access and starts verified export/deletion.
- `SR-1`: Consent is not bundled with employer access to personal memory.
- `SR-2`: CLI output avoids exposing transcripts by default in shared terminals.
- `SR-3`: Pilot configuration rejects excluded sensitive-data categories.

#### Acceptance criteria

- `AC-1`: A fresh volunteer can complete onboarding and first capture using the
  written instructions.
- `AC-2`: Opt-in, opt-out, source revoke, export, and deletion tests pass.
- `AC-3`: The product owner reviews all user-facing privacy and uncertainty
  language.
- `AC-4`: A shoulder-surfing/log review finds no default transcript dump.

#### Review gate

Conduct a dry onboarding with synthetic data and examine every consent/control
screen before enrolling a real volunteer. Do not start Specification 6.2 until
accepted.

---

### Specification 6.2 — Volunteer runs and misfire-to-golden loop

Status: `draft`

Depends on: Specification 6.1 accepted

#### Outcome

The product owner and a small volunteer cohort run representative captures and
retrieval tasks; every consented misfire becomes an adjudicated, de-identified
regression case.

#### Scope

- Define a balanced scenario matrix across meetings, tasks, ideas, follow-ups,
  decisions, people, projects, and mixed/emotional speech.
- Include accent, speaking pace, noise, interruption, correction, and repeated
  multi-capture scenarios.
- Collect explicit output decisions: accept, move, split, merge, edit, reject,
  memory approve/reject, and retrieval relevance.
- Triage each failure by STT, provenance, organization, memory, retrieval,
  context, latency, or integration.
- Obtain separate consent before de-identification and shared-eval promotion.
- Compare candidate fixes through config/report diffs; do not tune directly on
  the held-out graduation set.

#### Non-goals

- Production traffic, performance evaluation of employees, or collecting data
  simply because it is accessible.

#### Expected repository changes

- pilot runbooks under `docs/pilot/`
- consented/de-identified eval fixtures
- evaluation reports and decision records
- configuration changes only when reports justify them

#### Requirements

- `FR-1`: Every run has pseudonymous participant/scenario IDs and config
  fingerprints.
- `FR-2`: Every misfire receives a category, expected behavior, and disposition.
- `FR-3`: Corrections immediately affect private personalization and enter
  shared evals only through separate consent.
- `SR-1`: Raw volunteer audio/transcripts remain outside git and expire under
  policy.
- `SR-2`: Reports suppress participant identity and unnecessary source content.
- `SR-3`: Pilot administrators cannot browse personal memory outside the
  participant-supported review flow.

#### Acceptance criteria

- `AC-1`: The agreed scenario matrix has enough adjudicated examples to report
  each graduation metric without hiding cohort failures.
- `AC-2`: Every observed misfire is fixed, explicitly accepted as a known
  limitation, or blocks graduation.
- `AC-3`: Repeated personalized scenarios show correction-rate improvement.
- `AC-4`: Retention and deletion jobs are verified during the live pilot.

#### Review gate

Review the misfire register, report diffs, privacy audit, and selected private
demonstrations. Do not start Specification 6.3 until accepted.

---

### Specification 6.3 — Measured graduation decision

Status: `draft`

Depends on: Specification 6.2 accepted

#### Outcome

A signed, evidence-linked decision determines whether Donna is ready for the
desktop and Teams phase or must continue iterating in the CLI pilot.

#### Scope

- Freeze the candidate commit, config, prompts, dataset versions, and pilot
  cohort window.
- Run the held-out full-loop graduation suite and aggregate pilot decisions.
- Report quality distributions, cohort slices, latency, cost, correction
  trends, privacy incidents, retention, and limitations.
- Check every hard and numerical gate.
- Record product-owner accept/reject and the exact reasons.

#### Non-goals

- Automatically graduating because one demo looks convincing or averages pass.

#### Expected repository changes

- a versioned graduation report under `packages/evals/reports/graduation/`
- a decision record under `docs/pilot/`
- no client implementation in this specification

#### Requirements

- `FR-1`: The report links every score to reproducible evidence.
- `FR-2`: Held-out cases are not altered after results are known.
- `FR-3`: Known limitations name affected users/workflows and mitigations.
- `SR-1`: Any tenant leak, invalid provenance, unapproved mutation, or duplicate
  action forces rejection.
- `SR-2`: Reports remain de-identified and access-controlled as required.

#### Acceptance criteria

- `AC-1`: Thought coverage is at least 95%.
- `AC-2`: Task recall is at least 95%.
- `AC-3`: First-pass bucket acceptance is at least 85%.
- `AC-4`: Provenance validity is 100%.
- `AC-5`: Retrieval success is at least 80%.
- `AC-6`: Tenant-isolation and duplicate-action failures are zero.
- `AC-7`: The product owner explicitly accepts graduation after examining the
  report and demonstrations.

#### Review gate

If any criterion fails, keep this specification `in-review` or return it to
`draft` with a focused remediation plan. Phase 7 may begin only after explicit
acceptance; Phase 9 client work remains locked until then.

## Phase exit gate

- The controlled pilot is consented, supportable, and privacy-preserving.
- Misfires feed a governed improvement loop.
- Every graduation threshold passes with linked evidence.
- The product owner explicitly approves moving beyond the CLI.
