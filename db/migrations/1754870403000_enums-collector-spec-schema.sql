-- Up Migration
--
-- Phase 1, part 1: the shared vocabulary, the people who collect, and the versioned
-- collection specification.
--
-- The spec lives here as DATA, not as code (ADR-0003). Changing what mappers collect
-- must never require an app release.

SET search_path = gt, reference, extensions, public;

-- ---------------------------------------------------------------------------
-- Vocabulary
--
-- In `public` alongside `provenance`, for the same reason (D-012): types are
-- referenced across schemas, and referencing a type requires USAGE on its schema.
-- ---------------------------------------------------------------------------

CREATE TYPE public.feature_class AS ENUM (
  'BUILDING_FOOTPRINT',
  'ACCESS_POINT',
  'ROAD_SEGMENT',
  'POI',
  'WATER_POINT',
  'ADDRESS_ANCHOR'
);

COMMENT ON TYPE public.feature_class IS
  'The v1 collection classes, deliberately narrow. Note what is absent: this system '
  'records descriptive attributes of places and never land extent, tenure, or '
  'title. BUILDING_FOOTPRINT is a STRUCTURE extent, never a land extent.';

CREATE TYPE public.feature_status AS ENUM (
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'SUPERSEDED',
  'DISPUTED'
);

CREATE TYPE public.observation_qa_status AS ENUM (
  'PENDING',
  'IN_REVIEW',
  'ACCEPTED',
  'REJECTED',
  'FLAGGED',
  'RETRACTED'
);

CREATE TYPE public.review_decision AS ENUM ('ACCEPT', 'REJECT', 'ESCALATE');

CREATE TYPE public.competency_status AS ENUM (
  'TRAINEE',      -- 100% human review (QA stage 5)
  'PROVEN',       -- sampled review
  'SUSPENDED'     -- submissions accepted but never auto-promoted
);

CREATE TYPE public.ledger_reason AS ENUM (
  'OBSERVATION_ACCEPTED',
  'RESURVEY_BONUS',
  'CORRECTION',
  'ADJUSTMENT'
);

-- ---------------------------------------------------------------------------
-- collector
--
-- PERSONAL DATA. Subject to the Personal Data Protection Act 2022. This table and
-- anything joining to it (notably observation, which carries GPS traces) is in scope
-- for retention limits and erasure. `display_name` is the only directly identifying
-- field held here; contact details deliberately live in the identity provider, not
-- in the canonical database.
-- ---------------------------------------------------------------------------

CREATE TABLE gt.collector (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref       text NOT NULL,
  display_name       text NOT NULL,

  competency_status  public.competency_status NOT NULL DEFAULT 'TRAINEE',

  -- Running quality score in [0,1]. Distinct from confidence: this describes the
  -- collector, confidence describes a feature.
  quality_score      numeric(4, 3) NOT NULL DEFAULT 0.500,

  -- Minor units (cents) to avoid float money. Accrual is per ACCEPTED observation
  -- only — paying per submission destroys data quality within one pay cycle.
  payment_rate_minor integer NOT NULL DEFAULT 0,
  currency           char(3) NOT NULL DEFAULT 'TZS',

  assigned_ward_id   uuid REFERENCES reference.admin_area (id),

  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT collector_quality_score_range
    CHECK (quality_score >= 0 AND quality_score <= 1),
  CONSTRAINT collector_payment_rate_non_negative
    CHECK (payment_rate_minor >= 0)
);

CREATE UNIQUE INDEX collector_external_ref_unique ON gt.collector (external_ref);
CREATE INDEX collector_competency_idx ON gt.collector (competency_status) WHERE active;
CREATE INDEX collector_ward_idx ON gt.collector (assigned_ward_id);

COMMENT ON TABLE gt.collector IS
  'Field mappers. Contains personal data — see PDPA retention obligations. '
  'Payment accrues per accepted observation, never per submission.';

-- ---------------------------------------------------------------------------
-- feature_class_schema
--
-- The Data Collection Specification, as data. One row per published version of one
-- class. Published versions are IMMUTABLE: correcting a mistake means publishing a
-- new version, never editing an old one, because observations reference the version
-- they were collected under, forever (ADR-0003).
-- ---------------------------------------------------------------------------

CREATE TABLE gt.feature_class_schema (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_class    public.feature_class NOT NULL,

  -- Opaque identifier of the form `{class}@{major}.{minor}`, e.g. road_segment@2.1.
  spec_version     text NOT NULL,
  major            integer NOT NULL,
  minor            integer NOT NULL,

  json_schema      jsonb NOT NULL,

  -- Presentation only: widget types, ordering, and BOTH locales' labels. Separate
  -- from json_schema so a label change can never alter validation semantics.
  -- Swahili is the default locale; a missing Swahili label blocks publication.
  ui_hints         jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Clients below this refuse the bundle and keep their last valid one rather than
  -- rendering a form they cannot render faithfully.
  min_app_version  text NOT NULL,

  published_at     timestamptz NOT NULL DEFAULT now(),
  retired_at       timestamptz,

  CONSTRAINT fcs_version_shape
    CHECK (spec_version ~ '^[a-z_]+@[0-9]+\.[0-9]+$'),
  CONSTRAINT fcs_version_non_negative
    CHECK (major >= 0 AND minor >= 0),
  CONSTRAINT fcs_retired_after_published
    CHECK (retired_at IS NULL OR retired_at > published_at),
  CONSTRAINT fcs_json_schema_is_object
    CHECK (jsonb_typeof(json_schema) = 'object')
);

CREATE UNIQUE INDEX fcs_class_version_unique
  ON gt.feature_class_schema (feature_class, spec_version);
CREATE UNIQUE INDEX fcs_class_major_minor_unique
  ON gt.feature_class_schema (feature_class, major, minor);
CREATE INDEX fcs_active_idx
  ON gt.feature_class_schema (feature_class) WHERE retired_at IS NULL;

COMMENT ON TABLE gt.feature_class_schema IS
  'Versioned collection specification. Published rows are immutable — observations '
  'reference their spec_version forever, and rewriting one destroys the ability to '
  'answer what a historical observation actually meant. See ADR-0003.';

-- Down Migration

DROP TABLE IF EXISTS gt.feature_class_schema;
DROP TABLE IF EXISTS gt.collector;
DROP TYPE IF EXISTS public.ledger_reason;
DROP TYPE IF EXISTS public.competency_status;
DROP TYPE IF EXISTS public.review_decision;
DROP TYPE IF EXISTS public.observation_qa_status;
DROP TYPE IF EXISTS public.feature_status;
DROP TYPE IF EXISTS public.feature_class;
