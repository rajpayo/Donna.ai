# Phase 4 — Evaluation moat

Status: `not-started`

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

Status: `draft`

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

Status: `draft`

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
