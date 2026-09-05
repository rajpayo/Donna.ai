# Eval report — organize.dev.v2 (stage: organize)

- started: 2026-09-05T16:23:35.665Z
- duration: 374866 ms
- commit: 73d2c7e7e83c6dac89051dbc0741d73c96878f35 (dirty tree)
- dataset: organize.dev.v2 v1 sha256:79eeb5758968…
- config fingerprint: a0771d9ddc059618…
- models.config.yaml sha256: c22d0c66675f…
- prompt/schema versions: organize=donna.organize-prompt.v4-structured/donna.organize.v2 answer=donna.answer-prompt.v1
- environment: node v24.15.0 win32/x64

## Outcome

- cases run: 28 (errored: 0 — external-flaky: 0, product: 0)
- HARD FAILURES: 0

## Metric distributions

| metric | n | missing | mean | min | p50 | p90 | max | pass direction |
|---|---|---|---|---|---|---|---|---|
| organize.schema_valid | 28 | 0 | 1 | 1 | 1 | 1 | 1 | higher-is-better |
| organize.thought_coverage | 28 | 0 | 1 | 1 | 1 | 1 | 1 | higher-is-better |
| organize.thought_count_f1 | 28 | 0 | 1 | 1 | 1 | 1 | 1 | higher-is-better |
| organize.task_precision | 28 | 0 | 0.7500 | 0 | 1 | 1 | 1 | higher-is-better |
| organize.task_recall | 28 | 0 | 1 | 1 | 1 | 1 | 1 | higher-is-better |
| organize.provenance_fidelity | 28 | 0 | 1 | 1 | 1 | 1 | 1 | higher-is-better |
| route.mode_accuracy | 28 | 0 | 0.7857 | 0 | 1 | 1 | 1 | ? |
| final.placement_acceptance | 28 | 0 | 0.4643 | 0 | 0 | 1 | 1 | ? |
| review.pending_rate | 28 | 0 | 0.2500 | 0 | 0 | 1 | 1 | ? |
| mint.precision | 7 | 21 | 0.7143 | 0 | 1 | 1 | 1 | ? |
| mint.recall | 9 | 19 | 0.5556 | 0 | 1 | 1 | 1 | ? |
| mint.exact_name | 9 | 19 | 0.2222 | 0 | 0 | 1 | 1 | ? |
| mint.validator_pass | 7 | 21 | 1 | 1 | 1 | 1 | 1 | ? |
| tasks.hard_rule | 11 | 17 | 1 | 1 | 1 | 1 | 1 | ? |
| route.join_id_accuracy | 19 | 9 | 0.6842 | 0 | 1 | 1 | 1 | ? |
| route.joined_conflict_rate | 19 | 9 | 0.2632 | 0 | 0 | 1 | 1 | ? |

## Cohort slices (pseudonymous; groups < 3 suppressed)

- {"language":"en"} (n=28, hard failures=0)
  - organize.schema_valid: mean 1 (n=28)
  - organize.thought_coverage: mean 1 (n=28)
  - organize.thought_count_f1: mean 1 (n=28)
  - organize.task_precision: mean 0.7500 (n=28)
  - organize.task_recall: mean 1 (n=28)
  - organize.provenance_fidelity: mean 1 (n=28)
  - route.mode_accuracy: mean 0.7857 (n=28)
  - final.placement_acceptance: mean 0.4643 (n=28)
  - review.pending_rate: mean 0.2500 (n=28)
  - mint.precision: mean 0.7143 (n=7)
  - mint.recall: mean 0.5556 (n=9)
  - mint.exact_name: mean 0.2222 (n=9)
  - mint.validator_pass: mean 1 (n=7)
  - tasks.hard_rule: mean 1 (n=11)
  - route.join_id_accuracy: mean 0.6842 (n=19)
  - route.joined_conflict_rate: mean 0.2632 (n=19)

## Per-case results

| case | scores | hard failures | error |
|---|---|---|---|
| organize-pilot-44123a90c85f | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=1 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=1 final.placement_acceptance=1 review.pending_rate=0 mint.precision=1 mint.recall=1 mint.exact_name=1 mint.validator_pass=1 tasks.hard_rule=1 | — | — |
| organize-pilot-2e92c926d69e | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=1 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=1 final.placement_acceptance=1 review.pending_rate=0 mint.precision=1 mint.recall=1 mint.exact_name=1 mint.validator_pass=1 tasks.hard_rule=1 | — | — |
| organize-pilot-adfc1c7c9ba0 | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=0 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=1 final.placement_acceptance=1 review.pending_rate=0 mint.precision=1 mint.recall=1 mint.exact_name=0 mint.validator_pass=1 | — | — |
| organize-pilot-22e900b5241e | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=1 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=1 final.placement_acceptance=1 review.pending_rate=0 mint.precision=1 mint.recall=1 mint.exact_name=0 mint.validator_pass=1 tasks.hard_rule=1 | — | — |
| organize-pilot-3e5db92a8889 | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=1 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=1 final.placement_acceptance=1 review.pending_rate=0 route.join_id_accuracy=1 route.joined_conflict_rate=0 tasks.hard_rule=1 | — | — |
| organize-pilot-33bfa698bcf7 | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=1 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=1 final.placement_acceptance=1 review.pending_rate=0 route.join_id_accuracy=1 route.joined_conflict_rate=0 tasks.hard_rule=1 | — | — |
| organize-pilot-3745612ca3d6 | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=1 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=1 final.placement_acceptance=1 review.pending_rate=0 route.join_id_accuracy=1 route.joined_conflict_rate=0 tasks.hard_rule=1 | — | — |
| organize-pilot-c6574e37f556 | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=0 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=0 final.placement_acceptance=0 review.pending_rate=0 mint.recall=0 mint.exact_name=0 | — | — |
| organize-pilot-e9233092bf82 | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=0 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=0 final.placement_acceptance=0 review.pending_rate=0 mint.recall=0 mint.exact_name=0 | — | — |
| organize-pilot-096ee9b9c59c | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=1 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=1 final.placement_acceptance=1 review.pending_rate=0 mint.precision=1 mint.recall=1 mint.exact_name=0 mint.validator_pass=1 | — | — |
| organize-pilot-9202859574c3 | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=1 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=1 final.placement_acceptance=1 review.pending_rate=0 route.join_id_accuracy=1 route.joined_conflict_rate=0 tasks.hard_rule=1 | — | — |
| organize-pilot-3a789117ded6 | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=1 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=1 final.placement_acceptance=1 review.pending_rate=0 route.join_id_accuracy=1 route.joined_conflict_rate=0 tasks.hard_rule=1 | — | — |
| organize-pilot-7fb14eea3904 | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=1 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=1 final.placement_acceptance=0 review.pending_rate=1 route.join_id_accuracy=1 route.joined_conflict_rate=1 | — | — |
| organize-pilot-69cdc746bf08 | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=1 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=0 final.placement_acceptance=0 review.pending_rate=0 route.join_id_accuracy=0 route.joined_conflict_rate=0 mint.precision=0 mint.validator_pass=1 | — | — |
| organize-pilot-bcd0ed72ba08 | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=0 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=1 final.placement_acceptance=0 review.pending_rate=0 route.join_id_accuracy=0 route.joined_conflict_rate=0 | — | — |
| organize-pilot-d477d2b44296 | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=1 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=1 final.placement_acceptance=0 review.pending_rate=1 route.join_id_accuracy=1 route.joined_conflict_rate=1 | — | — |
| organize-pilot-718ad79bc294 | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=1 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=1 final.placement_acceptance=0 review.pending_rate=1 route.join_id_accuracy=1 route.joined_conflict_rate=1 | — | — |
| organize-pilot-7bf31075401d | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=1 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=0 final.placement_acceptance=0 review.pending_rate=1 mint.recall=0 mint.exact_name=0 | — | — |
| organize-pilot-fcdf67c9f21f | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=1 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=0 final.placement_acceptance=0 review.pending_rate=1 mint.recall=0 mint.exact_name=0 | — | — |
| organize-pilot-94d204ecdd0c | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=1 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=1 final.placement_acceptance=1 review.pending_rate=0 route.join_id_accuracy=1 route.joined_conflict_rate=0 tasks.hard_rule=1 | — | — |
| organize-pilot-0580fdc50282 | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=1 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=1 final.placement_acceptance=0 review.pending_rate=1 route.join_id_accuracy=1 route.joined_conflict_rate=1 | — | — |
| organize-pilot-88d6b53f9d55 | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=0 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=1 final.placement_acceptance=0 review.pending_rate=0 route.join_id_accuracy=0 route.joined_conflict_rate=0 | — | — |
| organize-pilot-57e0c7a3668f | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=1 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=1 final.placement_acceptance=0 review.pending_rate=1 route.join_id_accuracy=1 route.joined_conflict_rate=1 | — | — |
| organize-pilot-f8e9b02c5951 | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=1 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=1 final.placement_acceptance=1 review.pending_rate=0 route.join_id_accuracy=1 route.joined_conflict_rate=0 tasks.hard_rule=1 | — | — |
| organize-pilot-897bbbac2906 | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=0 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=1 final.placement_acceptance=0 review.pending_rate=0 route.join_id_accuracy=0 route.joined_conflict_rate=0 | — | — |
| organize-pilot-578d420add30 | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=0 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=1 final.placement_acceptance=0 review.pending_rate=0 route.join_id_accuracy=0 route.joined_conflict_rate=0 | — | — |
| organize-pilot-03bb37de25ed | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=1 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=0 final.placement_acceptance=0 review.pending_rate=0 route.join_id_accuracy=0 route.joined_conflict_rate=0 mint.precision=0 mint.validator_pass=1 | — | — |
| organize-pilot-ded96d8c3abd | organize.schema_valid=1 organize.thought_coverage=1 organize.thought_count_f1=1 organize.task_precision=1 organize.task_recall=1 organize.provenance_fidelity=1 route.mode_accuracy=1 final.placement_acceptance=1 review.pending_rate=0 route.join_id_accuracy=1 route.joined_conflict_rate=0 tasks.hard_rule=1 | — | — |

---
Contains case IDs, scores, model/config fingerprints, and machine tokens only. No transcript text, credentials, gateway error bodies, or personal data are recorded.
