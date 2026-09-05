# Architecture

## What we're proving with this MVP

One thing: **the core loop is achievable and good** — speak messy thoughts,
get structured, organized, retrievable output with provenance. Everything in
this repo exists to make that loop (a) work, (b) measurable, and (c) cheap to
iterate toward perfect.

## Design rules

1. **Ports and adapters.** `packages/core` defines the domain and the
   interfaces (`Transcriber`, `Organizer`, `Embedder`, `BucketStore`). Vendors
   live only in `packages/providers`. Swapping a model — or a vendor — never
   touches pipeline code.
2. **Models are config.** `models.config.yaml` names the model for every
   stage and lane. A/B testing gpt-5-mini vs claude-sonnet-5 is a config
   edit plus `npm run eval`, not a code change.
3. **Two lanes everywhere.** A cheap `default` lane carries routine volume;
   an `escalation` lane (stronger model) handles low-confidence or
   schema-failed runs. Routing lives in exactly one place:
   `packages/pipeline/src/run.ts`.
4. **Provenance is mandatory.** A thought without its source span is a bug.
5. **Telemetry from request one.** Every gateway call is tagged
   (app/tenant/stage) so cost per successful core loop is measured, not
   estimated.
6. **Private files fail closed.** File adapters write through
   `packages/file-security`: POSIX hosts enforce `0700` directories and
   `0600` files; Windows enforces owner+SYSTEM NTFS ACLs. The CLI refuses
   personal-data processing when the configured data root cannot be secured.

## The dynamic bucket engine

Buckets are the product's central object — the user's mental filing system
*and* (later) the agents' work queues.

- **Creation is on demand.** There is no fixed taxonomy. When a thought fits
  nothing, the engine mints a bucket at that moment, seeded with the
  thought's embedding as its centroid.
- **LLM proposes, geometry disposes.** The organizer suggests a placement in
  natural language; the engine verifies with cosine similarity against bucket
  centroids (`assign_threshold` / `create_threshold` in
  `models.config.yaml`). This keeps bucket creation stable instead of
  trusting the LLM's mood.
- **Tasks are special-cased.** A thought carrying a commitment always lands
  in the `Tasks` bucket, created on first use. This is the hook the future
  Asana agent hangs off (see `docs/roadmap-agents.md`).
- **Centroids drift with use.** Each new item folds into the bucket's running
  centroid, so buckets track what the user actually means by them.

Known follow-ups (deliberately not in MVP): bucket merge/rename hygiene,
per-user bucket splitting as graphs grow, pgvector-backed store.

## Data flow

```
Capture (audio file)
  └─▶ Transcriber            → Transcript (segments + timestamps)
  └─▶ Organizer (default)    → structured thoughts (JSON schema enforced)
      └─▶ Organizer (escalation, on failure/low confidence)
  └─▶ Embedder               → vector per thought
  └─▶ BucketEngine           → assign-or-create per thought
  └─▶ BucketStore            → buckets + items, file-backed for MVP
```

## Why TypeScript

One language across the future surfaces that are already committed in the
business plan: a desktop app/PWA (the primary surface — users are at
laptops), an Office add-in, and this backend.
The AI SDKs (OpenAI/Anthropic) are first-class in TS, and the eval harness
doesn't need a Python data stack at MVP scale.

## Security baseline (even for the demo)

- Company gateway = internal demo only; no public user data through it.
- No transcripts or PII in logs; telemetry carries counts and latencies only.
- Audio files stay local to the demo machine with short retention.
- Per-tenant/user isolation in the store from day one (file layout already
  partitions by tenant/user).
