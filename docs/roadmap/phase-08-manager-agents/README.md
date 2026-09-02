# Phase 8 — Manager-generated personal agents

Status: `not-started`

## Objective

Implement the “immune system” pattern: an unfamiliar, recurring bucket can
trigger a manager to design a specialized personal agent, but the blueprint is
quarantined, tested, and approved before receiving any tools or work.

## Entry conditions

- Phase 7 is accepted.
- Static templates, tool brokerage, approval, idempotency, audit, job runtime,
  and agent evals are proven.
- The manager has no direct route around those controls.

## Specification order

### Specification 8.1 — Unmatched-bucket trigger and declarative blueprint

Status: `draft`

Depends on: Phase 7 accepted

#### Outcome

Donna detects recurring useful work in an unmatched bucket and produces a
declarative personal-agent proposal describing what an agent could do, without
activating tools, credentials, code, or side effects.

#### Scope

- Define when a bucket is unmatched and when it has enough representative
  accepted items to justify a proposal.
- Add novelty, recurrence, user-correction, and potential-value thresholds.
- Define `AgentBlueprint` with role, owner, source bucket, subscription,
  instructions, non-goals, requested tool capabilities, budgets, output
  schemas, approval policy, tests, stop conditions, and source evidence.
- Generate blueprints in a restricted manager context with read-only access to
  minimum representative items.
- Store new blueprints as `quarantined`.
- Deduplicate similar proposals and rate-limit blueprint creation.

#### Non-goals

- Executable generated code, automatic tool discovery, credential assignment,
  or activation.

#### Expected repository changes

- `packages/agents/src/manager/`
- core blueprint and lifecycle types
- database migrations for personal blueprint state/evidence
- manager-specific datasets and budgets

#### Requirements

- `FR-1`: One-off or low-confidence buckets remain organized memory.
- `FR-2`: A blueprint explains its purpose and evidence in user-readable terms.
- `FR-3`: Similar buckets reuse or revise an existing personal proposal.
- `FR-4`: The output is validated declarative data only.
- `SR-1`: The manager receives no destination commit methods or credentials.
- `SR-2`: Source content cannot inject tools, scopes, or policy exceptions.
- `SR-3`: Blueprints are permanently bound to owner tenant/user unless
  separately promoted under Specification 8.4.

#### Acceptance criteria

- `AC-1`: Recurrent unmatched fixtures create one useful quarantined proposal.
- `AC-2`: One-off, malicious, duplicate, and cross-tenant fixtures create no
  active agent.
- `AC-3`: Generated output outside the blueprint schema is rejected.
- `AC-4`: The product owner can trace every blueprint field to evidence or
  policy.

#### Review gate

Demonstrate one useful proposal, one abstention, one deduplication, and one
injection rejection. Do not start Specification 8.2 until accepted.

---

### Specification 8.2 — Automated blueprint policy and security checks

Status: `draft`

Depends on: Specification 8.1 accepted

#### Outcome

Every generated blueprint receives deterministic and adversarial checks before
it can be shown as eligible for human approval.

#### Scope

- Validate schema, ownership, subscription scope, tool capability class,
  least privilege, budgets, stop conditions, output schema, and approval
  policy.
- Reject executable code, raw URLs outside allowlists, credential requests,
  unrestricted tools, shell/database access, and policy-changing instructions.
- Scan for private data copied into reusable instructions.
- Compare requested tools to approved capability catalogs.
- Generate synthetic/adversarial test cases from the blueprint and run them in
  a no-tool simulator.
- Produce a signed/versioned policy report with pass, fail, and required edits.

#### Non-goals

- Treating an LLM reviewer as the sole security control or auto-approving a
  passing blueprint.

#### Expected repository changes

- `packages/agents/src/policy/`
- policy-as-code configuration
- blueprint adversarial eval suites
- immutable policy report storage

#### Requirements

- `FR-1`: Deterministic checks run before model-assisted quality review.
- `FR-2`: A failed check keeps the blueprint quarantined.
- `FR-3`: Editing a blueprint invalidates prior reports and approvals.
- `SR-1`: Tool capabilities are allowlisted by stable IDs and versions.
- `SR-2`: Policy evaluation has no external write access.
- `SR-3`: Reports minimize personal source content.
- `SR-4`: Prompt injection and data-exfiltration tests are mandatory.

#### Acceptance criteria

- `AC-1`: Seeded over-permission, cross-scope, code-execution, SSRF,
  exfiltration, and approval-bypass blueprints fail.
- `AC-2`: A valid minimum-privilege blueprint produces a reviewable pass report.
- `AC-3`: Mutation after approval invalidates the approval cryptographically or
  by an equivalent immutable version binding.
- `AC-4`: False-positive/negative policy fixtures are versioned and reviewed.

#### Review gate

The product owner examines failed and passing policy reports and confirms the
tool-capability catalog. Do not start Specification 8.3 until accepted.

---

### Specification 8.3 — Human approval, dry run, and activation

Status: `draft`

Depends on: Specification 8.2 accepted

#### Outcome

A policy-passing blueprint can be reviewed, edited, approved, and exercised in
a read-only dry run before becoming a personal agent instance under the normal
runtime and action-approval controls.

#### Scope

- Present purpose, source bucket, examples, requested data/tools, budgets,
  guardrails, expected drafts, and policy report.
- Require employee approval and tenant-admin approval when company-wide tools
  or sensitive scopes require it.
- Run synthetic cases plus recent owner-approved items through read-only dry
  run mode.
- Compare outputs to blueprint acceptance criteria and show all planned tool
  calls without executing mutations.
- Activate an immutable blueprint version only after dry-run acceptance.
- Support pause, revoke, retire, and rollback to a prior accepted version.

#### Non-goals

- Silent activation or bypassing per-action accept/reject after agent
  activation.

#### Expected repository changes

- manager blueprint review CLI/API
- dry-run runtime mode
- activation/revocation lifecycle services
- blueprint approval audit records

#### Requirements

- `FR-1`: Approval binds to the exact blueprint and policy-report versions.
- `FR-2`: Dry run has no destination commit capability.
- `FR-3`: Activation creates a normal scoped `AgentInstance` and subscription.
- `FR-4`: Pause/revoke stops new jobs and safely resolves in-flight work.
- `SR-1`: Tool grants cannot exceed the approved blueprint.
- `SR-2`: Every later external action still requires accept/reject.
- `SR-3`: Rejected blueprints cannot be activated by replaying stale approval.

#### Acceptance criteria

- `AC-1`: Edit, stale approval, rejected dry run, revoked tool, and replay tests
  fail closed.
- `AC-2`: An accepted blueprint activates only the shown tools and scope.
- `AC-3`: Pause/revoke prevents new processing without corrupting audit state.
- `AC-4`: The product owner accepts the dry-run output before any live job.

#### Review gate

Demonstrate the complete proposal → policy → review → dry run → activate →
pause/revoke lifecycle. Do not start Specification 8.4 until accepted.

---

### Specification 8.4 — Personal reuse and reviewed tenant promotion

Status: `draft`

Depends on: Specification 8.3 accepted

#### Outcome

An accepted specialized agent is reused for its owner when similar bucket
context returns. Useful patterns may become de-identified tenant templates only
through a separate, visible, admin-reviewed promotion process.

#### Scope

- Match future owner buckets to accepted personal agents using versioned,
  explainable similarity and subscription rules.
- Collect owner corrections and performance evidence for blueprint revisions.
- Keep revisions quarantined until rechecked and approved.
- Build a promotion pipeline that removes names, emails, source content,
  company specifics, credentials, destinations, and personal preferences.
- Show a semantic diff between personal blueprint and proposed tenant template.
- Rerun template security and quality suites before tenant-admin approval.
- Never promote across company tenants.

#### Non-goals

- Automatic promotion, cross-company reuse, or exposing one employee's
  blueprint/memory to another employee.

#### Expected repository changes

- `packages/agents/src/matching/`
- `packages/agents/src/promotion/`
- personal performance and revision records
- tenant template review surfaces

#### Requirements

- `FR-1`: Personal reuse remains bound to the owner.
- `FR-2`: Weak matches abstain and remain normal organized memory.
- `FR-3`: Every revision and promotion has source version, diff, eval, and
  decision records.
- `SR-1`: De-identification is deterministic where possible and human-reviewed.
- `SR-2`: Tenant promotion contains no personal examples or inferred emotion.
- `SR-3`: Tenant-admin approval cannot grant access to the original personal
  agent or memory.

#### Acceptance criteria

- `AC-1`: A repeated owner scenario selects the accepted personal agent.
- `AC-2`: An unrelated or other-user scenario does not.
- `AC-3`: Seeded names, emails, personal preferences, and source excerpts are
  removed or block promotion.
- `AC-4`: A promoted template passes the same checks as static Phase 7
  templates.
- `AC-5`: Promotion and rejection are fully auditable.

#### Review gate

Demonstrate personal reuse, abstention, a blocked unsafe promotion, and an
accepted de-identified promotion. Phase 8 completes only after all four
specifications are accepted.

## Phase exit gate

- Unmatched recurring work can produce a useful blueprint without authority.
- Policy, approval, and dry-run gates prevent automatic privilege creation.
- Specialized agents improve for their owner.
- Tenant promotion is de-identified, evaluated, visible, and admin-approved.
