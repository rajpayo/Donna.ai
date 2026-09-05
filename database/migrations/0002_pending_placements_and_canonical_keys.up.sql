-- Specification 6.7 — pending placements + per-user canonical bucket-name key.
--
-- Additive and reversible (see 0002_*.down.sql). No existing bucket is
-- merged, renamed, or deleted (SR-11). The canonical-name backfill is
-- FAIL-CLOSED: any legacy collision stops the migration with a reviewed
-- collision report (the raised error lists the colliding scopes/keys);
-- human resolution is required before re-applying.
--
-- Note: the application canonical key is Unicode NFKC + case fold +
-- punctuation/whitespace fold + token normalization. SQL has no NFKC, so
-- the backfill uses lower() + punctuation/whitespace folding, which is
-- equivalent for the existing ASCII fixture data; the application
-- recomputes the full canonical key on every create/rename.

/* --------------------- buckets: canonical name key ------------------ */

ALTER TABLE buckets ADD COLUMN canonical_name_key text;

UPDATE buckets
   SET canonical_name_key =
     trim(regexp_replace(lower(name), '[[:punct:][:space:]]+', ' ', 'g'));

-- Fail-closed collision report: abort when the backfilled key collides
-- within a scope. No automatic merge is allowed (SR-11).
DO $$
DECLARE
  collision RECORD;
  report text := '';
BEGIN
  FOR collision IN
    SELECT tenant_id, user_id, canonical_name_key, count(*) AS n
      FROM buckets
     GROUP BY tenant_id, user_id, canonical_name_key
    HAVING count(*) > 1
  LOOP
    report := report || format(
      'scope %s/%s key "%s" x%s; ',
      collision.tenant_id, collision.user_id, collision.canonical_name_key, collision.n
    );
  END LOOP;
  IF report <> '' THEN
    RAISE EXCEPTION 'canonical-name backfill collision(s) — resolve manually, no automatic merge: %', report;
  END IF;
END $$;

ALTER TABLE buckets ALTER COLUMN canonical_name_key SET NOT NULL;

-- Per-user canonical uniqueness. The existing case-insensitive unique
-- index (buckets_unique_name) is retained during migration.
CREATE UNIQUE INDEX buckets_unique_canonical_name
  ON buckets (tenant_id, user_id, canonical_name_key);

/* ------------------------ pending placements ------------------------ */

-- Durable scoped pending placement review (FR-8/FR-9): the minimum
-- verified thought + proposal needed to resolve filing (SR-6). Excluded
-- from retrieval; covered by scoped export/deletion.
CREATE TABLE pending_placements (
  tenant_id             text        NOT NULL,
  user_id               text        NOT NULL,
  id                    text        NOT NULL,
  thought               jsonb       NOT NULL,
  proposal              jsonb,
  reason                text        NOT NULL
    CHECK (reason IN ('unknown-id', 'invalid-route', 'middle-band',
                      'model-geometry-mismatch', 'new-vs-existing',
                      'possible-existing-match', 'naming-invalid')),
  naming_failures       jsonb,
  candidates            jsonb       NOT NULL,
  recommended_bucket_id text,
  allowlist_hash        text        NOT NULL,
  status                text        NOT NULL
    CHECK (status IN ('pending', 'resolved')),
  resolution            jsonb,
  created_at            timestamptz NOT NULL,
  resolved_at           timestamptz,
  PRIMARY KEY (tenant_id, user_id, id)
);

CREATE INDEX pending_placements_by_status
  ON pending_placements (tenant_id, user_id, status, created_at);

ALTER TABLE pending_placements ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_placements FORCE ROW LEVEL SECURITY;

CREATE POLICY scope_isolation ON pending_placements
  USING (tenant_id = current_setting('app.tenant_id', true)
     AND user_id  = current_setting('app.user_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
          AND user_id  = current_setting('app.user_id', true));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'donna_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON pending_placements TO donna_app';
  END IF;
END $$;
