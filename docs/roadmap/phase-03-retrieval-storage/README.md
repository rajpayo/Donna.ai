# Phase 3 — Retrieval and production storage

Status: `in-progress`

> Product-owner directive (2026-09-03): Specifications 3.1, 3.2, and 3.3
> are approved and are executed in one ordered run, one specification at a
> time, on branch `cursor/import-mvp-scaffold-b430`. Each specification still
> moves approved → in-progress → in-review with its own evidence; the
> per-specification acceptance gate between specifications is overridden for
> this phase only (as was done for Phases 1-2). Phase 2 is accepted; its
> memory layers, consent, corrections, and context assembly are the entry
> conditions for this phase.
>
> Product-owner-reported defect to fix in Specification 3.3: correction
> adherence applicability uses keyword overlap and undercounts paraphrases
> (a correction about "test removing email verification" was not matched to
> a later "try one-click signup" placement). The applicability check must
> become semantic (embedding similarity, documented threshold) with the
> deterministic keyword path kept as fallback when no embedder is available.

## Objective

Make Donna's organized knowledge reliably findable with provenance, then move
state needed by concurrent users and agents from whole-file JSON to a
transactional, tenant-isolated store.

## Entry conditions

- Phase 2 is accepted.
- Thoughts, transcripts, memories, and corrections have stable scoped records.
- Deletion and consent rules are defined before indexing begins.

## Specification order

### Specification 3.1 — Read model and deterministic local retrieval

Status: `in-review`

> Implementation evidence (2026-09-03, implementation worker):
>
> - **Scoped read ops** (`packages/core/src/ports.ts`,
>   `packages/buckets/src/store.file.ts`): `BucketStore` gains `getItem`,
>   `listItemsByBucket`, and `listItemsInRange` (time-filtered; ISO
>   inclusive bounds). `Thought` gains an optional `createdAt` (set by the
>   pipeline on every new thought). Items persisted before this spec lack
>   `createdAt`; time-filtered reads fail closed and exclude them
>   (documented ambiguity resolution — conservative option). All test
>   MemStores implement the new ops.
> - **Core types** (`packages/core/src/types.ts`): `RetrievalQuery`
>   (tenant/user scope + text and/or embedding + filters + limit),
>   `RetrievalFilters` (bucketIds, createdFrom/To, hasTask, people,
>   memoryIds — all ANDed), `RetrievalHit` (thought + bucket + score
>   components + scoreVersion; provenance carried on the thought, FR-2),
>   and the `RetrievalIndex` port (indexItem / removeThought /
>   removeCapture / search / rebuild).
> - **New package `packages/retrieval/`**: `LocalRetrievalIndex` — a
>   deterministic file-backed read model at
>   `<dataDir>/<tenant>/<user>/retrieval-index.v1.json` (0600/0700,
>   partition-ID validation, per-entry scope check on load — fail closed).
>   Scoring is versioned (`donna.local-retrieval.v1`): text = normalized
>   token overlap |Q∩T|/|Q| over summary+text; semantic = clamped cosine
>   over the stored thought embeddings; combined = 0.5/0.5 when both
>   signals present, the single signal otherwise; ranking is combined
>   desc → createdAt desc → thoughtId asc. Entries denormalize the full
>   thought (text, summary, embedding, provenance refs) plus bucket,
>   creation time, people hints (task assignee), and memory links
>   (memories whose sources name the thought). `indexItem` is an
>   idempotent upsert; `rebuild` reads ONLY the scoped source-of-truth
>   bucket store and writes a byte-identical file for unchanged sources
>   (FR-3); corrupt index files fail closed with a rebuild instruction
>   (SR-3). No logging of query/result text anywhere (SR-2).
> - **Pipeline** (`packages/pipeline/src/run.ts`): optional
>   `retrievalIndex` dep indexes each placed item as it persists; an
>   indexing failure emits `retrieval.index.error` (counts only) and the
>   run continues — the projection is rebuildable (SR-3).
> - **CLI** (`apps/cli/src/main.ts`): `donna items --bucket <name>` (list
>   bucket contents with provenance), `donna search <text> [--bucket]
>   [--from] [--to] [--task] [--person] [--semantic] [--limit]` (semantic
>   mode embeds the query via the configured embedder), `donna reindex`.
>   Capture deletion carries a retrieval-index projection, so deleted
>   records disappear from search (FR-4).
> - **Tests: 21 new (227 total green), typecheck clean.** Coverage: text
>   and semantic retrieval on fixtures (AC-1), deterministic ranking,
>   bucket/time/task/person/memory-link filters (AC-2), removeThought /
>   removeCapture / duplicate-index idempotency / rebuild determinism
>   (byte-identical) / corrupt-index recovery (AC-3, FR-3, FR-4, SR-3),
>   cross-tenant and cross-user denial incl. path-traversal IDs and
>   foreign-entry fail-closed load (SR-1), browse mode, limits, the new
>   store read ops (in-scope, fail-closed, undated-excluded), pipeline
>   indexing + index-failure degradation.
> - **Live demo (synthetic espeak-ng audio, real gateway, temp data
>   dir):** captured "Remind me to review the vendor contract renewal
>   with Priya before Thursday. Also, the onboarding checklist…" → 2
>   thoughts into `Tasks`. `donna items --bucket Tasks` listed both with
>   capture/segment/audio-window provenance (AC-4). `donna search
>   "vendor contract"` returned the exact thought (score 1.000) with full
>   transcript provenance. `donna search "paperwork for the new joiner"
>   --semantic` (live text-embedding-3-large@1024) ranked the onboarding
>   thought first (0.559) despite near-zero keyword overlap. `donna
>   reindex` rebuilt 2 items; `delete-capture` removed the capture and
>   the same search then returned 0 hits (FR-4 end-to-end).
> - **Known limitations:** people filtering is deterministic hint/text
>   matching (semantic person matching is Spec 3.3); the local index is
>   whole-file JSON — the transactional store is Spec 3.2; ranking
>   weights are the fixed v1 pair (versioned hybrid ranking is Spec 3.3).
>
> Awaiting product-owner examination for acceptance.

Depends on: Phase 2 accepted

#### Outcome

The CLI can inspect buckets and items and run deterministic local full-text and
vector retrieval without changing the source-of-truth storage architecture.

#### Scope

- Add scoped `getItem`, `listItems`, `listItemsByBucket`, and time-filtered read
  operations.
- Define `RetrievalQuery`, `RetrievalHit`, `RetrievalFilters`, and
  `RetrievalIndex` interfaces.
- Implement a deterministic local adapter for tests and the early CLI.
- Index thought text, summary, bucket, time, people/task hints, memory links,
  and provenance references.
- Support deletion/reindex and an index rebuild from source-of-truth records.
- Add CLI commands to list bucket contents and search by text.

#### Non-goals

- Natural-language answer generation, production database selection, or M365
  content indexing.

#### Expected repository changes

- [`packages/core/src/types.ts`](../../../packages/core/src/types.ts)
- [`packages/core/src/ports.ts`](../../../packages/core/src/ports.ts)
- [`packages/buckets/src/store.file.ts`](../../../packages/buckets/src/store.file.ts)
- `packages/retrieval/`
- [`apps/cli/src/main.ts`](../../../apps/cli/src/main.ts)

#### Requirements

- `FR-1`: Every retrieval operation includes tenant/user scope.
- `FR-2`: Results expose score components and source provenance.
- `FR-3`: Index rebuild is deterministic and idempotent.
- `FR-4`: Deleted records disappear from normal reads and search.
- `SR-1`: Query filters cannot select another tenant/user.
- `SR-2`: Search logs contain timing/counts, not query or result text.
- `SR-3`: Corrupt index state can be discarded and rebuilt from scoped source
  records.

#### Acceptance criteria

- `AC-1`: Text and semantic similarity retrieve expected local fixtures.
- `AC-2`: Bucket, time, and task/person filters produce deterministic results.
- `AC-3`: Delete, rebuild, duplicate-index, and cross-tenant tests pass.
- `AC-4`: The product owner can find a stored thought and inspect its exact
  transcript provenance from the CLI.

#### Review gate

Demonstrate list, search, filter, deletion, and rebuild on a local fixture.
Do not start Specification 3.2 until retrieval semantics are accepted.

---

### Specification 3.2 — PostgreSQL, pgvector, and row-level isolation

Status: `draft`

Depends on: Specification 3.1 accepted

#### Outcome

Captures, transcripts, thoughts, buckets, memories, corrections, consent, and
retrieval vectors are stored transactionally with database-enforced tenant/user
isolation and concurrency controls.

#### Scope

- Design versioned migrations for source records and rebuildable projections.
- Store monetary/cost values as integer minor units or exact decimals.
- Enable pgvector for thought and memory embeddings.
- Enforce row-level security using tenant/user values derived from authenticated
  session context.
- Add uniqueness, foreign-key, version, and idempotency constraints.
- Use transactions and optimistic locking for bucket centroid/item updates.
- Add a PostgreSQL adapter behind existing ports while preserving the file
  adapter for tests.
- Define backup, restore, migration rollback, and index rebuild procedures.

#### Non-goals

- Public cloud topology, analytics warehouse, or agent job queues.

#### Expected repository changes

- `packages/storage-postgres/`
- `database/migrations/`
- [`packages/core/src/ports.ts`](../../../packages/core/src/ports.ts)
- integration-test infrastructure using isolated tenant fixtures

#### Requirements

- `FR-1`: One transaction persists thought placement, bucket statistics, and
  retrieval projection state or none of them.
- `FR-2`: Optimistic conflicts retry safely without lost updates.
- `FR-3`: Every table carrying personal data includes tenant/user scope.
- `SR-1`: Row-level security denies unscoped access even when application code
  omits a filter.
- `SR-2`: Database credentials come from runtime secrets with TLS validation.
- `SR-3`: Backups preserve encryption and deletion obligations.
- `SR-4`: Raw SQL is parameterized; user input never becomes an operator or
  identifier.

#### Acceptance criteria

- `AC-1`: Migration up/down and clean-install tests pass.
- `AC-2`: Database-level tests prove cross-tenant and cross-user access denial.
- `AC-3`: Concurrent placements do not lose items or centroid updates.
- `AC-4`: File fixtures can migrate once without duplicates.
- `AC-5`: Backup/restore and retrieval-index rebuild are documented and tested.

#### Review gate

Demonstrate database-enforced isolation using intentionally faulty application
queries plus a concurrent-write test. Do not start Specification 3.3 until the
product owner accepts the storage boundary.

---

### Specification 3.3 — Hybrid natural-language retrieval with provenance

Status: `draft`

Depends on: Specification 3.2 accepted

#### Outcome

An employee can ask Donna a natural-language question and receive ranked,
source-linked results or a grounded synthesis that clearly distinguishes
stored evidence from model interpretation.

#### Scope

- Combine vector similarity, full-text matching, bucket affinity, recency,
  person/task filters, and accepted personalization signals.
- Add reranking with configuration-selected models only when deterministic
  ranking is insufficient.
- Return direct hits before optional answer synthesis.
- Ground every answer sentence or claim in retrieval hit identifiers.
- Support follow-up questions within session working memory.
- Expose transcript text and audio-window playback while audio is retained;
  show transcript-only state after expiry.
- Add CLI query, explain-ranking, and retrieval-feedback commands.

#### Non-goals

- Searching the entire company by default, autonomous action from a query, or
  unsupported claims beyond retrieved evidence.

#### Expected repository changes

- `packages/retrieval/src/hybrid-search.ts`
- `packages/retrieval/src/reranker.ts`
- `packages/retrieval/src/answer.ts`
- [`apps/cli/src/main.ts`](../../../apps/cli/src/main.ts)
- [`models.config.yaml`](../../../models.config.yaml)

#### Requirements

- `FR-1`: Retrieval works without answer generation.
- `FR-2`: Synthesized answers cite live retrieval records.
- `FR-3`: Ranking features and weights are versioned and reportable.
- `FR-4`: User relevance feedback becomes a correction event.
- `SR-1`: Prompt injection in stored content cannot request tools or alter
  system policy.
- `SR-2`: ACL and tenant/user filtering happens before ranking or generation.
- `SR-3`: Deleted/expired content is excluded from all caches and citations.

#### Acceptance criteria

- `AC-1`: The golden retrieval set reaches at least 80% accepted success under
  the agreed metric.
- `AC-2`: Unsupported-answer and stale-citation tests fail closed.
- `AC-3`: Explain-ranking output identifies why each result ranked without
  exposing hidden data.
- `AC-4`: The product owner can retrieve a prior thought by topic, person,
  bucket, and approximate time.
- `AC-5`: Cross-tenant, injection, deletion, and audio-expiry tests pass.

#### Review gate

Demonstrate direct retrieval, grounded synthesis, ranking explanation, feedback,
and provenance playback. Phase 3 completes only after all three
specifications are accepted.

## Phase exit gate

- Organized knowledge is readable and retrievable.
- PostgreSQL and pgvector provide transactional concurrency and database-level
  scope enforcement.
- Retrieval meets the agreed success threshold and never loses provenance.
