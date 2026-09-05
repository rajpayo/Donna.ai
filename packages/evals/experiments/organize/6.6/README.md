# Organizer experiment 6.6

`plan.json` and `plan.lock.json` are immutable before the first binding result.
The lock hashes the exact plan bytes; every command fails hard on drift.

This binding plan contains A, A0, and B only (three fixed dev replicates each,
nine runs total). No authoritative TrueFoundry tariff artifact was supplied,
so Candidate C is excluded from eligibility, manifests, capability preflight,
and runs. There is deliberately no Candidate C config file here. Generic
tooling and offline tests retain the approved tariff-gated 12-run path for
separately authorized future research.

The candidate YAML files are complete `models.config.yaml` snapshots. The
normal provider registry resolves provider, model, prompt version, and
temperature; experiment code contains no model-specific candidate branch.

`rubric.json` is the immutable expected-label/candidate-blind minted-name
rubric. Any generated review packet remains owner-only and gitignored. Only a
content-free completed review record may be committed as `review.json`.
