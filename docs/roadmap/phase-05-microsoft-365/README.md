# Phase 5 — Microsoft 365 grounding and destinations

Status: `not-started`

## Objective

Ground Donna in explicitly selected corporate context while preserving source
permissions, tenant/user isolation, consent, and the boundary between retrieved
content and trusted instructions.

## Entry conditions

- Phases 1–4 are accepted.
- Identity, memory, retrieval, deletion, and evaluation contracts exist.
- The internal pilot has an approved Entra application and least-privilege
  scope plan.

## Specification order

### Specification 5.1 — Entra identity, consent, and token boundary

Status: `draft`

Depends on: Phase 4 accepted

#### Outcome

Every Microsoft 365 read or destination request is bound to an authenticated
employee and company tenant with explicit source consent and securely managed
delegated credentials.

#### Scope

- Add Entra authentication for the post-CLI service boundary while preserving
  a clearly marked single-user local mode.
- Derive `tenantId` and `userId` from validated identity claims, never body,
  query, or caller-selected headers.
- Validate issuer, audience, expiry, signing algorithm, and required claims.
- Define source-level consent for calendar, selected mail, selected Teams
  threads, OneDrive/SharePoint files, and future destinations.
- Store delegated refresh material encrypted in an approved secret/token store.
- Support revoke, re-consent, expiry, and employee data disconnection.

#### Non-goals

- Blanket tenant-wide ingestion, application permissions where delegated
  permissions suffice, or employer browsing of personal Donna memory.

#### Expected repository changes

- `packages/identity/`
- `packages/privacy/`
- [`packages/core/src/types.ts`](../../../packages/core/src/types.ts)
- service composition/auth middleware introduced by the approved deployment
  specification

#### Requirements

- `FR-1`: Authenticated claims establish the only accepted tenant/user scope.
- `FR-2`: Consent records name resource type, granted scopes, time, and
  revocation state.
- `FR-3`: Revocation stops new reads and invalidates source caches.
- `SR-1`: Tokens and client secrets never enter logs, model prompts, or source
  control.
- `SR-2`: TLS validation is mandatory.
- `SR-3`: Least-privilege delegated scopes are documented and tested.
- `SR-4`: Session IDs rotate after authentication state changes.

#### Acceptance criteria

- `AC-1`: Valid, expired, wrong-audience, wrong-issuer, and tampered-token tests
  behave correctly.
- `AC-2`: Caller-supplied tenant/user values cannot override authenticated
  identity.
- `AC-3`: Consent revoke prevents retrieval and purges cached projections.
- `AC-4`: Security review confirms tokens cannot be exposed to LLM adapters.

#### Review gate

Demonstrate login, scoped consent, token refresh, revocation, and a blocked
cross-tenant attempt. Do not start Specification 5.2 until accepted.

---

### Specification 5.2 — Scoped Microsoft 365 read context

Status: `draft`

Depends on: Specification 5.1 accepted

#### Outcome

Donna can use calendar and employee-selected email, Teams, OneDrive, and
SharePoint content as source-linked context without continuously copying the
employee's entire Microsoft 365 history.

#### Scope

- Add a `ContextSource` port and Microsoft 365 adapter.
- Fetch calendar context for the relevant time window.
- Fetch only resources explicitly selected by the employee or directly linked
  from the active workflow.
- Normalize Graph/MCP responses into minimal `ContextSnippet` records with
  source URI/ID, permission scope, owner, timestamp, excerpt, and TTL.
- Apply source ACL filtering before memory/retrieval ranking.
- Keep snippets in a TTL cache; promotion to durable memory is a separate
  visible proposal.
- Feed relevant snippets through the trusted `ContextAssembler` boundary.

#### Non-goals

- Full mailbox/Teams/drive synchronization, hidden background surveillance, or
  external writes.

#### Expected repository changes

- `packages/integrations-m365/`
- [`packages/core/src/ports.ts`](../../../packages/core/src/ports.ts)
- memory context assembly and retrieval adapters
- M365 consented integration fixtures

#### Requirements

- `FR-1`: Every snippet records its Microsoft source and access basis.
- `FR-2`: Selection and TTL behavior are visible to the employee.
- `FR-3`: Source deletion or permission loss removes the snippet from context.
- `FR-4`: Calendar, mail, Teams, and file failures degrade independently.
- `SR-1`: Retrieved content is untrusted data and cannot change system policy
  or request tools.
- `SR-2`: ACL and tenant/user checks occur before content reaches a model.
- `SR-3`: Minimize excerpts and never send full documents when smaller context
  is sufficient.
- `SR-4`: No PII is sent to analytics or telemetry.

#### Acceptance criteria

- `AC-1`: A voice note linked to a selected meeting receives relevant attendee
  and agenda context.
- `AC-2`: An unselected or unauthorized message/file is never retrieved.
- `AC-3`: Revocation, deletion, TTL, prompt-injection, and partial-failure tests
  pass.
- `AC-4`: Every M365-grounded thought or answer cites the originating resource.

#### Review gate

Demonstrate one calendar context case and one explicitly selected artifact,
followed by revocation. Do not start Specification 5.3 until accepted.

---

### Specification 5.3 — OneNote capability and destination adapter

Status: `draft`

Depends on: Specification 5.2 accepted

#### Outcome

Approved organized content can be previewed and idempotently published to the
employee's chosen OneNote destination with provenance and write-back state.

#### Scope

- First perform a capability spike against the actual Microsoft integration.
- Confirm notebook/section/page discovery, page creation, content append/update,
  supported HTML, identity/scopes, and stable returned links.
- The currently connected Microsoft 365 MCP exposes no OneNote page operation;
  either add that capability or approve a delegated Microsoft Graph adapter.
- Define a generic `Destination` preview/commit contract.
- Render bucket pages with item IDs, source timestamps, task status, and
  update markers.
- Use idempotency keys so retries cannot duplicate pages or entries.
- Write destination status/link/error back to Donna's scoped record.

#### Non-goals

- Treating OneNote as Donna's authoritative database or publishing without
  employee approval.

#### Expected repository changes

- `packages/destinations/`
- `packages/integrations-m365/src/onenote.ts`
- [`packages/core/src/ports.ts`](../../../packages/core/src/ports.ts)
- OneNote contract and sandbox integration tests

#### Requirements

- `FR-1`: Preview shows the exact target and rendered changes before commit.
- `FR-2`: Repeating a commit with the same idempotency key creates no duplicate.
- `FR-3`: Donna remains source of truth and records the external link/version.
- `SR-1`: Writes require active delegated consent and explicit approval.
- `SR-2`: Notebook/page selection is constrained to the authenticated user.
- `SR-3`: Untrusted content is encoded safely; scripts and unsafe HTML are
  rejected.
- `SR-4`: OneNote errors are redacted and do not leak page content.

#### Acceptance criteria

- `AC-1`: The capability report proves a supported real page-write path.
- `AC-2`: Preview, approve, create/update, retry, and write-back tests pass.
- `AC-3`: Cross-user target selection and unsafe-content tests fail closed.
- `AC-4`: The product owner inspects the resulting page and source links.

#### Review gate

If no supported OneNote API is available, mark this specification `blocked`;
do not replace it with a file upload labeled as OneNote support. Do not start
Specification 5.4 until the real destination is accepted.

---

### Specification 5.4 — Approval-ready Microsoft action drafts

Status: `draft`

Depends on: Specification 5.3 accepted

#### Outcome

Donna can prepare, but not autonomously execute, typed action drafts for
Outlook, Teams, Planner/To Do, and approved file destinations. These contracts
become inputs to the later agent approval runtime.

#### Scope

- Define typed previews for email draft, Teams message, task creation/update,
  calendar proposal, and file/page publication.
- Validate recipient, target, content, due date, and permissions server-side.
- Store drafts in Donna with source thought IDs and expiration.
- Add sandbox destination adapters or capability reports for each intended
  Microsoft action.
- Do not expose commit methods to LLM prompts; only the later approval service
  can invoke them.

#### Non-goals

- Automatic sends, assignments, calendar changes, or the concurrent agent
  runtime.

#### Expected repository changes

- `packages/destinations/src/microsoft/`
- typed action draft definitions in core
- destination validation and sandbox integration tests

#### Requirements

- `FR-1`: Every draft is source-linked, scoped, typed, and previewable.
- `FR-2`: Draft expiry and cancellation are deterministic.
- `FR-3`: Invalid recipients/targets/content are rejected before approval.
- `SR-1`: Creating a draft never performs the external mutation.
- `SR-2`: No model has direct access to a commit credential or method.
- `SR-3`: Sensitive content has restrictive caching and logging behavior.

#### Acceptance criteria

- `AC-1`: Each supported draft type has schema, preview, validation, and
  cancellation tests.
- `AC-2`: A prompt-injection fixture cannot turn a draft into a committed
  action.
- `AC-3`: The product owner can inspect drafts and their exact source context.

#### Review gate

Demonstrate each supported draft without external side effects. Phase 5
completes only after all four specifications are accepted.

## Phase exit gate

- Entra identity and delegated consent establish scope.
- Microsoft context is selected, minimal, permission-aware, and source-linked.
- OneNote has a real tested adapter or remains an explicit blocker.
- Microsoft actions exist only as validated drafts for the future approval
  service.
