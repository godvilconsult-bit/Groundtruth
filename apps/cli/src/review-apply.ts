/**
 * Apply a reviewer's decision.
 *
 * The decision's MEANING comes from `@groundtruth/qa`; this only performs the
 * writes it implies. All of them happen in one transaction, because a half-applied
 * decision is the worst possible state: an observation marked accepted with no
 * review row explaining it, or a payment accrued against a decision that was rolled
 * back.
 */

import type pg from 'pg';
import { reviewEffects, type ReviewInput } from '@groundtruth/qa';

export interface ApplyResult {
  readonly observationId: string;
  readonly status: 'ACCEPTED' | 'REJECTED' | 'FLAGGED';
  readonly paymentAccrued: boolean;
  readonly collectorFlagged: boolean;
}

/**
 * Claim a batch of flagged observations for one reviewer.
 *
 * Expired claims are released first, explicitly. `now()` cannot appear in an index
 * predicate, so expiry is not enforced by the unique index — and doing it as a
 * visible step also leaves a record of the expiry rather than burying it in a clock
 * comparison nobody can audit.
 */
export async function claimForReview(
  client: pg.Client,
  args: { reviewerId: string; limit?: number; holdSeconds?: number; wardId?: string | null },
): Promise<string[]> {
  const limit = args.limit ?? 25;
  const hold = args.holdSeconds ?? 600;

  await client.query('SET search_path = gt, reference, extensions, public');

  await client.query(
    `UPDATE gt.review_claim
        SET released_at = now()
      WHERE released_at IS NULL AND expires_at <= now()`,
  );

  const { rows } = await client.query(
    `INSERT INTO gt.review_claim (observation_id, reviewer_id, expires_at)
     SELECT q.observation_id, $1, now() + make_interval(secs => $2)
       FROM gt.review_queue q
      WHERE ($4::uuid IS NULL OR q.ward_id = $4)
      ORDER BY q.submitted_at
      LIMIT $3
     ON CONFLICT DO NOTHING
     RETURNING observation_id`,
    [args.reviewerId, hold, limit, args.wardId ?? null],
  );

  return rows.map((r) => r.observation_id as string);
}

/**
 * Record a decision and everything that follows from it.
 *
 * Idempotent on the payment accrual through the partial unique index on
 * `payment_ledger`, so a retried request cannot pay twice for one observation.
 */
export async function applyReview(client: pg.Client, input: ReviewInput): Promise<ApplyResult> {
  const effects = reviewEffects(input);

  await client.query('SET search_path = gt, reference, extensions, public');
  await client.query("SELECT set_config('gt.actor', $1, false)", [`reviewer:${input.reviewerId}`]);

  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO gt.review
         (observation_id, reviewer_id, decision, reason_code, notes, duration_ms)
       VALUES ($1, $2, $3::public.review_decision, $4, $5, $6)`,
      [
        input.observationId,
        input.reviewerId,
        input.decision,
        input.reason,
        input.notes ?? null,
        Math.round(input.durationMs),
      ],
    );

    await client.query(
      `UPDATE gt.observation
          SET qa_status = $2::public.observation_qa_status
        WHERE id = $1`,
      [input.observationId, effects.observationStatus],
    );

    if (effects.accruePayment) {
      await client.query(
        `INSERT INTO gt.payment_ledger (collector_id, observation_id, amount_minor, reason)
         SELECT o.collector_id, o.id, c.payment_rate_minor, 'OBSERVATION_ACCEPTED'
           FROM gt.observation o
           JOIN gt.collector c ON c.id = o.collector_id
          WHERE o.id = $1
         ON CONFLICT (observation_id) WHERE reason = 'OBSERVATION_ACCEPTED' DO NOTHING`,
        [input.observationId],
      );
    }

    // Escalated work stays queued for someone more senior, so its claim is released
    // rather than left to expire — otherwise it is invisible for the hold period.
    await client.query(
      `UPDATE gt.review_claim
          SET released_at = now()
        WHERE observation_id = $1 AND released_at IS NULL`,
      [input.observationId],
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }

  return {
    observationId: input.observationId,
    status: effects.observationStatus,
    paymentAccrued: effects.accruePayment,
    collectorFlagged: effects.flagsCollector,
  };
}

export interface QueueSummary {
  readonly waiting: number;
  readonly claimed: number;
  readonly byReason: Readonly<Record<string, number>>;
  readonly oldestWaitingHours: number | null;
}

export async function queueSummary(client: pg.Client): Promise<QueueSummary> {
  await client.query('SET search_path = gt, reference, extensions, public');

  const waiting = await client.query('SELECT count(*)::int n FROM gt.review_queue');
  const claimed = await client.query(
    `SELECT count(*)::int n FROM gt.review_claim
      WHERE released_at IS NULL AND expires_at > now()`,
  );
  const reasons = await client.query(
    `SELECT code, count(*)::int n
       FROM gt.review_queue, unnest(reason_codes) code
      GROUP BY code ORDER BY n DESC`,
  );
  const oldest = await client.query(
    `SELECT round(extract(epoch FROM now() - min(submitted_at)) / 3600.0, 1) h
       FROM gt.review_queue`,
  );

  return {
    waiting: waiting.rows[0].n as number,
    claimed: claimed.rows[0].n as number,
    byReason: Object.fromEntries(reasons.rows.map((r) => [r.code, r.n])),
    oldestWaitingHours: oldest.rows[0].h === null ? null : Number(oldest.rows[0].h),
  };
}
