# Phase 2 — Private memory and personalization

Status: `in-progress`

> Product-owner directive (2026-09-03): Specifications 2.1, 2.2, 2.3, and 2.4
> are approved and are executed in one ordered run, one specification at a
> time, on branch `cursor/import-mvp-scaffold-b430`. Each specification still
> moves approved → in-progress → in-review with its own evidence; the
> per-specification acceptance gate between specifications is overridden for
> this phase only (as was done for Phase 1). Phase 1 is accepted; its
> persisted captures/transcripts, deterministic provenance, encrypted audio,
> and tenant/user-scoped stores are the entry conditions for this phase.

## Objective

Give Donna explicit, private, source-linked memory that improves organization
and retrieval from user corrections without training a personal foundation
model or creating a hidden employee profile.

## Entry conditions

- Phase 1 is accepted.
- Captures, transcripts, thoughts, and provenance have stable identifiers.
- Deletion can propagate through derived data.

## Specification order

### Specification 2.1 — Memory domain, consent, and lifecycle

Status: `in-review` (approved by product owner 2026-09-03; implementation completed 2026-09-03)

> Implementation evidence (2026-09-03, implementation worker):
>
> - **Domain types** (`packages/core/src/types.ts`): `MemoryRecord` (layers
>   working/episodic/semantic/procedural; status confirmed/superseded/
>   expired; origin explicit/approved; confidence, subject key, TTL
>   `expiresAt`, `sessionId`, supersession fields), `MemoryProposal`
>   (quarantined pending/approved/rejected), `MemorySource` (kind + id +
>   optional `captureId` + reason), `ConsentRecord` (append-only,
>   latest-decides), `Session`, `MemoryEvent` (append-only, non-content).
> - **Ports** (`packages/core/src/ports.ts`): `MemoryStore`, `ConsentStore`
>   — scoped persistence only; all lifecycle policy lives in the service.
>   No cross-user/cross-tenant listing exists anywhere (SR-1/SR-2).
> - **New package `packages/memory/`**: `FileMemoryStore` +
>   `FileConsentStore` (`<dataDir>/<tenant>/<user>/memory.json` /
>   `consents.json`, partition-ID validation, fail-closed scope checks on
>   every stored record, 0700 dirs / 0600 files); `MemoryService`
>   (stateExplicit, propose/approve/reject, supersede with conflict events,
>   working-memory session expiry, TTL sweep, forget, export, removeSource);
>   deterministic SR-4 screener (private keys, API tokens/JWTs, passwords,
>   Luhn-valid card numbers, national-id patterns) that rejects
>   model-generated proposals and reports category tokens only — never the
>   matched text.
> - **CLI** (`apps/cli/src/main.ts`): `donna memory list|proposals|approve|
>   reject|remember|supersede|forget|export|events` and `donna consent
>   list|grant|revoke`. `delete-capture` now carries a memory projection:
>   memories sourced from the deleted capture are removed or unlinked.
> - **Tests: 36 new (131 total green), typecheck clean.** Coverage: four
>   layer separation (AC-1), FR-2 source/reason enforcement, propose →
>   approve → confirmed and propose → reject → never-served (AC-3), source
>   and confidence inspection (AC-2), conflict event without overwrite +
>   explicit supersession (FR-3), working-memory session expiry and TTL
>   sweep idempotency (FR-4), forget/export scoping (SR-3), SR-4 screening
>   incl. no-secret-in-error, source-deletion propagation (AC-4), consent
>   grant/revoke/latest-wins, cross-tenant/user denial and fail-closed
>   partition checks (AC-5), file modes.
> - **Live demo (synthetic espeak-ng audio, real gateway, temp data dir):**
>   propose → approve → use → correct → forget shown for one preference
>   ("Prefers meetings before 11am", inferred confidence 0.62) and one
>   relationship ("Meera leads the onboarding workstream", explicit);
>   supersession kept the old record as `superseded` history; SR-4 refused
>   a model attempt to store a password; a live capture (1 thought →
>   `Tasks`) was deleted via `delete-capture` and its source-linked
>   episodic memory was removed (`source-removed … memory-deleted` event).
> - **Known limitations:** conflict detection is deterministic
>   (layer/kind/subject + normalized text), not embedding-semantic;
>   proposals are created by the service API (the pipeline does not yet
>   infer proposals — that wiring is Spec 2.2+); consent purposes are
>   free-form strings until later specs fix the catalog.
>
> Awaiting product-owner examination for acceptance.

Depends on: Phase 1 accepted

#### Outcome

Donna can store and distinguish working, episodic, semantic, and procedural
memory, with explicit ownership, provenance, confidence, consent, expiry, and
deletion semantics.

#### Scope

- Define `MemoryRecord`, `MemoryProposal`, `MemorySource`, `ConsentRecord`, and
  `Session` domain types.
- Add a tenant/user-scoped `MemoryStore` and `ConsentStore`.
- Represent four layers:
  - working memory for the current interaction;
  - episodic memory for captures, thoughts, decisions, and outcomes;
  - semantic memory for confirmed facts, preferences, vocabulary, people, and
    recurring themes;
  - procedural memory for corrections and organization/action preferences.
- Separate proposed inferred memory from user-confirmed memory.
- Add TTL, supersession, conflict, confidence, source, and delete/export fields.
- Add CLI inspection controls so the employee can view, approve, correct,
  reject, and forget durable memory.

#### Non-goals

- Microsoft 365 ingestion, emotional inference, vector retrieval, or
  per-user fine-tuning.

#### Expected repository changes

- [`packages/core/src/types.ts`](../../../packages/core/src/types.ts)
- [`packages/core/src/ports.ts`](../../../packages/core/src/ports.ts)
- `packages/memory/`
- [`apps/cli/src/main.ts`](../../../apps/cli/src/main.ts)

#### Requirements

- `FR-1`: Every durable memory is either explicitly stated or visibly approved
  from a proposal.
- `FR-2`: Every memory links to one or more source records and records why it
  exists.
- `FR-3`: Conflicting memory is represented as a conflict/supersession event,
  not silently overwritten.
- `FR-4`: Working memory expires with the session.
- `SR-1`: Memory reads and writes always require tenant and user scope.
- `SR-2`: Employers/admins receive no API for browsing personal memory.
- `SR-3`: Export, edit, and deletion are available to the owning employee.
- `SR-4`: Secrets, credentials, and regulated identifiers are rejected as
  durable model-generated memory unless explicitly required by an approved
  future policy.

#### Acceptance criteria

- `AC-1`: Tests demonstrate separation and lifecycle of all four memory layers.
- `AC-2`: A user can inspect the source and confidence of every durable memory.
- `AC-3`: Rejecting a proposal prevents it from influencing later context.
- `AC-4`: Deleting a source removes or invalidates dependent memories.
- `AC-5`: Cross-user and cross-tenant memory access tests fail closed.

#### Review gate

Demonstrate propose → approve → use → correct → forget for one preference and
one relationship. Do not start Specification 2.2 until the data model and user
controls are accepted.

---

### Specification 2.2 — Context assembler with source attribution

Status: `draft`

Depends on: Specification 2.1 accepted

#### Outcome

Before organization, Donna builds a bounded context packet containing only the
most relevant private memories and current-session context, with source labels
and no instruction privilege for retrieved content.

#### Scope

- Add a `ContextAssembler` port/service and `ContextPacket` type.
- Select relevant recent captures, bucket summaries, confirmed memories,
  vocabulary, relationships, and corrections under configurable token and item
  budgets.
- Keep system instructions, trusted user settings, and untrusted retrieved
  content in separate prompt sections/channels.
- Include source IDs and freshness for every context element.
- Record which context influenced an organization request without logging its
  content.
- Add deterministic fallback when memory retrieval is unavailable.

#### Non-goals

- Microsoft 365 context, autonomous tool calls, or full semantic search UI.

#### Expected repository changes

- `packages/memory/src/context-assembler.ts`
- [`packages/core/src/ports.ts`](../../../packages/core/src/ports.ts)
- [`packages/pipeline/src/run.ts`](../../../packages/pipeline/src/run.ts)
- [`packages/providers/src/organize-schema.ts`](../../../packages/providers/src/organize-schema.ts)
- [`models.config.yaml`](../../../models.config.yaml) for budgets, not model IDs
  in code

#### Requirements

- `FR-1`: Context selection is query/capture-specific rather than dumping all
  memories into every prompt.
- `FR-2`: Token limits produce deterministic truncation with source priority.
- `FR-3`: Confirmed user preferences outrank inferred/proposed memory.
- `FR-4`: The organizer output records context source IDs used.
- `SR-1`: Retrieved text is data, never executable instruction.
- `SR-2`: Context cannot contain another user's record.
- `SR-3`: Prompt/telemetry logs expose counts and IDs only.
- `SR-4`: A deleted or expired record cannot reappear from cache.

#### Acceptance criteria

- `AC-1`: Context assembly remains within the configured token budget.
- `AC-2`: Relevant confirmed preferences appear; irrelevant memories do not.
- `AC-3`: Prompt-injection text stored in memory cannot alter tool access or
  system policy.
- `AC-4`: Organization still works in an explicit degraded mode when the memory
  store is unavailable.
- `AC-5`: Every included element is traceable to a live source.

#### Review gate

Demonstrate two users giving similar voice notes but receiving correctly
different organization based on their own approved preferences. The product
owner reviews the exact context packet and attribution before acceptance.

---

### Specification 2.3 — Correction-driven personalization

Status: `draft`

Depends on: Specification 2.2 accepted

#### Outcome

Moving, editing, accepting, or rejecting organized content becomes a
source-linked correction event that improves later decisions for that employee
and supplies de-identified evaluation cases only with consent.

#### Scope

- Define immutable correction events for bucket move/merge/rename, thought
  edit/split/merge, task add/remove, provenance correction, memory decision, and
  retrieval relevance.
- Add correction capture commands and a review queue to the CLI.
- Update bucket centroids and procedural preferences safely after accepted
  corrections.
- Retrieve a bounded set of relevant prior corrections as personalized
  examples.
- Track whether the system followed or contradicted a learned correction.
- Add a consented de-identification path from misfire to shared golden case.

#### Non-goals

- Online model-weight updates, automatic cross-user learning, or silent
  promotion of private examples.

#### Expected repository changes

- `packages/memory/src/corrections.ts`
- [`packages/buckets/src/engine.ts`](../../../packages/buckets/src/engine.ts)
- [`apps/cli/src/main.ts`](../../../apps/cli/src/main.ts)
- [`packages/evals`](../../../packages/evals)

#### Requirements

- `FR-1`: Corrections append an event; they do not destroy prior provenance.
- `FR-2`: Replaying events produces the same current state.
- `FR-3`: Only accepted corrections influence later decisions.
- `FR-4`: Personal examples remain within the owner partition.
- `SR-1`: Shared eval promotion requires explicit consent and de-identification.
- `SR-2`: Free-form correction text is treated as untrusted content.
- `SR-3`: Correction application is idempotent.

#### Acceptance criteria

- `AC-1`: Repeating a corrected scenario follows the user's accepted preference.
- `AC-2`: Correction rate and adherence are measurable per pseudonymous user.
- `AC-3`: Event replay, duplicate submission, deletion, and tenant-isolation
  tests pass.
- `AC-4`: No private correction enters the shared dataset by default.

#### Review gate

Demonstrate a mis-bucket, user correction, and improved repeat capture with the
source event visible. Do not start Specification 2.4 until accepted.

---

### Specification 2.4 — Session emotion and intent context

Status: `draft`

Depends on: Specification 2.3 accepted

#### Outcome

Donna can use tentative urgency, frustration, uncertainty, or emotional tone
to respond and organize more appropriately during the current session without
claiming to know the employee's true feelings or retaining a hidden profile.

#### Scope

- Define `IntentSignal` and `EmotionalSnapshot` with confidence, evidence,
  model/version, session ID, correction state, and expiry.
- Keep emotional snapshots in session storage by default.
- Show tentative language and allow the employee to correct or disable the
  inference.
- Use emotion only to adjust tone, review priority, or uncertainty handling;
  never to change access, performance evaluation, or employment decisions.
- Add a separate explicit opt-in before any emotional context is promoted to
  durable private memory.
- Delete session snapshots automatically at session expiry.

#### Non-goals

- Mental-health diagnosis, personality scoring, employer reporting, or
  emotion-based autonomous action.

#### Expected repository changes

- [`packages/core/src/types.ts`](../../../packages/core/src/types.ts)
- `packages/memory/src/session-store.ts`
- `packages/memory/src/emotional-context.ts`
- [`packages/providers/src/organize-schema.ts`](../../../packages/providers/src/organize-schema.ts)
- consent and calibration tests

#### Requirements

- `FR-1`: Every inference is labeled as inferred and confidence-scored.
- `FR-2`: Session expiry removes the snapshot unless a separate opt-in exists.
- `FR-3`: The user can disable, correct, or delete emotional context.
- `SR-1`: Emotional data is private to the employee.
- `SR-2`: No agent permission or external action depends on emotional state.
- `SR-3`: Persisting emotional context without an active consent record fails
  closed.

#### Acceptance criteria

- `AC-1`: Default sessions leave no durable emotional record.
- `AC-2`: Opt-in and revocation behavior is covered by tests.
- `AC-3`: Calibration evals measure false confident inferences and abstention.
- `AC-4`: Disabling emotion leaves core capture/organization functional.
- `AC-5`: Product copy and demonstrations use uncertainty-aware language.

#### Review gate

The product owner examines default expiry, opt-in, correction, and disabled
flows. Phase 2 completes only after all four specifications are accepted.

## Phase exit gate

- Memory layers, consent, provenance, and deletion are explicit.
- Context assembly is bounded, attributed, and injection-resistant.
- Corrections demonstrably improve repeated scenarios for the same user.
- Emotional context is private, tentative, user-controlled, and ephemeral by
  default.
