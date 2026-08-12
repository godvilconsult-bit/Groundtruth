-- Up Migration
--
-- Review claims: which reviewer is currently holding which observation.
--
-- Two failures this exists to prevent, both of which are silent:
--
--   1. Two reviewers adjudicating the same observation. Neither sees the other's
--      decision, the second overwrites the first, and the reason-code distribution
--      that R-007 depends on quietly acquires duplicate entries.
--
--   2. Work stranded forever because a reviewer closed their laptop. Without an
--      expiry, a claim outlives the session that took it and the observation is
--      never seen again — indistinguishable, from the queue's side, from work
--      nobody has got to yet.
--
-- A separate table rather than columns on `observation`: a claim is a transient
-- operational fact about a person's session, not a property of the field evidence.

SET search_path = gt, reference, extensions, public;

CREATE TABLE gt.review_claim (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  observation_id uuid NOT NULL REFERENCES gt.observation (id),
  reviewer_id    uuid NOT NULL,

  claimed_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  released_at    timestamptz,

  CONSTRAINT review_claim_expiry_after_claim CHECK (expires_at > claimed_at),
  CONSTRAINT review_claim_release_after_claim
    CHECK (released_at IS NULL OR released_at >= claimed_at)
);

-- At most one live claim per observation.
--
-- The predicate deliberately tests only `released_at IS NULL` and not expiry:
-- `now()` is not immutable and cannot appear in an index predicate. Expired claims
-- are therefore released explicitly before each claim round, which also gives us a
-- record of the expiry having happened rather than it being implicit in a clock.
CREATE UNIQUE INDEX review_claim_one_live_per_observation
  ON gt.review_claim (observation_id)
  WHERE released_at IS NULL;

CREATE INDEX review_claim_reviewer_idx ON gt.review_claim (reviewer_id, claimed_at DESC);
CREATE INDEX review_claim_expiry_idx ON gt.review_claim (expires_at)
  WHERE released_at IS NULL;

COMMENT ON TABLE gt.review_claim IS
  'Transient hold on an observation while a reviewer adjudicates it. Expires, so a '
  'closed laptop cannot strand work.';

-- ---------------------------------------------------------------------------
-- The review queue
--
-- Oldest flagged work first, excluding anything currently claimed. A view because
-- every consumer — console, supervisor surface, metrics — must agree on what "the
-- queue" means; three slightly different queries would eventually disagree about
-- the backlog and nobody would notice which was right.
-- ---------------------------------------------------------------------------

CREATE VIEW gt.review_queue AS
SELECT
  o.id                AS observation_id,
  o.collector_id,
  o.feature_class,
  o.spec_version,
  o.ward_id,
  o.submitted_at,
  o.gps_accuracy_m,
  o.media_refs,
  v.verdict,
  v.reason_codes,
  v.selected_for_resurvey,
  v.evaluated_at
FROM gt.observation o
JOIN LATERAL (
  SELECT verdict, reason_codes, selected_for_resurvey, evaluated_at
    FROM gt.qa_verdict q
   WHERE q.observation_id = o.id
   ORDER BY q.id DESC
   LIMIT 1
) v ON true
WHERE o.qa_status = 'FLAGGED'
  AND NOT EXISTS (
    SELECT 1 FROM gt.review_claim c
     WHERE c.observation_id = o.id
       AND c.released_at IS NULL
       AND c.expires_at > now()
  );

COMMENT ON VIEW gt.review_queue IS
  'Flagged observations awaiting adjudication, excluding live claims. Oldest first '
  'is applied by the caller so a supervisor can order by ward instead.';

GRANT SELECT ON gt.review_queue TO gt_app;

-- ---------------------------------------------------------------------------
-- Throughput
--
-- The Phase 3 deliverable is 100 observations per hour, which is 36 seconds each.
-- That is a measurement, not an aspiration, so it gets a view rather than a
-- spreadsheet — and it exposes the median as well as the mean, because a reviewer
-- who rubber-stamps ninety and agonises over ten has a flattering mean.
-- ---------------------------------------------------------------------------

CREATE VIEW gt.review_throughput AS
SELECT
  reviewer_id,
  date_trunc('hour', reviewed_at)                          AS hour,
  count(*)::bigint                                          AS decisions,
  round(avg(duration_ms) / 1000.0, 1)                       AS mean_seconds,
  round((percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) / 1000.0)::numeric, 1)
                                                            AS median_seconds,
  count(*) FILTER (WHERE decision = 'ACCEPT')::bigint        AS accepted,
  count(*) FILTER (WHERE decision = 'REJECT')::bigint        AS rejected,
  count(*) FILTER (WHERE decision = 'ESCALATE')::bigint      AS escalated,
  -- Sub-two-second decisions are not adjudication; they are a held-down key.
  count(*) FILTER (WHERE duration_ms < 2000)::bigint         AS suspiciously_fast
FROM gt.review
WHERE duration_ms IS NOT NULL
GROUP BY reviewer_id, date_trunc('hour', reviewed_at);

COMMENT ON VIEW gt.review_throughput IS
  'Reviewer throughput against the 100/hour target, with a rubber-stamping counter. '
  'Median as well as mean: agonising over ten and waving through ninety produces a '
  'flattering average.';

GRANT SELECT ON gt.review_throughput TO gt_app;

-- Down Migration

DROP VIEW IF EXISTS gt.review_throughput;
DROP VIEW IF EXISTS gt.review_queue;
DROP TABLE IF EXISTS gt.review_claim;
