---
id: "NN-NN"
title: "Specification title"
phase: "NN"
status: "draft"
depends_on: []
---

# Specification NN.N — Title

## Outcome

Describe one observable user or system outcome.

## Why this comes now

State the accepted dependency or risk that makes this the next specification.

## Scope

- Required behavior.
- Required interfaces and data.
- Required documentation and operations.

## Non-goals

- Behavior deliberately deferred to a named later specification.
- Adjacent cleanup that must not expand this implementation.

## Expected repository changes

List proposed existing files and new packages. These paths remain proposals
until the specification is approved.

## Functional requirements

Number every testable requirement as `FR-N`. Every `FR-N` — and every
user-facing action elsewhere in the specification — carries a short
`End-user experience:` note describing concretely what the user sees or does
in the final product when using it: the exact CLI command and what it
prints, or the future desktop-UI surface it feeds. The product owner uses
these notes to check what is actually being built (product-owner directive,
2026-09-05).

## Security, privacy, and provenance requirements

Number every requirement as `SR-N`. Include:

- authenticated tenant/user source;
- tenant filters on every read and write;
- secret handling;
- retention and deletion behavior;
- source provenance;
- log redaction;
- untrusted-content boundaries; and
- external-action approval where applicable.

## Acceptance criteria

Number every measurable outcome as `AC-N`. Avoid subjective phrases such as
“works well” without a metric or demonstration.

## Verification

List the required unit, integration, security, evaluation, and end-to-end
checks. Name the expected report or artifact.

## Demonstration

Describe exactly what the product owner will examine before accepting the
specification. Each demonstration step carries its own `End-user
experience:` note — the exact command the product owner runs or the exact
screen or artifact they open.

## Completion evidence

Leave empty until implementation. Record commits, changed interfaces, test
results, metrics, demo evidence, limitations, and the product-owner decision.

## Review gate

Implementation is forbidden while `status` is `draft`. After implementation
and verification, set `status` to `in-review` and wait for explicit product
owner acceptance before starting the next specification.
