# Roadmap — bucket-driven agents

> Vision, not MVP scope. Written down now because the MVP's data model is
> deliberately shaped to make this possible without rework.
>
> The executable specifications and review gates are now maintained in
> [Phase 7 — Bucket-agent swarm](./roadmap/phase-07-agent-swarm/README.md) and
> [Phase 8 — Manager-generated agents](./roadmap/phase-08-manager-agents/README.md).

## The idea

Buckets are not just filing — they are **work queues for agents**. Each agent
subscribes to the bucket(s) it owns. When a new item lands, the agent
recognizes it, takes its instructed action, and routes the outcome through a
human confirm/reject loop.

### The flagship example: Tasks → Asana

1. Executive speaks after a meeting: *"…and Riya should own the pricing-page
   refresh, need it by end of month."*
2. Core loop: thought extracted with a `task`, placed in the **Tasks** bucket
   (guaranteed by the engine's hard rule).
3. The **Asana agent** (subscribed to Tasks) picks it up, drafts an Asana task
   with assignee Riya and the due hint.
4. Riya gets a notification: **confirm or reject** — without opening Asana.
   On confirm, the task is assigned to her. On reject, it returns to the
   executive's review queue.
5. The outcome is written back to the item (status, link), so the OneNote
   page stays the source of truth.

The same pattern generalizes: an **Ideas** bucket agent that clusters and
surfaces weekly themes, a **People/Follow-ups** agent that drafts nudges, a
**Meetings** agent that preps briefs. New capability = new agent subscription,
not a pipeline change.

## Why the MVP already supports this

- `Tasks` bucket is special-cased and created on demand — the agent's queue
  exists from the first capture.
- Every item carries provenance and a stable ID — agents act on durable
  records, not chat history.
- Ports/adapters mean the agent's actions (Asana, Microsoft To Do, Jira) are
  just new provider adapters behind a `Destination` port.
- The microsoft-365 and asana MCP servers are the candidate integration
  surfaces for the demo of this layer.

## Hard rules for the agent layer (when we build it)

- **Human-in-the-loop by default.** No agent assigns work to a person without
  that person's confirm. Autonomy is earned per-action-type.
- **Idempotent actions.** An agent processes an item exactly once; retries
  never double-create tasks.
- **Tenant isolation.** Agents inherit the same tenant/user scoping as the
  store; no cross-tenant reads, ever.
- **Auditability.** Every agent action writes back status + provenance.

## Sequencing

The complete dependency order is defined in
[`docs/roadmap/`](./roadmap/README.md). In summary:

1. Prove provenance, memory, retrieval, evaluations, and scoped Microsoft 365
   context.
2. Pass the controlled CLI pilot quality gate.
3. Build durable bucket events, approvals, idempotency, audit, and approved
   common agent templates.
4. Add the quarantined manager-agent blueprint flow for recurring unmatched
   buckets.
5. Graduate to product clients and separate public infrastructure only after
   the relevant specifications are accepted.
