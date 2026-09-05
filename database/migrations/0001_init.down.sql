-- Specification 3.2 — full rollback of 0001_init.
-- Dropping the tables drops their policies and indexes with them.

DROP TABLE IF EXISTS retrieval_index   CASCADE;
DROP TABLE IF EXISTS corrections       CASCADE;
DROP TABLE IF EXISTS consents          CASCADE;
DROP TABLE IF EXISTS memory_events     CASCADE;
DROP TABLE IF EXISTS memory_proposals  CASCADE;
DROP TABLE IF EXISTS memories          CASCADE;
DROP TABLE IF EXISTS items             CASCADE;
DROP TABLE IF EXISTS buckets           CASCADE;
DROP TABLE IF EXISTS transcripts       CASCADE;
DROP TABLE IF EXISTS captures          CASCADE;

DROP EXTENSION IF EXISTS vector;
