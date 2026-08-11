-- Up Migration
--
-- Foundational structure: extensions, the three-schema separation, and the
-- privilege barrier that keeps ODbL-licensed data out of commercial exports.
--
-- See ADR-0001 (provenance segregation). The role grants below are layer 2 of that
-- ADR and are the load-bearing control: contamination becomes a PostgreSQL
-- permission error rather than an application bug.

-- Supabase provisions an `extensions` schema and installs extensions there rather
-- than in `public`. Honour that where it exists, so we match the platform's layout
-- instead of scattering extensions across two schemas; fall back to the default on a
-- vanilla cluster. IF NOT EXISTS makes this a no-op when the platform has already
-- enabled them, which Supabase often has.
--
-- pgcrypto is not needed for gen_random_uuid() on PostgreSQL 13+ (it is built in).
-- It is here for digest(), which Phase 1's hash-chained audit log requires.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
    CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA extensions;
    CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
  ELSE
    CREATE EXTENSION IF NOT EXISTS postgis;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Schemas
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS gt;
COMMENT ON SCHEMA gt IS
  'Canonical proprietary dataset. Exportable. Never contains OSM-derived data.';

CREATE SCHEMA IF NOT EXISTS osm_reference;
COMMENT ON SCHEMA osm_reference IS
  'OpenStreetMap data under ODbL. Basemap tiles and navigation reference ONLY. '
  'Share-alike: must never be joined into gt or reach any commercial export. '
  'See ADR-0001.';

CREATE SCHEMA IF NOT EXISTS reference;
COMMENT ON SCHEMA reference IS
  'Operational reference data: administrative areas used as work-assignment '
  'geofences and QA plausibility envelopes. Not cadastral, never exported. '
  'See DECISIONS.md D-004.';

-- ---------------------------------------------------------------------------
-- search_path for the migration session
--
-- node-pg-migrate sets search_path to its --schema option, which defaults to
-- `public`. That drops `extensions`, so the PostGIS `geometry` type fails to resolve
-- in any later migration — with the thoroughly unhelpful message
-- `type "geometry" does not exist`, which reads like PostGIS is missing rather than
-- merely out of scope.
--
-- Naming a schema that does not exist is legal and silent in PostgreSQL, so this one
-- statement is correct on both a managed platform with an `extensions` schema and a
-- vanilla cluster where PostGIS lands in `public`.
-- ---------------------------------------------------------------------------

SET search_path = gt, reference, extensions, public;

-- ---------------------------------------------------------------------------
-- Roles
--
-- NOLOGIN group roles. Deployment creates login users and GRANTs the appropriate
-- group. Passwords are never set in migrations.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gt_app') THEN
    CREATE ROLE gt_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gt_export') THEN
    CREATE ROLE gt_export NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gt_tileserv') THEN
    CREATE ROLE gt_tileserv NOLOGIN;
  END IF;
END
$$;

-- COMMENT ON ROLE requires true superuser. Managed Postgres generally withholds it
-- (on Supabase only `supabase_admin` has it; the `postgres` role does not), so these
-- are best-effort. They are documentation, and documentation must never be the
-- reason a migration fails to apply — the grants below are what actually matter.
DO $$
BEGIN
  COMMENT ON ROLE gt_app IS 'Application: read/write gt + reference. No osm_reference access.';
  COMMENT ON ROLE gt_export IS 'Export pipeline: read-only gt. No osm_reference access, ever.';
  COMMENT ON ROLE gt_tileserv IS 'Tile server: read-only osm_reference. No gt access.';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'skipping COMMENT ON ROLE: requires superuser (expected on managed Postgres)';
END
$$;

-- ---------------------------------------------------------------------------
-- Revoke the permissive defaults
--
-- PostgreSQL grants USAGE and CREATE on the public schema and USAGE on new schemas
-- to PUBLIC in some configurations. Every role inherits PUBLIC, so leaving this in
-- place would silently hand osm_reference access to gt_export and defeat the
-- entire control.
-- ---------------------------------------------------------------------------

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA gt FROM PUBLIC;
REVOKE ALL ON SCHEMA osm_reference FROM PUBLIC;
REVOKE ALL ON SCHEMA reference FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Grants: gt_app
-- ---------------------------------------------------------------------------

-- USAGE on `public` for all three roles: it holds the shared `provenance` type
-- (migration 1754870401000) and nothing else. Schema USAGE conveys no table access,
-- so this permits naming the type and nothing more.
GRANT USAGE ON SCHEMA public TO gt_app, gt_export, gt_tileserv;

GRANT USAGE ON SCHEMA gt, reference TO gt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA gt TO gt_app;
GRANT SELECT ON ALL TABLES IN SCHEMA reference TO gt_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA gt TO gt_app;

-- ---------------------------------------------------------------------------
-- Grants: gt_export — read-only gt, and nothing else
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA gt TO gt_export;
GRANT SELECT ON ALL TABLES IN SCHEMA gt TO gt_export;

-- ---------------------------------------------------------------------------
-- Grants: gt_tileserv — read-only osm_reference, and nothing else
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA osm_reference TO gt_tileserv;
GRANT SELECT ON ALL TABLES IN SCHEMA osm_reference TO gt_tileserv;

-- ---------------------------------------------------------------------------
-- Default privileges
--
-- Without these, a table created in osm_reference tomorrow carries whatever the
-- creator's defaults are, and the barrier silently develops a hole. These make the
-- separation hold for tables that do not exist yet.
-- ---------------------------------------------------------------------------

ALTER DEFAULT PRIVILEGES IN SCHEMA gt
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gt_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA gt
  GRANT SELECT ON TABLES TO gt_export;
ALTER DEFAULT PRIVILEGES IN SCHEMA gt
  GRANT USAGE, SELECT ON SEQUENCES TO gt_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA reference
  GRANT SELECT ON TABLES TO gt_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA osm_reference
  GRANT SELECT ON TABLES TO gt_tileserv;

-- Belt and braces: explicitly revoke from the roles that must never read OSM data,
-- for tables created in osm_reference in future.
ALTER DEFAULT PRIVILEGES IN SCHEMA osm_reference
  REVOKE ALL ON TABLES FROM gt_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA osm_reference
  REVOKE ALL ON TABLES FROM gt_export;

-- Down Migration

ALTER DEFAULT PRIVILEGES IN SCHEMA osm_reference REVOKE ALL ON TABLES FROM gt_tileserv;
ALTER DEFAULT PRIVILEGES IN SCHEMA reference REVOKE ALL ON TABLES FROM gt_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA gt REVOKE ALL ON SEQUENCES FROM gt_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA gt REVOKE ALL ON TABLES FROM gt_export;
ALTER DEFAULT PRIVILEGES IN SCHEMA gt REVOKE ALL ON TABLES FROM gt_app;

DROP SCHEMA IF EXISTS reference CASCADE;
DROP SCHEMA IF EXISTS osm_reference CASCADE;
DROP SCHEMA IF EXISTS gt CASCADE;

DROP ROLE IF EXISTS gt_tileserv;
DROP ROLE IF EXISTS gt_export;
DROP ROLE IF EXISTS gt_app;
