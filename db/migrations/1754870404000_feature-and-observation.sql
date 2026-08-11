-- Up Migration
--
-- Phase 1, part 2: the canonical record and the field submissions that feed it.
--
-- `feature` is the product. `observation` is the immutable evidence behind it.
-- Many observations resolve to one feature; the resolution happens server-side in
-- QA, never on the device (ADR-0002).

SET search_path = gt, reference, extensions, public;

-- ---------------------------------------------------------------------------
-- National grid alignment
--
-- The brief asks for a generated ARC 1960 / UTM 37S column (EPSG:21037, the correct
-- zone for Tanga at ~39°E). It cannot be a GENERATED column: ST_Transform is STABLE,
-- not IMMUTABLE — it reads spatial_ref_sys, which can change — and PostgreSQL
-- rejects non-immutable expressions in generated columns.
--
-- Marking a wrapper IMMUTABLE to force it through is the usual workaround and is a
-- lie to the planner: it would let an index silently retain values computed under a
-- superseded projection definition. A trigger is honest, costs one function call per
-- write, and keeps the column correct by construction.
-- ---------------------------------------------------------------------------

CREATE FUNCTION gt.set_geom_utm() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.geom_utm := ST_Transform(NEW.geom, 21037);
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Content-addressed media references
--
-- A domain rather than a CHECK on the column: CHECK constraints cannot contain
-- subqueries, so validating each element of a text[] is not expressible there. A
-- domain applies its constraint per element when the array is constructed, which is
-- exactly the semantics wanted — one malformed digest fails the insert.
-- ---------------------------------------------------------------------------

CREATE DOMAIN public.sha256_hex AS text
  CHECK (VALUE ~ '^[0-9a-f]{64}$');

COMMENT ON DOMAIN public.sha256_hex IS
  'Lowercase hex SHA-256 digest. Used for content-addressed media, which is how '
  'uploads dedupe and resume over 2G (ADR-0002).';

COMMENT ON FUNCTION gt.set_geom_utm() IS
  'Maintains the ARC 1960 / UTM 37S projection of geom. A trigger rather than a '
  'GENERATED column because ST_Transform is STABLE, not IMMUTABLE.';

-- ---------------------------------------------------------------------------
-- feature — the canonical record
-- ---------------------------------------------------------------------------

CREATE TABLE gt.feature (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_class     public.feature_class NOT NULL,

  geom              geometry(Geometry, 4326) NOT NULL,
  geom_utm          geometry(Geometry, 21037),

  attributes        jsonb NOT NULL DEFAULT '{}'::jsonb,

  provenance        public.provenance NOT NULL,
  confidence_score  numeric(4, 3),
  status            public.feature_status NOT NULL DEFAULT 'PENDING',

  first_observed_at timestamptz NOT NULL,
  last_verified_at  timestamptz,
  valid_from        timestamptz NOT NULL DEFAULT now(),
  valid_to          timestamptz,

  supersedes_id     uuid REFERENCES gt.feature (id),
  spec_version      text NOT NULL,

  ward_id           uuid REFERENCES reference.admin_area (id),

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- ADR-0001 layer 3: OSM_ODBL is representable in the type but unwritable here.
  -- The earliest possible rejection point, with the smallest blast radius.
  CONSTRAINT feature_provenance_not_osm
    CHECK (provenance <> 'OSM_ODBL'),

  CONSTRAINT feature_confidence_range
    CHECK (confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 1)),

  -- An ACCEPTED feature without a confidence score is not a product we can license:
  -- confidence is what customers buy alongside the geometry.
  CONSTRAINT feature_accepted_requires_confidence
    CHECK (status <> 'ACCEPTED' OR confidence_score IS NOT NULL),

  CONSTRAINT feature_validity_ordered
    CHECK (valid_to IS NULL OR valid_to > valid_from),

  CONSTRAINT feature_no_self_supersede
    CHECK (supersedes_id IS NULL OR supersedes_id <> id),

  CONSTRAINT feature_spec_version_shape
    CHECK (spec_version ~ '^[a-z_]+@[0-9]+\.[0-9]+$'),

  -- Geometry must match its class. A POI arriving as a polygon is a collection bug,
  -- and a BUILDING_FOOTPRINT arriving as anything else breaks the structure-extent
  -- guarantee the non-cadastral position rests on.
  CONSTRAINT feature_geometry_matches_class CHECK (
    CASE feature_class
      WHEN 'BUILDING_FOOTPRINT' THEN GeometryType(geom) = 'POLYGON'
      WHEN 'ROAD_SEGMENT'       THEN GeometryType(geom) = 'LINESTRING'
      ELSE GeometryType(geom) = 'POINT'
    END
  ),

  CONSTRAINT feature_attributes_is_object
    CHECK (jsonb_typeof(attributes) = 'object')
);

CREATE TRIGGER feature_geom_utm
  BEFORE INSERT OR UPDATE OF geom ON gt.feature
  FOR EACH ROW EXECUTE FUNCTION gt.set_geom_utm();

CREATE INDEX feature_geom_gist      ON gt.feature USING gist (geom);
CREATE INDEX feature_geom_utm_gist  ON gt.feature USING gist (geom_utm);
CREATE INDEX feature_attributes_gin ON gt.feature USING gin (attributes jsonb_path_ops);
CREATE INDEX feature_status_idx     ON gt.feature (status);
CREATE INDEX feature_spec_version_idx ON gt.feature (spec_version);
CREATE INDEX feature_class_idx      ON gt.feature (feature_class);
CREATE INDEX feature_ward_idx       ON gt.feature (ward_id);
CREATE INDEX feature_supersedes_idx ON gt.feature (supersedes_id);

-- The export and tile paths read accepted features almost exclusively. A partial
-- index keeps that hot path off the rejected and superseded rows, which will
-- eventually outnumber the accepted ones.
CREATE INDEX feature_accepted_geom_gist ON gt.feature USING gist (geom)
  WHERE status = 'ACCEPTED';

-- Re-verification scheduling: find accepted features whose last check is oldest.
CREATE INDEX feature_stale_idx ON gt.feature (last_verified_at NULLS FIRST)
  WHERE status = 'ACCEPTED';

COMMENT ON TABLE gt.feature IS
  'The canonical dataset. Descriptive attributes of places; carries no '
  'determination of any right or interest in land.';
COMMENT ON COLUMN gt.feature.geom IS
  'For BUILDING_FOOTPRINT this is the STRUCTURE extent, never a land extent.';
COMMENT ON COLUMN gt.feature.geom_utm IS
  'ARC 1960 / UTM zone 37S (EPSG:21037). Maintained by trigger, not generated.';

-- ---------------------------------------------------------------------------
-- observation — immutable field evidence
--
-- Never edited, never overwritten. A correction is a new observation retracting an
-- earlier one (ADR-0002); the original survives so the audit trail survives.
-- ---------------------------------------------------------------------------

CREATE TABLE gt.observation (
  -- Client-generated UUIDv7, minted on the phone at capture time so the record has
  -- a stable identity before any server sees it. v7 is time-ordered, so ingest
  -- appends to the index hot end instead of scattering across it.
  id               uuid PRIMARY KEY,

  feature_id       uuid REFERENCES gt.feature (id),
  collector_id     uuid NOT NULL REFERENCES gt.collector (id),
  device_id        text NOT NULL,

  feature_class    public.feature_class NOT NULL,

  geom             geometry(Geometry, 4326) NOT NULL,
  geom_utm         geometry(Geometry, 21037),
  gps_accuracy_m   numeric(6, 2) NOT NULL,

  -- Device clock: UNTRUSTED. User-settable on cheap Android hardware.
  captured_at      timestamptz NOT NULL,
  -- Server clock: trusted.
  submitted_at     timestamptz NOT NULL DEFAULT now(),
  -- Monotonic per device, and not user-rewindable. This is what makes per-device
  -- ordering recoverable when the wall clock is nonsense (ADR-0002).
  device_sequence  bigint NOT NULL,

  raw_attributes   jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- SHA-256 hex of the BLURRED, re-encoded bytes. Raw imagery never leaves the
  -- phone — faces and plates are blurred on-device before storage (PDPA 2022).
  media_refs       public.sha256_hex[] NOT NULL DEFAULT '{}',
  -- Required where the observation involves identifiable persons or private
  -- premises. Nullable because most observations involve neither.
  consent_ref      text,

  app_version      text NOT NULL,
  spec_version     text NOT NULL,
  sync_batch_id    uuid NOT NULL,

  provenance       public.provenance NOT NULL DEFAULT 'FIELD_COLLECTED',
  qa_status        public.observation_qa_status NOT NULL DEFAULT 'PENDING',

  ward_id          uuid REFERENCES reference.admin_area (id),

  retracts_id      uuid REFERENCES gt.observation (id),
  retraction_reason text,

  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT observation_provenance_not_osm
    CHECK (provenance <> 'OSM_ODBL'),

  CONSTRAINT observation_gps_accuracy_positive
    CHECK (gps_accuracy_m > 0),

  CONSTRAINT observation_no_self_retract
    CHECK (retracts_id IS NULL OR retracts_id <> id),

  CONSTRAINT observation_retraction_has_reason
    CHECK (retracts_id IS NULL OR retraction_reason IS NOT NULL),

  CONSTRAINT observation_spec_version_shape
    CHECK (spec_version ~ '^[a-z_]+@[0-9]+\.[0-9]+$'),

  CONSTRAINT observation_geometry_matches_class CHECK (
    CASE feature_class
      WHEN 'BUILDING_FOOTPRINT' THEN GeometryType(geom) = 'POLYGON'
      WHEN 'ROAD_SEGMENT'       THEN GeometryType(geom) = 'LINESTRING'
      ELSE GeometryType(geom) = 'POINT'
    END
  ),

  CONSTRAINT observation_raw_attributes_is_object
    CHECK (jsonb_typeof(raw_attributes) = 'object')
);

CREATE TRIGGER observation_geom_utm
  BEFORE INSERT OR UPDATE OF geom ON gt.observation
  FOR EACH ROW EXECUTE FUNCTION gt.set_geom_utm();

-- Per-device monotonic sequence. Also makes re-sent batches collide loudly rather
-- than silently duplicating a walk.
CREATE UNIQUE INDEX observation_device_sequence_unique
  ON gt.observation (device_id, device_sequence);

CREATE INDEX observation_geom_gist       ON gt.observation USING gist (geom);
CREATE INDEX observation_attributes_gin  ON gt.observation USING gin (raw_attributes jsonb_path_ops);
CREATE INDEX observation_collector_idx   ON gt.observation (collector_id, captured_at DESC);
CREATE INDEX observation_feature_idx     ON gt.observation (feature_id);
CREATE INDEX observation_batch_idx       ON gt.observation (sync_batch_id);
CREATE INDEX observation_spec_version_idx ON gt.observation (spec_version);
CREATE INDEX observation_retracts_idx    ON gt.observation (retracts_id);

-- The QA queue: pending work, oldest first. Partial, because the pending set stays
-- small while the accepted set grows without bound.
CREATE INDEX observation_qa_queue_idx ON gt.observation (qa_status, submitted_at)
  WHERE qa_status IN ('PENDING', 'IN_REVIEW', 'FLAGGED');

-- Temporal plausibility (QA stage 3) walks a collector's track in device order.
CREATE INDEX observation_track_idx
  ON gt.observation (collector_id, device_id, device_sequence);

COMMENT ON TABLE gt.observation IS
  'Immutable field submissions. Never edited or deleted — a correction is a new '
  'observation retracting an earlier one. See ADR-0002.';
COMMENT ON COLUMN gt.observation.captured_at IS
  'Device clock. UNTRUSTED — validate against device_sequence and submitted_at.';
COMMENT ON COLUMN gt.observation.media_refs IS
  'SHA-256 of blurred, re-encoded image bytes. Raw imagery never leaves the device.';

-- Down Migration

DROP TABLE IF EXISTS gt.observation;
DROP TABLE IF EXISTS gt.feature;
DROP DOMAIN IF EXISTS public.sha256_hex;
DROP FUNCTION IF EXISTS gt.set_geom_utm();
