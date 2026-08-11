-- Up Migration
--
-- Phase 1, part 3: adjudication, payment, and a tamper-evident history.

SET search_path = gt, reference, extensions, public;

-- ---------------------------------------------------------------------------
-- review — human adjudication (QA stage 7)
-- ---------------------------------------------------------------------------

CREATE TABLE gt.review (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id uuid NOT NULL REFERENCES gt.observation (id),
  reviewer_id    uuid NOT NULL,
  decision       public.review_decision NOT NULL,

  -- Granular and enumerated, not free text. Reason codes are how we detect a
  -- collector converging on reviewer preferences rather than on the ground truth
  -- (RISKS.md R-007) — that signal is invisible if the reason is prose.
  reason_code    text NOT NULL,
  notes          text,
  reviewed_at    timestamptz NOT NULL DEFAULT now(),

  -- Milliseconds of reviewer attention. Feeds the 100-observations-per-hour target
  -- and flags rubber-stamping.
  duration_ms    integer,

  CONSTRAINT review_reason_code_shape CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,49}$'),
  CONSTRAINT review_duration_sane CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

CREATE INDEX review_observation_idx ON gt.review (observation_id);
CREATE INDEX review_reviewer_idx    ON gt.review (reviewer_id, reviewed_at DESC);
CREATE INDEX review_reason_idx      ON gt.review (reason_code);

-- ---------------------------------------------------------------------------
-- payment_ledger — append-only
--
-- Credits accrue per ACCEPTED observation, never per submission. Paying per
-- submission destroys data quality within one pay cycle.
-- ---------------------------------------------------------------------------

CREATE TABLE gt.payment_ledger (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  collector_id   uuid NOT NULL REFERENCES gt.collector (id),
  observation_id uuid REFERENCES gt.observation (id),

  amount_minor   bigint NOT NULL,
  currency       char(3) NOT NULL DEFAULT 'TZS',
  reason         public.ledger_reason NOT NULL,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  -- Accrual for an accepted observation must name the observation. Adjustments and
  -- corrections may not have one, but must carry an explanation.
  CONSTRAINT ledger_accrual_references_observation
    CHECK (reason <> 'OBSERVATION_ACCEPTED' OR observation_id IS NOT NULL),
  CONSTRAINT ledger_adjustment_has_notes
    CHECK (reason NOT IN ('ADJUSTMENT', 'CORRECTION') OR notes IS NOT NULL)
);

CREATE INDEX ledger_collector_idx   ON gt.payment_ledger (collector_id, created_at DESC);
CREATE INDEX ledger_observation_idx ON gt.payment_ledger (observation_id);

-- One accrual per observation. Without this, a QA replay or a retried job pays
-- twice for the same work, and the error is only visible at payroll.
CREATE UNIQUE INDEX ledger_one_accrual_per_observation
  ON gt.payment_ledger (observation_id)
  WHERE reason = 'OBSERVATION_ACCEPTED';

-- ---------------------------------------------------------------------------
-- audit_log — append-only, hash-chained
--
-- Each row's hash covers the previous row's hash, so altering any interior record
-- invalidates every hash after it.
--
-- WHAT THIS DOES NOT DO, stated plainly: an actor with write access can recompute
-- the chain forward from any point, because the chain head lives in the same
-- database as the records. Hash chaining alone is therefore NOT tamper-proof; it is
-- tamper-evident only against actors who cannot rewrite the whole table.
--
-- `audit_anchor` below is what closes that gap. See RISKS.md R-002.
-- ---------------------------------------------------------------------------

CREATE TABLE gt.audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),

  -- Application user or job identity. Never a raw credential, never PII.
  actor       text NOT NULL,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   uuid,

  before      jsonb,
  after       jsonb,

  prev_hash   bytea,
  hash        bytea NOT NULL,

  CONSTRAINT audit_action_shape CHECK (action ~ '^[A-Z][A-Z0-9_]{2,63}$')
);

CREATE INDEX audit_entity_idx     ON gt.audit_log (entity_type, entity_id, id);
CREATE INDEX audit_occurred_idx   ON gt.audit_log (occurred_at);
CREATE INDEX audit_actor_idx      ON gt.audit_log (actor, id);

-- ---------------------------------------------------------------------------
-- Chain computation
--
-- sha256() is a pg_catalog builtin (PostgreSQL 11+), deliberately used in place of
-- pgcrypto's digest(): it needs no extension and therefore no schema qualification,
-- which keeps this correct wherever pgcrypto happens to be installed.
--
-- jsonb's text output is canonical — keys are normalised and ordered by the type
-- itself — so the same logical payload always hashes identically. That would not
-- hold for `json`.
-- ---------------------------------------------------------------------------

CREATE FUNCTION gt.audit_log_append() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  last_hash bytea;
  payload   text;
BEGIN
  -- Serialise appenders. Two concurrent inserts reading the same head would fork
  -- the chain into two branches sharing a prev_hash, which verification cannot
  -- distinguish from tampering. The lock is transaction-scoped and released
  -- automatically.
  PERFORM pg_advisory_xact_lock(hashtext('gt.audit_log'));

  SELECT a.hash INTO last_hash FROM gt.audit_log a ORDER BY a.id DESC LIMIT 1;

  NEW.prev_hash := last_hash;

  payload :=
    coalesce(encode(last_hash, 'hex'), 'GENESIS') || E'\x1f' ||
    extract(epoch from NEW.occurred_at)::text     || E'\x1f' ||
    NEW.actor                                     || E'\x1f' ||
    NEW.action                                    || E'\x1f' ||
    NEW.entity_type                               || E'\x1f' ||
    coalesce(NEW.entity_id::text, '')             || E'\x1f' ||
    coalesce(NEW.before::text, '')                || E'\x1f' ||
    coalesce(NEW.after::text, '');

  NEW.hash := sha256(convert_to(payload, 'UTF8'));
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_log_chain
  BEFORE INSERT ON gt.audit_log
  FOR EACH ROW EXECUTE FUNCTION gt.audit_log_append();

-- Append-only enforcement.
--
-- A trigger that RAISEs, not a rule that silently discards: a rewrite attempt must
-- be a loud error, since the attempt itself is the security signal. Note this binds
-- ordinary roles, not the role that owns the table, which can drop the trigger —
-- precisely why R-002 needs external anchoring.
CREATE FUNCTION gt.deny_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    USING MESSAGE = format('%I.%I is append-only; %s is not permitted',
                           TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP),
          ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON gt.audit_log
  FOR EACH ROW EXECUTE FUNCTION gt.deny_mutation();

CREATE TRIGGER payment_ledger_append_only
  BEFORE UPDATE OR DELETE ON gt.payment_ledger
  FOR EACH ROW EXECUTE FUNCTION gt.deny_mutation();

REVOKE UPDATE, DELETE ON gt.audit_log      FROM gt_app;
REVOKE UPDATE, DELETE ON gt.payment_ledger FROM gt_app;

-- ---------------------------------------------------------------------------
-- audit_anchor — the external witness (RISKS.md R-002)
--
-- Periodically the chain head is written somewhere the database cannot reach:
-- object-lock/WORM storage under a separate credential, or a timestamping
-- authority. Each anchor bounds the tamper window — an attacker can only rewrite
-- history back to the last anchor without the divergence becoming provable.
--
-- The row here is the local record of that external write. The write itself is
-- infrastructure work; this table exists from the first audit row because anchoring
-- introduced later leaves everything before it permanently unverifiable.
-- ---------------------------------------------------------------------------

CREATE TABLE gt.audit_anchor (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  anchored_at    timestamptz NOT NULL DEFAULT now(),

  -- Chain head at anchoring time.
  audit_log_id   bigint NOT NULL REFERENCES gt.audit_log (id),
  chain_head_hash bytea NOT NULL,

  -- Where the witness lives: 's3-object-lock', 'rfc3161', 'manual'.
  anchor_kind    text NOT NULL,
  -- Verifiable pointer: object version id, timestamp token, receipt.
  external_ref   text NOT NULL,

  CONSTRAINT anchor_kind_known
    CHECK (anchor_kind IN ('s3-object-lock', 'rfc3161', 'manual'))
);

CREATE UNIQUE INDEX anchor_log_id_unique ON gt.audit_anchor (audit_log_id);
CREATE INDEX anchor_time_idx ON gt.audit_anchor (anchored_at DESC);

CREATE TRIGGER audit_anchor_append_only
  BEFORE UPDATE OR DELETE ON gt.audit_anchor
  FOR EACH ROW EXECUTE FUNCTION gt.deny_mutation();

REVOKE UPDATE, DELETE ON gt.audit_anchor FROM gt_app;

-- ---------------------------------------------------------------------------
-- Chain verification
--
-- Recomputes every hash from the genesis row and reports the first divergence.
-- Returns the broken row's id, or NULL when the chain is intact.
-- ---------------------------------------------------------------------------

CREATE FUNCTION gt.verify_audit_chain(from_id bigint DEFAULT 0)
RETURNS TABLE (broken_at bigint, reason text)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  r          record;
  expected   bytea;
  running    bytea;
  first_row  boolean := true;
BEGIN
  FOR r IN
    SELECT * FROM gt.audit_log WHERE id > from_id ORDER BY id
  LOOP
    IF first_row THEN
      running := r.prev_hash;
      first_row := false;
    ELSIF r.prev_hash IS DISTINCT FROM running THEN
      broken_at := r.id;
      reason := 'prev_hash does not match preceding row hash';
      RETURN NEXT;
      RETURN;
    END IF;

    expected := sha256(convert_to(
      coalesce(encode(r.prev_hash, 'hex'), 'GENESIS') || E'\x1f' ||
      extract(epoch from r.occurred_at)::text         || E'\x1f' ||
      r.actor                                         || E'\x1f' ||
      r.action                                        || E'\x1f' ||
      r.entity_type                                   || E'\x1f' ||
      coalesce(r.entity_id::text, '')                 || E'\x1f' ||
      coalesce(r.before::text, '')                    || E'\x1f' ||
      coalesce(r.after::text, ''), 'UTF8'));

    IF expected IS DISTINCT FROM r.hash THEN
      broken_at := r.id;
      reason := 'row content does not match its recorded hash';
      RETURN NEXT;
      RETURN;
    END IF;

    running := r.hash;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION gt.verify_audit_chain(bigint) IS
  'Recomputes the hash chain and returns the first divergence, or no rows when '
  'intact. Detects edits by an actor who did not also recompute every later hash. '
  'Detecting a full recomputation requires an external anchor — see gt.audit_anchor.';

-- ---------------------------------------------------------------------------
-- Record every mutation to feature, as the brief requires
-- ---------------------------------------------------------------------------

CREATE FUNCTION gt.feature_audit() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO gt.audit_log (actor, action, entity_type, entity_id, before, after)
  VALUES (
    coalesce(current_setting('gt.actor', true), session_user),
    'FEATURE_' || TG_OP,
    'feature',
    coalesce(NEW.id, OLD.id),
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) - 'geom_utm' END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) - 'geom_utm' END
  );
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION gt.feature_audit() IS
  'Audits every feature mutation. geom_utm is excluded: it is derived from geom by '
  'trigger, so recording it would double the payload and add nothing recoverable.';

CREATE TRIGGER feature_audit_trigger
  AFTER INSERT OR UPDATE OR DELETE ON gt.feature
  FOR EACH ROW EXECUTE FUNCTION gt.feature_audit();

-- Down Migration

DROP TRIGGER IF EXISTS feature_audit_trigger ON gt.feature;
DROP FUNCTION IF EXISTS gt.feature_audit();
DROP FUNCTION IF EXISTS gt.verify_audit_chain(bigint);
DROP TABLE IF EXISTS gt.audit_anchor;
DROP TABLE IF EXISTS gt.audit_log;
DROP TABLE IF EXISTS gt.payment_ledger;
DROP TABLE IF EXISTS gt.review;
DROP FUNCTION IF EXISTS gt.audit_log_append();
DROP FUNCTION IF EXISTS gt.deny_mutation();
