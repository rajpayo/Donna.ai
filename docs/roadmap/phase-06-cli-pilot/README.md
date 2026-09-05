# Phase 6 — Controlled CLI pilot

Status: `accepted` (product owner, 2026-09-03)

> Product-owner directive (2026-09-03): Specifications 6.1, 6.2, and 6.3 are
> approved and are executed in one ordered run, one specification at a time,
> on branch `cursor/import-mvp-scaffold-b430`. Each specification still moves
> approved → in-progress → in-review with its own evidence; the
> per-specification acceptance gate between specifications is overridden for
> this phase only (as was done for Phases 1–5). Phases 1–5 are accepted.
>
> Reality constraint (recorded with the approval): Specifications 6.2 and 6.3
> are partly operational — the product owner must recruit 2–3 consenting
> colleagues and collect real recordings. Volunteer-dependent acceptance
> criteria are implemented as tooling/runbooks/instrumentation, proven with
> synthetic data plus the product owner's own existing captures, and marked
> "awaiting product-owner pilot runs". Volunteer data is never fabricated;
> pilot graduation is not claimed.

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

Status: `accepted` (product owner, 2026-09-03)

Depends on: Phase 5 accepted

> Implementation evidence (2026-09-03, implementation worker):
>
> - **New `@donna/pilot` package** (`packages/pilot/`):
>   - `src/policy.ts` — closed permitted data-class set (meetings, tasks,
>     ideas, follow-ups, decisions, people, projects) matching the approved
>     scenario matrix; excluded-category rejection for HR/legal/financial/
>     KYC/payment via whole-token + two-word-phrase matching (no substring
>     false positives) with a clear message (SR-3); consent-text version
>     `pilot-consent.v1`; the plain-language explanations (`PILOT_EXPLANATIONS`,
>     AC-3): what Donna stores, what admins cannot see, not-authoritative/
>     never-autonomous, emotion tentativeness, M365 per-source choice,
>     exclusions, leaving, misfire reporting; redaction helpers (SR-2) that
>     replace content with a length-only placeholder (never a prefix).
>   - `src/profile.ts` — `PilotProfile` (pseudonymous participant ID,
>     consent-text version, per-setting choices, fixed 7-day audio
>     retention, status enrolled/exited) + scoped file store under
>     `data/pilot/<tenant>/<user>/` (partition-ID guards, 0700/0600).
>   - `src/onboarding.ts` — `PilotService`: affirmative enrollment (every
>     acknowledgement required; every chosen/non-chosen setting recorded as
>     a grant or explicit denial in the append-only ConsentStore with the
>     consent-text version in the channel — FR-1); per-setting changes
>     (`updateDataClasses`, `updateM365Sources`, `setDurableMemory`,
>     `setEmotionInference`, `setEmotionPersistence`) re-recording versioned
>     consent (FR-2); `exit` revoking EVERY active purpose with history
>     preserved (FR-3); `exportBundle` (profile + memory export + captures
>     + corrections + misfires).
>   - `src/misfires.ts` — private scoped misfire register: category
>     (stt/provenance/organization/memory/retrieval/context/latency/
>     integration/other), description, links, pseudonymous reporter, and a
>     consent snapshot (eval-sharing state) at report time.
> - **Durable-memory gate** (`packages/memory/src/service.ts`): optional
>   `durableMemoryGate` on `MemoryService` — durable creation
>   (stateExplicit/approve/supersede, non-working layers) fails closed with
>   `DurableMemoryDisabledError` when the enrolled profile has durable
>   memory off; working memory never gated; undefined gate = unchanged
>   non-pilot behavior. `CorrectionService.derivePreference` catches the
>   gate error: a ground-truth correction still applies (move/centroids),
>   only the derived durable preference is skipped.
> - **CLI** (`apps/cli/src/main.ts`): `pilot explain` | `pilot onboard`
>   (interactive readline with buffered async-iterator prompts and an
>   explicit final "yes" affirmation, or fully flag-driven with `--affirm`)
>   | `pilot status` (consent state + counts only) | `pilot settings` |
>   `pilot set <setting>` (m365-source removal also purges cached snippets
>   and drops selections of revoked types) | `pilot review` (pending
>   corrections + pending proposals + thoughts below the documented 0.75
>   organizer-confidence floor) | `pilot export --out <file>` (0600 file,
>   never the terminal) | `pilot leave --out <file> [--delete-all]`
>   (export → M365 disconnect+purge → revoke all → optional wipe with
>   re-listed zero-count verification) | `pilot report-misfire` |
>   `pilot misfires`. Global CLI errors now print clean actionable messages
>   instead of stack traces.
> - **Redaction (SR-2)**: while a scope is enrolled, `capture` (transcript
>   block + per-item verbatim source), `search`/`query` (verbatim source
>   lines) redact by default; `--show-transcripts` reveals per invocation.
>   `export` refuses the terminal dump while enrolled and directs to
>   `pilot export --out`. Non-enrolled scopes keep prior behavior exactly.
> - **FR-1 enforcement**: `capture` refuses scopes whose pilot profile is
>   `exited` until re-onboarding.
> - **Live verification (2026-09-03, live TrueFoundry gateway, scratch
>   users pilot-probe-61/61b):** `pilot explain` renders all explanations;
>   onboarding with `hr` in data classes → "The pilot excludes HR, legal,
>   financial, KYC, and payment content. Rejected: \"hr\" (hr)…" with zero
>   consent records written; flags onboarding recorded 11 versioned consent
>   records (narrow defaults as explicit denials); interactive onboarding
>   (piped answers) enrolled with all-default narrow choices, and a final
>   non-"yes" answer aborted with nothing recorded; `pilot set
>   durable-memory off` → `memory remember` failed closed ("Durable memory
>   is off for this pilot profile…"), re-enable restored it; m365-sources
>   calendar,mail → calendar revoked mail (grant→revoke history visible);
>   a live espeak-ng synthetic capture as the enrolled user printed the
>   transcript and source lines redacted, `--show-transcripts` revealed
>   them, and the non-enrolled m365-spec52-probe scope printed unredacted
>   as before; `pilot report-misfire organization …` recorded the consent
>   snapshot (eval-sharing not granted); `pilot export` wrote a 0600 bundle
>   (1 capture, 1 memory, 17 consent records, 1 misfire); `pilot leave
>   --delete-all` exported, disconnected M365, revoked 6 active purposes,
>   wiped all content stores, and verified eight zero counts; a subsequent
>   capture as that scope was refused ("left the pilot… re-onboard").
> - **Tests: 20 new (435 total green with Postgres live, typecheck
>   clean).** Coverage: fresh onboarding + versioned consent records +
>   narrow-default denials; source-choice grants; missing-acknowledgement
>   refusal; pseudonymous-ID validation; duplicate-enrollment refusal;
>   excluded-category rejection across aliases ("hr", "Human Resources",
>   "legal", "financial", "KYC", "payment-processing", "payroll") with
>   unknown-vs-excluded distinction; unknown-class rejection; emotion
>   persistence-requires-inference; per-setting opt-in/opt-out re-records;
>   data-class grant/revoke diff; m365 source revoke; export bundle shape;
>   exit revokes all + history preserved + re-enrollment; not-enrolled
>   refusals; durable-memory gate (durable blocked, working allowed,
>   approve blocked, ungated unchanged); correction applies with preference
>   skipped when gated off; redaction defaults + no-prefix placeholder +
>   explicit-show; misfire report shape/consent snapshot; unknown-category
>   and empty-description rejection.
> - **Known limitations:** the low-confidence review list uses the
>   persisted organizer self-confidence (the capture-time `needsReview`
>   flag, which also reflects bucket-band placement and session review
>   bias, is shown at capture time but not persisted); `pilot leave` keeps
>   consent history and the exited profile as the audit trail by design;
>   interactive prompts require a stdin that supplies every answer (EOF
>   aborts fail-closed).
>
> Awaiting product-owner examination for acceptance. Review-gate dry run
> executed with synthetic data and scratch users only — no real volunteer
> was enrolled.

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

Status: `accepted` (product owner, 2026-09-03 — tooling, runbooks, and instrumentation accepted; the volunteer pilot itself remains an open operational activity the product owner will run)

Depends on: Specification 6.1 accepted

> Implementation evidence (2026-09-03, implementation worker):
>
> - **Runbooks** (`docs/pilot/`): `RUNBOOK.md` — named-owner table, hard
>   rules, enrollment steps, the balanced scenario matrix (SC-MEET-01 …
>   SC-MULTI-01 across meetings/tasks/ideas/follow-ups/decisions/people/
>   projects/mixed-emotional/multi-capture, plus variants V-ACCENT, V-PACE,
>   V-NOISE, V-INTERRUPT, V-CORRECT, V-REPEAT), per-scenario run flow, the
>   explicit-decision → command mapping (accept/move/split/merge/edit/
>   reject/memory approve-reject/retrieval relevance), the misfire triage
>   workflow, the separately-consented golden promotion path, weekly
>   retention/deletion verification, and the support/incident path;
>   `CONSENT_SCRIPT.md` — the exact pre-onboarding read-aloud script;
>   `SESSION_CHECKLIST.md` — pre/during/post session checklist.
> - **Run instrumentation** (`packages/pilot/src/runs.ts`): `PilotRunBook`
>   over a scoped `runs.json`. Every run records the pseudonymous
>   participant ID, runbook scenario ID, and the eval-harness config
>   fingerprint (same `captureSnapshot`/`snapshotFingerprint` the harness
>   uses — FR-1). One open run at a time; `end` gathers the window's
>   capture IDs and explicit decision counts/IDs from the correction and
>   memory stores (`collectRunDecisions`, pure). Records carry IDs and
>   counts only (SR-2). CLI: `pilot run start|end|list|show`.
> - **Misfire triage tooling** (`packages/pilot/src/misfires.ts`):
>   `triage` (category + expected behavior required — FR-2), `resolve`
>   (disposition fixed / accepted-limitation / blocks-graduation, note
>   required, triage-first enforced), `linkGoldenCase`, and `summarize`
>   (the board: counts by category/status/disposition, unresolved list,
>   graduation blockers — IDs only). CLI: `pilot misfire triage|resolve|
>   promote|board`.
> - **Consented de-identification wiring**: `pilot misfire promote <id>
>   --correction <id>` checks active `eval-sharing` consent BEFORE calling
>   the Spec 2.3 promotion path (which re-checks and de-identifies), then
>   records the golden-case link on the misfire. Fail-closed without
>   consent — verified live (see below).
> - **Live loop proof (2026-09-03, scratch participant P-INTERACTIVE /
>   pilot-probe-61b, synthetic espeak-ng audio, live gateway):** run
>   SC-IDEA-01 opened with config fingerprint 71093c3f…; one capture → 2
>   thoughts; TWO genuine misfires observed and reported: (1) STT — the
>   synthetic entity "finance-free review board" was transcribed as
>   "finance pre-review board" → triaged stt → resolved
>   accepted-limitation (chunked-timestamp STT fallback already
>   documented); (2) organization — vendor-portal thought landed in the
>   generic Product Ideas bucket → participant correction `bucket.move` →
>   pinned "Vendor Portal" → accepted → triaged organization → resolved
>   fixed with the correction linked. Promotion WITHOUT eval-sharing
>   consent failed closed ("The misfire stays private…"); after explicit
>   `consent grant eval-sharing`, promotion wrote de-identified case
>   `4d7e4b5c…` to `corrections.v1.json` (no tenant/user/capture IDs —
>   type + bucket names + summary only) and linked the misfire. Board: 2
>   reports, 2 resolved (1 fixed, 1 accepted-limitation), 1 promoted, 0
>   blockers. Run end gathered 1 window capture + bucket.move=1.
> - **Tests: 11 new (446 total green with Postgres live, typecheck
>   clean).** Coverage: triage fields + timestamp; resolve-requires-triage;
>   all three dispositions; unknown category/disposition and empty-field
>   rejections; golden-case link recording; board counts + blocker list;
>   run start shape + single-open-run + scenario required; end terminal +
>   not-found; window decision gathering (in/out-of-window corrections,
>   memory approvals/rejections, capture filtering); collectRunDecisions
>   counting; file-store round-trip + cross-partition invisibility.
> - **Known limitations:** promotion currently supports `bucket.move`
>   corrections only (the Spec 2.3 golden-case shape); STT/provenance
>   misfire classes are triaged and dispositioned but not yet promotable —
>   they enter datasets as authored fixtures. Run decision gathering is
>   window-based; decisions made after `run end` belong to no run.
>
> **Volunteer-dependent acceptance criteria — AWAITING PRODUCT-OWNER
> PILOT RUNS (not claimed):**
>
> - `AC-1` (scenario matrix adjudicated deeply enough to report every
>   graduation metric without hiding cohort failures): tooling and matrix
>   exist; requires the product owner's 2–3 consenting volunteers to run
>   the matrix. The loop proof above covers one synthetic participant.
> - `AC-2` (every observed misfire dispositioned): proven for the two
>   synthetic-loop misfires; the cohort-wide register awaits real runs.
> - `AC-3` (repeated personalized scenarios show correction-rate
>   improvement): requires repeated volunteer runs; not measurable yet.
> - `AC-4` (retention and deletion jobs verified during the live pilot):
>   the mechanism is verified (Spec 1.3 retention suite + `pilot leave`
>   zero-count verification in 6.1); the DURING-THE-PILOT verification
>   cadence (runbook §6) awaits real pilot weeks.
>
> Awaiting product-owner examination for acceptance.

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

Status: `accepted` (product owner, 2026-09-03 — graduation tooling accepted; the current-state verdict is honestly REJECTED on bucket acceptance and the volunteer pilot to grow that evidence remains open)

Depends on: Specification 6.2 accepted

> Implementation evidence (2026-09-03, implementation worker):
>
> - **Graduation runner v2** (`packages/evals/src/graduation.ts`,
>   `donna.graduation-runner.v1`): `buildGraduationReportV2` wraps the
>   locked v1 gate evaluation and adds the candidate freeze (commit,
>   branch, dirty flag, models.config.yaml sha256, prompt/schema versions,
>   per-stage dataset name/version/content-hash, cohort window — FR-1/FR-2
>   with an explicit held-out-alteration note), per-stage quality
>   distributions (n/missing/mean/min/p50/p90/max), merged cohort slices
>   (small groups already suppressed in evidence — SR-2), latency (aggregate
>   metric with per-case latencyMs fallback) and cost (gateway-reported
>   only, never estimated; token proxy summed across evidence), pilot
>   extras (correction trends, misfire board, retention verification,
>   privacy incidents, limitations), and the decision block: any failed
>   gate, any tenant-leak/invalid-provenance/unapproved-write/
>   duplicate-action hard failure (SR-1), any privacy incident, any
>   unresolved blocks-graduation misfire, or any retention violation forces
>   `rejected` with named reasons. The report carries a stable SHA-256
>   content hash (`graduationReportHash`, canonical key-sorted
>   serialization) as the product owner's sign-off anchor; sign-off stays
>   `pending` — manual by construction.
> - **Evals CLI**: `graduation-run <reports…> [--extras <file>]
>   [--cohort-window <start>..<end>]` captures the candidate snapshot at
>   run time and writes the versioned JSON + Markdown report under
>   `packages/evals/reports/graduation/` (exit 1 on rejection).
> - **Pilot extras producer** (`apps/cli`): `donna pilot
>   graduation-extras --out <file> [--limitations-file <f>]` aggregates
>   correction trends (totals + adherence), the misfire board (category/
>   disposition counts, unresolved, blockers, promoted golden cases), and
>   retention verification (per-capture audio state; 7-day policy
>   violations counted) across every pilot scope in the data directory —
>   counts only, de-identified (SR-2).
> - **Decision record template**: `docs/pilot/DECISION_RECORD_TEMPLATE.md`
>   (report-hash sign-off, gate table, evidence checklist, required
>   reasons, remediation plan on rejection).
> - **Honest current-state run (2026-09-03, clean commit 8a6bcd9, all four
>   evidence reports generated at the same commit):**
>   `packages/evals/reports/graduation/graduation-run-2026-09-03T18-41-06-379Z.{json,md}`
>   (report hash `011e5093…`). Verdict: **REJECTED — NOT ALL PASS**:
>   first-pass bucket acceptance 0.8333 < 0.85 on the current small
>   organize set (3 cases; min 0.50, p50 1.0). All other gates PASS on
>   fresh live evidence: thought coverage 1.0, task recall 1.0, provenance
>   fidelity 1.0 with zero invalid-provenance hard failures, retrieval
>   hit-at-k 1.0 (24 cases), zero tenant-isolation and duplicate-action
>   failures, adversarial 8/8 blocked. Latency (live full-loop): mean
>   15.7s, p90 21.8s; token proxy 4,669 prompt + 6,188 completion; cost
>   not reported by the gateway (never estimated). Pilot extras from the
>   two scratch scopes: 1 accepted correction, 2 misfires (1 fixed +
>   1 accepted-limitation, 0 unresolved, 0 blocking, 1 promoted golden
>   case), 1 capture with audio retained, 0 retention violations, 0
>   privacy incidents. This REJECTED outcome on the pre-pilot dataset is
>   the correct, expected result — the volunteer pilot exists to grow the
>   organize evidence past the gate.
> - **Tests: 9 new (455 total green with Postgres live, typecheck
>   clean).** Coverage: eligible verdict only when all gates pass with no
>   blockers; freeze fields; failing-gate rejection with named reasons;
>   SR-1 hard-failure rejection despite perfect metrics; extras blockers
>   (misfire blocks-graduation, privacy incident, retention violation)
>   each force rejection; quality/cohort/latency/cost/limitation carry-over;
>   per-case latency fallback; report-hash stability and sensitivity;
>   Markdown rendering (reasons, evidence links, manual sign-off).
> - **Known limitations:** the cohort window is unset (pre-pilot evidence);
>   cost is absent until the gateway reports usage; bucket-acceptance
>   evidence is 3 cases — statistically thin, which is precisely what the
>   volunteer pilot must grow.
>
> **Volunteer-dependent acceptance criteria — AWAITING PRODUCT-OWNER
> PILOT RUNS (not claimed):**
>
> - `AC-1`–`AC-6`: measured on current evidence above — AC-3 (bucket
>   acceptance) FAILS today; all gates must pass on pilot-grown datasets
>   before graduation.
> - `AC-7` (product owner explicitly accepts graduation after examining
>   the report and demonstrations): manual by design; the decision record
>   template awaits the product owner.
>
> Awaiting product-owner examination for acceptance.

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

---

### Specification 6.4 — Pilot decision capture and graduation-evidence promotion

Status: `accepted` (product owner, 2026-09-04) — see
[`SPEC-6.4-graduation-evidence.md`](SPEC-6.4-graduation-evidence.md) for the
accepted specification, binding open-question resolutions, and completion
evidence.

---

### Specification 6.5 — In-context organize evaluation

Status: `accepted` (product owner, 2026-09-05). The adjudicated held-out v3
live run measured exact in-context
bucket acceptance at 0.484375 versus the cold v2 baseline 0.453125, so the
unchanged 0.85 graduation gate still fails honestly — see
[`SPEC-6.5-incontext-organize-eval.md`](SPEC-6.5-incontext-organize-eval.md)
for the accepted behavior, clean drift/additive-diff evidence, frozen report
and lock hashes, completed verification, and product-owner decision.

---

### Specification 6.6 — Organizer-quality experiment

Status: `rejected` (product owner, 2026-09-05). The locked A/A0/B experiment
selected `NONE`: every candidate failed multiple binding bucket floors, and
the completed blinded review confirmed a broad quality problem. No winner,
validation-v3 run, private diagnostic, fresh set, or graduation run was
allowed. Immutable evidence is preserved in
[`SPEC-6.6-organizer-quality-experiment.md`](SPEC-6.6-organizer-quality-experiment.md).

---

### Specification 6.7 — Structured bucket routing and governed minting

Status: `draft` (binding architecture decisions recorded 2026-09-05;
implementation approval pending). The product owner authorized a one-off
narrow dependency on rejected Spec 6.6's immutable evidence without amending
the general execution protocol. See
[`SPEC-6.7-structured-bucket-routing.md`](SPEC-6.7-structured-bucket-routing.md).

---

## Phase exit gate

- **Met (tooling side):** the controlled pilot is consented, supportable, and
  privacy-preserving — onboarding with versioned per-setting consent, narrow
  defaults, redacted output, verified export/deletion, and a private misfire
  path are implemented and live-verified (Spec 6.1). Volunteer enrollment
  itself awaits the product owner.
- **Met (tooling side):** misfires feed a governed improvement loop — triage,
  dispositions, and the consented de-identified golden-case path are
  implemented and proven end-to-end on synthetic data (Spec 6.2).
- **NOT MET (honestly):** every graduation threshold passes with linked
  evidence — bucket acceptance measures 0.833 < 0.85 on the pre-pilot
  dataset (Spec 6.3 report `graduation-run-2026-09-03T18-41-06-379Z`). The
  volunteer pilot must grow the organize evidence; the runner is ready.
- **Awaiting the product owner:** explicit approval to move beyond the CLI
  (decision record template in `docs/pilot/`).

Post-acceptance Windows portability, private-file ACL, and full PostgreSQL CI
maintenance evidence is recorded in
[`docs/pilot/LOCAL_WINDOWS_MAINTENANCE_2026-09-04.md`](../../pilot/LOCAL_WINDOWS_MAINTENANCE_2026-09-04.md).
It does not change the unmet graduation gate above.
