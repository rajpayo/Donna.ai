# Phase 7 — Bucket-agent swarm

Status: `not-started`

## Objective

Turn selected buckets into independent, durable work queues served by approved
agent templates. Agents may reason and prepare drafts concurrently, while all
external mutations remain idempotent, auditable, and explicitly approved.

## Entry conditions

- Phases 1–6 are accepted.
- The CLI graduation gate has passed.
- Transactional storage, identity, consent, retrieval, M365 drafts, and quality
  evaluation are operational.

## Specification order

### Specification 7.1 — Bucket events, subscriptions, and durable jobs

Status: `draft`

Depends on: Phase 6 accepted

#### Outcome

Persisting an eligible bucket item emits one durable scoped event that can be
matched to approved subscriptions and delivered as retryable jobs without
losing or duplicating work.

#### Scope

- Define `BucketEvent`, `AgentTemplate`, `AgentInstance`,
  `AgentSubscription`, and `AgentJob`.
- Use a transactional outbox so item persistence and event publication cannot
  diverge.
- Match approved templates by stable bucket semantics/configuration, not an
  unconstrained model decision.
- Create independent jobs for each matching agent.
- Add leases, delivery attempts, visibility timeout, cancellation, and dead
  letter state.
- Preserve correlation IDs from capture through agent jobs.

#### Non-goals

- Model reasoning, external actions, or manager-generated templates.

#### Expected repository changes

- `packages/agents/`
- `packages/events/`
- database migrations for outbox, subscriptions, jobs, and leases
- [`packages/pipeline/src/run.ts`](../../../packages/pipeline/src/run.ts)

#### Requirements

- `FR-1`: Event creation is atomic with item placement.
- `FR-2`: Re-publishing an event does not create duplicate logical jobs.
- `FR-3`: One failed agent job does not block jobs for other agents/buckets.
- `FR-4`: Subscriptions are versioned and can be paused/revoked.
- `SR-1`: Events and jobs carry immutable tenant/user scope.
- `SR-2`: Workers cannot widen scope from payload text.
- `SR-3`: Bucket names/content cannot activate unapproved tools or templates.

#### Acceptance criteria

- `AC-1`: Crash/retry tests lose no events and create no duplicate logical job.
- `AC-2`: Multiple subscriptions fan out independently.
- `AC-3`: Revoked subscriptions receive no new jobs.
- `AC-4`: Cross-tenant subscription and forged-event tests fail closed.

#### Review gate

Demonstrate atomic publication, fan-out, worker failure, retry, pause, and dead
letter behavior without running an LLM or external destination. Do not start
Specification 7.2 until accepted.

---

### Specification 7.2 — Approval, idempotency, and immutable audit

Status: `draft`

Depends on: Specification 7.1 accepted

#### Outcome

Agents can create typed action drafts and previews, but only an authorized
accept decision can invoke an external destination. Retries cannot duplicate
the action, and every transition is auditable.

#### Scope

- Define `ActionDraft`, `ActionPreview`, `ApprovalRequest`,
  `ApprovalDecision`, `SideEffectRecord`, and `AuditEntry`.
- Use an explicit state machine:
  `draft → validated → awaiting-approval → approved/rejected/expired →
  committing → completed/failed`.
- Compute stable idempotency keys from tenant, user, source item, agent
  template/version, action type, and logical target.
- Bind approval to the exact preview hash so changed payloads require new
  approval.
- Store append-only audit events and external system references.
- Separate approval authority for owner and affected assignee when required.

#### Non-goals

- Automatic low-risk writes or emotion-based approval decisions.

#### Expected repository changes

- `packages/approvals/`
- `packages/destinations/`
- database migrations for drafts, decisions, side effects, and audit
- notification interfaces for later Teams/desktop surfaces

#### Requirements

- `FR-1`: Models and agent code can create drafts but cannot call commit
  credentials directly.
- `FR-2`: Reject/expiry prevents commit permanently for that draft version.
- `FR-3`: Repeated commit/retry returns the original result.
- `FR-4`: Audit includes actor, state, source, versions, before/after hashes,
  timestamps, and correlation ID.
- `SR-1`: Approval identity and tenant/user scope are server-verified.
- `SR-2`: Preview payloads redact secrets and minimize sensitive data.
- `SR-3`: Constant-time checks protect signed approval tokens where used.
- `SR-4`: Audit data is append-only and tenant-isolated.

#### Acceptance criteria

- `AC-1`: Unapproved, rejected, expired, modified, and forged drafts cannot
  commit.
- `AC-2`: Retrying a successful action produces zero duplicate side effects.
- `AC-3`: The entire source → draft → decision → destination → write-back chain
  is reconstructable without model memory.
- `AC-4`: Owner/assignee approval policies are covered by tests.

#### Review gate

Demonstrate preview tampering rejection, accept/reject/expiry, a simulated
destination crash, idempotent replay, and audit reconstruction. Do not start
Specification 7.3 until accepted.

---

### Specification 7.3 — Concurrent agent runtime and failure isolation

Status: `draft`

Depends on: Specification 7.2 accepted

#### Outcome

Approved agent instances independently read their scoped inputs, plan within
budgets, invoke allowlisted read/draft tools, and produce action drafts under
bounded concurrency and observable failure handling.

#### Scope

- Add a worker runtime with per-job model/tool/time/token/cost budgets.
- Build context from the subscribed bucket item, approved memory, scoped
  retrieval, and allowed M365 sources.
- Use a tool broker that enforces per-template allowlists and schemas outside
  the model.
- Run unrelated jobs concurrently; serialize only conflicting state or approved
  side effects.
- Add retry classes, backoff, circuit breakers, cancellation, dead letters, and
  human escalation.
- Record non-content metrics and trace IDs without chain-of-thought storage.

#### Non-goals

- Manager-generated agents, arbitrary code execution, shell access, or
  unrestricted MCP discovery.

#### Expected repository changes

- `packages/agents/src/runtime/`
- `packages/agents/src/tool-broker/`
- worker application under `apps/`
- [`models.config.yaml`](../../../models.config.yaml) for agent model lanes and
  budgets

#### Requirements

- `FR-1`: An agent sees only the item, context, memory, and tools allowed by its
  instance policy.
- `FR-2`: Tool arguments and outputs are schema-validated and size-limited.
- `FR-3`: One timeout/failure does not delay unrelated jobs.
- `FR-4`: Budget exhaustion stops safely and creates a visible failure/review.
- `SR-1`: Voice, email, Teams, file, memory, and tool output are all untrusted
  prompt content.
- `SR-2`: No runtime supports `eval`, arbitrary shell, raw database, or raw
  credential access.
- `SR-3`: SSRF-sensitive tools use host allowlists and block private addresses
  unless explicitly required by an internal adapter.
- `SR-4`: Agent scope cannot be changed by generated text.

#### Acceptance criteria

- `AC-1`: Concurrency tests show independent jobs progressing during a blocked
  job.
- `AC-2`: Prompt-injection fixtures cannot add tools, change scope, or bypass
  approval.
- `AC-3`: Timeout, rate limit, transient failure, poison job, cancellation, and
  dead-letter behavior are deterministic.
- `AC-4`: Cost/token/concurrency limits are enforced under load.

#### Review gate

Demonstrate concurrent draft generation with one injected failure and one
prompt-injection case. No real external mutation is needed. Do not start
Specification 7.4 until accepted.

---

### Specification 7.4 — Approved common agent template library

Status: `draft`

Depends on: Specification 7.3 accepted

#### Outcome

Donna ships a reviewed initial library of common corporate-worker agents whose
roles, subscriptions, tools, budgets, tests, and approval boundaries are
explicit.

#### Initial templates

- `tasks`: resolve task details and prepare Asana or Planner/To Do drafts.
- `meetings`: prepare briefs, decisions, notes, and follow-up drafts.
- `communications`: prepare Outlook and Teams follow-ups.
- `ideas-research`: cluster ideas, research approved sources, and synthesize
  evidence.
- `knowledge-sync`: preview approved OneNote publication.
- `decisions`: maintain decision context, alternatives, and follow-up review.
- `people-relationships`: prepare private relationship context and follow-ups
  without employer profiling.
- `projects`: connect tasks, decisions, meetings, risks, and status drafts.
- `risks-blockers`: surface unresolved blockers and prepare escalation drafts.
- `personal-routines`: handle user-approved recurring work patterns.

#### Scope

- Store templates as declarative, versioned configuration.
- Define semantic subscription rules, required evidence, tool allowlists,
  budgets, stop conditions, output schemas, approval policy, and eval suite.
- Implement templates incrementally within this specification's review cycle;
  each template receives an individual evidence subsection before the library
  is accepted.
- Begin with read/draft mode; enable destination commit only through
  Specification 7.2's approval service.

#### Non-goals

- A generic all-powerful agent or automatic activation for every dynamic
  bucket.

#### Expected repository changes

- `packages/agents/templates/`
- template-specific golden datasets and policy fixtures
- approved destination bindings

#### Requirements

- `FR-1`: Every template has one bounded purpose and explicit non-goals.
- `FR-2`: Unmatched content remains organized memory for Phase 8.
- `FR-3`: Template versions are immutable for already-approved actions.
- `SR-1`: Each template receives the minimum required read/draft tools.
- `SR-2`: People/emotion data cannot become performance or employment output.
- `SR-3`: External writes always use the central approval service.

#### Acceptance criteria

- `AC-1`: Every template passes its quality, injection, scope, budget, failure,
  and approval tests.
- `AC-2`: Ambiguous buckets abstain instead of selecting a privileged template.
- `AC-3`: The product owner reviews each template's examples and tool matrix.
- `AC-4`: Replaying any approved action remains idempotent.

#### Review gate

Demonstrate each template in read/draft mode and selected templates through an
approved sandbox destination. Phase 7 completes only after all four
specifications and every included template are accepted.

## Phase exit gate

- Bucket events and jobs are durable and scoped.
- Independent agents run concurrently with bounded resources.
- Approval, idempotency, audit, and failure isolation are proven.
- The initial template library is individually reviewed and accepted.
