-- Up Migration
--
-- Phase 4: the change log customers sync against, plus scoped API keys and usage
-- metering.
--
-- ===========================================================================
-- THE CURSOR PROBLEM, AND WHY THIS IS NOT `WHERE updated_at > $cursor`
-- ===========================================================================
--
-- The obvious delta feed — filter by a timestamp or by an IDENTITY column — loses
-- rows silently, and the loss is undetectable from the customer's side.
--
-- Transaction A begins and takes sequence 5. Transaction B begins, takes 6, and
-- commits. A is still open. A customer polls, sees 6, and stores cursor = 6. A then
-- commits. Sequence 5 is now visible but permanently behind the cursor: that feature
-- is never delivered, to that customer, ever.
--
-- For a logistics customer this is an access point that does not exist in their
-- system — a failed delivery they will never trace back to us.
--
-- The fix here is to assign the sequence under a transaction-scoped advisory lock,
-- the same technique the audit chain uses. Holding the lock until commit means a
-- transaction that takes a lower sequence necessarily commits first, so sequence
-- order IS commit order and `change_seq > cursor` cannot skip.
--
-- The cost is that concurrent writers to `feature` serialise at this point. That is
-- acceptable: feature writes are a QA-pipeline batch operation, not a hot path, and
-- correctness of the customer feed outranks ingest throughput.

SET search_path = gt, reference, extensions, public;

CREATE SEQUENCE gt.feature_change_seq;

CREATE TABLE gt.feature_change (
  change_seq    bigint PRIMARY KEY,
  feature_id    uuid NOT NULL,
  op            text NOT NULL,
  feature_class public.feature_class NOT NULL,
  status        public.feature_status NOT NULL,
  -- Denormalised so a delta query never joins back to `feature` — and so a DELETE
  -- can still tell a customer WHAT disappeared.
  provenance    public.provenance NOT NULL,
  ward_id       uuid,
  changed_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT feature_change_op_known CHECK (op IN ('INSERT', 'UPDATE', 'DELETE')),
  -- ADR-0001 layer 3, again at the delivery edge. The change log is an export
  -- path, so it gets the same write-time refusal the canonical table has.
  CONSTRAINT feature_change_provenance_not_osm CHECK (provenance <> 'OSM_ODBL')
);

CREATE INDEX feature_change_feature_idx ON gt.feature_change (feature_id, change_seq DESC);
CREATE INDEX feature_change_class_idx ON gt.feature_change (feature_class, change_seq);
CREATE INDEX feature_change_ward_idx ON gt.feature_change (ward_id, change_seq);

COMMENT ON TABLE gt.feature_change IS
  'Ordered change log for customer delta sync. change_seq is assigned under an '
  'advisory lock so sequence order equals commit order and a poll cannot skip a row.';

CREATE FUNCTION gt.record_feature_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  row_data record;
BEGIN
  -- Serialise sequence assignment. Held to commit, so a lower sequence always
  -- commits first. Without this the feed silently drops rows (see header).
  PERFORM pg_advisory_xact_lock(hashtext('gt.feature_change'));

  IF TG_OP = 'DELETE' THEN
    row_data := OLD;
  ELSE
    row_data := NEW;
  END IF;

  INSERT INTO gt.feature_change
    (change_seq, feature_id, op, feature_class, status, provenance, ward_id)
  VALUES
    (nextval('gt.feature_change_seq'), row_data.id, TG_OP, row_data.feature_class,
     row_data.status, row_data.provenance, row_data.ward_id);

  RETURN NULL;
END;
$$;

CREATE TRIGGER feature_change_trigger
  AFTER INSERT OR UPDATE OR DELETE ON gt.feature
  FOR EACH ROW EXECUTE FUNCTION gt.record_feature_change();

-- ---------------------------------------------------------------------------
-- API keys, scoped
--
-- A key is not an all-or-nothing credential. The brief requires scoping by feature
-- class, geographic extent and rate limit, and that shape is also the product: a
-- logistics customer buys access points and roads for Tanga, not the whole dataset.
-- ---------------------------------------------------------------------------

CREATE TABLE gt.api_key (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_name  text NOT NULL,

  -- argon2id hash. The plaintext key is shown once at creation and never stored —
  -- a leaked database must not yield working credentials.
  key_hash       text NOT NULL,
  -- Non-secret prefix, so a key can be identified in logs and support requests
  -- without the secret appearing anywhere.
  key_prefix     text NOT NULL,

  -- Empty array means every class. Explicit is better, but a scope of "everything"
  -- must be expressible without enumerating and then forgetting a new class.
  feature_classes public.feature_class[] NOT NULL DEFAULT '{}',
  -- Licensed extent. NULL means unrestricted.
  extent         geometry(Polygon, 4326),

  rate_limit_per_minute integer NOT NULL DEFAULT 60,

  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,
  revoked_at     timestamptz,

  CONSTRAINT api_key_rate_limit_positive CHECK (rate_limit_per_minute > 0),
  CONSTRAINT api_key_expiry_after_creation CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE UNIQUE INDEX api_key_prefix_unique ON gt.api_key (key_prefix);
CREATE INDEX api_key_active_idx ON gt.api_key (active) WHERE active;
CREATE INDEX api_key_extent_gist ON gt.api_key USING gist (extent);

COMMENT ON COLUMN gt.api_key.key_hash IS
  'argon2id. Plaintext is shown once at creation and never persisted.';

-- ---------------------------------------------------------------------------
-- Usage metering
--
-- Append-only. This is what customers are billed against, so a row that can be
-- edited after the fact is a row that can be disputed and not defended.
-- ---------------------------------------------------------------------------

CREATE TABLE gt.usage_meter (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  api_key_id      uuid NOT NULL REFERENCES gt.api_key (id),
  endpoint        text NOT NULL,
  features_returned integer NOT NULL DEFAULT 0,
  bytes_returned  bigint NOT NULL DEFAULT 0,
  status_code     integer NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT usage_meter_counts_non_negative
    CHECK (features_returned >= 0 AND bytes_returned >= 0)
);

CREATE INDEX usage_meter_key_time_idx ON gt.usage_meter (api_key_id, occurred_at DESC);
CREATE INDEX usage_meter_time_idx ON gt.usage_meter (occurred_at);

CREATE TRIGGER usage_meter_append_only
  BEFORE UPDATE OR DELETE ON gt.usage_meter
  FOR EACH ROW EXECUTE FUNCTION gt.deny_mutation();

REVOKE UPDATE, DELETE ON gt.usage_meter FROM gt_app;

-- ---------------------------------------------------------------------------
-- The exportable view
--
-- The ONLY relation the delivery layer reads. Filtering lives here rather than in
-- application queries so a new endpoint cannot forget it: an endpoint that queries
-- gt.feature directly would bypass both the status and provenance filters, and
-- would do so silently.
-- ---------------------------------------------------------------------------

CREATE VIEW gt.exportable_feature AS
SELECT
  f.id,
  f.feature_class,
  f.geom,
  f.attributes,
  f.provenance,
  f.confidence_score,
  f.first_observed_at,
  f.last_verified_at,
  f.spec_version,
  f.ward_id,
  f.updated_at
FROM gt.feature f
WHERE f.status = 'ACCEPTED'
  AND f.valid_to IS NULL
  -- Belt and braces. The CHECK constraint already makes OSM_ODBL unwritable here,
  -- so this can never filter anything — which is exactly why it stays: if it ever
  -- does filter a row, something upstream has failed and the export is still clean.
  AND f.provenance <> 'OSM_ODBL';

COMMENT ON VIEW gt.exportable_feature IS
  'The only relation the delivery layer may read. Accepted, current, and '
  'provenance-clean. Querying gt.feature directly from an endpoint bypasses these '
  'filters silently — see ADR-0001.';

GRANT SELECT ON gt.exportable_feature TO gt_export;
GRANT SELECT ON gt.feature_change TO gt_export;

-- Down Migration

DROP VIEW IF EXISTS gt.exportable_feature;
DROP TRIGGER IF EXISTS usage_meter_append_only ON gt.usage_meter;
DROP TABLE IF EXISTS gt.usage_meter;
DROP TABLE IF EXISTS gt.api_key;
DROP TRIGGER IF EXISTS feature_change_trigger ON gt.feature;
DROP FUNCTION IF EXISTS gt.record_feature_change();
DROP TABLE IF EXISTS gt.feature_change;
DROP SEQUENCE IF EXISTS gt.feature_change_seq;
