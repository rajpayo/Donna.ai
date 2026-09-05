---
id: "6.7"
title: "Structured bucket routing and governed minting"
phase: "06"
status: "blocked"
depends_on: ["6.6"]
---

# Specification 6.7 — Structured bucket routing and governed minting

> **Binding product-owner decisions (2026-09-05):** Specification 6.6 is
> **rejected** with its immutable `NONE` evidence preserved. No candidate met
> multiple binding bucket floors; the blinded rubric confirmed a broad quality
> problem; and no winner, validation-v3 run, private diagnostic, fresh set, or
> graduation run was allowed. The product owner explicitly authorizes this
> draft 6.7 as the one-off narrow remediation that may depend on immutable
> failed 6.6 evidence despite the normal accepted-dependency rule in
> `EXECUTION.md:27-35`. This is not a general protocol amendment, and
> `EXECUTION.md` remains unchanged.
>
> The product owner also selected the binding 6.7 architecture: full scoped
> ID/name/description allowlist; mutually exclusive join/mint schema with one
> existing escalation; conservative geometry-agreement routing; validated
> immediate minting with one isolated naming retry; separate locked
> near-duplicate threshold initially `0.90`; extraction completed before
> routing; gpt-5-mini structured baseline only; durable pending review for
> every conflict; dual metrics followed by a versioned migration to final
> placement acceptance at the unchanged `0.85` graduation threshold; and
> three fixed dev replicates plus deterministic safety/concurrency tests.
>
> Status is `approved` (product owner, 2026-09-05). These decisions resolve
> product architecture; implementation and dev-only evidence collection are
> authorized. Held-out runs, validation-v3 runs, and fresh P-00 collection
> remain unauthorized until dev eligibility passes and the product owner
> separately approves the next step.

## Outcome

Donna no longer asks a model to express both an existing-bucket choice and a
new-bucket proposal as ambiguous free-form names. For each atomic thought, the
organizer emits exactly one structured placement proposal:

```ts
type PlacementProposal =
  | { mode: "existing"; bucketId: string }
  | { mode: "new"; name: string; description: string };
```

An existing proposal can reference only an opaque ID from the authenticated
user's request-scoped allowlist. A new proposal is only a candidate: the
bucket engine applies the absolute Tasks rule, semantic geometry, canonical
name validation, and collision/near-duplicate checks before any placement is
final. Clear join agreement auto-files. A valid, distinct, below-threshold new
topic auto-creates and files immediately. Disagreement, middle-band
uncertainty, unknown/invalid routing, duplicate conflict, or a name that still
fails after one isolated naming retry persists for review. User corrections
remain ground truth.

The observable product result is:

- a clear existing placement prints **`Filed in X`**;
- a valid, distinct new topic prints **`Created new bucket Y — filed`**;
- a pending mint prints **`Create new bucket Y?`** only when user resolution
  is required;
- an unknown ID, model/geometry disagreement, near-duplicate, or other
  uncertainty prints a named conflict and offers human-readable choices;
- names, people, deadlines, task details, and provenance survive; and
- no internal bucket ID appears in CLI or future desktop UI.

## Why this comes now

Specification 6.6 tested the current free-form naming contract exhaustively
enough to reject another prompt/temperature-only iteration. Its locked plan
contains exactly A/A0/B, three replicates each, on the same 28-case dev
envelope (`packages/evals/experiments/organize/6.6/plan.json:30-65,76-96`).
The committed no-winner evidence records 252 case executions with no
best-of-three (`no-winner.json:1-13`).

Every run had schema validity, thought coverage, task recall, and provenance
of `1.0`, with zero external errors, product errors, or hard failures, but all
three candidates missed multiple bucket floors:

- A (best): overall exact `0.55952`, joined `0.66667`, minted exact
  `0.33333`, task precision `0.82143`, p90 `13,033 ms`
  (`no-winner.json:15-38`);
- A0: overall `0.51190`, joined `0.59649`, minted `0.33333`, task precision
  `0.77381`, p90 `13,398 ms` (`no-winner.json:40-68`);
- prompt-v3 B: overall `0.45238`, joined `0.57895`, minted `0.18519`, task
  precision `0.65476`, p90 `15,474 ms` (`no-winner.json:70-99`).

The causal deltas are negative: A→A0 reduced overall by `0.04762`; A0→B
reduced it by another `0.05952` and reduced mint exactness by `0.14815`
(`no-winner.json:101-121`). Selection mechanically returned `none`, and each
candidate failed overall, joined, and minted floors
(`selection.json:331-369`). The product-owner-authorized blinded review was
also poor: all five criteria passed on 36/81 outputs (44.44%); correct-topic
passed 36/81; concise, reusable, distinct, and stable each passed 38/81
(`SPEC-6.6-organizer-quality-experiment.md:1178-1199`). It was diagnostic and
did not change `NONE`.

The failure is therefore not adequately addressed by asking the same free-form
schema to copy names more carefully. This specification changes the product
contract and deterministic routing path. It does not propose another
prompt-only A/B.

## Current-state analysis (verified against code)

### 1. The current organizer contract is three independent optional strings

There is no unified `proposedBucket` field in the current core contract.
`OrganizeOutput` has `suggestedBucket?: string`, `newBucketName?: string`, and
`newBucketDescription?: string`, alongside summary, text, confidence, task,
and provenance (`packages/core/src/ports.ts:40-60`). The Zod and OpenAI JSON
schemas repeat those fields under `donna.organize.v1`
(`packages/providers/src/organize-schema.ts:23-54,57-110`). OpenAI strips
JSON nulls and then parses the Zod schema
(`packages/providers/src/openai-organizer.ts:51-72`); Anthropic exposes the
same fields through a forced tool and parses the same Zod schema
(`packages/providers/src/anthropic-organizer.ts:26-68,96-114`).

The schema does not enforce exactly one of join or mint. Both may be absent or
both may be present. The prompt asks the model to copy an existing **name**
into `suggestedBucket`, or invent `newBucketName` plus a description
(`packages/providers/src/organize-schema.ts:120-126,134-144`). Existing
buckets are rendered as `"name": description` only in the no-context branch
(`organize-schema.ts:176-192`). In the context-present branch, the
`existingBuckets` argument is not rendered at all
(`organize-schema.ts:195-225`). Instead, `ContextAssembler` independently
ranks bucket summaries, caps them at `maxBucketSummaries`, and adds their
names/descriptions as retrieved context
(`packages/memory/src/context-assembler.ts:166-199`). Prompt rendering then
deliberately omits those elements' source IDs
(`organize-schema.ts:201-208`). The production CLI wires a context assembler
(`apps/cli/src/main.ts:949-959`), so production normally exposes a bounded
retrieved subset of human-readable bucket summaries—not the full direct list
and never selectable IDs. The organizer port likewise receives only
`Pick<Bucket, "name" | "description">`
(`packages/core/src/ports.ts:62-80`).

This is not merely a name-copy problem: evaluation calls the organizer without
a `ContextPacket`, so its capture-time `existingBuckets` list is rendered
directly (`packages/evals/src/scorers/organize.ts:120-139`), while the normal
CLI context path uses the bounded context packet instead. V2 must render one
dedicated ID/name/description allowlist in both branches and keep memory/
retrieved context separate. For the CLI pilot, the selected allowlist is
the full current scoped bucket list; any future shortlist/pagination policy is
a measured product change because omission can create false-new proposals.

### 2. The pipeline forwards names as hints; it does not assign by name

Production loads the authenticated user's full bucket list and context
(`packages/pipeline/src/run.ts:192-205`), calls the organizer with that list
(`run.ts:488-509`), preserves output-to-thought association by stable array
index (`run.ts:218-230`), and forwards only the three optional name fields to
`BucketEngine.place` (`run.ts:241-258`). It copies the task object unchanged
into `Thought` (`run.ts:558-575`); `TaskCandidate` already supports
`title`, `assigneeHint`, and `dueHint`
(`packages/core/src/types.ts:104-126`).

The forwarded names are hints, not direct assignment commands:

1. A task-bearing thought ignores the proposal and joins or creates the
   seeded `Tasks` bucket (`packages/buckets/src/engine.ts:64-78`).
2. For non-tasks, the engine ranks every existing centroid by cosine
   similarity (`engine.ts:80-90`; cosine implementation at
   `packages/buckets/src/similarity.ts:1-15`).
3. If the best centroid clears `assign_threshold`, the best bucket wins,
   whether or not it is the named suggestion (`engine.ts:91-94`). In the
   `0.82`–`0.90` band, the presence of any resolvable suggestion suppresses
   review through `!suggested`; the code does not require that suggestion to
   equal the winning best bucket. A model/geometry mismatch can therefore be
   filed without a mismatch-specific review reason.
4. A same-name suggested bucket can win only after the high-confidence best
   branch and only if that suggested bucket clears `create_threshold`
   (`engine.ts:95-99`).
5. Otherwise any best bucket clearing `create_threshold` wins and is marked
   for review (`engine.ts:100-102`).

Therefore current proposed names do not generally control assignment. They can
influence a mid-band join, review state, collision handling, and the name/
description used if geometry reaches the create path.

### 3. Current name proposals do affect collision handling and minting

Below the create threshold, the engine chooses
`newBucketName ?? suggestedBucket` as `proposedName`
(`packages/buckets/src/engine.ts:104-113`). A case-insensitive exact collision
joins the existing bucket and flags review, even when geometry is below the
create threshold (`engine.ts:114-121`; exercised at
`packages/buckets/src/engine.test.ts:176-193`). A parroted `bucket:<uuid>`
string is specially resolved to a current bucket; an unknown reference falls
back to a summary-derived name (`engine.ts:109-133`;
`engine.test.ts:195-228`). Otherwise the engine mints immediately using the
proposed name/description or a three-word title-cased summary fallback
(`engine.ts:136-146,201-209`).

The current exact collision check is only trim + lowercase
(`engine.ts:148-152`). The file store's `createBucket` appends without its own
duplicate check (`packages/buckets/src/store.file.ts:82-97`). PostgreSQL does
enforce per-user case-insensitive name uniqueness
(`database/migrations/0001_init.up.sql:48-68`), but
`PostgresBucketStore.createBucket` relies on that insert and has no
near-duplicate policy (`packages/storage-postgres/src/bucket-store.pg.ts:42-95`).
Neither adapter currently stores a canonical comparison key or pending mint
proposal.

### 4. The current organize metric measures proposals, not final placement

The organize scorer calls the organizer directly with a capture-time
name/description snapshot (`packages/evals/src/scorers/organize.ts:109-139`).
It then scores `suggestedBucket ?? newBucketName` against the expected name;
for minted cases it specifically requires `newBucketName`
(`organize.ts:215-259`). It never instantiates `BucketEngine`, never computes
centroid similarity, never exercises collision handling, and never observes
the bucket ultimately persisted by the pipeline. By contrast, the full-loop
scorer creates real stores, `BucketEngine`, pipeline, memory, correction, and
retrieval components (`packages/evals/src/scorers/full-loop.ts:123-229`) and
checks both placement-time Tasks behavior and final bucket state
(`full-loop.ts:260-319,399-458`).

This distinction is material because `DECISIONS.md:71-81` says the LLM may
propose but deterministic similarity/product rules decide placement. A
proposal-exact-name metric remains useful as an organizer diagnostic; it is
not, by itself, the user-facing final-placement truth.

### 5. Corrections and Tasks boundaries already exist and must survive

Direct `bucket.move` is ground truth. The correction path always applies the
move, then keeps Tasks membership and the task field consistent: moving out
clears the task candidate; moving into Tasks creates one from the summary
(`packages/memory/src/corrections.ts:383-410`). An accepted move derives a
private procedural preference, but if durable memory is disabled the move
still applies and only preference derivation is skipped
(`corrections.ts:530-553`). A later contradictory correction supersedes the
earlier example without rewriting it (`corrections.ts:558-585`).

This specification must not reinterpret that user-ground-truth rule. It also
must not let a model proposal, learned preference, prompt injection, or
uncertainty setting soften autonomous Tasks placement.

### 6. Existing eval data can evolve, but the v3 history stays historical

The organize envelope currently supports an optional capture-time
`existingBuckets` array of names/descriptions and per-thought
`bucketOrigin: "minted" | "joined"`
(`packages/evals/src/datasets.ts:123-156`). Loader rules reject duplicate
normalized snapshot names and joined/minted label inconsistencies
(`datasets.ts:420-482`), then screen every string field
(`datasets.ts:490-565`). The schema does not yet carry fixture bucket IDs.

Validation-v3 is known evidence, not blind evidence. Specification 6.6
preserves its bytes, lock, IDs, and history and forbids using it as the final
exam (`SPEC-6.6-organizer-quality-experiment.md:130-141,185-198`). Spec 6.7
therefore begins with dev-only schema/eval migration. It does not edit or run
validation-v3, collect a new P-00 matrix, or run any held-out/final set until
the dev floors and product-owner decisions below pass.

## Recommended product architecture

### A. Versioned, discriminated organizer contract

Add `donna.organize.v2` rather than mutating v1 in place. Each output thought
keeps `summary`, `text`, `confidence`, optional `task`, and mandatory
provenance exactly as today, and adds exactly one `placement` branch:

```ts
type OrganizeThoughtV2 = {
  summary: string;
  text: string;
  confidence: number;
  task?: { title: string; assigneeHint?: string; dueHint?: string };
  provenance: {
    segmentIds: string[];
    sourceText: string;
    startSec: number;
    endSec: number;
  };
  placement:
    | { mode: "existing"; bucketId: string }
    | { mode: "new"; name: string; description: string };
};
```

The request gives the model `Array<{id, name, description}>`, where IDs
are stable, opaque, and drawn from the authenticated tenant/user scope. Names
and descriptions remain visible so the model can reason semantically and the
product can render previews. The response has no tenant ID, user ID, scope,
provider, model, tool, threshold, or action field. Provider adapters validate
the discriminated schema; the pipeline independently validates referential
membership against the exact request allowlist before the engine sees it.
The dedicated allowlist is rendered identically whether memory context is
present, absent, or degraded; context budgets cannot silently remove routing
options in this pilot version.

Join and mint are mutually exclusive. A join with no valid exact supplied ID
or with any new-name field is invalid. A mint with an existing-ID field, an ID
embedded in its name, a canonical collision, or an unknown route action is
invalid. Schema/referential invalidity uses the existing escalation organizer
exactly once; if the escalated output is still invalid, the already verified
extraction persists pending with no placement or mint side effect.

`donna.organize.v1` remains readable for historical reports and rollback, but
new v2 product runs do not translate a free-form existing name back into an ID.
This makes the existing-bucket exact-copy defect structurally impossible:
the existing branch returns only an ID, while UI resolves the corresponding
human name.

### B. Selected decision policy: geometry veto, agreement auto-files

The product owner selected this policy. It intentionally keeps dynamic
personal buckets; it is not a fixed taxonomy.

1. **Tasks first.** If `thought.task` exists, route to the authenticated
   user's Tasks bucket (creating the seeded Tasks bucket if absent), regardless
   of `placement`. Record any conflicting proposal diagnostically.
2. **Allowlist validation.** An `existing` ID not present in the exact scoped
   request list is `unknown-id`. It causes zero placement/mint side effects,
   is never interpreted as a name, and enters review with an optional
   geometry recommendation if the existing escalation lane also returns an
   invalid response.
3. **Geometry ranking.** Rank only authenticated, scoped, non-pending buckets.
   Existing `assign_threshold` and `create_threshold` retain their current
   values; this draft does not weaken them.
4. **Agreement.** Auto-file only when the model's allowlisted ID equals the
   top geometric bucket and that bucket clears `assign_threshold`.
5. **Middle band.** At or above `create_threshold` but below
   `assign_threshold`, the structured proposal is a recommendation/tie signal
   only. The thought remains pending; neither geometry nor the model may
   silently join.
6. **Mismatch.** If model and top geometry disagree, queue review showing the
   two human names and similarities as confidence language, not raw internal
   IDs. Do not silently join or mint.
7. **Mint eligibility.** Consider `mode:"new"` only when no existing bucket
   clears `create_threshold`. If exact, lexical, or semantic duplicate checks
   find an existing bucket, queue `possible-existing-match` review and
   recommend that bucket. If no match exists and every canonical validator
   passes, create and file immediately.
8. **Correction ground truth.** A user's selection wins immediately through
   the existing correction semantics. Autonomous rules may record adherence
   but may not reverse the correction.

Semantic similarity is never sufficient by itself to silently join or create.
The structured model proposal and deterministic rules must agree for an
automatic join, while automatic minting requires geometry to find no existing
match and every validator to pass.

### C. Selected mint policy: validated immediate creation

Three designs were considered; the product owner selected validated-immediate:

- **(a) Mint immediately.** Lowest friction, but current code already does
  this without sufficient validation, and the blinded all-five usefulness
  result is only 44.44%. Unvalidated immediate minting is rejected.
- **(b) Mint a provisional generic bucket, then refine after repeated
  evidence.** It keeps every thought attached to a bucket, but exposes vague
  labels, makes later matching unstable, and creates rename/merge churn. It
  also risks becoming a hidden fixed “miscellaneous” taxonomy.
- **(c) Validated immediate mint with pending fallback (selected).** When no
  existing match clears `create_threshold`, canonical validators pass, and no
  exact/lexical/semantic near-duplicate exists, create and file immediately.
  If only naming fails, retry the isolated naming stage once with the already
  completed thought, task, provenance, route decision, validator reasons, and
  same allowlist; do not rerun extraction or routing. If that name still
  fails, or the case is a disagreement, middle-band result, unknown/invalid
  route, or duplicate conflict, persist it for review. Pending review supports
  confirm, edit, reject, and file-existing.

Pending fallback needs a scoped pending-placement store because current items
require a bucket (`database/migrations/0001_init.up.sql:70-89`) and the
pipeline saves an item immediately after `place`
(`packages/pipeline/src/run.ts:241-260`). The pending record must preserve the
already verified extraction/provenance, proposal, allowlist hash,
deterministic reason tokens, and human-readable candidates. It must not
duplicate raw audio or private memory, and it is unavailable to normal
retrieval until resolved.

### D. Deterministic canonicalization and duplicate protection

For a proposed new bucket:

1. Build a canonical display value with Unicode NFKC normalization and
   trimmed/collapsed whitespace. Reject wrapping quotes and sentence
   punctuation rather than silently repairing them. Preserve meaningful
   internal capitalization and acronyms such as `M365`; do not lowercase
   proper nouns merely to title-case them.
2. Require a concise one-to-four-token reusable topic noun phrase. Reject
   control characters, blank/oversized names, standalone dates, deadline or
   urgency language, and imperative/one-off action wording. A durable person,
   project, organization, or product proper name may be valid; `Ask Arjun by
   Friday` is not.
3. Derive a separate canonical comparison key from NFKC, case folding,
   whitespace/punctuation folding, and token normalization. Exact-key
   collision becomes a proposed join, never a mint.
4. Check lexical containment and semantic near-duplication against every
   scoped existing bucket's canonical name plus description. Semantic
   comparison uses only the configured embedder and a separate config value
   whose initial candidate is `0.90`. Calibrate it only on synthetic fixtures
   before live dev results, then freeze its model/config/threshold hashes. Do
   not reuse the `0.82` assignment threshold. It never accepts model-supplied
   scope or vectors.
5. Any near-duplicate is a review conflict. The UI shows the proposed name and
   likely existing human name; it does not create either silently.
6. A valid distinct candidate creates immediately in one scoped transaction.
   For a pending confirmation/edit, repeat exact and semantic checks against
   current state; a race becomes conflict/review, not a duplicate bucket.

The PostgreSQL migration should add a per-user unique canonical-name key while
retaining the existing case-insensitive unique index during migration. The
file store must enforce the same invariant before append. Existing bucket
rows are backfilled under a reviewed collision report; no automatic merge is
allowed. Near-duplicate semantics remain dynamic and personal, not a global
taxonomy.

### E. Extraction completes before routing

No new `people` field is needed to implement structured routing. Current
`Thought` retains names in summary/text and current `TaskCandidate` already
has assignee and due hints (`packages/core/src/types.ts:109-139`). V2 tests
must ensure one related action's subject, supporting detail, person, and
deadline remain together and task precision does not regress.

Atomic thought extraction, task classification, `assigneeHint`/`dueHint`,
names/deadlines, and provenance complete before routing or naming. Routing and
the isolated naming retry consume immutable extracted fields and cannot
rewrite, split, omit, or generalize them. The single permitted naming retry
changes only the proposed new name/description.

Entity-normalized people fields or a richer task-detail structure would affect
core types, corrections, storage JSON/SQL, retrieval, exports, and eval labels.
That is a separable extraction feature, not silently part of routing. The
selected 6.7 scope preserves and tests current fields; it does not add new
ones.

## Scope

- Introduce and validate the versioned v2 discriminated placement proposal.
- Supply scoped opaque bucket IDs plus human names/descriptions to organizers.
- Replace name-hint interpretation in the v2 engine path with allowlisted ID
  validation and explicit new-bucket candidates.
- Implement the product-owner-approved model/geometry decision policy,
  mandatory conflict reasons, and no-side-effect unknown-ID behavior.
- Implement deterministic mint-name canonicalization, exact collision and
  semantic near-duplicate checks, validated-immediate creation, and one
  isolated naming-only retry.
- Persist pending placement review safely across CLI invocations.
- Complete extraction before routing/naming and prevent either stage from
  changing thought/task/provenance content.
- Keep Tasks absolute, corrections ground truth, current thought/task fields,
  provenance, ports/adapters, and config-selected models.
- Add dev-only route-choice and final-placement evaluation without rewriting
  validation-v3 history or weakening any gate.
- Use gpt-5-mini only for the structured baseline; Sonnet remains unavailable
  without both stable structured evidence and authoritative tariff evidence.
- Version the approved graduation-gate source migration to deterministic final
  placement acceptance at the unchanged `0.85` threshold before fresh results.
- Add CLI now and define the future desktop review-card behavior.

## Non-goals

- No Phase 7 agents, manager agents, blueprints, Teams actions, or external
  writes.
- No STT model, adapter, prompt, dataset-label, or transcription change.
- No full extraction/routing prompt retry, prompt-paragraph iteration, or
  prompt/model-only A/B. The only model retry is one isolated naming-only
  retry after deterministic name-validation failure.
- No weakening `assign_threshold`, `create_threshold`, graduation thresholds,
  provenance rules, Tasks, or security hard blockers.
- No validation-v3 rewrite, held-out retry, fresh P-00 matrix, final run, or
  graduation run before dev eligibility and an approved gate policy.
- No repeated validation/held-out run after results, and no use of blinded
  review to convert Spec 6.6 into a pass.
- No arbitrary global taxonomy or fixed topic list; personal buckets remain
  dynamic.
- No unrestricted model bucket creation and no silent mint on a model name.
- No Sonnet or expensive-model experiment in 6.7.
- No new memory sharing, private-context snapshots, cross-user bucket sharing,
  or tenant templates.
- No new person entity model or task schema beyond preserving current
  `title`/`assigneeHint`/`dueHint`.
- No automatic merge/rename of existing buckets during canonical-key backfill.

## Expected repository changes

Proposed paths only; all changes are forbidden while this specification is
`draft`.

- `packages/core/src/ports.ts` — v2 placement union; organizer bucket option
  includes `id`; `BucketStore` gains scoped ID lookup/finalization primitives;
  new `PendingPlacementStore` port, explicit placement result union, and an
  isolated bucket-naming port that cannot modify extracted thought fields.
- `packages/core/src/types.ts` — versioned pending-placement/review records;
  no expansion of `Thought` or `TaskCandidate` content fields.
- `packages/providers/src/organize-schema.ts` — `donna.organize.v2`, strict
  discriminated JSON/Zod schema, v2 prompt rendering opaque IDs with names and
  descriptions, strict prohibition of IDs in new names, isolated naming schema,
  and v1 retained for history/rollback.
- `packages/providers/src/openai-organizer.ts`,
  `anthropic-organizer.ts`, `registry.ts` — adapter support and config-selected
  contract/prompt versions; no model-specific routing policy.
- `packages/pipeline/src/run.ts` — pass v2 placement by stable output index,
  validate allowlist membership, perform at most one existing escalation for
  invalid routing output, keep extraction immutable, invoke at most one
  naming-only retry, handle placed versus pending results, and preserve
  task/provenance/version records.
- `packages/buckets/src/engine.ts`, `similarity.ts` — geometry-veto decision
  policy, canonicalization, descriptor near-duplicate check, reasoned review
  outcomes, and atomic revalidation/finalization.
- `packages/buckets/src/store.file.ts` — private scoped pending store and
  canonical-key uniqueness with parity to PostgreSQL.
- `packages/storage-postgres/src/bucket-store.pg.ts` and a descriptively named
  reversible `database/migrations/0002_*.{up,down}.sql` — RLS-protected pending
  placements, canonical-name key/backfill, scoped indexes, and atomic finalize.
  Generated/custom SQL must be reviewed and tested on a copy before apply; no
  destructive merge is part of migration.
- `apps/cli/src/main.ts` — human-readable capture status and interactive/
  deferred placement review without displaying IDs.
- `packages/evals/src/datasets.ts` — additive dev fixture IDs and v2 expected
  mode/ID shape; IDs are de-identified per-case handles, not operational user
  IDs.
- `packages/evals/src/scorers/organize.ts` — route-choice metrics and v1
  compatibility diagnostics; expected labels/IDs never enter prompts.
- `packages/evals/src/scorers/full-loop.ts` or a focused routing scorer — run
  the real engine/store path for deterministic final-placement acceptance,
  conflict, pending mint, confirmation, and correction behavior.
- `packages/evals/src/organize-experiment.ts` and
  `packages/evals/experiments/organize/6.7/` — locked dev-only plan, fixed
  replicates, reports/hashes, and mechanical stop.
- `packages/memory/src/corrections.ts` — only integration needed to ensure
  reviewed choices and direct moves preserve existing ground-truth semantics;
  no new shared-memory content.
- `models.config.yaml` — only approved contract/prompt/near-duplicate
  configuration with near-duplicate initial candidate `0.90`; gpt-5-mini is
  the only 6.7 organizer/namer and model identity remains config-only.
- `docs/pilot/RUNBOOK.md` — capture/review wording and explicit pending-mint
  handling.
- Comprehensive tests beside every changed module plus PostgreSQL integration
  and CLI end-to-end coverage.

## Functional requirements

- `FR-1`: Add `donna.organize.v2` with exactly one discriminated `placement`
  branch per thought: `{mode:"existing", bucketId}` or
  `{mode:"new", name, description}`. Preserve summary, text, confidence,
  task, and provenance. Reject zero/both branches, unknown route actions,
  join without an exact allowlisted ID, join carrying proposed/new-name
  fields, mint carrying an existing ID, mint with an ID-shaped name, duplicate
  canonical name, unknown fields, and empty required values. Keep v1 available
  only for historical compatibility and rollback.
  End-user experience: the user still speaks one note and sees the same
  thought/task content; ambiguous combinations cannot reach the filing UI.

- `FR-2`: The v2 prompt supplies each existing option as opaque stable ID plus
  human-readable name/description from the authenticated user's scoped bucket
  list, in a dedicated allowlist rendered identically with or without a
  `ContextPacket`. Context-summary budgets cannot truncate that routing list.
  The response cannot set tenant/user/scope/tool/model/threshold data, and
  expected eval labels never enter the prompt.
  End-user experience: CLI and desktop show only bucket names and descriptions;
  internal IDs are never printed or rendered.

- `FR-3`: Independently validate an `existing` ID against the exact request
  allowlist in the pipeline and again in the engine/store boundary. Unknown,
  stale, cross-scope, malformed, or duplicated IDs fail closed with zero
  placement or mint side effects. Any invalid organizer response escalates
  exactly once through the existing escalation lane; if the second response
  is invalid, persist the verified extraction as pending review and never
  continue silently.
  End-user experience: Donna says `I couldn't verify that destination; choose
  a bucket` and lists human names, never an unknown ID or a fabricated bucket.

- `FR-4`: Apply the Tasks hard rule before any proposal or semantic decision.
  Every autonomous task-bearing thought joins/creates Tasks; proposal conflict
  is diagnostic only. Direct user corrections retain the accepted consistency
  semantics for moving into/out of Tasks.
  End-user experience: a commitment prints `Filed in Tasks` with its stated
  assignee/deadline; a later direct user move is honored and task state stays
  consistent.

- `FR-5`: Implement the approved deterministic decision table. Only scoped
  buckets participate; auto-file requires proposal/top-geometry agreement and
  `assign_threshold`; the middle band uses the structured proposal only as a
  recommendation/tie signal and stays pending; mismatch, new-versus-existing,
  correction conflict, and still-invalid routing outcomes carry explicit
  reason codes and require review. Semantic similarity alone cannot silently
  join or create.
  End-user experience: a clear match prints `Filed in Project Atlas`; a
  conflict prints `Review needed: Project Atlas or Product Ideas?`.

- `FR-6`: For `mode:"new"`, deterministically canonicalize and validate the
  display name and description. Enforce a concise reusable topic phrase; no
  control characters, dates/deadlines, urgency, imperative episode wording,
  sentence punctuation, IDs, or person-specific task wording. Preserve valid
  proper names and acronyms. If only naming fails, rerun exactly one isolated
  naming stage using immutable extraction/routing inputs; if it still fails,
  persist pending. Do not rerun extraction or route selection.
  End-user experience: Donna proposes `Project Atlas`, not `Ask Arjun to send
  Atlas by Friday`; after one failed repair it says `Name needs review` without
  changing the thought or task.

- `FR-7`: Before any mint, run normalized exact-key, lexical, and semantic
  near-duplicate checks over scoped existing names/descriptions. Exact
  collision becomes an existing recommendation; near-duplicate becomes a
  conflict. Semantic comparison uses the separately configured `0.90` initial
  candidate, calibrated only on synthetic fixtures and frozen before live dev
  runs; it never reuses `assign_threshold`. Re-run checks atomically for
  pending confirmation/edit.
  End-user experience: Donna asks `Use Project Atlas instead?` rather than
  creating `Project Atlas Updates` beside it, and never exposes a threshold.

- `FR-8`: Use validated-immediate canonical minting. Auto-create and file only
  when no existing bucket clears `create_threshold`, all canonical validators
  pass, and no exact/lexical/semantic near-duplicate exists. Otherwise persist
  the verified extraction/proposal in a private scoped pending store.
  Confirmation/edit/reject/file-existing are idempotent pending alternatives;
  valid distinct mints do not require confirmation.
  End-user experience: a valid case prints `Created new bucket Vendor
  Contracts — filed`; a failed name or conflict prints `Create new bucket Y?`
  or `Use X instead?`; future desktop shows **Create**, **File in…**,
  **Edit name**, and **Reject** only for pending cases.

- `FR-9`: Pending placement survives restart, is included in private
  export/deletion/retention operations, and is excluded from normal retrieval
  and external-action queues until resolved. Resolution records non-content
  audit reason/status and the final human-readable bucket.
  End-user experience: `donna review placements` restores unfinished choices
  after restart, and leaving the pilot exports or deletes them with the rest
  of the user's data.

- `FR-10`: Existing-bucket exact-copy failures disappear structurally:
  `mode:"existing"` carries no model-authored name. Reports resolve the
  allowlisted ID to a name for human review; no runtime path mints from an
  existing-mode value.
  End-user experience: the bucket preview always uses the user's current
  spelling, punctuation, and plurality without asking the model to copy it.

- `FR-11`: Preserve stated names, organizations, products/projects, owners,
  assignees, deadlines, and related task detail in one atomic thought. Split
  unrelated actions, but do not split qualifiers of one action. Reuse existing
  `assigneeHint`/`dueHint`; add no new people/task schema under 6.7.
  Extraction, task classification, and provenance complete before routing;
  routing and the isolated naming retry cannot mutate those fields.
  End-user experience: `Ask Priya to send the Project Atlas deck by Thursday`
  remains one Tasks item showing Priya and Thursday.

- `FR-12`: User review/correction is ground truth. A selected existing bucket,
  edited mint name, confirmed creation, rename, or later direct move cannot be
  reversed by autonomous geometry. Learned preference adherence remains honest
  and cannot soften Tasks.
  End-user experience: after the user files an item in `Vendor Portal`, Donna
  keeps that correction and future reviews reflect it rather than moving the
  item back silently.

- `FR-13`: Record separate route proposal, deterministic recommendation, final
  placement, override/conflict reason, review status, and user resolution for
  measurement. Telemetry and committed reports contain counts, rates, opaque
  eval IDs, versions, and hashes only—not thought, bucket, memory, or identity
  content.
  End-user experience: the product owner can see `joined override rate 7%`
  while participants see only their own human-readable filing history.

- `FR-14`: Extend dev evaluation with distinct metrics: stable-ID routing
  accuracy, join-versus-mint decision accuracy, deterministic final-placement
  acceptance, joined override/conflict rate, mint decision precision/recall,
  canonical-name validator pass, blinded name usefulness, exact-name
  reproducibility diagnostic, thought coverage, task precision/recall,
  provenance, schema, Tasks hard-rule, latency, hard failures, and observed
  final user acceptance. Expected labels never enter runtime prompts.
  End-user experience: the eval CLI prints separate `MODEL PROPOSAL`,
  `DETERMINISTIC FINAL`, `MINT QUALITY`, and `TASK/PROVENANCE` sections so the
  product owner can identify the failing layer.

- `FR-15`: Dual-report old-compatible proposal diagnostics and deterministic
  final placement on frozen dev evidence. After dual evidence passes and
  before any fresh result, migrate the graduation source explicitly to a
  versioned deterministic final-placement acceptance metric—the user's final
  bucket—while retaining model route/name diagnostics. Keep the numerical
  threshold exactly `0.85`; blinded review cannot override the metric.
  End-user experience: the graduation CLI clearly labels which metric is
  `GATE v2: FINAL PLACEMENT >= 0.85` and which are diagnostics; the meaning is
  frozen before the fresh exam and never changes between attempts.

- `FR-16`: Validation is dev-only until every strict eligibility floor passes.
  Preserve validation-v3 files/locks/history and Spec 6.6's fresh-blind
  protocol. Do not collect or evaluate a new P-00 final matrix before the
  approved v2 product is committed and eligible.
  End-user experience: dev commands print `DEV ONLY — NOT GRADUATION`; no user
  is asked to record the nine-case fresh matrix for an ineligible build.

- `FR-17`: Models, providers, prompt/contract versions, and embedding model
  resolve through versioned config/manifests. No pipeline, engine, scorer, or
  CLI branch hard-codes a candidate model. The 6.7 structured baseline uses
  gpt-5-mini only. Sonnet is forbidden until the structured baseline is stable
  and authoritative tariff evidence exists; 6.7 runs no expensive model A/B.
  End-user experience: the product owner sees one gpt-5-mini structured
  baseline and its config hashes, not another model tournament.

- `FR-18`: CLI capture and review, and the future desktop surface, use the
  exact user-facing states `Filed in X`, `Created new bucket Y — filed`,
  `Create new bucket Y?`, and `Review needed`. They always show preserved task
  name/deadline and allow correct/file-existing/edit-name/rename/reject actions
  for pending cases without exposing IDs.
  End-user experience: the user can understand and fix every uncertain filing
  from names and descriptions alone.

## Security, privacy, and provenance requirements

- `SR-1`: Tenant/user scope comes only from the authenticated CLI/session
  context. No organizer output, request text, flag, review payload, or pending
  record may choose or override tenant/user scope.
- `SR-2`: Existing bucket IDs sent to the model are opaque, allowlisted, and
  scoped to this one request. Unknown/stale/cross-scope IDs produce zero side
  effects after the one existing escalation also fails validation. IDs are
  forbidden in proposed new names and are never shown to users or included in
  content telemetry.
- `SR-3`: Transcript, existing names/descriptions, memories, and model output
  are untrusted data. Prompt injection cannot introduce an unknown ID, bypass
  Tasks, change thresholds, select a tool, approve a mint, or cause an external
  write.
- `SR-4`: Provenance remains mandatory and is deterministically verified before
  a thought can be placed or persisted as pending. Invalid provenance is a
  hard blocker that cannot be queued as an otherwise valid mint.
- `SR-5`: The pending store and every bucket/item read/write are tenant/user
  filtered. PostgreSQL uses forced RLS and parameterized queries; file paths
  retain partition validation and private permissions.
- `SR-6`: Pending records contain the minimum verified thought and proposal
  needed to resolve filing; no raw audio, full memory packet, credential,
  provider response, or tool data. Export/deletion and pilot-exit flows cover
  them.
- `SR-7`: Logs/reports use reason/category tokens and counts only. They do not
  log transcript text, bucket names/descriptions, task details, IDs tied to a
  real user, session IDs, or stack traces in production CLI output.
- `SR-8`: Official committed fixtures are synthetic or separately consented,
  de-identified, previewed, screened, and adjudicated under accepted Spec 6.4
  mechanics. Operational bucket IDs are never committed; fixtures use
  per-case opaque eval handles. No private memory appears in fixtures.
- `SR-9`: The Tasks rule is enforced outside the model and tested against
  conflicting placement fields and injection text. User corrections remain
  the sole accepted exception path, with task-field consistency.
- `SR-10`: Validated-immediate mint and pending confirmation are idempotent and
  revalidate current scoped state atomically. Concurrent capture/replay/
  confirmation creates at most one canonical bucket and never loses or
  double-files a thought.
- `SR-11`: New SQL migration is additive/reversible, backfill is
  collision-reporting and fail-closed, and no existing buckets are merged,
  renamed, or deleted automatically.
- `SR-12`: Security, privacy, provenance, tenant isolation, or unauthorized
  mutation failure blocks eligibility regardless of quality averages.

## Measurement and graduation-gate policy

### Metrics that answer different questions

- **Route-choice correctness:** did v2 choose the expected mode, and for
  existing mode the expected allowlisted fixture ID? This isolates organizer
  reasoning without name-copy noise.
- **Deterministic final-placement acceptance:** after Tasks, allowlist,
  geometry, collision, and review policy, is the engine's recommended/final
  destination the adjudicated user destination? This is closest to what the
  user experiences.
- **Joined override/conflict rate:** how often does model existing-ID choice
  disagree with deterministic geometry, and how often is review required?
- **Mint decision precision/recall:** when the model says new, was new truly
  needed; and when new was needed, did it propose new? Precision prevents
  bucket sprawl; recall prevents forcing unrelated thoughts together.
- **Minted-name quality:** report the frozen five-part rubric and exact-name
  match separately. Exact remains a reproducibility diagnostic; rubric judges
  concise/reusable/correct/distinct/stable usefulness.
- **Invariant metrics:** thought coverage/count F1, task precision and recall,
  provenance, schema/referential validity, latency, hard failures, and review
  completion.

The current gate cannot silently become the final-placement metric. Today
`organize.bucket_acceptance` is proposal-name matching
(`packages/evals/src/scorers/organize.ts:215-280`), while product architecture
says deterministic geometry decides (`docs/roadmap/DECISIONS.md:71-81`).
The product owner selected this migration:

1. Under 6.7, report both old-compatible proposal acceptance and new final
   placement acceptance on frozen dev data.
2. Require the strict dev floors below for both the product path and all
   invariants.
3. After dual evidence passes, implement and record a versioned gate migration
   to deterministic final-placement acceptance. Retain stable-ID route,
   join/mint, minted-name, and blinded-usefulness metrics as diagnostics.
4. Keep the numerical `0.85` threshold unchanged, update the decision record
   and graduation runner, and freeze the versioned gate meaning before
   collecting or evaluating fresh blind evidence.
5. Only then follow the preserved fresh-blind one-valid-run protocol. Never
   reinterpret an already-seen result, and never use blind review to override
   the metric.

### Strict dev eligibility (binding)

Use one approved structured-routing implementation—not a prompt-only
candidate tournament—against a frozen dev envelope, with three fixed live
replicates and common aggregation. No best-of-three, omitted run, or quality
retry.

The implementation is eligible to approach validation only if:

- thought coverage is `>=0.97`;
- task recall is `>=0.95`;
- task precision does not regress below A's aggregate baseline
  `0.8214285714`;
- provenance fidelity is `1.0`;
- schema and referential validity are `1.0`;
- Tasks hard-rule compliance is `1.0`;
- join-by-ID accuracy is `>=0.90`;
- correct join-versus-mint decision accuracy is `>=0.90`;
- canonical minted-name validator pass is `>=0.90`;
- blinded minted-name usefulness is `>=0.85`;
- deterministic final user-facing placement acceptance is `>=0.90`;
- cross-tenant or forged-ID successes are exactly zero;
- duplicate bucket creation under replay/concurrency is exactly zero;
- organizer p90 is `<=20,000 ms`;
- product errors, hard failures, and security/privacy failures are zero; and
- the complete deterministic engine/CLI/PostgreSQL decision-table,
  concurrency, replay, pending, and security suites pass.

Mint decision precision/recall, joined override/conflict rate, exact-name
reproducibility, pending-review rate/resolution, and final observed user
acceptance remain mandatory reported diagnostics with counts; they do not gain
unapproved extra floors. All three live replicates must independently pass
every blocking safety invariant, while the stated quality floors use the
pre-registered common aggregation.

These floors retain or exceed Spec 6.6's quality bars; none weakens the
graduation threshold. If any floor fails, stop. Do not edit labels, tune
thresholds after results, add prompt/model-only retries, run validation-v3,
collect fresh blind data, or reinterpret the gate.

## Acceptance criteria

- `AC-1`: V2 schema/provider tests prove exactly one placement branch,
  preservation of all current thought/task/provenance fields, rejection of
  every forbidden join/mint combination and ID-bearing new name, strict
  unknown field/action rejection, and byte-stable v1 historical support.
- `AC-2`: Prompt/input audit proves every existing option has one scoped opaque
  ID plus name/description, no tenant/user/tool fields, and no expected labels,
  origins, scorer fields, or adjudication data.
- `AC-3`: Unknown, malformed, stale, and cross-scope IDs produce a pending
  `unknown-id` review after exactly one invalid-response escalation also
  fails, with zero bucket/item/retrieval writes and no ID in user-visible
  output.
- `AC-4`: Every decision-table branch is exercised with fixed vectors:
  Tasks override; high agreement auto-file; mid-band review; existing
  mismatch review; new-versus-existing review; valid distinct immediate mint;
  exact collision; semantic near-duplicate; first naming failure repaired by
  the isolated retry; second naming failure pending; and no-fit fallback.
- `AC-5`: Canonicalization fixtures cover Unicode/whitespace/punctuation,
  proper nouns/acronyms, dates, urgency, imperatives, one-off wording, blank/
  oversized/control/ID input, exact collisions, and near-duplicates. Synthetic
  calibration freezes the separate initial `0.90` threshold before live dev;
  file and PostgreSQL adapters produce the same outcome.
- `AC-6`: A pending mint survives restart; create/file-existing/edit-name/
  reject are idempotent; confirmation revalidates atomically; a valid distinct
  immediate mint creates one bucket/item; concurrent immediate mint or pending
  confirmation creates at most one bucket/item; normal retrieval/agents cannot
  see pending content.
- `AC-7`: Tasks stays absolute against conflicting IDs/new names and injection;
  extraction completes before routing; names/deadlines/assignee hints and
  provenance are byte-identical through route and naming retry; user moves
  into/out of Tasks retain existing task-consistency behavior.
- `AC-8`: CLI end-to-end tests show exactly `Filed in X`, `Created new bucket
  Y — filed`, `Create new bucket Y?`, and human-readable conflict/review
  states; no bucket ID appears in captured stdout/stderr, reports, or
  screenshots.
- `AC-9`: Dev reports contain all metrics listed in FR-14, with proposal and
  deterministic-final sections separated and counts beside rates. Expected
  labels/IDs remain scorer-only.
- `AC-10`: Three fixed dev replicates satisfy every strict eligibility floor.
  Each independently passes every blocking safety invariant. Any
  missing/extra/excluded run, failed floor, hard failure, or post-result
  mutation writes a mechanical stop record and makes later modes unreachable;
  no best-of-three is allowed.
- `AC-11`: Validation-v3 envelopes, locks, reports, case IDs, adjudications,
  and hashes are unchanged; no fresh P-00/held-out/final/graduation report
  exists under 6.7 before dev eligibility and the gate decision.
- `AC-12`: Full typecheck/unit/integration/security/dataset suites are green;
  migration up/down is tested on a database copy; RLS, file partition guards,
  canonical uniqueness, idempotency, export, and deletion checks pass.
- `AC-13`: Product owner resolves all material questions below, examines the
  demonstrated UX and metric disagreement cases, and later explicitly
  approves or rejects implementation evidence. The architecture questions are
  resolved here, but status remains draft pending implementation approval;
  passing automation does not auto-accept or unlock Phase 7.

## Verification

1. Validate v1/v2 schema snapshots, provider parity, prompt trust separation,
   join/mint exclusivity, no-label/no-scope input, ID-in-new-name rejection,
   allowlist referential checks, and exactly-one escalation behavior.
   End-user experience: the product owner sees `SCHEMA V2 VALID` and
   `NO LABEL/SCOPE FIELDS SUPPLIED`; no participant content is printed.
2. Run deterministic engine decision-table, canonicalization, collision,
   synthetic `0.90` near-duplicate calibration, isolated naming retry, task,
   correction, concurrency, replay, and unknown-ID tests for file and
   PostgreSQL stores.
   End-user experience: the test report names human states (`filed`,
   `review`, `create-confirmation`) and confirms `unknown ID: zero writes`.
3. Run CLI end-to-end captures for one clear join, one task, one validated
   immediate mint, one twice-invalid name, one near-duplicate, one
   model/geometry mismatch, and one deferred review restored after restart.
   End-user experience: the product owner sees `Filed in X`, `Created new
   bucket Y — filed`, `Create new bucket Y?`, and actionable conflicts, with
   preserved person/deadline and no IDs.
4. Run migration up/backfill/down on a database copy containing canonical and
   colliding legacy names; inspect the collision report and RLS behavior.
   End-user experience: the product owner sees counts and safe-stop reasons;
   no real bucket is silently renamed, merged, or deleted.
5. Lock the dev plan/dataset/config/policy hashes, then run exactly three live
   dev replicates and the deterministic final-placement suite.
   End-user experience: the eval CLI prints `DEV ONLY — NOT GRADUATION`,
   `run 1 of 3` through `run 3 of 3`, and separated metric sections.
6. Run the mechanical eligibility command and inspect every floor/count,
   disagreement sample through the owner-only de-identified review surface,
   and the versioned gate-migration readiness state.
   End-user experience: the product owner sees `ELIGIBLE FOR VALIDATION
   REVIEW` or `STOP — STRUCTURED ROUTING FAILED`, never an anecdotal pass.
7. Run full tests, typecheck, dataset validation, privacy/content scan, and
   prove `git diff` is empty for validation-v3 and fresh-blind artifacts.
   End-user experience: the product owner sees green checks plus
   `VALIDATION-V3 UNCHANGED` and `NO FRESH RESULTS`.

Expected evidence artifacts after approved implementation are a locked 6.7
dev plan, three dev reports and hashes, deterministic placement report,
content-free conflict/rubric review, migration collision report, test output,
privacy scan, gate-policy decision, and a mechanical selection/stop record.

## Demonstration

The product owner examines synthetic/de-identified dev data and scratch scopes
only:

1. Capture a clear topical thought whose v2 existing ID agrees with the top
   geometric bucket.
   End-user experience: the CLI prints `Filed in Project Atlas`; the detail
   view shows the thought and source, not an ID.
2. Capture a commitment containing a named person and deadline while the model
   proposes another bucket.
   End-user experience: the CLI prints `Filed in Tasks` and retains the person,
   task title, and deadline.
3. Capture a genuinely new durable topic whose name passes every validator and
   duplicate check.
   End-user experience: the CLI prints `Created new bucket Vendor Contracts —
   filed`; future desktop shows the new human-readable bucket without a
   confirmation interruption.
4. Capture a new topic whose first and isolated-retry names both fail; edit,
   confirm, replay confirmation, and reject a second pending item.
   End-user experience: the first item asks `Create new bucket Y?`; edit shows
   the canonical preview; confirmation creates/files once; replay says
   `Already filed`; rejection creates nothing.
5. Propose a near-duplicate and a model/geometry mismatch.
   End-user experience: Donna shows likely existing human names and asks for a
   choice; it never silently joins or creates.
6. Inject an unknown/cross-scope ID and prompt instructions attempting to
   bypass Tasks and approve creation.
   End-user experience: Donna shows a safe review message, no ID or stack
   trace, and storage evidence shows zero side effects.
7. Restart with one unresolved pending placement, then export and delete the
   scratch participant.
   End-user experience: review restores the pending choice; export contains it
   privately; deletion returns verified zero counts.
8. Open the three dev reports and mechanical eligibility record.
   End-user experience: proposal, deterministic final, mint, task, provenance,
   latency, and review metrics are visibly separated with counts and an
   explicit eligible/stop result.
9. Compare repository hashes/paths for validation-v3 and fresh-blind state.
   End-user experience: the product owner sees `VALIDATION-V3 UNCHANGED` and
   `NO FRESH RESULTS`; no held-out command is run.
10. Review the versioned graduation-gate migration before any future blind
    collection.
    End-user experience: the decision screen states `GATE v2: FINAL PLACEMENT
    >= 0.85`, retains model route/name diagnostics, and shows manual
    implementation acceptance still pending.

## Rollback

- Keep v1 schema/prompt/provider parsing available and make the v2 product lane
  config-selectable until 6.7 acceptance. Rollback selects the pre-6.7 v1
  contract/config; it does not select a model in code.
- Use additive SQL migration with a tested down migration. Do not drop pending
  records while unresolved; export or resolve them before schema rollback.
- If v2 fails any dev floor, disable v2 before any validation/fresh run and
  preserve the failed plan/reports/hashes as audit history.
- If validated-immediate mint is disabled during rollback, unresolved pending
  records remain private/reviewable; already valid user buckets/items are not
  deleted or rewritten.
- Reverting v2 routing code must not revert user corrections, rename/merge
  history, Tasks consistency, or existing buckets/items.
- Canonical-key backfill never merges data. If legacy collisions block the
  migration, stop and request human resolution; do not weaken uniqueness.
- No threshold, label, scorer, or historical validation artifact is changed to
  make rollback evidence appear successful.

## Definition of done and required completion evidence

Before this specification can move to `in-review`, record:

- draft product-owner resolutions recorded here, later implementation
  approval, the one-off 6.6 dependency exception, and the versioned
  graduation-gate migration;
- commit IDs and exact changed files/interfaces/migrations;
- v1/v2 schema/prompt/config hashes and no-label/no-scope audit;
- the approved deterministic decision table, synthetic near-duplicate
  calibration, and frozen `0.90`-candidate threshold/config hashes;
- file/PostgreSQL parity, RLS, migration up/down/backfill collision evidence;
- comprehensive unit/integration/security/CLI results and full test/typecheck;
- the locked dev envelope/plan hashes and exactly three fixed live dev reports;
- every strict floor with numerator/denominator and replicate values;
- proposal versus deterministic-final disagreement/override analysis;
- minted decision precision/recall, exact diagnostic, and blinded five-part
  usefulness review;
- task detail preservation, Tasks injection resistance, user-correction
  ground truth, unknown-ID zero-side-effect, and provenance evidence;
- validated-immediate mint, isolated naming retry, and pending review
  restart/idempotency/concurrency/export/deletion evidence;
- user-facing CLI output and future desktop state demonstration with no IDs;
- unchanged validation-v3/fresh-blind hashes and proof no held-out/final run
  occurred prematurely;
- rollback rehearsal, known limitations, and any split follow-up spec; and
- explicit product-owner accept/reject decision. Phase 7 remains blocked.

## Completion evidence

Implementation is approved (2026-09-05). Evidence is appended below as
implementation and verification complete.

### Implementation evidence (2026-09-05)

**Commits (in order):**

- `5957650` docs: approve spec 6.7 structured bucket routing
- `96cce55` feat: structured bucket routing and governed minting (spec 6.7)
- `a1fc652` evals: normalize 6.7 plan artifacts to LF and relock hashes
- `0d4ebba` test: spec 6.7 decision-table, pending, schema, pipeline, CLI,
  and eval-machinery coverage
- `37af326` evals: calibrate and freeze near-duplicate threshold at 0.88
  (synthetic fixtures)
- `086f6e2` evals: void pre-calibration replicates, normalize candidate
  config to LF, relock 6.7 plan at 0.88

**Changed files / interfaces:**

- `packages/core/src/types.ts` — `PlacementProposal`, `PendingPlacement`,
  `PendingPlacementResolution`, `PlacementCandidate`,
  `PendingPlacementReason`, `PlacementOutcome`; `CoreLoopResult` gains
  `pendingPlacements`. No `Thought`/`TaskCandidate` content expansion.
- `packages/core/src/ports.ts` — `BucketOption`, `OrganizeOutputV2`,
  `OrganizerV2`, `BucketNamer` (isolated naming-only port),
  `PendingPlacementStore`; `BucketStore` gains scoped `getBucketById`.
- `packages/providers/src/organize-schema.ts` — `donna.organize.v2` strict
  discriminated Zod + JSON schemas, `donna.organize-naming.v1`, v4
  structured prompt with the dedicated allowlist rendered identically in
  both branches, `nameContainsIdReference`; v1 retained byte-identical.
- `packages/providers/src/openai-organizer-v2.ts`,
  `anthropic-organizer-v2.ts` — adapter validation incl. ID-in-new-name
  rejection; `openai-organizer-v2.ts` also implements the isolated namer.
- `packages/providers/src/registry.ts` — config-selected `contract`
  (v1 default for rollback, v2 for 6.7), `near_duplicate_threshold`
  (default 0.90), v2 organizer/escalation/namer resolution.
- `packages/buckets/src/canonical.ts` — NFKC display canonicalization,
  canonical validators (1–4 words, no sentence punctuation/dates/
  deadlines/urgency/imperatives/one-off wording/IDs/control chars),
  canonical comparison key, lexical containment, descriptor builder.
- `packages/buckets/src/engine-v2.ts` — `StructuredBucketEngine`: Tasks
  absolute (conflict diagnostic), allowlist fail-closed (`unknown-id`),
  agreement auto-file, middle-band/mismatch/new-vs-existing pending,
  validated-immediate mint, exact/lexical/semantic duplicate checks at the
  frozen 0.88 descriptor threshold, atomic `revalidateMint`.
- `packages/buckets/src/pending-store.file.ts` — durable scoped pending
  store (restart-safe, idempotent resolution, deletion propagation).
- `packages/buckets/src/pending-resolution.ts` — idempotent
  create/file-existing/edit-name/reject with atomic revalidation and
  crash/replay repair.
- `packages/buckets/src/store.file.ts` — canonical-name uniqueness before
  append, idempotent `saveItem` (PG parity), per-file write
  serialization for concurrent placements.
- `packages/storage-postgres/src/pending-store.pg.ts`,
  `bucket-store.pg.ts` — RLS-protected pending store, canonical key on
  create/rename, scoped `getBucketById`.
- `database/migrations/0002_pending_placements_and_canonical_keys.{up,down}.sql`
  — additive/reversible; fail-closed collision-reporting backfill; down
  refuses to drop unresolved pending records.
- `packages/pipeline/src/run.ts` — v2 lane: full scoped allowlist,
  pipeline-side referential validation, exactly one escalation, at most
  one isolated naming retry, pending persistence, extraction immutable,
  token-only telemetry.
- `apps/cli/src/main.ts`, `placements.ts` — exact user-facing states
  (`Filed in X`, `Created new bucket Y — filed`, `Create new bucket Y?`,
  `Review needed: A or B?`, safe unknown-ID message), `donna review
  placements` + idempotent resolve, export/leave/delete propagation.
- `packages/pilot/src/onboarding.ts` — pending placements in the private
  export bundle.
- `packages/evals/src/datasets.ts` — additive per-case opaque fixture IDs
  (`eval-b-*`), uniqueness validation.
- `packages/evals/datasets/golden/organize/organize.dev.v2.json` — dev v60
  content + additive fixture IDs (28 cases; validation-v3 untouched).
- `packages/evals/src/scorers/organize-v2.ts` — real-pipeline scorer with
  separated MODEL PROPOSAL / DETERMINISTIC FINAL / MINT QUALITY /
  TASK/PROVENANCE metric families; labels never enter prompts.
- `packages/evals/src/organize-v2-experiment.ts` + `cli.ts` — locked plan,
  three fixed replicates, common aggregation, mechanical floors/stop,
  blinded-review packet, gate-migration readiness record.
- `packages/evals/experiments/organize/6.7/` — locked plan
  (`9250477c4dc3fd367db6fd35fd8c2ef049eb0c67bd8be263f47b34f29bb12e2f`),
  candidate config snapshot, synthetic calibration report.
- `models.config.yaml` — gpt-5-mini only (default + escalation), contract
  v2, prompt v4-structured, frozen `near_duplicate_threshold: 0.88`.
- `docs/pilot/RUNBOOK.md` — structured-routing capture states, review
  commands, pending export/deletion coverage.

**Near-duplicate threshold calibration (synthetic fixtures only, frozen
before live dev results):** 12 synthetic pairs through the config-selected
embedder (text-embedding-3-large@1024). The 0.90 initial candidate missed
2/6 near-duplicates (0.88553, 0.89500) with zero false positives and a
distinct-pair ceiling of 0.38451; 0.88 separates every synthetic pair
(false negatives 0, false positives 0) and errs toward review. Frozen at
**0.88** in `models.config.yaml`, the candidate snapshot, and the locked
plan (`calibration.json` sha256
`296ec152fb6afe0d2955695d994336276e38ae4b03bf640a89000391318fa4aa`).
A replicate started at 0.90 before calibration completed was voided
before any aggregation or interpretation; no best-of-three occurred.

**Test results (2026-09-05, local):** full `npm test` 606 tests, 605 pass,
0 fail, 1 environment-gated skip (PostgreSQL suite runs in CI);
`npm run typecheck` clean across all workspaces; dataset validation green
including `organize.dev.v2`; deterministic baseline check green
(adversarial/provenance/buckets/memory/emotion/retrieval/full-loop all
pass vs accepted baselines). New focused coverage: schema mutual
exclusion/strictness, prompt allowlist parity and no-label audit, the full
engine decision table (Tasks override, agreement auto-file, middle band,
mismatch, new-vs-existing, valid mint, exact collision, lexical and
semantic near-duplicate, naming retry once, second failure pending,
unknown-ID zero writes, no-fit fallback), pending restart/idempotency/
replay/concurrency/crash-repair, pipeline v2 (escalation exactly once,
Tasks vs injection, provenance fail-closed, extraction immutability), CLI
end-to-end review flow with no IDs in output, eval metric separation,
plan immutability, and floor evaluation including the mint-specific
failure signal.

### Live dev experiment result (2026-09-05): STOP — STRUCTURED ROUTING FAILED

Three fixed live replicates of the locked structured baseline S
(gpt-5-mini, `donna.organize.v2`, prompt v4-structured, frozen
near-duplicate threshold 0.88) ran against the frozen dev envelope
(`organize.dev.v2`, 28 cases, sha256 `79eeb575…`). No best-of-three, no
omitted run, no post-result mutation. Every replicate: 28/28 cases, zero
external errors, zero product errors, zero hard failures; provenance 1.0,
schema 1.0, Tasks hard-rule 1.0 in every replicate (blocking safety
invariants all pass). Reports: `packages/evals/reports/organize/6.7/S/`
(replicate-1..3, hashes recorded in `experiments/organize/6.7/eligibility.json`).

Aggregated metrics (arithmetic mean of the three run means) versus the
binding floors, from the mechanical eligibility record:

| Floor | Threshold | Actual | Result |
|---|---|---|---|
| thought coverage | >= 0.97 | 1.00000 | PASS |
| task recall | >= 0.95 | 1.00000 | PASS |
| task precision (no regression vs A baseline) | >= 0.82143 | 0.70238 | **FAIL** |
| provenance fidelity | 1.0 | 1.00000 | PASS |
| schema/referential validity | 1.0 | 1.00000 | PASS |
| Tasks hard rule | 1.0 | 1.00000 | PASS |
| join-by-ID accuracy | >= 0.90 | 0.64912 | **FAIL** |
| join-vs-mint decision accuracy | >= 0.90 | 0.75000 | **FAIL** |
| canonical minted-name validator pass | >= 0.90 | 1.00000 | PASS |
| deterministic final placement acceptance | >= 0.90 | 0.44048 | **FAIL** |
| organizer p90 latency | <= 20,000 ms | 16,946 ms | PASS |
| product/external/hard failures | 0 | 0 | PASS |
| per-replicate safety invariants | all pass | all pass | PASS |
| deterministic suites (decision table, concurrency/replay, security, parity) | all pass | all pass | PASS |
| blinded minted-name usefulness | >= 0.85 | not evaluated | moot (floors already failed) |

Mandatory diagnostics (counts beside rates in the reports): mint decision
precision 0.67143, recall 0.48148; joined override/conflict rate 0.22807;
review pending rate 0.21429; minted exact-name reproducibility diagnostic
0.22222 (6.6 candidate A was 0.33333).

**Outcome: STOP — STRUCTURED ROUTING FAILED** (mechanical record:
`experiments/organize/6.7/eligibility.json`). `mintSpecificFailure` is
**false**: the failure is NOT mint-only. Canonical name validation passed
perfectly (1.0), but the routing layer itself missed its floors —
join-by-ID 0.649 and final placement 0.440 — and task precision regressed
below the 6.6 A baseline.

**Honest reading against the calibrated expectations:** the product owner
expected join accuracy to improve substantially from the structural fix.
Measured join-by-ID accuracy (0.649) did not improve over 6.6 A's joined
exact-name rate (0.667) on this envelope — the structural
existing-by-ID contract did not fix the underlying route-choice reasoning
problem, and the conservative agreement rule converts every
model/geometry disagreement into pending review (pending rate 0.214),
which caps deterministic final acceptance. Mint naming validity is fixed
(validator pass 1.0), but mint decision recall (0.481) and exact-name
reproducibility (0.222) remain poor — consistent with the product owner's
expectation that mint quality may still fail on the same underlying
reasoning problem.

**Limitations / deviations:**

- The deterministic-final metric seeds eval bucket centroids from
  name+description descriptor embeddings (the harness has no member
  thoughts); production centroids are member-thought embeddings. This
  deterministic choice was committed before any run and was not changed
  after results; it may depress geometry/model agreement relative to
  production.
- Blinded minted-name usefulness was not evaluated: the floors failed
  before it could matter. The private blinded packet (27 items) is
  prepared for the product owner at
  `reports/organize/6.7/blinded-review/` should a diagnostic review still
  be wanted; it cannot change the STOP outcome.
- A pre-calibration replicate at the 0.90 candidate was voided before
  aggregation or interpretation (recorded above); the binding three
  replicates all ran at the frozen 0.88.

**What was NOT done (per protocol):** no validation-v3 run, no fresh P-00
matrix, no held-out/final/graduation run, no prompt/model retry, no
threshold or label tuning after results, no gate migration. Validation-v3
bytes, locks, and history are unchanged (`git diff` empty for those
paths). Phase 7 remains blocked.

**Product-owner decision: PENDING.** The evidence supports a narrow
follow-up discussion: mint naming validation worked, but route-choice
reasoning (join-by-ID and join-vs-mint) is the failing layer — a future
specification should target routing reasoning (e.g. richer per-bucket
signal, few-shot routing exemplars, or a different decision split), not
repeat this architecture or mint naming. Awaiting the product owner's
examination and direction.

## Product-owner decision

**Approved for implementation (product owner, 2026-09-05).** The product
owner approved this specification on 2026-09-05 with calibrated expectations,
recorded verbatim:

> Join accuracy should improve substantially from the structural fix; mint
> quality may still fail because the same underlying reasoning problem
> remains. If it fails specifically on minting, that evidence should justify
> a narrow mint-focused follow-up rather than repeating this architecture.
> Security, provenance, Tasks, and tenant isolation are not weakened, and
> this specification alone never unlocks Phase 7.

The ten decisions below are binding. Implementation, the dev-only
schema/eval migration, config changes, synthetic-fixture threshold
calibration, and the three fixed live dev replicates are now authorized.
Validation-v3 runs, a fresh P-00 matrix, held-out/final/graduation runs, and
Phase 7 remain unauthorized until dev eligibility passes and the product
owner separately approves the next step.

Prior state: architecture resolved 2026-09-05 with implementation approval
pending; that approval is now granted as recorded above.

## Review gate

Status is `approved` (product owner, 2026-09-05; see Product-owner decision).
Set status to `in-review` only when all strict dev floors and evidence
requirements pass. If structured routing fails, stop: no full-stage prompt/model retry,
label edit, threshold weakening, validation-v3, fresh blind, held-out, or
graduation attempt. The one isolated naming retry is the sole approved retry.
Explicit product-owner acceptance is required before any later specification
or Phase 7 work.

## Open questions for the product owner

1. **Dependency lifecycle (recommended first):** approve a narrow execution
   protocol exception for remediation evidence: mark 6.6 `rejected` with its
   immutable `NONE` evidence preserved, and allow 6.7 to depend on that failed
   evidence despite the accepted-dependency rule. Alternative: amend
   `EXECUTION.md` with a general rejected/blocked-remediation dependency type.
   Which governance path should bind before 6.7 can be approved?
   - **Resolved (product owner, 2026-09-05):** mark 6.6 `rejected`, preserve
     its immutable failed evidence, and authorize 6.7 as a one-off narrow
     remediation dependency exception. Do not amend `EXECUTION.md` and do not
     treat this as a reusable protocol exception.

2. **Final deterministic decision policy (recommended: geometry veto,
   agreement auto-files):** auto-file only when allowlisted model ID equals
   top geometry and clears `assign_threshold`; queue every mismatch/mid-band/
   new-versus-existing case. Alternative: let model preference break a
   pre-registered narrow geometric tie. Should 6.7 use the conservative
   agreement rule, or define a tie margin and its review threshold?
   - **Resolved (product owner, 2026-09-05):** use conservative agreement.
     Tasks always route to Tasks; high-band auto-file requires the exact
     allowlisted model ID to agree with top geometry; middle-band and every
     disagreement remain pending; below create threshold may consider mint;
     user correction remains ground truth. Similarity alone never silently
     joins or creates.

3. **Allowlist scale (recommended: full scoped list for the CLI pilot):**
   render every current bucket ID/name/description in a dedicated section so
   context budgets cannot produce false-new proposals; measure prompt tokens
   and latency. Alternative: a deterministic shortlist plus a mandatory
   geometry check over all buckets, which reduces tokens but increases review
   and omission risk. What bucket-count/token boundary, if any, should trigger
   a separately approved shortlist policy?
   - **Resolved (product owner, 2026-09-05):** use the full scoped
     ID/name/description allowlist for the CLI pilot and measure tokens/latency.
     There is no shortlist in 6.7; any future shortlist requires a separate
     approved specification.

4. **Mint lifecycle (historical alternatives):** choose validated-immediate,
   confirmation-first pending, or provisional/refine naming. How should the
   36/81 all-five-useful result balance capture flow against bucket quality?
   - **Resolved (product owner, 2026-09-05):** validated-immediate. Auto-create
     only below `create_threshold` when every canonical validator passes and
     no exact/lexical/semantic near-duplicate exists. Retry only the isolated
     naming stage once after naming failure; if it still fails, persist
     pending. Disagreement, middle-band, unknown/invalid routing, and duplicate
     conflict also remain pending with confirm/edit/reject/file-existing.

5. **Graduation gate meaning (recommended: migrate, but only after dual
   evidence):** replace the gate source with versioned deterministic
   final-placement acceptance while retaining proposal route/name metrics as
   diagnostics; keep the numerical `0.85` threshold unless separately changed.
   Alternative: keep proposal exact-name acceptance as the gate even though the
   engine, not the proposal, decides placement. Which metric represents
   first-pass user acceptance? No implementation changes before separate draft
   approval.
   - **Resolved (product owner, 2026-09-05):** after dual dev evidence passes
     and before fresh results, explicitly version and migrate the gate source
     to deterministic final-placement acceptance—the user-facing final bucket.
     Retain route/name metrics as diagnostics, keep `0.85` unchanged, and
     never use blinded review to override the metric.

6. **Task/person extraction scope (recommended: separate):** preserve and test
   current summary/text plus `TaskCandidate.assigneeHint`/`dueHint` in 6.7.
   Put normalized people entities or richer task-detail structure in a later
   specification because it changes storage, retrieval, corrections, export,
   and eval labels. Should any extraction schema expansion be pulled into 6.7?
   - **Resolved (product owner, 2026-09-05):** complete extraction before
     routing and preserve current atomic thought, task, `assigneeHint`,
     `dueHint`, names/deadlines, and provenance fields. Routing/naming cannot
     damage them. Defer richer normalized people entities and expanded task
     schema to a later specification.

7. **Uncertainty UX (recommended: auto-file only high agreement; review every
   conflict):** should a high-similarity geometry winner auto-file when the
   model selected another allowlisted bucket, with an explicit `rules
   overrode proposal` review flag, or should disagreement remain pending with
   no item placement? This choice affects retrieval availability and review
   burden, but may never weaken Tasks.
   - **Resolved (product owner, 2026-09-05):** every model/geometry
     disagreement and every middle-band case remains pending with no retrieval
     placement until the user resolves it. Show human names/options only; no
     IDs.

8. **Near-duplicate semantic threshold (recommended: separate locked config,
   calibrated before live dev results):** use canonical exact/lexical rules
   plus a descriptor-embedding threshold distinct from the existing
   thought-centroid thresholds; freeze model/config/threshold in the plan.
   Alternative: reuse `assign_threshold`, although it was not calibrated for
   name+description comparison. Which policy and initial threshold should be
   approved?
   - **Resolved (product owner, 2026-09-05):** use a separate locked config
     value with initial candidate `0.90`; calibrate only on synthetic fixtures
     before live dev results, then freeze. Do not reuse `0.82`.

9. **Minimum dev evidence (recommended: three fixed live replicates plus the
   deterministic full decision suite):** retain Spec 6.6's three-replicate
   common aggregation/no-best-of-three protocol on the frozen dev envelope,
   require all concrete floors above, and stop on any failure. Is that
   sufficient before one validation-v3 regression run, or should dev require
   more adjudicated structured-routing cases—especially new-needed and
   mismatch cases—before validation?
   - **Resolved (product owner, 2026-09-05):** three fixed live replicates
     plus the complete deterministic decision-table/concurrency/security suite
     on frozen dev. No best-of-three. Stop on any floor failure; do not run
     held-out or collect/run a fresh matrix until all floors pass.

10. **Potential split:** the pending-placement persistence/migration and review
   UX are necessary for the recommended `Create new bucket Y?` behavior, but
   they are larger than the organizer schema change. Recommended: keep them in
   6.7 because otherwise implementation would still mint silently and fail the
   product outcome. Split only richer person/task extraction and any later
   auto-mint-after-repeated-evidence policy. Does the product owner agree?
   - **Resolved (product owner, 2026-09-05):** keep pending persistence and
     review UX in 6.7 because invalid/conflicting routes and failed naming
     retry need durable safe handling. Defer only richer extraction and any
     later auto-mint-after-repeated-evidence policy.
