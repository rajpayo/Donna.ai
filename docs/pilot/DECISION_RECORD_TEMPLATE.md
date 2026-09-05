# Graduation decision record — TEMPLATE

Specification 6.3. Copy this file to `DECISION-<date>.md`, fill every
field, and sign. The decision is manual; the report is only evidence.

---

- **Decision date:**
- **Product owner (name):**
- **Decision:** ACCEPT graduation / REJECT graduation
- **Graduation report:** `packages/evals/reports/graduation/<file>.json`
- **Report hash (from the report header):** `sha256:…`

## Candidate under decision

- **Commit:** (must match the report freeze; a dirty tree is not gradable)
- **models.config.yaml sha256:**
- **Dataset versions:** (per stage, from the report freeze)
- **Cohort window:** (pilot start → end)

## Gate results reviewed

| Gate | Measured | Threshold | Pass? |
|---|---|---|---|
| atomic-thought coverage |  | ≥ 95% |  |
| task recall |  | ≥ 95% |  |
| first-pass bucket acceptance |  | ≥ 85% |  |
| valid provenance |  | 100%, zero hard failures |  |
| retrieval success |  | ≥ 80% |  |
| tenant-isolation failures |  | zero |  |
| duplicate external actions |  | zero |  |

## Evidence examined

- [ ] Every gate's linked evidence report opened and checked
- [ ] Quality distributions reviewed (not just means — min/p90)
- [ ] Cohort slices reviewed (small groups suppressed is expected)
- [ ] Latency and token/cost proxy reviewed
- [ ] Correction trends reviewed
- [ ] Misfire board reviewed: zero unresolved, zero blocks-graduation
- [ ] Retention verification reviewed: zero 7-day policy violations
- [ ] Privacy incidents: zero
- [ ] Known limitations read; affected users/workflows named and accepted
- [ ] At least one private live demonstration observed (capture → review →
      correction → retrieval)

## Reasons (required — the exact grounds for accept or reject)

>
>

## If REJECTED — focused remediation plan

(What must change, which gate/misfire it clears, and how it will be
re-measured. A rejection returns the specification to `draft` per the
execution protocol.)

-
