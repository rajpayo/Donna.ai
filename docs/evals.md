# Evals — the iterate-to-perfection loop

The product's moat is sort quality, and sort quality only improves if every
change is measured. The loop:

```
misfire observed → add labeled case to golden dataset
→ change model/prompt/config → npm run eval → compare report → keep winner
```

## What we measure (packages/evals/src/scorers.ts)

| Metric | What it tells us |
|---|---|
| Schema validity rate | Does the organizer return parseable, contract-valid JSON? (Hard requirement.) |
| Content coverage | Did every expected thought survive distillation? (Losing a thought = losing trust.) |
| Task extraction precision/recall | Are commitments caught, without false alarms? |
| Tasks-bucketed-correctly | Does every task land in the Tasks bucket? (The agent layer depends on this.) |

Planned next: WER scoring for the STT stage once we have recorded demo audio
with reference transcripts, and bucket-assignment agreement once the golden
set has enough multi-capture cases.

## Golden datasets

`packages/evals/datasets/golden/*.json` — hand-labeled messy voice dumps with
expected thoughts, buckets, and tasks. Rules:

- Every demo misfire becomes a labeled case the same day.
- Labels are human-adjudicated (a flagship model may assist, a human decides).
- Version the datasets (`organize.v1`, `v2`, …) so reports stay comparable.

## Reports

Each run writes `packages/evals/reports/<timestamp>-<model>.json` with
per-case and aggregate scores. Comparing two reports is the decision record
for a model swap — keep them.

## Cost telemetry

Gateway requests are tagged by stage, so TrueFoundry's cost dashboard gives
us **cost per successful core loop** — the metric that ties quality to unit
economics. Cheap is only good if the sort is still right.
