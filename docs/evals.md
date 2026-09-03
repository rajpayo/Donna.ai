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
economics. Cheap is only good if the sort is still right. The 4.2 harness
also records per-call token usage the gateway reports (never estimated);
this gateway reports tokens but no USD cost field, so tokens per accepted
loop are the in-repo proxy and the dashboard remains the USD source.

---

## Phase 4 — the versioned harness

### Datasets (4.1)

Every shared dataset is a versioned envelope (`donna.eval-dataset.v1`) under
`packages/evals/datasets/<stage>/` with fixture metadata (provenance,
labeler/adjudicator, consent, sensitivity, language/accent/noise) and an
append-only adjudication log. The pre-Phase-4 flat golden files stay in
place; stage envelopes reference them via `legacyImport` (content is
single-sourced). Validate everything:

```bash
npm run eval:harness --workspace @donna/evals -- validate
```

STT fixtures are synthetic espeak-ng recordings: git holds only the
reference text and the audio SHA-256. Regenerate and verify:

```bash
node packages/evals/fixtures/generate-stt-fixtures.mjs
```

### Running stage evals (4.2)

```bash
npm run eval:harness --workspace @donna/evals -- run <stage>   # adversarial, provenance, buckets, memory, retrieval, emotion — offline
npm run eval:harness --workspace @donna/evals -- run transcribe          # live gateway
npm run eval:harness --workspace @donna/evals -- run full-loop --mode live --personalization on
```

Deterministic stages need no credentials. Live stages fail closed with
classified external-flaky errors when credentials are absent. Every run
writes a machine-readable JSON report and a human-readable Markdown report
(gitignored) with the commit/config/dataset fingerprint.

### Baselines, comparison, CI (4.3)

Accepted baselines live in `packages/evals/baselines/<stage>.baseline.json`
(committed). Re-accept one after an intentional change:

```bash
npm run eval:harness --workspace @donna/evals -- baseline <stage>
```

Compare any candidate report against its baseline (exit 1 on hard failure
or material regression; exact regressed cases are named):

```bash
npm run eval:harness --workspace @donna/evals -- compare <stage> <candidate-report.json>
```

`.github/workflows/eval.yml` runs the deterministic suite + baseline
comparisons on every PR (`check`), with zero secrets required. Comparison
rules: deterministic suites are zero-noise, so any case-level regression is
material; aggregate mean drift beyond 0.05 also fails; external-flaky errors
never fail a run but too many make it inconclusive (never a silent pass).

### Credentialed internal runs

The live gateway suite runs only via the guarded manual trigger
(**Actions → eval → Run workflow**, a reason is required) — never on PRs,
and it skips successfully when the TrueFoundry secrets are not configured,
so missing secrets can never fail a pull request. Secrets come from the
repository's GitHub Actions secrets (`TRUEFOUNDRY_BASE_URL`,
`TRUEFOUNDRY_API_KEY`); reports uploaded as artifacts contain IDs, scores,
and fingerprints only (no transcript text, no credentials).

### Graduation (4.3)

```bash
npm run eval:harness --workspace @donna/evals -- graduation <report.json> [more...]
```

Checks the locked gates (≥95% thought coverage, ≥95% task recall, ≥85%
first-pass bucket acceptance, 100% valid provenance, ≥80% retrieval success,
zero tenant leaks, zero duplicate external actions) and writes a decision
document linking its evidence. Sign-off is always manual — metrics never
auto-graduate the pilot.
