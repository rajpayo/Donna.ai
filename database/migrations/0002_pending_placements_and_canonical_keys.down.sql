-- Specification 6.7 — rollback for pending placements + canonical keys.
--
-- Additive-down only: unresolved pending records must be exported or
-- resolved BEFORE schema rollback (see the spec's Rollback section); this
-- down migration refuses to drop unresolved pending placements.
-- Existing buckets/items are never deleted or rewritten.

DO $$
DECLARE
  unresolved bigint;
BEGIN
  SELECT count(*) INTO unresolved FROM pending_placements WHERE status = 'pending';
  IF unresolved > 0 THEN
    RAISE EXCEPTION 'rollback refused: % unresolved pending placement(s) — export or resolve them first', unresolved;
  END IF;
END $$;

DROP TABLE IF EXISTS pending_placements;

DROP INDEX IF EXISTS buckets_unique_canonical_name;
ALTER TABLE buckets DROP COLUMN IF EXISTS canonical_name_key;
