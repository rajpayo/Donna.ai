# Phase 4 — Evaluation moat

Status: `in-progress`

> Product-owner directive (2026-09-03): Specifications 4.1, 4.2, and 4.3
> are approved and are executed in one ordered run, one specification at a
> time, on branch `cursor/import-mvp-scaffold-b430`. Each specification still
> moves approved → in-progress → in-review with its own evidence; the
> per-specification acceptance gate between specifications is overridden for
> this phase only (as was done for Phases 1–3). Phases 1–3 are accepted;
> their gateway, memory, corrections, retrieval, and Postgres storage are
> the entry conditions for this phase.

## Objective

Make every claim about understanding, organization, personalization, retrieval,
privacy, and cost measurable. Model, prompt, memory, and ranking changes ship
only when report diffs show that they improve Donna without crossing a hard
safety boundary.

Evaluation fixtures are added throughout earlier phases. This phase formalizes
the complete harness and graduation gate.

## Entry conditions

- Phases 1–3 are accepted.
- The full capture, memory, correction, and retrieval paths expose versioned
  inputs and outputs.
- Volunteer data can enter shared evals only through explicit consent and
  de-identification.

## Specification order

### Specification 4.1 — Versioned datasets and reproducible harness

Status: `in-review` (approved by the product owner 2026-09-03)

> Implementation evidence (2026-09-03, implementation worker):
>
> - **Versioned dataset envelope** (`packages/evals/src/datasets.ts`,
>   schema `donna.eval-dataset.v1`): name, stage, integer version,
>   description, `defaultMeta`, cases, and an append-only `adjudications`
>   log (FR-3 — `recordAdjudication` is the only supported label-change
>   path; entries record who/what/why and must reference real cases).
>   Per-case fixture metadata: provenance (synthetic / de-identified /
>   consented-volunteer / adversarial), pseudonymous labeler/adjudicator,
>   consent state, sensitivity (`high` is not representable — SR-1),
>   language/accent/noise notes. Validation (AC-2) rejects missing
>   consent/labels/source metadata, consent↔provenance contradictions,
>   duplicate IDs, dangling adjudications, and any text field tripping the
>   shared sensitive-content screener (SR-1).
> - **Stage-split datasets** (all validate via `eval:harness validate`):
>   `transcribe/` (5 synthetic espeak-ng cases — reference TEXT + SHA-256
>   of the generated audio only; audio regenerable via
>   `fixtures/generate-stt-fixtures.mjs`, verified byte-identical, never
>   committed), `provenance/` (5 valid/invalid verifier cases), `memory/`
>   (4: proposal precision with runtime-materialized synthetic secrets,
>   correction adherence, conflict handling ×2), `full-loop/` (2
>   longitudinal multi-capture scenarios with scripted-thought
>   deterministic mode), `adversarial/` (8: prompt injection ×3, tenant
>   scope ×3, false provenance ×2 — AC-4). Pre-Phase-4 flat golden files
>   are untouched; stage envelopes for organize/buckets/retrieval/emotion
>   REFERENCE them via `legacyImport` (content single-sourced, no
>   duplication). The buckets envelope carries the first real adjudication
>   entry (the 2026-09-02 task-vs-idea label decision).
> - **Config snapshots** (`src/snapshot.ts`): every run records commit,
>   branch, dirty flag, models.config.yaml SHA-256, prompt/schema versions
>   (organize-prompt v2, organize v1, answer-prompt v1, emotion v1),
>   ranking settings, memory policy (context budgets + adherence
>   threshold), bucket tuning, and a non-secret environment fingerprint.
>   `snapshotFingerprint` = SHA-256 over the score-determining subset
>   (FR-1); a model swap or dataset version bump changes it (tested).
> - **Isolation** (`src/isolation.ts`): dedicated `eval-tenant`/`eval-user`
>   scope (eval-* prefix enforced); eval data dirs must live under the OS
>   temp dir or the evals package — the CLI pilot data dir is refused
>   (FR-4). Postgres RLS proof: the eval scope reads zero pilot-tenant
>   rows at the database level (SR-3, gated on the test DB).
> - **Reports** (`src/report.ts`): machine-readable JSON
>   (`donna.eval-report.v1`) + human-readable Markdown, both carrying
>   environment/config fingerprints. Hard failures (tenant leak, invalid
>   provenance, unapproved write, duplicate action, consent violation,
>   injection succeeded) are listed per case and counted at top level —
>   never averaged (FR-2). Metric distributions (n/missing/mean/min/p50/
>   p90/max) and pseudonymous cohort slices with small-group suppression
>   (n<3). METRIC_DOCS documents every metric's denominator, missing-data
>   behavior, and pass direction. Reports contain IDs/scores/tokens only
>   (SR-2 — tested: no API key material in a serialized report).
> - **Harness** (`src/harness.ts`, `src/cli.ts`): `validate` (all 9
>   datasets), `run <stage>`, `snapshot`. Isolation is asserted before any
>   scorer runs.
> - **Reproducibility proof (AC-1, live):** `run adversarial` twice on
>   commit d979098 (dirty tree with the 4.1 changes) → identical
>   fingerprint `20cf0ff53ed5471a53c4aa45…`, identical per-case scores,
>   `reportsEquivalent` clean; 8/8 attacks blocked, 0 hard failures.
>   Reports: `packages/evals/reports/adversarial/adversarial.v1-2026-09-03T15-04-54-553Z.{json,md}`
>   (gitignored per the reports convention).
> - **Tests: 31 new (296 total green with Postgres live, typecheck
>   clean).** Coverage: envelope validation (9 rejection paths + legacy
>   lifting + adjudication append), all 9 shipped datasets validate,
>   snapshot contents/stability/sensitivity, fingerprint drift on model
>   swap, scope + data-dir isolation, RLS eval-tenant denial, harness
>   end-to-end, reproducibility, hard-failure surfacing, injection
>   confinement meta-checks (the check can fail), answer-layer canary
>   fail-closed.
> - **Ambiguities resolved (conservative):** (1) existing flat golden files
>   kept as canonical content with envelopes referencing them rather than
>   duplicating case content into the new format. (2) STT fixture audio
>   hashes are recorded at dataset creation; regeneration mismatch is loud
>   (exit 1) but the 4.2 STT scorer still runs against the reference text.
>   (3) Synthetic secrets for memory-screening cases are materialized by
>   the scorer at runtime — even fake secret patterns stay out of git.
> - **Known limitations:** the adversarial prompt-injection check is
>   structural (trust-section confinement); the live canary run is 4.2
>   work. Cohort slicing is metadata-driven; no volunteer cohorts exist
>   yet. The legacy flat-file runners (runner.ts, retrieval.ts) predate
>   the harness and are superseded by stage scorers in 4.2.
>
> Awaiting product-owner examination for acceptance.

Depends on: Phases 1–3 accepted

#### Outcome

Donna has reproducible, versioned datasets and a runner that evaluates a named
configuration without altering live user state.

#### Scope

- Split datasets by STT, organization, provenance, bucket sequences, memory,
  retrieval, emotion calibration, and full-loop scenarios.
- Define fixture provenance, labeler/adjudicator, consent, sensitivity,
  language/accent/noise metadata, and dataset version.
- Add synthetic, de-identified, adversarial, and consented representative
  cases.
- Run configs from explicit snapshots of `models.config.yaml`, prompt/schema
  versions, ranking settings, and memory policy.
- Isolate eval tenants and prevent report generation from writing to user data.
- Produce machine-readable and human-readable reports with environment and
  configuration fingerprints.

#### Non-goals

- Automatically treating a flagship model's label as ground truth or storing
  raw volunteer data in git.

#### Expected repository changes

- [`packages/evals`](../../../packages/evals)
- `packages/evals/datasets/golden/transcribe/`
- `packages/evals/datasets/golden/provenance/`
- `packages/evals/datasets/golden/buckets/`
- `packages/evals/datasets/golden/memory/`
- `packages/evals/datasets/golden/retrieval/`
- `packages/evals/datasets/adversarial/`

#### Requirements

- `FR-1`: A report can be reproduced from a commit, dataset version, and config
  fingerprint.
- `FR-2`: Cases distinguish hard failures from quality scores.
- `FR-3`: Human adjudication and label changes are auditable.
- `FR-4`: Eval runs never mutate production or pilot state.
- `SR-1`: Shared fixtures contain no unapproved employee PII or confidential
  company data.
- `SR-2`: Secrets and full gateway error bodies are excluded from reports.
- `SR-3`: Eval tenants cannot access live tenant rows.

#### Acceptance criteria

- `AC-1`: Repeating an eval on the same commit/config produces equivalent
  scores.
- `AC-2`: Dataset schema validation catches missing consent, labels, or source
  metadata.
- `AC-3`: The product owner can inspect a failing case and its adjudicated
  expected result.
- `AC-4`: At least one adversarial suite covers prompt injection, tenant scope,
  and false provenance.

#### Review gate

Demonstrate reproducibility, isolation, and one adjudication update. Do not
start Specification 4.2 until the product owner accepts the dataset rules.

---

### Specification 4.2 — Full-loop quality, latency, and cost scoring

Status: `in-review` (approved by the product owner 2026-09-03)

> Implementation evidence (2026-09-03, implementation worker):
>
> - **Stage scorers** (`packages/evals/src/scorers/`): stt.ts (WER via
>   word-Levenshtein with number-word/percent normalization +
>   entity/date/task preservation), organize.ts (schema validity, thought
>   coverage, over/under-splitting F1, STRICT task precision/recall — an
>   expected task counts only when a task-bearing thought covers it —
>   bucket acceptance, provenance fidelity), provenance.ts, buckets.ts
>   (engine replay of the seeded misfires), memory.ts (proposal precision
>   with runtime-materialized synthetic secrets, correction adherence,
>   conflict handling), retrieval.ts (hit@k + citation validity +
>   abstention + stale exclusion), emotion.ts (calibration/abstention).
>   Every metric is documented in METRIC_DOCS with denominator,
>   missing-data behavior, and pass direction (FR-1) — enforced by test.
> - **Full-loop longitudinal runner** (`scorers/full-loop.ts`): real
>   pipeline + stores + context assembler + correction service + retrieval
>   index in an isolated scratch tree. Deterministic mode replays
>   scriptedThoughts through scripted adapters (offline, exact); live mode
>   synthesizes espeak-ng audio from the case transcripts and runs the
>   configured gateway stack (gpt-4o-transcribe → gpt-5-mini →
>   text-embedding-3-large). Per-capture outcomes carry stage/total
>   latency, tokens, escalation flag; summaries carry bucket-state,
>   hard-rule, and adherence scores (FR-4). Fault-injection seam proves
>   broken implementations fail closed (AC-1). Personalization on/off
>   comparison supported (FR-3).
> - **Cost/latency (FR-4, AC-4):** MeteredGatewayClient wraps the real
>   client and records per-call usage the gateway reports. This gateway
>   reports TOKENS (prompt/completion) but NO cost field — USD cost is
>   recorded as missing (never estimated); tokens per accepted loop are
>   the honest proxy. Live full-loop: 5/5 captures accepted, total
>   latency 12.2–18.7s per capture (stt 2.3–3.1s, organize 9.0–15.2s,
>   embed 0.6–1.1s), 1,364–2,168 tokens/loop, escalation rate 0.
> - **Live results (real gateway, 2026-09-03):**
>   transcribe WER 0.000 (5/5, preservation 100% — clean synthetic
>   speech caveat); organize coverage 0.889, task recall 1.000, task
>   precision 0.611 (the documented "we should test X" over-tasking —
>   consistent with the Phase 2 live eval), bucket acceptance 0.833,
>   provenance fidelity 1.000; retrieval hit@3 100% (24/24), citation
>   validity 100% (17/17 answers), abstention correctness 79.2%
>   (over-abstention on 5 answerable cases — real finding), stale
>   exclusion 100%; memory/emotion/buckets/provenance all 100%.
> - **Longitudinal (AC-3):** deterministic mode: both scenarios pass —
>   bucket state evolves correctly, corrections apply, adherence recorded
>   (followed:1 / contradicted:1 per the scenarios), personalization-off
>   runs flip adherence to unobserved (FR-3 comparison proven). Live mode:
>   placement-time Tasks hard rule 100% (5/5).
> - **Hard failures never average out (SR-1):** per-case hard-failure
>   lists + top-level counts; the seeded provenance-failure test proves a
>   broken organizer fails closed with invalid-provenance hard failures
>   while quality metrics still average normally.
> - **Findings for the product owner (real, surfaced by the live run):**
>   (1) DECISION POINT: an accepted bucket.move correction moved a
>   task-bearing thought OUT of Tasks (placement-time hard rule held at
>   100%; the correction-apply path is separate). Should bucket.move
>   refuse or record "contradicted" when the target thought carries a
>   task? (2) Live bucket naming: gpt-5-mini minted "Onboarding" beside
>   "Onboarding improvements" (the known near-duplicate class from
>   buckets.v1.json). (3) Live adherence did not fire on the paraphrase
>   (semantic threshold 0.5 was calibrated on one pair — flagged for
>   revisit per the existing decision note). (4) Answer synthesis
>   over-abstains on 5/22 retrieval cases.
> - **Tests: 27 new (323 total green with Postgres live, typecheck
>   clean).** Coverage: WER math + normalization + credential-absent
>   classification + degraded-STT regression (AC-1), organize metrics +
>   under-splitting regression + provenance hard failure, provenance /
>   buckets / memory / retrieval / emotion stages through the harness,
>   full-loop deterministic + personalization comparison + seeded
>   provenance fail-closed, report distributions + cohort suppression
>   (n<3) + error classification + metric-doc completeness.
> - **Known limitations:** STT fixtures are clean synthetic speech (real
>   accents/noise will score lower — the cohort machinery is ready for
>   consented real fixtures); the gateway reports no USD cost (tokens are
>   the proxy; TrueFoundry's dashboard aggregates cost by stage tags);
>   citation validity is measured on synthetic fixtures; over-abstention
>   finding needs product-owner judgment (stricter prompt vs. accept).
>
> Awaiting product-owner examination for acceptance.

Depends on: Specification 4.1 accepted

#### Outcome

The harness measures every stage and the complete user journey, including
whether personalization helps the intended user without harming global
quality.

#### Scope

- Add STT word-error rate plus entity/task/date preservation.
- Score atomic-thought coverage, over/under-splitting, schema validity, task
  precision/recall, bucket agreement/acceptance, and provenance fidelity.
- Score retrieval relevance, grounded-answer citation, abstention, and stale
  result handling.
- Score memory proposal precision, correction adherence, conflict handling,
  and emotion calibration/abstention.
- Measure default/escalation routing, stage/total latency, tokens, gateway cost,
  and cost per accepted core loop.
- Support multi-capture longitudinal cases where bucket and memory state evolve.

#### Non-goals

- Optimizing only one aggregate score or declaring inferred emotion objectively
  correct without human labels.

#### Expected repository changes

- [`packages/evals/src/scorers.ts`](../../../packages/evals/src/scorers.ts)
- [`packages/evals/src/runner.ts`](../../../packages/evals/src/runner.ts)
- new stage and longitudinal runners under `packages/evals/src/`
- [`packages/pipeline/src/run.ts`](../../../packages/pipeline/src/run.ts) for
  non-content metrics

#### Requirements

- `FR-1`: Every scorer documents its denominator, missing-data behavior, and
  pass direction.
- `FR-2`: Reports include per-case results, distributions, and cohort slices,
  not only averages.
- `FR-3`: Personalized and non-personalized runs can be compared on the same
  scenario.
- `FR-4`: Cost and latency are tied to successful/accepted outcomes.
- `SR-1`: Tenant, provenance, unapproved-write, and duplicate-action failures
  are hard failures with no averaging.
- `SR-2`: Cohort slices remain pseudonymous and suppress unsafe small groups.

#### Acceptance criteria

- `AC-1`: Known intentionally broken implementations reduce the expected
  metrics.
- `AC-2`: Full-loop reports trace every stage failure to a case and version.
- `AC-3`: Longitudinal reports show whether corrections reduce repeated errors.
- `AC-4`: Gateway cost and latency are available per accepted capture without
  transcript content.

#### Review gate

Review one full-loop report, one longitudinal personalization report, and one
intentional regression. Do not start Specification 4.3 until accepted.

---

### Specification 4.3 — Regression CI and graduation decisions

Status: `draft`

Depends on: Specification 4.2 accepted

#### Outcome

Automated checks prevent quality regressions and produce an explicit,
reviewable decision about whether the CLI pilot may graduate.

#### Scope

- Define baseline reports and statistically defensible comparison rules.
- Run deterministic and no-secret suites in pull-request CI.
- Run credentialed gateway suites in an isolated internal environment on an
  approved trigger.
- Block merges on hard safety failures and material regressions.
- Track per-user correction-rate and retrieval-success trends privately while
  reporting de-identified aggregates.
- Generate a graduation report against all agreed thresholds.
- Require a product-owner sign-off; metrics do not auto-launch the next phase.

#### Non-goals

- Publishing private eval reports or auto-selecting a model solely by cost.

#### Expected repository changes

- CI workflow files
- `packages/evals/src/compare.ts`
- `packages/evals/src/graduation.ts`
- `packages/evals/baselines/`
- documentation for credentialed internal runs

#### Requirements

- `FR-1`: CI identifies the exact regressed cases and metric changes.
- `FR-2`: Model/config swaps compare against the accepted baseline.
- `FR-3`: Flaky external runs are distinguished from product regressions.
- `SR-1`: CI logs and artifacts redact credentials and personal content.
- `SR-2`: Any tenant leak, invalid provenance, unapproved mutation, or
  duplicate action blocks regardless of averages.

#### Acceptance criteria

- `AC-1`: A seeded quality regression fails CI.
- `AC-2`: A seeded tenant/provenance violation always fails CI.
- `AC-3`: The graduation report checks at least 95% thought coverage, 95% task
  recall, 85% bucket acceptance, 100% provenance, and 80% retrieval success.
- `AC-4`: The report records zero tenant leaks and zero duplicate external
  actions.
- `AC-5`: The product owner can accept or reject graduation with linked
  evidence.

#### Review gate

Demonstrate passing and failing CI examples plus a complete draft graduation
report. Phase 4 completes only after all three specifications are accepted.

## Phase exit gate

- Datasets and reports are reproducible, consented, and isolated.
- Full-loop and longitudinal quality are measurable.
- Safety failures are hard blockers.
- CI protects the accepted baseline.
