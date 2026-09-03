# Phase 5 — Microsoft 365 grounding and destinations

Status: `in-progress`

> Product-owner directive (2026-09-03): the REVISED Specifications 5.1, 5.2,
> 5.3, and 5.4 are approved and are executed in one ordered run, one
> specification at a time, on branch `cursor/import-mvp-scaffold-b430`. Each
> specification still moves approved → in-progress → in-review with its own
> evidence; the per-specification acceptance gate between specifications is
> overridden for this phase only (as was done for Phases 1–4). Phases 1–4
> are accepted; their consent, context-assembly, retrieval, and storage
> contracts are the entry conditions for this phase.

> **Approved revision (product owner, 2026-09-03):** this phase runs on the
> **TrueFoundry-managed Microsoft 365 MCP**, not a Donna-registered Entra
> application. The product owner cannot obtain app-registration permission
> (intern account), and the managed MCP makes it unnecessary: TrueFoundry owns
> the Entra app, OAuth configuration, token storage, and refresh; each
> employee authorizes their own Microsoft account via Connect Now. Verified
> live 2026-09-03 against
> `https://eu.gateway.truefoundry.ai/payoneer-corp/mcp/microsoft-365/server`:
> direct MCP initialize (HTTP 200, `m365-mcp-server`), tools/list (48 tools:
> 25 read, 23 write/draft), and an authenticated `list_calendars` call all
> succeed with the existing TrueFoundry API key. **OneNote is deferred** — the
> managed MCP exposes no OneNote page API; the knowledge destination is
> **OneDrive Markdown** in a dedicated `Donna` folder until TrueFoundry adds
> page tools. Donna's own desktop UI (Phase 9) remains the primary experience.

## Objective

Ground Donna in explicitly selected corporate context while preserving source
permissions, tenant/user isolation, consent, and the boundary between retrieved
content and trusted instructions.

## Entry conditions

- Phases 1–4 are accepted.
- Identity, memory, retrieval, deletion, and evaluation contracts exist.
- The TrueFoundry-managed M365 MCP is connected and reachable with the
  existing gateway credential (verified 2026-09-03).

## Specification order

### Specification 5.1 — Managed-MCP identity, consent, and connection boundary

Status: `in-review` (approved by product owner 2026-09-03)

Depends on: Phase 4 accepted

> Implementation evidence (2026-09-03, implementation worker):
>
> - **McpClient transport** (`packages/integrations-m365/src/mcp-client.ts`):
>   JSON-RPC 2.0 over HTTP POST to the managed endpoint, `Accept:
>   application/json, text/event-stream`, event-stream `data: ` parsing
>   (plain-JSON fallback), initialize → tools/list → tools/call, Bearer
>   auth from the existing TrueFoundry credential only. Endpoint pinning
>   (SR-2): https mandatory, URL-embedded credentials rejected, host
>   extracted from the configured endpoint (`DONNA_M365_MCP_URL` override,
>   default the verified 2026-09-03 endpoint). Injectable fetch; network
>   errors are re-thrown without the underlying message (it can embed the
>   URL). `M365McpError` carries stage + HTTP status + JSON-RPC code only.
> - **Client-side tool allowlist** (`src/tools.ts`, SR-3, AC-3): the 48
>   live tools are classified 25 read / 23 write-draft; unrecognized tools
>   are `unknown` and denied in every mode (a server-side addition can
>   never widen Donna's reach). `m365ReadOnlyClient` (context layer)
>   throws `M365ToolDeniedError` BEFORE any network I/O — tested: zero
>   fetch calls recorded for send_email/create_draft/post_channel_message/
>   share_file/unknown-tool attempts. `m365ApprovalPathClient` takes an
>   explicit per-tool allowlist for Specification 5.4.
> - **Core boundary** (`packages/core/src/types.ts`, `ports.ts`):
>   `M365ReadSourceType`, canonical consent purposes
>   (`m365.read.calendar|mail|teams|files`, `m365.destination.onedrive`),
>   `ContextSnippet`, `McpConnection` and `ContextSource` ports; the port
>   docs pin the identity model (managed MCP owns Entra/OAuth/storage/
>   refresh; pilot runs under the connector owner's Microsoft identity).
> - **Connection health** (`src/connection.ts`, FR-3): `checkM365Connection`
>   reports endpoint-config → gateway-auth → mcp-initialize →
>   tool-discovery → read-probe, failing closed at the first broken stage
>   (later stages "skipped"). The read probe (`list_calendars`) discards
>   content and keeps only an item count. Env inspection classifies
>   unset/placeholder/configured without exposing values.
> - **Consent + disconnect** (FR-2, AC-2): `requireM365Consent` fails
>   closed per scope against the existing append-only ConsentStore;
>   `disconnectM365` revokes every active `m365.*` grant and purges the
>   scoped cache partition (`data/m365/<tenant>/<user>/`, path-traversal
>   guarded), idempotently; consent history is preserved (grant + revoke
>   records both persist).
> - **CLI** (`apps/cli/src/main.ts`): `m365 status`, `m365 connect-info`
>   (endpoint host, identity note, per-purpose consent state),
>   `m365 disconnect`.
> - **Live verification (2026-09-03, real managed MCP):** `m365 status` →
>   all 5 stages ok; initialize 200 (`m365-mcp-server`); tools/list 48
>   (25 read / 23 write / 0 unknown); read probe `list_calendars` ok,
>   3 items, content discarded. Consent grant → connect-info active →
>   disconnect revoked 2 grants → second disconnect revoked 0
>   (idempotent); consent list shows append-only grant+revoke history.
> - **Tests: 30 new (369 total green with Postgres live, typecheck
>   clean).** Coverage: event-stream/plain-JSON/no-data-line parsing,
>   endpoint pinning rejections, 401→gateway-auth mapping, non-auth stage
>   attribution, JSON-RPC code-only errors, network-failure redaction,
>   allowlist denial before I/O (incl. unknown tools, approval-path
>   scoping), happy-path/failing health reports, missing-credential and
>   bad-endpoint short-circuits (zero HTTP requests), report redaction
>   sweep (AC-4 — scripted 403 body echoing the key + a trace id never
>   appears in the serialized report), consent grant/deny/revoke,
>   cross-scope denial, disconnect revoke+purge+idempotency, partition-ID
>   traversal guards.
> - **Known limitations:** the probe's item count requires parsing the
>   tool result shape; unparseable shapes report ok without a count.
>   Stage attribution of downstream Microsoft authorization failures is
>   heuristic (tool-error results advise re-running Connect Now without
>   echoing detail).
>
> Awaiting product-owner examination for acceptance.

> Revised 2026-09-03: replaces the Donna-registered Entra application with
> the TrueFoundry-managed M365 MCP. Donna never sees Microsoft tokens; the
> platform owns OAuth, storage, and refresh.

#### Outcome

Every Microsoft 365 read or destination request runs through a governed MCP
connection bound to the authenticated employee's own Microsoft authorization,
with Donna-side source consent records and a fail-closed connection boundary.

#### Scope

- Add an `McpClient` transport in `packages/integrations-m365/` speaking
  JSON-RPC over HTTP to the TrueFoundry MCP endpoint (initialize →
  tools/list → tools/call), authenticated with the existing gateway
  credential from runtime secrets.
- Derive the Donna tenant/user scope from the authenticated CLI/session
  context as today; the MCP's per-user Microsoft authorization is the
  downstream identity. Document that the pilot runs under the connector
  owner's Microsoft identity until TrueFoundry per-user OAuth is exercised
  per volunteer.
- Define Donna-side source-level consent records (calendar, selected mail,
  selected Teams threads, OneDrive/SharePoint files, destinations) in the
  existing `ConsentStore` — independent of Microsoft-side OAuth consent.
- Connection health command: initialize, tool discovery, and one read-only
  probe, reporting stage-level failures without token or content leakage.
- Support disconnect: Donna stops calling the MCP and purges cached source
  snippets.

#### Non-goals

- Donna-owned Entra app registration, Microsoft token handling, blanket
  tenant-wide ingestion, or employer browsing of personal Donna memory.

#### Expected repository changes

- `packages/integrations-m365/` (new: MCP client + connection boundary)
- [`packages/core/src/ports.ts`](../../../packages/core/src/ports.ts)
  (`ContextSource` / connection ports)
- [`apps/cli/src/main.ts`](../../../apps/cli/src/main.ts) (`m365 status`,
  `m365 connect-info`, `m365 disconnect`)

#### Requirements

- `FR-1`: MCP calls happen only inside an established Donna tenant/user scope.
- `FR-2`: Donna-side consent records name resource type, time, and revocation
  state; revocation stops new reads and invalidates cached snippets.
- `FR-3`: Connection failures are reported by stage (gateway auth, MCP
  initialize, downstream Microsoft authorization) with redacted detail.
- `SR-1`: Gateway credentials and MCP session identifiers never enter logs,
  model prompts, or source control.
- `SR-2`: TLS validation is mandatory; the endpoint is pinned to the
  configured gateway host.
- `SR-3`: Tool allowlisting is enforced client-side: the context layer may
  invoke read tools only; write/draft tools are reachable solely through the
  Phase 5.4 approval path.
- `SR-4`: MCP tool results are untrusted content — they can never alter
  system policy or grant new capabilities.

#### Acceptance criteria

- `AC-1`: `m365 status` succeeds end-to-end with the real managed MCP
  (initialize, tools/list, one read probe) and fails closed with actionable
  stage-level errors when credentials/authorization are missing.
- `AC-2`: Donna-side consent revoke prevents further MCP reads and purges
  cached snippets.
- `AC-3`: A context-layer attempt to call a write/draft tool is denied by the
  client-side allowlist.
- `AC-4`: No credential, token, or Microsoft content appears in logs or
  telemetry (verified by test).

#### Review gate

Demonstrate `m365 status` live, consent grant/revoke behavior, and a blocked
write-tool attempt from the context layer. Do not start Specification 5.2
until accepted.

---

### Specification 5.2 — Scoped Microsoft 365 read context

Status: `in-review` (approved by product owner 2026-09-03)

Depends on: Specification 5.1 accepted

> Implementation evidence (2026-09-03, implementation worker):
>
> - **ContextSource adapter** (`packages/integrations-m365/src/context-source.ts`):
>   `M365ContextSource` implements the core `ContextSource` and
>   `ExternalContextCollector` ports over the read-only MCP connection.
>   Calendar context comes from a consent-gated `list_events` call
>   filtered to the capture window client-side (the managed MCP exposes
>   no window parameters — verified in its inputSchema; defaults −4h/+12h,
>   top 25 pre-filter). Selected resources fetch by ID via the selection's
>   recorded fetch plan (get_email / get_event / get_file / get_item /
>   get_chat_messages / get_channel_messages). Per-selection and
>   per-calendar failure domains degrade to machine-readable tokens
>   (FR-4).
> - **Normalization** (`src/snippets.ts`): Graph-shaped payloads → minimal
>   `ContextSnippet` records (deterministic ID `m365-<type>-<hash>`,
>   source URI/ID, owner hint, tool, consent purpose, ISO source
>   timestamp, fetched/expires). Excerpts capped at 280 chars (SR-3);
>   Graph no-zone dateTimes re-parsed to canonical ISO so window
>   comparisons are reliable; HTML stripped from Teams bodies.
> - **Selection registry** (`src/selections.ts`): scoped
>   `selections.json`; selection requires the matching active Donna-side
>   consent at selection time; composite IDs for teams-channel
>   (`team/channel`) and sharepoint (`site/list/item`) validated;
>   re-selection is idempotent.
> - **TTL cache** (`src/snippet-cache.ts`): scoped per-snippet files
>   (15-minute default TTL) + per-thread selection markers; cache-first
>   reads; embedded scope re-verified on read (a planted cross-scope
>   entry is evicted, never served); expiry evicts; source deletion
>   (isError) evicts on next fetch (FR-3). `m365 disconnect` purges the
>   whole partition.
> - **Assembler trust boundary** (`packages/memory/src/context-assembler.ts`):
>   optional `ExternalContextCollector` dep; snippets render only as
>   `untrusted-retrieved` `m365-snippet` elements with attribution
>   (`[M365 <type> <snippet-id>] …`), scope- and TTL-re-checked before
>   inclusion, capped by the new `max_external_snippets` budget (default
>   6, set in models.config.yaml — never code). Degraded tokens merge
>   into the packet's degradedReasons. The organizer prompt's existing
>   trust-separated sections carry them as data (organize-prompt v2
>   unchanged).
> - **Pipeline** (`packages/pipeline/src/run.ts`): `capturedAt` anchors
>   the calendar window in the assemble query.
> - **CLI**: `m365 select <email|event|teams-chat|teams-channel|file|
>   sharepoint> <id>` (consent-gated), `m365 selected` (shows consent
>   state), `m365 unselect <id>`, `m365 snippets` (IDs, tool, consent,
>   TTL, excerpt length — never content). The capture pipeline wires the
>   source only when MCP credentials are configured.
> - **Live verification (2026-09-03, real managed MCP, scratch user
>   `m365-spec52-probe`):** granted `m365.read.calendar` + `m365.read.mail`;
>   selected one real calendar event and one real email (IDs only). A
>   generated voice note (espeak-ng) captured through the live loop:
>   context packet carried exactly the 2 selected M365 snippet IDs
>   (`m365-email-…`, `m365-calendar-event-…`) — AC-1. `m365 snippets`
>   showed both cached with 15-min TTLs. After `consent revoke
>   m365.read.mail`, a second capture's packet excluded the email snippet
>   and reported degraded (mail selection not consented); `m365 selected`
>   showed "CONSENT REVOKED — not read" — AC-2/AC-3. No Microsoft content
>   was printed in any evidence (IDs/counts/stages only).
> - **Tests: 19 new (388 total green with Postgres live, typecheck
>   clean).** Coverage: per-type normalization (fields, capping, HTML
>   strip, ISO normalization, fail-closed on unparseable), consent denial
>   with zero MCP calls, unselected-never-fetched (AC-2), window
>   filtering, TTL cache hit/refetch, revocation cache-bypass (AC-3),
>   source-deletion eviction, independent degradation (FR-4),
>   prompt-injection confinement (injected excerpt stays inert data; no
>   consent/capability change), cross-scope cache refusal (SR-2),
>   malformed composite IDs; assembler: untrusted-section rendering with
>   attribution (AC-4), cross-scope/expired drop, budget cap, degraded
>   merge, injection-invariance.
> - **Known limitations:** calendar context refetches the top-N event list
>   per capture (window filter is client-side — the MCP has no window
>   parameters); the per-event snippet cache dedupes storage, not the
>   list call. Teams selection is thread-level (chat/channel), not
>   single-message — the managed MCP exposes no get-message tool.
>
> Awaiting product-owner examination for acceptance.

#### Outcome

Donna can use calendar and employee-selected email, Teams, OneDrive, and
SharePoint content as source-linked context without continuously copying the
employee's entire Microsoft 365 history.

#### Scope

- Add a `ContextSource` port and Microsoft 365 adapter built on the managed
  M365 MCP from Specification 5.1 (no direct Graph calls).
- Fetch calendar context for the relevant time window.
- Fetch only resources explicitly selected by the employee or directly linked
  from the active workflow.
- Normalize MCP tool responses into minimal `ContextSnippet` records with
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

### Specification 5.3 — OneDrive Markdown destination adapter (OneNote deferred)

Status: `in-review` (approved by product owner 2026-09-03)

Depends on: Specification 5.2 accepted

> Implementation evidence (2026-09-03, implementation worker):
>
> - **Destination contract** (`packages/core/src/ports.ts`): generic
>   `Destination` preview/commit port — every external write is preview →
>   explicit approval → commit; `DestinationPreview` carries the exact
>   target, exact content, SHA-256 hash, and no-op detection;
>   `DestinationCommit` carries item ID, link, hash (FR-3 write-back).
> - **Renderer** (`packages/destinations/src/markdown.ts`, new
>   `@donna/destinations` package): `renderBucketMarkdown` is a pure
>   function of bucket state — items sorted by thought ID, no render
>   timestamps, byte-identical re-render (hash-tested, FR-2). Documents
>   carry bucket name, per-item summaries, task status, source capture
>   timestamps/audio windows, and stable Donna item IDs as HTML comments
>   (`<!-- donna:item <id> -->`). All untrusted fields are HTML-escaped
>   and whitespace-collapsed (SR-3). Document names are
>   `<slug>-<bucketIdHash8>.md` — stable and collision-free.
> - **OneDriveMarkdownDestination**
>   (`packages/integrations-m365/src/onedrive-markdown.ts`): ensure-folder
>   lists root first and creates `Donna/` only when missing (verified
>   live: create_folder renames on conflict — a naive ensure would
>   duplicate). Preview downloads and hashes the remote document for true
>   byte-level no-op detection. Commit re-renders live state and refuses
>   stale approvals (`PreviewStaleError`), uploads with
>   overwrite-in-place semantics (verified live: same item ID), and
>   creates an organization-scoped share link whose RESPONSE scope is
>   verified — non-organization fails closed and is never recorded
>   (AC-4). Write-back state + pending-preview records live under the
>   scoped `data/m365/<tenant>/<user>/destinations/` partition (purged by
>   `m365 disconnect`). MCP errors surface as redacted stage tokens
>   (SR-4). The adapter runs on an approval-path MCP connection
>   allowlisted to exactly {list_files, get_file, download_file,
>   create_folder, upload_file, share_file} (SR-3 of 5.1).
> - **CLI**: `donna publish <bucket>` (preview + pending record; prior
>   publication state shown; `--show-content` prints the render),
>   `donna publish <bucket> --approve` (commits EXACTLY the pending
>   preview; no pending preview → refusal). Target folder is pinned;
>   there is no cross-scope target selection API (SR-2, tested).
> - **Live verification (2026-09-03, real managed MCP + real OneDrive,
>   scratch user `m365-spec52-probe`, bucket `Tasks`):** preview
>   (`Donna/tasks-01675030.md`, 3 items, hash fff38f3c…) → approve →
>   published (item 01JGFRGN6ZODGTF25GRZBZ2LJ3Z3SDKUCJ, organization
>   link) → re-preview detected byte-identical remote → re-approve was a
>   no-op (same item, no upload) → new capture added a 4th item →
>   preview showed hash change → approve overwrote IN PLACE (same item
>   ID, hash 6cb8ff36…). AC-1 complete. AC-2 (product owner opens
>   `Donna/tasks-01675030.md` in OneDrive) is the owner's manual step.
> - **Tests: 15 new (403 total green with Postgres live, typecheck
>   clean).** Renderer: byte-identity, order independence, HTML escaping,
>   task/provenance rendering, name stability/collisions. Adapter:
>   consent fail-closed with zero MCP calls, full publish cycle, no-op
>   re-publish (no second upload), changed re-publish in place, stale
>   preview refusal, non-organization share scope fails closed, redacted
>   tool errors, folder pinning, cross-scope invisibility, folder reuse.
> - **Known limitations:** root listing is read with top=200 before
>   folder creation (a drive root with >200 items and the Donna folder
>   paged out would mis-create; the connector-owner pilot drive has 19).
>   Bucket rename changes the document slug, leaving the old file behind
>   (documented; Donna remains source of truth). Probe-folders created
>   during capability verification were deleted (delete_file) the same
>   day.
>
> Awaiting product-owner examination for acceptance.

> Revised 2026-09-03 (product owner): the managed M365 MCP exposes no OneNote
> page API, so the knowledge destination is OneDrive Markdown in a dedicated
> `Donna` folder. OneNote is an optional future integration pending
> TrueFoundry page tools. Donna's own desktop UI (Phase 9) is the primary
> experience; this destination is an export surface, never the source of
> truth.

#### Outcome

Approved organized content can be previewed and idempotently published as
Markdown documents in the employee's OneDrive `Donna/` folder — one document
per bucket — with provenance and write-back state.

#### Scope

- Define a generic `Destination` preview/commit contract in core.
- Implement `OneDriveMarkdownDestination` on the managed MCP:
  `create_folder` (ensure `Donna/`), `upload_file` (create/overwrite
  per-bucket `.md`), `list_files`/`get_file` for state, `share_file`
  (organization-scoped link only) for the write-back link.
- Render bucket documents with item summaries, task status, source capture
  timestamps, and stable Donna item IDs as HTML comments for idempotent
  re-render.
- Idempotency: document content is a deterministic function of bucket state;
  re-publishing the same state produces the same document (no duplicates,
  no append drift). Overwrite-in-place, never append-copies.
- Write destination status/link/error back to Donna's scoped record.

#### Non-goals

- Claiming OneNote support, treating OneDrive as Donna's authoritative
  database, anonymous sharing links, or publishing without employee approval.

#### Expected repository changes

- `packages/destinations/`
- `packages/integrations-m365/src/onedrive-markdown.ts`
- [`packages/core/src/ports.ts`](../../../packages/core/src/ports.ts)
- destination contract and sandbox integration tests

#### Requirements

- `FR-1`: Preview shows the exact target folder, document name, and rendered
  diff before commit.
- `FR-2`: Re-publishing unchanged state is a byte-identical no-op; republishing
  after changes updates in place; no duplicate files ever.
- `FR-3`: Donna remains source of truth and records the external item ID,
  link, and content hash.
- `SR-1`: Writes require active Donna-side destination consent and explicit
  approval.
- `SR-2`: Folder/file selection is constrained to the authenticated user's
  own drive root `Donna/` folder.
- `SR-3`: Untrusted content is rendered as Markdown with embedded HTML
  escaped; no scripts or active content.
- `SR-4`: MCP errors are redacted and do not leak file content.

#### Acceptance criteria

- `AC-1`: Preview, approve, publish, re-publish (no-op), and changed
  re-publish (in-place update) all pass against the real MCP.
- `AC-2`: The product owner opens the OneDrive `Donna/` folder and inspects a
  rendered bucket document with provenance.
- `AC-3`: Cross-scope target selection and unsafe-content tests fail closed.
- `AC-4`: Share links default to organization scope; anonymous links are
  impossible through this adapter.

#### Review gate

Demonstrate the full preview → approve → publish → idempotent re-publish
cycle live against OneDrive. Do not start Specification 5.4 until accepted.

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
