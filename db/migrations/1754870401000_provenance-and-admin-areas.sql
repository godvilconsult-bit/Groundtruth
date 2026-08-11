-- Up Migration
--
-- The provenance vocabulary, and the operational administrative areas used for
-- work assignment and QA plausibility envelopes.
--
-- Canonical tables (feature, observation, review, ...) are Phase 1. This migration
-- establishes only what Phase 0 needs: the shared provenance type, and one
-- reference table to seed a Tanga ward against.

-- Repeated from migration 1754870400000 so this migration is correct when run on its
-- own, not only as part of a full run. Without it, `geometry` fails to resolve
-- wherever PostGIS lives outside `public`. See the note in that migration.
SET search_path = gt, reference, extensions, public;

-- ---------------------------------------------------------------------------
-- Provenance
--
-- One shared type across all schemas, so a row's origin is directly comparable
-- across the gt / osm_reference barrier. OSM_ODBL is a member of the type because
-- osm_reference rows must be labelled honestly — not because it is ever valid in
-- gt, where a CHECK constraint forbids it (added with the feature table in Phase 1,
-- and applied to reference.admin_area below).
-- ---------------------------------------------------------------------------

-- Deliberately in `public`, not `gt`.
--
-- Provenance labels rows in all three schemas — including osm_reference, whose rows
-- must be labelled honestly (ADR-0001). Referencing a type requires USAGE on its
-- schema, so a type living in `gt` would force us to grant gt_tileserv access to the
-- canonical schema purely to read its own reference tables. That trades away the
-- clean "gt_tileserv has no gt access" property for nothing.
--
-- `public` is the neutral namespace: on every role's search_path by default, and
-- otherwise empty — migration 1754870400000 revoked PUBLIC's rights on it and we
-- create no tables there. Schema USAGE alone conveys no table access, so this grants
-- nothing beyond naming the type.
CREATE TYPE public.provenance AS ENUM (
  'FIELD_COLLECTED',
  'DRONE_DERIVED',
  'LICENSED_THIRD_PARTY',
  'OSM_ODBL',
  'PUBLIC_DOMAIN'
);

COMMENT ON TYPE public.provenance IS
  'Origin of a geometry and the licence obligations travelling with it. '
  'OSM_ODBL is share-alike and is confined to the osm_reference schema. '
  'See ADR-0001.';

-- ---------------------------------------------------------------------------
-- reference.admin_area
--
-- Administrative areas (region / district / ward) used as:
--   - work assignment units for collectors
--   - plausibility envelopes for QA stage 2
--
-- These are NOT cadastral and NOT land tenure. They are operational geofences,
-- sourced from national administrative data, and they are never exported to
-- customers. See DECISIONS.md D-004.
-- ---------------------------------------------------------------------------

CREATE TABLE reference.admin_area (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- National administrative code, where one exists.
  code             text,
  name_en          text NOT NULL,
  name_sw          text NOT NULL,
  level            text NOT NULL,

  parent_id        uuid REFERENCES reference.admin_area (id),

  geom             geometry(MultiPolygon, 4326) NOT NULL,

  provenance       public.provenance NOT NULL,
  source           text NOT NULL,

  -- False for development fixtures and any approximation. Production collection
  -- must refuse to assign work against a non-authoritative area — a wrong envelope
  -- produces false QA rejections of good field data, which damages collector
  -- reputation scores that are expensive to repair. See RISKS.md R-005.
  is_authoritative boolean NOT NULL DEFAULT false,

  valid_from       timestamptz NOT NULL DEFAULT now(),
  valid_to         timestamptz,

  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT admin_area_level_known
    CHECK (level IN ('REGION', 'DISTRICT', 'WARD')),

  -- Administrative reference data must not come from OSM: it would place
  -- share-alike geometry in the operational path and invite it into a join.
  CONSTRAINT admin_area_provenance_not_osm
    CHECK (provenance <> 'OSM_ODBL'),

  CONSTRAINT admin_area_validity_ordered
    CHECK (valid_to IS NULL OR valid_to > valid_from)
);

COMMENT ON TABLE reference.admin_area IS
  'Operational geofences for work assignment and QA plausibility. Not cadastral, '
  'not land tenure, never exported. See DECISIONS.md D-004.';

COMMENT ON COLUMN reference.admin_area.geom IS
  'Administrative extent as published by the national source. Carries no '
  'determination of any right or interest in land.';

COMMENT ON COLUMN reference.admin_area.is_authoritative IS
  'False for development fixtures and approximations. Production work assignment '
  'must require true.';

CREATE INDEX admin_area_geom_gist ON reference.admin_area USING gist (geom);
CREATE INDEX admin_area_level_idx ON reference.admin_area (level);
CREATE INDEX admin_area_parent_idx ON reference.admin_area (parent_id);
CREATE UNIQUE INDEX admin_area_code_unique
  ON reference.admin_area (code) WHERE code IS NOT NULL;

GRANT SELECT ON reference.admin_area TO gt_app;

-- Down Migration

DROP TABLE IF EXISTS reference.admin_area;
DROP TYPE IF EXISTS public.provenance;
