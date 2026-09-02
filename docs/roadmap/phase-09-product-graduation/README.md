# Phase 9 — Product graduation and public readiness

Status: `not-started`

## Objective

Turn the proven CLI and backend into employee-facing mobile/PWA and Teams
experiences, then separate all company-only dependencies and pass security,
privacy, reliability, and operational gates before any public launch.

## Entry conditions

- Phases 1–8 are accepted.
- The CLI quality gate has passed.
- Agent drafts, approvals, and manager blueprints can be exercised safely from
  an internal review surface.
- Public provider contracts and data-processing boundaries are decided before
  public infrastructure work begins.

## Specification order

### Specification 9.1 — Mobile/PWA voice, memory, and retrieval experience

Status: `draft`

Depends on: Phase 8 accepted and CLI graduation accepted

#### Outcome

An employee can securely capture voice, see live processing state, review
organized output, search memory, correct Donna, and control personal data from
a mobile-friendly product rather than a terminal.

#### Scope

- Build authenticated mobile/PWA capture with resilient upload and clear
  recording state.
- Show transcript/provenance, dynamic buckets, low-confidence review, memory
  proposals, corrections, retrieval, and source links.
- Expose source consent, emotional-context setting, retention status, export,
  disconnect, and deletion controls.
- Support interruption, retry, offline-safe capture queueing, and duplicate
  prevention.
- Keep sensitive content out of notification previews and client logs.
- Add accessibility and keyboard/screen-reader support appropriate to the
  chosen web/mobile stack.

#### Non-goals

- Public self-service signup, background microphone recording, or client-side
  authorization decisions.

#### Expected repository changes

- a new approved app under `apps/`
- authenticated service/API boundary
- shared typed client contracts
- end-to-end and accessibility test suites

#### Requirements

- `FR-1`: Capture state and failures are visible and retry-safe.
- `FR-2`: Review/correction controls produce the same domain events as the CLI.
- `FR-3`: Data controls are available without contacting an administrator.
- `FR-4`: The client clearly labels evidence, inference, draft, and completed
  action states.
- `SR-1`: Authorization and resource ownership are enforced server-side.
- `SR-2`: Audio and personal data use secure transport and restrictive caching.
- `SR-3`: Tokens use secure platform storage and never appear in URLs/logs.
- `SR-4`: Recording requires a visible, affirmative user action.

#### Acceptance criteria

- `AC-1`: Capture → organize → review → correct → retrieve works end to end.
- `AC-2`: Offline/retry tests create no duplicate capture or thought.
- `AC-3`: Cross-user navigation/API tests fail closed.
- `AC-4`: Accessibility, retention, consent, export, and deletion flows pass
  product-owner review.

#### Review gate

Demonstrate the complete experience on target mobile and desktop browsers with
normal, failed, offline, and deletion scenarios. Do not start Specification
9.2 until accepted.

---

### Specification 9.2 — Teams review, retrieval, and approval cards

Status: `draft`

Depends on: Specification 9.1 accepted

#### Outcome

Employees can privately receive low-confidence reviews, retrieval results,
agent drafts, blueprint reviews, and accept/reject controls in Teams without
giving Teams messages authority to bypass Donna's server-side policy.

#### Scope

- Add personal/bot conversation surfaces and Adaptive Cards for review,
  correction, action approval, and blueprint approval.
- Bind every card action to authenticated identity, current resource version,
  expiry, and one-time decision semantics.
- Show target, source evidence, exact side effect, and changed fields before
  approval.
- Route all decisions through the central approval service.
- Update/expire cards after decisions and provide deep links to Donna for full
  sensitive context.

#### Non-goals

- Posting private memory into public channels, making Teams the source of
  truth, or approving via unverified message text.

#### Expected repository changes

- Teams app/bot package under `apps/`
- card schemas and signed action handlers
- notification adapter behind core ports
- Teams sandbox and security tests

#### Requirements

- `FR-1`: Card actions are version-bound, expiring, and idempotent.
- `FR-2`: Stale cards show current state and cannot repeat decisions.
- `FR-3`: Full sensitive content remains behind authenticated deep links when
  unnecessary in Teams.
- `SR-1`: Sender identity and conversation scope are verified server-side.
- `SR-2`: Channel/group delivery requires explicit user choice and content
  minimization.
- `SR-3`: Card payloads contain no secrets, raw tokens, or hidden authority.

#### Acceptance criteria

- `AC-1`: Review, accept, reject, expire, stale, and duplicate-click flows pass.
- `AC-2`: Forged payload and wrong-user tests fail closed.
- `AC-3`: No private card appears in an unintended chat/channel.
- `AC-4`: The product owner can trace a Teams decision through the immutable
  audit record and destination result.

#### Review gate

Demonstrate private review and approval in the company Teams sandbox, including
stale and forged interactions. Do not start Specification 9.3 until accepted.

---

### Specification 9.3 — Separate public provider and integration boundary

Status: `draft`

Depends on: Specification 9.2 accepted

#### Outcome

Donna can run outside the company environment without using company
TrueFoundry credentials, company MCPs, company Microsoft subscriptions, or
internal-only data.

#### Scope

- Implement separately contracted STT, organizer, embedding, and optional TTS
  adapters behind existing ports.
- Add customer-authorized Microsoft/Asana integrations with separate app
  registrations and secret stores.
- Maintain config-only model/provider selection and compare replacements
  against accepted eval baselines.
- Enforce environment separation across accounts, networks, data stores,
  telemetry, secrets, and deployment pipelines.
- Add migration/export paths that never copy internal pilot data by default.
- Define regional data, retention, subprocessors, and customer tenant
  configuration.

#### Non-goals

- Reusing company gateway/API keys, copying company pilot data into public
  evals, or hard-coding a public provider.

#### Expected repository changes

- new provider adapters under `packages/providers/`
- public environment/deployment configuration
- separate integration applications and secrets
- provider parity and failover evals

#### Requirements

- `FR-1`: Public runtime starts only with public-owned credentials.
- `FR-2`: Provider swaps require no pipeline/business-logic changes.
- `FR-3`: Internal and public telemetry/accounts cannot mix.
- `SR-1`: Startup fails closed when environment/provider identity is
  inconsistent.
- `SR-2`: TLS, secret rotation, egress allowlists, rate limits, and cost limits
  are enforced.
- `SR-3`: No internal recording, transcript, memory, or credential is included
  in public artifacts.

#### Acceptance criteria

- `AC-1`: An automated check proves no company credential/domain/dependency is
  required by the public runtime.
- `AC-2`: Replacement providers meet accepted quality/provenance thresholds.
- `AC-3`: Environment-isolation and secret-rotation drills pass.
- `AC-4`: Public integrations use customer-authorized identities and scopes.

#### Review gate

Demonstrate a complete isolated staging run with public-owned providers and
integration registrations. Do not start Specification 9.4 until accepted.

---

### Specification 9.4 — Public security, reliability, and launch gate

Status: `draft`

Depends on: Specification 9.3 accepted

#### Outcome

A formal evidence package determines whether Donna may accept public customer
data and actions.

#### Scope

- Complete threat modeling for voice, memory, retrieval, M365, MCP/tool,
  approval, agent, manager blueprint, and client surfaces.
- Run multi-tenant penetration tests and authorization/property-based tests.
- Verify retention, export, deletion, backup erasure, consent, and audit
  controls.
- Add SLOs, health checks, alerting, incident response, disaster recovery,
  dependency failover, quotas, abuse controls, and cost budgets.
- Review legal/privacy/security obligations and customer-facing documentation.
- Run staged load, chaos, restore, key rotation, and provider outage exercises.
- Produce an explicit launch decision with named residual risks.

#### Non-goals

- Launching automatically when CI is green or claiming compliance without the
  required independent evidence.

#### Expected repository changes

- production runbooks and threat models
- security/reliability test suites
- deployment health and operational configuration
- launch evidence and decision records

#### Requirements

- `FR-1`: Critical workflows have defined SLOs and graceful failure states.
- `FR-2`: Incident response can suspend agents/destinations without losing
  memory access.
- `FR-3`: Backups and restores preserve tenant isolation and deletion duties.
- `SR-1`: No critical/high security finding remains unmitigated.
- `SR-2`: Every external action remains approval-gated and idempotent under
  retries/outages.
- `SR-3`: Tenant isolation is tested at API, database, cache, queue, object
  storage, retrieval index, audit, and agent layers.

#### Acceptance criteria

- `AC-1`: Security, privacy, load, restore, failover, and deletion evidence is
  complete and reviewed.
- `AC-2`: Multi-tenant tests find zero cross-tenant access.
- `AC-3`: Disaster and provider-outage drills meet accepted recovery targets.
- `AC-4`: Product, security, privacy/legal, and operations owners explicitly
  accept launch or record a blocked decision.

#### Review gate

Public launch remains blocked until every accepted owner signs the evidence
package. Phase 9 and the roadmap complete only after explicit acceptance.

## Phase exit gate

- Employees have secure mobile/PWA and Teams experiences.
- Public runtime is fully separated from company-only infrastructure.
- Security, privacy, reliability, and operational evidence supports launch.
- The product owner records the final launch decision.
