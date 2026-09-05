# Donna.ai

Voice-first capture → dynamic organization → retrieval, for busy executives and managers.
Speak a messy stream of thoughts; Donna distills atomic thoughts, files them into
**dynamically created buckets**, and keeps provenance back to the exact spoken words.

> **Status:** MVP core loop (internal demo). Runs on the company TrueFoundry
> gateway — **internal use only**, not for public users. See
> `docs/architecture.md` for the design and
> [`docs/roadmap/`](docs/roadmap/README.md) for the gated delivery plan.

## The core loop

```
audio ─▶ transcribe ─▶ organize ─▶ embed ─▶ place in dynamic bucket ─▶ persist
        (gpt-4o-      (gpt-5-mini,   (text-    (assign-or-create,
         transcribe)   escalate to    embedding-  Tasks bucket is
                        sonnet-5 on   3-large)    special-cased)
                        low confidence)
```

- **Dynamic buckets, not a fixed taxonomy.** If a thought fits an existing
  bucket (embedding similarity ≥ threshold), it joins. If nothing fits, a new
  bucket is minted at that moment. Anything that smells like a commitment
  always lands in the `Tasks` bucket — created on first use if absent.
- **Provenance everywhere.** Every thought links back to transcript segments
  and audio timestamps.
- **Models are config, not code.** Everything runs through
  `models.config.yaml` — swap any model without touching the pipeline.

## Repo layout

```
Donna.ai/
├── models.config.yaml        # ← the ONE place models are chosen/swapped
├── docs/
│   ├── architecture.md       # system design and the why behind it
│   ├── model-registry.md     # how to add or swap a model
│   ├── evals.md              # the iterate-to-perfection loop
│   ├── roadmap-agents.md     # bucket-driven agent vision
│   └── roadmap/              # phase folders, specifications, and review gates
├── packages/
│   ├── core/                 # domain types + ports (interfaces) — no vendor code
│   ├── file-security/        # POSIX modes + Windows owner-only ACL adapter
│   ├── providers/            # gateway client + per-vendor adapters + registry
│   ├── buckets/              # dynamic bucket engine (assign-or-create) + stores
│   ├── pipeline/             # core-loop orchestration + model routing/escalation
│   └── evals/                # golden datasets, scorers, runner, reports
└── apps/
    └── cli/                  # demo CLI (internal demo surface)
```

## Quickstart

```bash
npm install
cp .env.example .env          # fill in TRUEFOUNDRY_BASE_URL / TRUEFOUNDRY_API_KEY

# run the loop on a recording
npm run capture -- capture ./sample.m4a --user raj

# see the buckets that formed
npm run capture -- buckets --user raj

# score the organizer against the golden dataset
npm run eval
```

## Iterating on quality

1. Add the misfiring capture to `packages/evals/datasets/golden/` (labeled).
2. Change a model in `models.config.yaml` (or add a config for a rival stack).
3. `npm run eval` — compare the report in `packages/evals/reports/`.
4. Keep what wins. The report history is the regression trail.

## Tests

```bash
npm test          # unit tests (bucket engine, scorers) — no API keys needed
npm run typecheck
```

The pull-request workflow also runs the PostgreSQL + pgvector integration
suite. To run those database tests locally, configure the non-production
`DONNA_TEST_DATABASE_URL` and `DONNA_TEST_ADMIN_URL` values described in
[`database/README.md`](database/README.md).

On Windows, use a real Git checkout (evaluation snapshots record its commit
and branch) and point `DONNA_DATA_DIR` at an owner-controlled directory such
as `%LOCALAPPDATA%\Donna.ai\data`. Donna applies an owner+SYSTEM NTFS ACL
there and fails closed if private-state permissions cannot be enforced.

## Delivery roadmap

The project is implemented one reviewed specification at a time. Each phase,
its ordered specifications, acceptance criteria, and completion gates live in
[`docs/roadmap/`](docs/roadmap/README.md). No later specification starts until
the current one has been implemented, demonstrated, and explicitly accepted.
