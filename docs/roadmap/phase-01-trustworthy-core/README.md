# Phase 1 — Trustworthy core

Status: `in-progress`

> Product-owner directive (2026-09-02): Specifications 1.1, 1.2, and 1.3 are
> approved and are executed in one ordered run. If Specification 1.1's live
> prerequisites (secret-injected gateway credentials, representative
> recording) are unavailable, it is recorded `blocked` with the exact missing
> prerequisite and Specifications 1.2 and 1.3 still proceed under this
> explicit directive, overriding the default dependency gate for this phase
> only.

## Objective

Turn the current scaffold into a core loop whose external model behavior,
stored transcript, source provenance, and audio lifecycle are proven rather
than assumed.

## Entry conditions

- The current TypeScript workspace installs, tests, and typechecks.
- TrueFoundry use is limited to internal company data.
- The product owner can provide a representative non-sensitive recording and
  secret-injected gateway credentials for Specification 1.1.

## Specification order

### Specification 1.1 — Real gateway compatibility and reference capture

Status: `blocked`

> Blocker recorded 2026-09-02 (implementation worker): the live reference
> capture cannot run because ALL of its external prerequisites are missing
> in the execution environment:
>
> 1. `TRUEFOUNDRY_BASE_URL` — present in `.env` but still the
>    `.env.example` placeholder; no secret-injected value provided.
> 2. `TRUEFOUNDRY_API_KEY` — present in `.env` but still the
>    `.env.example` placeholder; no secret-injected value provided.
> 3. Representative consented non-sensitive recording — no audio file
>    exists in the environment.
>
> Required decision/action: the product owner supplies secret-injected
> gateway credentials (Cursor Dashboard secrets) and one representative
> recording, then re-runs `donna compat-check --audio <file>` followed by
> two `donna capture` runs.
>
> Completed under the blocked path (per the product-owner directive):
>
> - `donna capture` now fails BEFORE any gateway request when credentials
>   are missing/placeholder or the audio file is missing/empty, with an
>   actionable message that names variables and never prints values (FR-1).
> - New `donna compat-check [--audio <file>]` writes a sanitized
>   compatibility report to `packages/evals/reports/compatibility/`
>   (gitignored) enumerating each configured stage/model, the expected 1024
>   embedding dimensions, and the exact missing prerequisites (FR-3
>   scaffolding; SR-1/SR-2 redaction verified by tests).
> - No live run was performed and none is claimed; AC-1..AC-6 remain
>   unverified until the prerequisites exist.

Depends on: current scaffold

#### Outcome

A representative internal recording completes the configured
transcribe → organize → embed → bucket pipeline, and an evidence report records
the actual request/response capabilities needed by later specifications.

#### Scope

- Load TrueFoundry credentials only from the runtime secret environment.
- Use one representative, consented, non-sensitive recording with a
  human-written reference transcript.
- Verify `gpt-4o-transcribe` returns non-empty, ordered timestamp segments
  through the actual gateway.
- Verify the default organizer, escalation organizer, and 1024-dimensional
  embedder against their configured gateway endpoints.
- Exercise task extraction, creation/reuse of `Tasks`, creation of at least one
  non-task bucket, and a second capture that can reuse an existing bucket.
- Record latency, token/usage data when available, model IDs, schema results,
  and sanitized failures without recording secrets or transcript text.

#### Non-goals

- Durable memory, semantic retrieval, Microsoft 365 grounding, or agents.
- Changing model names merely to make a demo pass without comparative evidence.

#### Expected repository changes

- [`apps/cli/src/main.ts`](../../../apps/cli/src/main.ts)
- [`packages/providers/src/gateway.ts`](../../../packages/providers/src/gateway.ts)
- [`packages/providers/src/openai-transcriber.ts`](../../../packages/providers/src/openai-transcriber.ts)
- [`packages/pipeline/src/run.ts`](../../../packages/pipeline/src/run.ts)
- `packages/evals/datasets/golden/transcribe/`
- `packages/evals/reports/compatibility/`

#### Requirements

- `FR-1`: Missing credentials or audio fail before any gateway request with an
  actionable, redacted message.
- `FR-2`: Timestamp segment IDs and bounds are captured exactly as returned by
  the adapter.
- `FR-3`: Gateway model and endpoint incompatibilities are reported by stage.
- `FR-4`: The second capture sees the first capture's scoped buckets.
- `SR-1`: No credential, recording, transcript, or personal name is committed.
- `SR-2`: Telemetry contains pseudonymous scope, stage, model, counts, latency,
  and cost only.
- `SR-3`: The gateway is never used for public or cross-company data.

#### Acceptance criteria

- `AC-1`: The command completes successfully on the reference recording.
- `AC-2`: STT output contains non-empty, monotonic timestamps covering the
  spoken content.
- `AC-3`: Every organized thought has a schema-valid provenance proposal.
- `AC-4`: Every embedding has exactly 1024 finite values.
- `AC-5`: The task enters `Tasks`; a normal thought enters a sensible dynamic
  bucket; the repeat capture can reuse an existing bucket.
- `AC-6`: A sanitized compatibility report and labeled misfires are reviewed by
  the product owner.

#### Verification and review gate

Run unit/type checks, the reference capture twice, and a credential-redaction
check. Demonstrate the transcript, bucket results, and sanitized report
privately. If timestamp-bearing output is unsupported, set this specification
to `blocked`; do not fake timestamps or start Specification 1.2.

---

### Specification 1.2 — Persisted transcripts and deterministic provenance

Status: `in-review`

> Implementation evidence (2026-09-02, implementation worker):
>
> - New domain records `CaptureRecord`/`TranscriptRecord` (tenant/user
>   scope, SHA-256 content hash, model ID, timestamps) and
>   `DerivationVersions` on every thought (FR-4) in `packages/core`.
> - New ports `CaptureStore`, `TranscriptStore`, `ProvenanceVerifier`;
>   scoped file adapters `FileCaptureStore`/`FileTranscriptStore`
>   (`packages/pipeline/src/stores.file.ts`) with partition-ID and
>   capture-ID validation, fail-closed scope mismatch, and transcript
>   content-hash re-verification on read (SR-1/SR-2).
> - `DeterministicProvenanceVerifier`
>   (`packages/pipeline/src/provenance.ts`): rejects empty, unknown,
>   duplicate, and cross-capture segment references and invalid stored
>   bounds; canonicalizes `sourceText`/`startSec`/`endSec` from stored
>   segments only (FR-2/FR-3).
> - Pipeline persists capture → transcript → thoughts in that order (FR-1),
>   escalates provenance-invalid output to the escalation lane at most
>   once, then fails closed with `ProvenanceError` persisting no thoughts;
>   organizer output is matched to thoughts by stable output index instead
>   of text equality.
> - Tests: `provenance.test.ts` (9), `run.test.ts` (8),
>   `stores.file.test.ts` (7), `run.integration.test.ts` (2, reload +
>   tenant isolation) — all green; `npm run typecheck` clean.
> - Known limitation: provenance proves which stored segments were used,
>   not that the speaker's statement is factually true (per non-goals).
>   Awaiting product-owner examination for acceptance.

Depends on: Specification 1.1 accepted

#### Outcome

Every stored thought can be deterministically traced to a persisted capture and
real transcript segments. The LLM proposes source segments; Donna verifies and
canonicalizes them.

#### Scope

- Add capture and transcript domain records with tenant/user scope, content
  hash, model ID, prompt/schema version, and timestamps.
- Add `CaptureStore`, `TranscriptStore`, and `ProvenanceVerifier` ports.
- Persist the transcript before organization results are accepted.
- Verify that all cited segment IDs exist, bounds are finite and ordered, and
  cited text comes from the referenced segments.
- Derive canonical `sourceText`, `startSec`, and `endSec` from stored segments
  instead of trusting model-generated values.
- Route semantically invalid organizer output through the configured
  escalation lane once, then fail closed if provenance remains invalid.
- Replace text-equality matching between organizer output and thoughts with
  stable output indexes or IDs.

#### Non-goals

- Audio encryption/deletion, semantic memory, or search.
- Claiming that provenance proves the speaker's statement is factually true;
  it proves only what source was used.

#### Expected repository changes

- [`packages/core/src/types.ts`](../../../packages/core/src/types.ts)
- [`packages/core/src/ports.ts`](../../../packages/core/src/ports.ts)
- [`packages/pipeline/src/run.ts`](../../../packages/pipeline/src/run.ts)
- `packages/pipeline/src/provenance.ts`
- `packages/pipeline/src/provenance.test.ts`
- a scoped file adapter for captures/transcripts

#### Requirements

- `FR-1`: A thought cannot be persisted before its capture and transcript.
- `FR-2`: Empty, unknown, duplicate-only, or cross-capture segment references
  are rejected.
- `FR-3`: Canonical source bounds span only referenced stored segments.
- `FR-4`: Model and schema versions are attached to derived records.
- `SR-1`: Every store method requires authenticated-style tenant/user scope.
- `SR-2`: Cross-scope records fail closed and never fall back to an empty file.
- `SR-3`: Errors and telemetry contain identifiers/counts, not source text.

#### Acceptance criteria

- `AC-1`: 100% of persisted thoughts pass deterministic provenance checks.
- `AC-2`: Unit tests cover unknown IDs, wrong capture, invalid bounds, empty
  segments, duplicate thought text, and escalation failure.
- `AC-3`: Reloading the process preserves the capture → transcript → thought
  chain.
- `AC-4`: The product owner can inspect one thought and recover its exact
  transcript segments without invoking a model.

#### Verification and review gate

Run unit, integration, type, and tenant-isolation tests. Demonstrate valid
provenance plus at least three rejected tampering cases. Do not start
Specification 1.3 until the product owner accepts the persisted chain.

---

### Specification 1.3 — Encrypted audio retention and user data controls

Status: `in-review`

> Implementation evidence (2026-09-02, implementation worker):
>
> - New `@donna/privacy` package: AES-256-GCM encryption (random 96-bit
>   nonces, versioned payload format), `EncryptedFileAudioStore`,
>   append-only non-content `FileAuditLog`, `RetentionService`
>   (seven-day retention from capture time, injectable clock, idempotent
>   cleanup), and `CaptureLifecycleService` (scoped export, early audio
>   deletion, complete capture deletion).
> - Keys come only from `DONNA_AUDIO_KEY` runtime secret management
>   (base64/hex 32 bytes); missing/invalid keys fail closed before any
>   capture work; keys are never written beside ciphertext or logged
>   (SR-1/SR-2).
> - Complete deletion propagates through audio, capture record,
>   transcript, and bucket items (thoughts + embeddings) with bucket
>   stats recomputed from surviving members; future projections plug in
>   via `extraProjections` and any non-deletable target fails explicitly
>   and retryably via `CaptureDeletionError` (FR-4).
> - CLI: `export`, `delete-audio`, `delete-capture`, `retention
>   [--cleanup]`; pipeline stores encrypted audio at capture time.
> - Tests: 30 privacy tests (round-trip, tamper, wrong-key, traversal,
>   cross-tenant, replay/idempotency, clock-controlled expiry, export
>   scoping, deletion propagation, explicit projection failure) + pipeline
>   audio-hook test — all green; `npm run typecheck` clean.
> - Demonstrated with a fake clock and seeded synthetic fixture: audio
>   available before expiry, transcript-only state after deletion,
>   idempotent replay, non-content audit trail.
> - Known limitation: export bundles contain capture/transcript/thoughts/
>   provenance metadata but not the raw audio bytes; bucket records
>   themselves are retained (they are the user's filing system) with
>   stats repaired. Awaiting product-owner examination for acceptance.

Depends on: Specification 1.2 accepted

#### Outcome

Original audio is encrypted, retained for seven days for provenance and
evaluation review, automatically removed afterward, and controllable by the
employee through export and deletion operations.

#### Scope

- Add an `AudioStore`/`CaptureStore` lifecycle with encryption at rest and keys
  supplied by runtime secret management, never stored beside ciphertext.
- Calculate retention from capture time and provide idempotent cleanup.
- Preserve transcript-only provenance after audio expiry and report that audio
  playback is no longer available.
- Add scoped CLI commands for capture export, early audio deletion, complete
  capture deletion, and retention status.
- Define deletion propagation across audio, transcript, thoughts, embeddings,
  memories, retrieval projections, and future agent drafts.
- Add an append-only, non-content audit record for lifecycle operations.

#### Non-goals

- Indefinite audio history, employer access to personal recordings, or
  production cloud storage selection.

#### Expected repository changes

- [`packages/core/src/ports.ts`](../../../packages/core/src/ports.ts)
- `packages/privacy/`
- a local encrypted audio adapter
- [`apps/cli/src/main.ts`](../../../apps/cli/src/main.ts)
- retention integration tests with an injectable clock

#### Requirements

- `FR-1`: New audio is encrypted before durable storage.
- `FR-2`: Cleanup is retry-safe and deletes audio after seven days.
- `FR-3`: Export and deletion operate only in the requesting tenant/user scope.
- `FR-4`: Complete deletion removes every derived projection or records an
  explicit retryable failure.
- `SR-1`: Encryption uses authenticated modern cryptography and secure random
  nonces.
- `SR-2`: Keys, raw audio, transcripts, and personal data never enter logs.
- `SR-3`: A malicious capture ID cannot traverse storage paths or select
  another user's object.

#### Acceptance criteria

- `AC-1`: Ciphertext cannot be decoded without the configured key.
- `AC-2`: Clock-controlled tests retain audio before expiry and remove it at or
  after seven days.
- `AC-3`: Repeated cleanup/deletion calls do not fail or restore data.
- `AC-4`: Export contains the user's capture, transcript, thoughts, and
  provenance but no other partition.
- `AC-5`: The product owner observes audio playback before expiry and an
  explicit transcript-only state after expiry.

#### Verification and review gate

Run cryptographic round-trip, tamper, expiry, deletion, export, and
cross-tenant tests. Demonstrate lifecycle behavior with a fake clock. Phase 1
is complete only after all three specifications are explicitly accepted.

## Phase exit gate

- The real configured gateway path is proven.
- Transcript and provenance are independently verifiable.
- Audio retention and user data controls behave deterministically.
- No secrets or private fixtures are tracked.
- All relevant tests and the product-owner demonstrations are accepted.
