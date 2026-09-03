# Phase 3 — Retrieval and production storage

Status: `accepted` (product owner, 2026-09-03)
awaiting product-owner examination)

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

Status: `accepted` (product owner, 2026-09-03)

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

Status: `accepted` (product owner, 2026-09-03)

> Implementation evidence (2026-09-03, implementation worker):
>
> - **Environment:** PostgreSQL 16.15 + pgvector 0.6.0 installed via apt
>   (`postgresql-16-pgvector`) — NO deviation; pgvector is live. Local
>   roles: `donna_app` (non-superuser app role, RLS-bound), `donna_backup`
>   (BYPASSRLS dump role), admin via `postgres`. Test DB `donna_test`.
> - **Migrations** (`database/migrations/0001_init.up.sql` /
>   `.down.sql`): versioned pair; tables captures, transcripts, buckets,
>   items, memories, memory_proposals, memory_events (append-only),
>   consents (append-only), corrections, retrieval_index (rebuildable
>   projection, FK cascade from items). Every personal-data table carries
>   tenant_id + user_id (FR-3). Constraints: composite PKs, FKs
>   (transcripts→captures CASCADE, items→buckets, retrieval_index→items
>   CASCADE), case-insensitive per-user unique bucket names, CHECK
>   constraints on enums, `buckets.version` optimistic-lock column,
>   idempotency via ON CONFLICT on natural PKs. Money rule: no monetary
>   columns exist; the integer-minor-units-or-NUMERIC rule is documented
>   as a review-enforced migration convention in `database/README.md`.
> - **RLS (SR-1):** ENABLE + FORCE ROW LEVEL SECURITY on all ten tables;
>   one `scope_isolation` policy per table bound to transaction-local
>   `app.tenant_id`/`app.user_id` (set via parameterized
>   `set_config(..., true)` in `scoped()`; unset context → NULL → zero
>   rows). Append-only tables grant the app role INSERT/SELECT only.
> - **New package `packages/storage-postgres/`:** `createPool` (runtime
>   secrets, TLS verified by default, explicit `allowInsecureTls` escape
>   hatch — SR-2), `scoped()` per-transaction scope pinning, migration
>   runner (`migrateUp`/`migrateDown`, per-migration transactions,
>   ledger), adapters for every existing port: `PostgresBucketStore`,
>   `PostgresCaptureStore`, `PostgresTranscriptStore` (content-hash
>   re-verified on read, fail closed), `PostgresMemoryStore`,
>   `PostgresConsentStore`, `PostgresCorrectionStore`,
>   `PostgresRetrievalIndex` (SQL scope+filters, pgvector `<=>` cosine
>   with `vector_dims` guard, shared deterministic text scorer, score
>   version `donna.pg-retrieval.v1`), `importFileFixtures` (port-based,
>   idempotent). All SQL parameterized (SR-4). `OptimisticLockError`
>   added to the core port contract.
> - **Concurrency (FR-1/FR-2):** `saveItem` = one transaction: bucket row
>   lock (SELECT … FOR UPDATE) + idempotent item insert + exact
>   `avg(vector)` centroid/count recompute + projection upsert. This
>   fixes the file store's read-modify-write race — concurrent placements
>   serialize per bucket. `updateBucketStats` is optimistic
>   version-checked with bounded retries (10) then OptimisticLockError.
>   move/merge/delete lock affected buckets in ID order (deadlock-safe).
> - **Tests: 9 new integration tests (236 total green with the DB live;
>   227 green without it — the suite skips cleanly when
>   DONNA_TEST_DATABASE_URL/DONNA_TEST_ADMIN_URL are unset), typecheck
>   clean.** Coverage: AC-1 clean install + idempotent up + down + re-up;
>   scoped CRUD round-trips across all stores (FR-3); AC-2/SR-1 raw
>   unscoped queries return zero rows, faulty no-filter queries under a
>   foreign scope see only their own rows, cross-tenant INSERT rejected
>   by WITH CHECK; AC-3 eight concurrent saveItem calls → 8 items, exact
>   mean centroid, no lost updates; FR-2 five concurrent stats writes →
>   version consistency; transcript tamper → integrity failure on read;
>   AC-4 file-fixture import runs twice without duplicates with stats
>   recomputed; retrieval projection search/filters/rebuild/cascade;
>   AC-5 pg_dump → restore into a fresh database preserves all scoped
>   rows including the projection.
> - **Docs:** `database/README.md` — roles, TLS, migration up/down,
>   backup/restore (BYPASSRLS backup role requirement), retrieval-index
>   rebuild procedure, monetary-column rule, and the fixed-dimension
>   `vector(N)` + HNSW upgrade path.
> - **Ambiguities resolved (conservative):** (1) "memory embeddings" —
>   the Spec 2.1 `MemoryRecord` domain has no embedding field, so no
>   memory embedding column was created; pgvector is enabled and used for
>   thought embeddings, and a nullable `memories.embedding` migration is
>   the documented path when semantic memory retrieval lands. (2)
>   Embedding columns are dimensionless `vector` (float4) so the model
>   can change without schema changes; fixed-dimension + HNSW is the
>   documented production upgrade. (3) The CLI remains file-backed in
>   this spec; the Postgres adapters are proven through the integration
>   suite (a config-driven store switch is a later product decision).
> - **Known limitations:** retrieval search fetches filtered rows and
>   scores in JS (text) — SQL-side candidate pruning (tsv @@, HNSW) is
>   the scale path; pgvector 0.6.0 float4 precision; sessions/emotion
>   snapshots stay file-backed (session-scoped and ephemeral by design,
>   not in the spec's table list).
>
> Awaiting product-owner examination for acceptance.

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

Status: `accepted` (product owner, 2026-09-03)

> Implementation evidence (2026-09-03, implementation worker):
>
> - **Hybrid ranking** (`packages/retrieval/src/hybrid-search.ts`):
>   `HybridRetriever` over any `RetrievalIndex` — six versioned,
>   explainable features (`donna.hybrid-ranking.v1`): text, semantic,
>   bucket affinity (query embedding vs bucket centroid), recency
>   (0.5^(days/half-life)), personalization (accepted-correction
>   affinity), task match. Weights, half-life, candidate limit, and the
>   relevance floor (`min_score` 0.20) live in models.config.yaml
>   (`retrieval:` section), parsed by the registry — FR-3. Scope and
>   filters are applied by the index BEFORE any feature is computed
>   (SR-2); there is no cache, so deleted/expired content cannot reappear
>   (SR-3). A reranker port (`reranker.ts`) exists with a deterministic
>   default; `applyReranker` enforces the permutation contract and fails
>   closed to the deterministic order — no LLM reranker is configured
>   because deterministic ranking meets the bar (spec: rerank only when
>   deterministic is insufficient).
> - **Grounded answer synthesis** (`packages/retrieval/src/answer.ts`):
>   optional (`retrieval.answer` lane → `AnswerGenerator` port, wired to
>   gpt-5-mini via the registry; FR-1 hits-only without it). Trust-
>   separated prompt `donna.answer-prompt.v1` (code-only SYSTEM POLICY,
>   UNTRUSTED evidence section, no tools — SR-1). `verifyAnswer` parses
>   claim sentences and [Hn] markers: uncited claims, stale citations
>   (unknown hit), empty output, and model abstention all return
>   `supported: false` with a machine-readable reason and the ungrounded
>   text is never presented (AC-2, fail closed).
> - **Follow-up questions**: `donna query --session <id>` records each
>   query as session-scoped working memory (expires with the session);
>   a bare follow-up that finds nothing is retried once with the recent
>   session queries appended (bounded, deterministic).
> - **Witnessed adherence fix**: `CorrectionService.observePlacement`
>   applicability is now semantic when an embedder is configured —
>   cosine ≥ `corrections.adherence_semantic_threshold` against the
>   correction's canonical thoughtSummary — with the deterministic
>   keyword path as fallback (no embedder, or embedder failure). The
>   context assembler's example SELECTION got the same semantic path
>   (otherwise the example is never injected for paraphrases and
>   adherence has nothing to observe). **Threshold calibration (live
>   text-embedding-3-large@1024, 2026-09-03): the witnessed pair ("test
>   removing email verification" vs "try one-click signup" class) scores
>   0.549; unrelated text scores 0.157 — the default is 0.5, documented
>   in models.config.yaml; revisit with more real correction pairs.**
> - **Projection freshness**: accepted corrections that mutate source
>   records now rebuild the retrieval projection (found during live
>   verification: a moved thought kept its old bucket name in search
>   until reindex). The Postgres adapter maintains its projection
>   transactionally per mutation; the local index rebuilds on accept.
> - **CLI**: `donna query` (direct hits first with provenance + audio
>   state: "audio retained" vs "transcript-only (audio deleted …)"),
>   `donna explain-ranking` (features × weights per hit, AC-3), `donna
>   retrieval-feedback <thought-id> --verdict relevant|irrelevant
>   --query <text>` (FR-4: becomes a retrieval.relevance correction
>   event in the review queue).
> - **Golden retrieval set** (`packages/evals/datasets/golden/
>   retrieval.v1.json` + `src/retrieval.ts`): 22 labeled cases over
>   synthetic fixtures in the existing demo style (vendor contracts,
>   hiring, errands, product) with hand-crafted 5-dim embeddings —
>   deterministic and offline. Metric hit@3. **Result: 22/22 = 100.0%
>   under the production ranking config (bar 80%)** — report written to
>   packages/evals/reports/retrieval/ (gitignored like other reports).
>   Honest caveat: fixtures are synthetic with clean vector separation;
>   real-world embeddings are noisier, and the set should grow with
>   real misfires.
> - **Tests: 27 new (263 total green with the DB live, 254 without;
>   typecheck clean).** Coverage: feature computation and weight-driven
>   determinism (FR-3), filters-before-ranking (SR-2), cross-tenant
>   denial (SR-1), follow-up expansion, deletion exclusion (SR-3),
>   supported/uncited/stale-citation/abstain/empty answer paths (AC-2),
>   prompt trust separation incl. injection confined to the untrusted
>   section (SR-1), reranker permutation contract, semantic adherence:
>   paraphrase counted, threshold boundary, keyword fallback, embedder-
>   failure fallback, keyword-path undercount regression documentation,
>   correction-accept projection rebuild, golden-set bar + determinism.
> - **Live demo (synthetic espeak-ng audio, real gateway, temp data
>   dir):** captured "We should test removing email verification…" +
>   "remind me to send Priya the updated onboarding checklist…" →
>   paraphrase query "how can we make signup easier" ranked the signup
>   thought first (0.387); person query found the Priya task; grounded
>   answer "You are testing removing email verification from the signup
>   flow to reduce drop-off.[H1]" cited the live hit ID (gpt-5-mini);
>   a separate answer with an uncited sentence failed closed
>   (uncited-claim). The correction "test removing email verification →
>   Growth Experiments" was accepted; the follow-up capture "Let's pilot
>   a one-click signup…" was semantically matched to it —
>   `correction.adherence followed=0 contradicted=1` (the thought carried
>   a task and the hard rule routed it to Tasks — see decision point
>   below) — where the keyword path had counted nothing. A bucket.rename
>   correction was reflected in search immediately (projection rebuild).
>   Session follow-up "who was it for" resolved via working memory.
>   delete-audio flipped hits to "transcript-only". An injection-laden
>   thought inserted directly into the store was retrieved as data; the
>   gateway's own prompt shield rejected the synthesis prompt and the
>   CLI failed closed; no buckets were altered. Cross-user and
>   cross-tenant queries return nothing.
> - **Decision point for the product owner:** when a corrected preference
>   conflicts with the Tasks hard-rule (a task-bearing thought the user
>   taught us belongs elsewhere), adherence currently records
>   "contradicted" — the hard rule wins placement. If task routing should
>   be exempt from adherence (or the hard rule should yield to accepted
>   corrections), that is a product decision.
> - **Known limitations:** follow-up expansion is naive concatenation
>   (no coreference resolution); the relevance floor and adherence
>   threshold are calibrated on a small sample; answer synthesis is
>   single-shot (no multi-turn grounding); the golden set is synthetic.
>
> Awaiting product-owner examination for acceptance.

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

## Independent verification round (2026-09-03, post-implementation)

A product-owner-style verification pass over the live CLI found and fixed two
real defects the implementation worker's tests had not caught:

1. **Label parroting (fixed, commit `0990bee`).** The organize prompt rendered
   context elements as `[bucket:<uuid> · as of …]`; gpt-5-mini echoed that
   label as a bucket *name*, minting a bucket literally called
   `bucket:45ce0675-…`. Source IDs no longer render into the prompt, and the
   engine resolves parroted `bucket:<id>` proposals to the referenced bucket.
2. **Adherence not wired (fixed, commit `0990bee`).** The CLI built the
   `ContextAssembler` without the embedder, silently degrading
   correction-example selection to keyword overlap; paraphrases never
   surfaced corrections. Verified live after the fix: a zero-keyword
   paraphrase of the accepted correction fires `correction.adherence`
   (`contradicted=1` — the Tasks hard-rule overrode the preference, the
   documented design decision awaiting product-owner confirmation).

Also verified live in this round: `items` with provenance, `reindex`
(17 items), text search, semantic paraphrase search ranking all five
onboarding items top, grounded `query --answer` with per-claim hit citations,
`explain-ranking` feature breakdown, `retrieval-feedback` → correction event,
and 265/265 tests with PostgreSQL 16 + pgvector 0.6.0 live.
