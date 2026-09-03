-- Specification 3.2 — initial transactional schema for Donna.
--
-- Every table carrying personal data has tenant_id + user_id and is
-- protected by row-level security (ENABLED + FORCED) keyed off the
-- per-transaction session context app.tenant_id / app.user_id (set via
-- set_config(..., true) — transaction-local). When the context is unset,
-- current_setting(..., true) returns NULL and every policy fails closed:
-- no rows are visible or writable.
--
-- Monetary/cost rule: no monetary values are persisted in this schema
-- version. Any future cost column MUST be BIGINT minor units or NUMERIC —
-- never float (Spec 3.2 requirement, enforced by review).

CREATE EXTENSION IF NOT EXISTS vector;

/* ----------------------------- captures ----------------------------- */

CREATE TABLE captures (
  tenant_id        text        NOT NULL,
  user_id          text        NOT NULL,
  id               text        NOT NULL,
  content_hash     text        NOT NULL,
  captured_at      timestamptz NOT NULL,
  duration_sec     double precision,
  audio_deleted_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, id)
);

/* ---------------------------- transcripts --------------------------- */

CREATE TABLE transcripts (
  tenant_id    text        NOT NULL,
  user_id      text        NOT NULL,
  capture_id   text        NOT NULL,
  text         text        NOT NULL,
  segments     jsonb       NOT NULL,
  language     text,
  model        text        NOT NULL,
  content_hash text        NOT NULL,
  created_at   timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, user_id, capture_id),
  FOREIGN KEY (tenant_id, user_id, capture_id)
    REFERENCES captures (tenant_id, user_id, id) ON DELETE CASCADE
);

/* ----------------------------- buckets ------------------------------ */

CREATE TABLE buckets (
  tenant_id   text        NOT NULL,
  user_id     text        NOT NULL,
  id          text        NOT NULL,
  name        text        NOT NULL,
  description text        NOT NULL,
  centroid    vector,
  item_count  integer     NOT NULL DEFAULT 0,
  origin      text        NOT NULL CHECK (origin IN ('auto', 'seeded', 'pinned')),
  created_at  timestamptz NOT NULL,
  -- Optimistic-locking version: every stats mutation increments it.
  version     integer     NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, user_id, id)
);

-- Bucket names are unique per user, case-insensitively (the file store
-- matches names case-insensitively; the database enforces it).
CREATE UNIQUE INDEX buckets_unique_name
  ON buckets (tenant_id, user_id, lower(name));

/* ------------------------------ items ------------------------------- */

CREATE TABLE items (
  tenant_id   text        NOT NULL,
  user_id     text        NOT NULL,
  thought_id  text        NOT NULL,
  bucket_id   text        NOT NULL,
  summary     text        NOT NULL,
  text        text        NOT NULL,
  confidence  double precision NOT NULL,
  task        jsonb,
  provenance  jsonb       NOT NULL,
  versions    jsonb       NOT NULL,
  embedding   vector,
  -- Nullable: records persisted before Specification 3.1 may lack a
  -- creation time; time-filtered reads fail closed and exclude them.
  created_at  timestamptz,
  PRIMARY KEY (tenant_id, user_id, thought_id),
  FOREIGN KEY (tenant_id, user_id, bucket_id)
    REFERENCES buckets (tenant_id, user_id, id)
);

CREATE INDEX items_by_bucket ON items (tenant_id, user_id, bucket_id);
CREATE INDEX items_by_capture
  ON items (tenant_id, user_id, (provenance ->> 'captureId'));

/* ----------------------------- memories ----------------------------- */

CREATE TABLE memories (
  tenant_id     text        NOT NULL,
  user_id       text        NOT NULL,
  id            text        NOT NULL,
  layer         text        NOT NULL
    CHECK (layer IN ('working', 'episodic', 'semantic', 'procedural')),
  status        text        NOT NULL
    CHECK (status IN ('confirmed', 'superseded', 'expired')),
  origin        text        NOT NULL CHECK (origin IN ('explicit', 'approved')),
  text          text        NOT NULL,
  kind          text        NOT NULL,
  subject       text        NOT NULL,
  confidence    double precision NOT NULL,
  sources       jsonb       NOT NULL,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  expires_at    timestamptz,
  session_id    text,
  superseded_by text,
  superseded_at timestamptz,
  PRIMARY KEY (tenant_id, user_id, id)
);

CREATE TABLE memory_proposals (
  tenant_id   text        NOT NULL,
  user_id     text        NOT NULL,
  id          text        NOT NULL,
  layer       text        NOT NULL,
  text        text        NOT NULL,
  kind        text        NOT NULL,
  subject     text        NOT NULL,
  confidence  double precision NOT NULL,
  sources     jsonb       NOT NULL,
  proposed_by jsonb       NOT NULL,
  created_at  timestamptz NOT NULL,
  status      text        NOT NULL
    CHECK (status IN ('pending', 'approved', 'rejected')),
  resolved_at timestamptz,
  PRIMARY KEY (tenant_id, user_id, id)
);

-- Append-only lifecycle events: the app role receives INSERT + SELECT
-- only (see grants below) — history cannot be rewritten through the app.
CREATE TABLE memory_events (
  seq         bigint      GENERATED ALWAYS AS IDENTITY,
  at          timestamptz NOT NULL,
  type        text        NOT NULL,
  tenant_id   text        NOT NULL,
  user_id     text        NOT NULL,
  memory_id   text,
  proposal_id text,
  detail      text,
  PRIMARY KEY (seq)
);

CREATE INDEX memory_events_by_scope
  ON memory_events (tenant_id, user_id, seq);

/* ----------------------------- consents ----------------------------- */

-- Append-only consent decisions; latest record per purpose decides.
CREATE TABLE consents (
  id         text        NOT NULL,
  tenant_id  text        NOT NULL,
  user_id    text        NOT NULL,
  purpose    text        NOT NULL,
  granted    boolean     NOT NULL,
  granted_at timestamptz NOT NULL,
  channel    text        NOT NULL,
  PRIMARY KEY (tenant_id, user_id, id)
);

CREATE INDEX consents_by_purpose
  ON consents (tenant_id, user_id, purpose, granted_at);

/* ---------------------------- corrections --------------------------- */

CREATE TABLE corrections (
  id                 text        NOT NULL,
  tenant_id          text        NOT NULL,
  user_id            text        NOT NULL,
  type               text        NOT NULL,
  created_at         timestamptz NOT NULL,
  target             jsonb       NOT NULL,
  payload            jsonb       NOT NULL,
  sources            jsonb       NOT NULL,
  status             text        NOT NULL
    CHECK (status IN ('pending', 'accepted', 'rejected')),
  resolved_at        timestamptz,
  applied_at         timestamptz,
  contradicted_by    text,
  shared_at          timestamptz,
  followed_count     integer     NOT NULL DEFAULT 0,
  contradicted_count integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, user_id, id)
);

/* ------------------------- retrieval projection --------------------- */

-- Rebuildable read-model projection over items (Specification 3.1/3.2).
-- Source of truth remains items/buckets; this table can be truncated per
-- scope and rebuilt. Deleting an item cascades here.
CREATE TABLE retrieval_index (
  tenant_id   text        NOT NULL,
  user_id     text        NOT NULL,
  thought_id  text        NOT NULL,
  bucket_id   text        NOT NULL,
  bucket_name text        NOT NULL,
  summary     text        NOT NULL,
  text        text        NOT NULL,
  tsv         tsvector    NOT NULL,
  embedding   vector,
  has_task    boolean     NOT NULL DEFAULT false,
  people      text[]      NOT NULL DEFAULT '{}',
  memory_ids  text[]      NOT NULL DEFAULT '{}',
  capture_id  text        NOT NULL,
  created_at  timestamptz,
  PRIMARY KEY (tenant_id, user_id, thought_id),
  FOREIGN KEY (tenant_id, user_id, thought_id)
    REFERENCES items (tenant_id, user_id, thought_id) ON DELETE CASCADE
);

CREATE INDEX retrieval_index_tsv ON retrieval_index USING gin (tsv);
CREATE INDEX retrieval_index_by_bucket
  ON retrieval_index (tenant_id, user_id, bucket_id);

/* ----------------------- row-level security ------------------------- */

ALTER TABLE captures          ENABLE ROW LEVEL SECURITY;
ALTER TABLE captures          FORCE ROW LEVEL SECURITY;
ALTER TABLE transcripts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcripts       FORCE ROW LEVEL SECURITY;
ALTER TABLE buckets           ENABLE ROW LEVEL SECURITY;
ALTER TABLE buckets           FORCE ROW LEVEL SECURITY;
ALTER TABLE items             ENABLE ROW LEVEL SECURITY;
ALTER TABLE items             FORCE ROW LEVEL SECURITY;
ALTER TABLE memories          ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories          FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_proposals  ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_proposals  FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_events     FORCE ROW LEVEL SECURITY;
ALTER TABLE consents          ENABLE ROW LEVEL SECURITY;
ALTER TABLE consents          FORCE ROW LEVEL SECURITY;
ALTER TABLE corrections       ENABLE ROW LEVEL SECURITY;
ALTER TABLE corrections       FORCE ROW LEVEL SECURITY;
ALTER TABLE retrieval_index   ENABLE ROW LEVEL SECURITY;
ALTER TABLE retrieval_index   FORCE ROW LEVEL SECURITY;

-- One policy shape per table: the row's tenant/user must equal the
-- transaction-local session context. USING filters reads; WITH CHECK
-- filters writes. An unset context yields NULL and matches nothing.
CREATE POLICY scope_isolation ON captures
  USING (tenant_id = current_setting('app.tenant_id', true)
     AND user_id  = current_setting('app.user_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
          AND user_id  = current_setting('app.user_id', true));

CREATE POLICY scope_isolation ON transcripts
  USING (tenant_id = current_setting('app.tenant_id', true)
     AND user_id  = current_setting('app.user_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
          AND user_id  = current_setting('app.user_id', true));

CREATE POLICY scope_isolation ON buckets
  USING (tenant_id = current_setting('app.tenant_id', true)
     AND user_id  = current_setting('app.user_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
          AND user_id  = current_setting('app.user_id', true));

CREATE POLICY scope_isolation ON items
  USING (tenant_id = current_setting('app.tenant_id', true)
     AND user_id  = current_setting('app.user_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
          AND user_id  = current_setting('app.user_id', true));

CREATE POLICY scope_isolation ON memories
  USING (tenant_id = current_setting('app.tenant_id', true)
     AND user_id  = current_setting('app.user_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
          AND user_id  = current_setting('app.user_id', true));

CREATE POLICY scope_isolation ON memory_proposals
  USING (tenant_id = current_setting('app.tenant_id', true)
     AND user_id  = current_setting('app.user_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
          AND user_id  = current_setting('app.user_id', true));

CREATE POLICY scope_isolation ON memory_events
  USING (tenant_id = current_setting('app.tenant_id', true)
     AND user_id  = current_setting('app.user_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
          AND user_id  = current_setting('app.user_id', true));

CREATE POLICY scope_isolation ON consents
  USING (tenant_id = current_setting('app.tenant_id', true)
     AND user_id  = current_setting('app.user_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
          AND user_id  = current_setting('app.user_id', true));

CREATE POLICY scope_isolation ON corrections
  USING (tenant_id = current_setting('app.tenant_id', true)
     AND user_id  = current_setting('app.user_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
          AND user_id  = current_setting('app.user_id', true));

CREATE POLICY scope_isolation ON retrieval_index
  USING (tenant_id = current_setting('app.tenant_id', true)
     AND user_id  = current_setting('app.user_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
          AND user_id  = current_setting('app.user_id', true));

/* ------------------------------ grants ------------------------------ */

-- The application role gets DML only; append-only tables get no
-- UPDATE/DELETE. Guarded so a clean install works whether or not the
-- role has been created yet (role provisioning is documented in
-- database/README.md).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'donna_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON
      captures, transcripts, buckets, items, memories, memory_proposals,
      corrections, retrieval_index TO donna_app';
    EXECUTE 'GRANT SELECT, INSERT ON memory_events, consents TO donna_app';
  END IF;
END $$;
