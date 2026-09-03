# Agreed product and architecture decisions

These decisions were made during roadmap planning. A phase specification must
not silently override them. Material changes require an explicit product-owner
decision and an update to this file.

## Product strategy

- Donna is a personal AI assistant for busy corporate workers who need to
  capture messy thoughts, recover context, organize knowledge, and approve
  prepared actions.
- The moat is not a proprietary foundation model. It is consented personal
  memory, correction-driven personalization, sorting quality, retrieval
  quality, evaluation data, and trusted workflows.
- The internal company pilot uses foundation models available through
  TrueFoundry. A public product must use separate provider accounts and
  infrastructure.
- Models remain selected through `models.config.yaml`; model identity must not
  be hard-coded into pipeline or agent logic.

## Delivery sequence

- Start with the CLI.
- First test with the product owner, then a small consenting volunteer cohort.
- Pilot content excludes HR, legal, financial, KYC, payment, and similarly
  high-sensitivity workflows.
- **Primary surface is laptop/desktop, not mobile.** Users are corporate
  workers at their computers; the graduated product is a desktop experience
  (desktop app or desktop browser PWA with microphone voice capture) plus
  Teams/Office surfaces where they already work. Mobile is a later companion,
  not the launch form factor.
- Move to the desktop voice/retrieval experience and Teams review/approval
  cards only after the measured CLI graduation gate passes.

## Context and memory

- Donna uses voice plus scoped corporate context; it is not only a
  transcription product.
- Initial Microsoft 365 grounding includes calendar and user-selected emails,
  Teams threads, and files.
- Donna does not continuously ingest the full mailbox, Teams history,
  OneDrive, or SharePoint estate.
- **Microsoft 365 integration runs through the TrueFoundry-managed M365 MCP
  (product owner, 2026-09-03):** the platform owns the Entra application,
  OAuth configuration, token storage, and refresh; each employee authorizes
  their own Microsoft account via Connect Now. Donna never registers its own
  Entra app for the internal pilot and never handles Microsoft tokens
  directly. Verified live 2026-09-03: direct MCP initialize + tools/list (48
  tools) + authenticated calendar read all succeed with the existing
  TrueFoundry credential.
- **Knowledge destination is OneDrive Markdown temporarily (product owner,
  2026-09-03):** the managed MCP exposes no OneNote page API, so approved
  bucket content publishes as Markdown files in a dedicated OneDrive `Donna`
  folder. OneNote is an optional future integration, pending TrueFoundry
  adding page tools. Donna's own desktop UI (Phase 9) is the primary
  experience; OneNote/OneDrive are export surfaces, never the source of
  truth.
- Durable personal memory may include explicit facts, preferences,
  relationships, vocabulary, recurring themes, corrections, and organization
  patterns.
- Emotional or frustration inference is probabilistic, user-correctable, and
  session-only by default.
- Persistent emotional context requires explicit employee opt-in and can be
  viewed, corrected, or deleted.
- Personal memory is private to the employee. It is not an employer-visible
  psychological or performance profile.
- Original audio is encrypted and retained for seven days, then automatically
  deleted. The transcript remains until the employee deletes it under the
  accepted retention policy.

## Dynamic organization

- The organizer produces atomic thoughts, not one summary of an entire voice
  note.
- Buckets are dynamic and personal; there is no mandatory fixed taxonomy.
- The LLM may propose a bucket, but deterministic similarity and product rules
  decide placement.
- Commitments always route to `Tasks`.
- **The `Tasks` hard-rule is absolute (product owner, 2026-09-03):** no
  accepted correction or preference may soften it. When a correction
  preference conflicts with the hard rule, placement follows the hard rule and
  adherence records "contradicted" — honest bookkeeping, not a silent override.
  Rationale: the Tasks bucket is the agent layer's safety anchor. Revisit at
  Phase 7 if pilot evidence demands it.
- **The user is ground truth on corrections (product owner, 2026-09-03):** a
  direct `bucket.move` correction is always allowed, even for task-bearing
  thoughts out of `Tasks`. The apply path keeps one invariant — Tasks
  membership and the task field never disagree: moving a task-bearing thought
  out of `Tasks` clears its task candidate; moving a thought into `Tasks`
  adds one from its summary. A direct user action is never recorded as
  "contradicted" — adherence bookkeeping measures only autonomous placements
  against learned preferences.
- Corrections are first-class learning events and evaluation inputs.
- Every thought and derived memory requires source provenance.

## Agent swarm

- Buckets can become independent work queues.
- Approved templates cover common buckets initially.
- Agents operate independently and may plan concurrently; one failing agent
  does not block unrelated buckets.
- Agents may read, reason, research, and prepare drafts without action
  approval.
- Every external write, send, assignment, share, or mutation requires explicit
  accept/reject.
- External actions are idempotent and auditable.
- An unmatched bucket may trigger a manager agent to draft a specialized
  blueprint.
- A generated blueprint is declarative, contains no credentials or executable
  code, and remains quarantined until automated policy checks, human approval,
  and a dry run pass.
- Learned agents remain personal by default.
- A learned agent may become a tenant template only after de-identification,
  repeat evaluation, a visible diff, and tenant-admin approval.
- No learned agent or memory crosses company tenants.

## Quality gates

CLI graduation requires:

- atomic-thought coverage of at least 95%;
- task recall of at least 95%;
- first-pass bucket acceptance of at least 85%;
- valid provenance of 100%;
- successful retrieval of at least 80%;
- zero tenant-isolation failures; and
- zero duplicate external actions.

Security, privacy, or provenance failures are hard blockers even when aggregate
quality metrics pass.
