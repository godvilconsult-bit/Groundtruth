-- Up Migration
--
-- Where the QA pipeline records what it decided and why.
--
-- Separate from `observation` deliberately. An observation carries its CURRENT
-- qa_status; this table carries the history of every evaluation that produced one.
-- Two reasons that matter:
--
--   1. The pipeline is re-run. A spec change, a corrected ward envelope, or a fixed
--      stage means re-evaluating observations already judged. Overwriting a verdict
--      in place would destroy the record of what the pipeline believed at the time,
--      which is exactly what someone disputing a feature will ask about.
--
--   2. Reason-code DISTRIBUTIONS are the fraud signal (RISKS.md R-007). A collector
--      converging on reviewer preferences is invisible in any single observation and
--      obvious across a few hundred. That query needs history, not a latest value.

SET search_path = gt, reference, extensions, public;

CREATE TYPE public.qa_verdict AS ENUM ('PASS', 'FLAG', 'REJECT');

COMMENT ON TYPE public.qa_verdict IS
  'PASS: may become canonical. FLAG: needs human adjudication. REJECT: cannot '
  'become a feature as submitted — but the observation is still retained, because '
  'an observation is a fact even when it fails validation.';

CREATE TABLE gt.qa_verdict (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  observation_id uuid NOT NULL REFERENCES gt.observation (id),

  verdict        public.qa_verdict NOT NULL,

  -- Enumerated codes, never prose. A distribution cannot be computed over prose,
  -- and the distribution is the point.
  reason_codes   text[] NOT NULL DEFAULT '{}',

  -- Per-stage detail: which stage produced which verdict, with its explanation.
  -- Kept as jsonb so a new stage does not require a migration to be recorded.
  stage_records  jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Which pipeline produced this. A verdict is only interpretable alongside the
  -- rules that generated it, and those rules change.
  pipeline_version text NOT NULL,

  selected_for_resurvey boolean NOT NULL DEFAULT false,

  evaluated_at   timestamptz NOT NULL DEFAULT now(),

  -- Per-element validation of reason_codes is NOT expressible as a CHECK — CHECK
  -- cannot contain a subquery, which is the same wall `media_refs` hit in D-014.
  -- Codes are constrained by the domain layer's enumeration rather than the
  -- database; a DOMAIN type here would need updating on every new reason code,
  -- which would make adding a QA check a migration.
  CONSTRAINT qa_verdict_stage_records_is_array
    CHECK (jsonb_typeof(stage_records) = 'array')
);

CREATE INDEX qa_verdict_observation_idx ON gt.qa_verdict (observation_id, id DESC);
CREATE INDEX qa_verdict_verdict_idx     ON gt.qa_verdict (verdict, evaluated_at DESC);
CREATE INDEX qa_verdict_evaluated_idx   ON gt.qa_verdict (evaluated_at DESC);

-- GIN over the codes: "how often did GEO_ACCURACY_POOR fire for this collector
-- last month" is the shape of every fraud and quality query we will write.
CREATE INDEX qa_verdict_reason_codes_gin ON gt.qa_verdict USING gin (reason_codes);

-- The re-survey work queue: accepted features selected for independent re-walking.
CREATE INDEX qa_verdict_resurvey_idx ON gt.qa_verdict (evaluated_at)
  WHERE selected_for_resurvey;

COMMENT ON TABLE gt.qa_verdict IS
  'History of QA pipeline evaluations. Append-only in practice: re-running the '
  'pipeline adds a row rather than replacing one, so what the pipeline believed at '
  'the time survives.';

-- Verdicts are evidence about how the dataset was judged. Editing one after the
-- fact would let a disputed decision be quietly rewritten.
CREATE TRIGGER qa_verdict_append_only
  BEFORE UPDATE OR DELETE ON gt.qa_verdict
  FOR EACH ROW EXECUTE FUNCTION gt.deny_mutation();

REVOKE UPDATE, DELETE ON gt.qa_verdict FROM gt_app;

-- ---------------------------------------------------------------------------
-- Collector standing, derived rather than stored
--
-- A view, not a column, because a stored acceptance rate is a denormalisation that
-- drifts: it is updated by one code path, read by three, and wrong after any
-- backfill or pipeline re-run. Reputation routing reads this.
-- ---------------------------------------------------------------------------

CREATE VIEW gt.collector_standing AS
SELECT
  c.id                                                     AS collector_id,
  c.competency_status,
  c.quality_score,
  count(*) FILTER (WHERE o.qa_status = 'ACCEPTED')::bigint  AS total_accepted,
  count(*) FILTER (WHERE o.qa_status IN ('ACCEPTED', 'REJECTED'))::bigint AS total_adjudicated,
  CASE
    WHEN count(*) FILTER (WHERE o.qa_status IN ('ACCEPTED', 'REJECTED')) = 0 THEN NULL
    ELSE round(
      count(*) FILTER (WHERE o.qa_status = 'ACCEPTED')::numeric
      / count(*) FILTER (WHERE o.qa_status IN ('ACCEPTED', 'REJECTED'))::numeric,
      4)
  END                                                       AS acceptance_rate
FROM gt.collector c
LEFT JOIN gt.observation o ON o.collector_id = c.id
GROUP BY c.id, c.competency_status, c.quality_score;

COMMENT ON VIEW gt.collector_standing IS
  'Derived collector reputation inputs. A view rather than stored columns, because '
  'a stored acceptance rate drifts after any backfill or pipeline re-run.';

GRANT SELECT ON gt.collector_standing TO gt_app;

-- Down Migration

DROP VIEW IF EXISTS gt.collector_standing;
DROP TRIGGER IF EXISTS qa_verdict_append_only ON gt.qa_verdict;
DROP TABLE IF EXISTS gt.qa_verdict;
DROP TYPE IF EXISTS public.qa_verdict;
