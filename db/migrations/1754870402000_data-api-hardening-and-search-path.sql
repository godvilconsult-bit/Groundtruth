-- Up Migration
--
-- Two platform-defence measures: revoking auto-generated data-API roles, and setting
-- an explicit search_path per application role.
--
-- ---------------------------------------------------------------------------
-- 1. Auto-generated data-API roles
--
-- Some managed Postgres platforms attach an auto-generated REST API to the database
-- and provision roles for it — Supabase's PostgREST setup uses `anon`,
-- `authenticated` and `service_role`, where `anon` is a PUBLISHED credential that
-- ships inside client applications. If the canonical dataset ever becomes reachable
-- by such a role, the dataset we intend to license is free to anyone holding the
-- project URL. That is not a breach in the usual sense; it is the licensing business
-- evaporating through a console setting, with no code change and no code review.
--
-- We are currently on Railway, which has no such API and no such roles, so this
-- section is a no-op here — as it is on local Docker and in CI. It is retained
-- deliberately: it costs one no-op DO block, and it means the protection is already
-- in place if the database is ever moved to a platform that does have one. Adding it
-- after such a move would depend on somebody remembering.
--
-- See RISKS.md R-010.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  supabase_role text;
  target_schema text;
BEGIN
  FOREACH supabase_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = supabase_role) THEN
      CONTINUE;
    END IF;

    FOREACH target_schema IN ARRAY ARRAY['gt', 'reference', 'osm_reference']
    LOOP
      EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', target_schema, supabase_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', target_schema, supabase_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', target_schema, supabase_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %I FROM %I', target_schema, supabase_role);

      -- And for tables that do not exist yet. Without this, the Phase 1 feature
      -- table would be created with whatever defaults are in force at that moment.
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM %I',
        target_schema, supabase_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM %I',
        target_schema, supabase_role
      );
    END LOOP;

    RAISE NOTICE 'revoked all privileges on gt/reference/osm_reference from %', supabase_role;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. search_path for the application roles
--
-- A role whose search_path omits the schema holding PostGIS cannot resolve the
-- `geometry` type, and every table with a geometry column fails to create. Where
-- PostGIS lands differs by platform: `public` on a vanilla cluster and on Railway,
-- a dedicated `extensions` schema on some managed platforms.
--
-- Listing both is correct everywhere — PostgreSQL ignores absent schemas in
-- search_path, so naming `extensions` on a cluster that has none costs nothing.
--
-- `public` is last and deliberately near-empty: migration 1754870400000 revoked
-- PUBLIC's rights on it, and nothing of ours is created there.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gt_app') THEN
    ALTER ROLE gt_app SET search_path = gt, reference, extensions, public;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gt_export') THEN
    -- No `reference`: administrative areas are operational, never exported.
    ALTER ROLE gt_export SET search_path = gt, extensions, public;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gt_tileserv') THEN
    ALTER ROLE gt_tileserv SET search_path = osm_reference, extensions, public;
  END IF;
END
$$;

-- Down Migration

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gt_app') THEN
    ALTER ROLE gt_app RESET search_path;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gt_export') THEN
    ALTER ROLE gt_export RESET search_path;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gt_tileserv') THEN
    ALTER ROLE gt_tileserv RESET search_path;
  END IF;
END
$$;

-- The privilege revocations are deliberately NOT reversed. Re-granting the Data API
-- access to the canonical dataset is not something a schema rollback should do
-- silently; if it is ever genuinely wanted, it should be written by hand and
-- reviewed by a person.
