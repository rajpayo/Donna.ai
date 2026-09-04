# Local Windows maintenance evidence — 2026-09-04

This is corrective maintenance for accepted Phases 2–6, authorized by the
product owner after moving development from a cloud worker to Windows 11. It
does not start Phase 7 or alter any graduation threshold.

## Corrected findings

- The imported local folder lacked Git metadata. It was verified byte-equivalent
  to PR #1 (line endings only) and restored at commit `241b20b` without replacing
  `.env`, pilot data, or recordings.
- Unit tests no longer require `espeak-ng` when the transcriber itself is
  stubbed. Production STT evaluation still uses the real synthetic-audio
  generator and reports its absence honestly.
- Configuration snapshots resolve detached GitHub PR checkouts from
  `GITHUB_HEAD_REF`/`GITHUB_REF_NAME`; no feature branch is hard-coded.
- Calendar values without an ISO suffix now honor an explicit UTC/GMT marker.
  Unsupported suffix-free zones fail closed instead of silently using the host
  timezone.
- Private file adapters now use `@donna/file-security`: POSIX mode enforcement
  on Unix and owner+SYSTEM ACL enforcement on Windows. CLI processing fails
  closed when its data root cannot be protected.
- Deterministic CI now provisions a digest-pinned PostgreSQL 16 + pgvector 0.8.1
  service and runs the RLS, migration, concurrency, retrieval, backup, and
  restore integration tests on every PR.

## Verification

- Commits: `a8eeaf1`, `251d320`.
- Local Windows:
  - `npm test`: 451 passed, 0 failed, 1 database-gated RLS check skipped; the
    nine-test PostgreSQL package remained gated because no local database is
    installed.
  - `npm run typecheck`: clean across every workspace.
  - eval dataset validation: all 9 registered datasets valid.
  - deterministic baseline check: adversarial, provenance, buckets, memory,
    emotion, retrieval, and full-loop all passed with zero hard failures.
- GitHub deterministic check:
  [run 33866196028](https://github.com/rajpayo/Donna.ai/actions/runs/33866196028)
  passed in 1m11s.
  - 461 tests passed, 0 failed, 0 skipped (the previous 455 plus 6 new
    portability/security tests).
  - PostgreSQL storage: 9/9 passed; the separate eval-tenant RLS proof passed.
  - Typecheck, all dataset validations, and every deterministic baseline passed.
- The P-00 runtime was copied to `%LOCALAPPDATA%\Donna.ai\data`: 16/16 files
  matched by SHA-256, the enrolled profile and counts reloaded successfully,
  and the old broadly inherited repository copy was deleted after explicit
  product-owner confirmation.

## Boundaries and rollback

- No model selection, prompt, dataset label, consent, or graduation gate changed.
- No secret, transcript, recording, or private path content is included here.
- The credentialed live-gateway job remains manual and skipped on PRs by design.
- Roll back code with the two commits above. A runtime-path rollback must first
  copy the private data to another owner-controlled directory; do not restore it
  under a location whose ACL Donna cannot secure.
- Phase 7 remains locked by the existing 0.833 first-pass bucket-acceptance
  report until pilot-grown evidence passes every gate or the product owner
  records an explicit override.
