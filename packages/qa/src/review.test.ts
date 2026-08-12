import { describe, it, expect } from 'vitest';
import {
  reviewEffects,
  validateReview,
  summariseThroughput,
  decisionForKey,
  REVIEW_REASON,
  REVIEW_KEYS,
  RUBBER_STAMP_MS,
  THROUGHPUT_TARGET_PER_HOUR,
  InvalidReviewError,
  type ReviewInput,
} from './review.js';

const review = (over: Partial<ReviewInput> = {}): ReviewInput => ({
  observationId: 'obs-1',
  reviewerId: 'rev-1',
  decision: 'ACCEPT',
  reason: REVIEW_REASON.CONFIRMED_CORRECT,
  notes: null,
  durationMs: 20_000,
  ...over,
});

describe('decision validity', () => {
  it('accepts a coherent decision', () => {
    expect(() => validateReview(review())).not.toThrow();
  });

  it('REFUSES a reason that does not match its decision', () => {
    // "rejected as CONFIRMED_CORRECT" would be noise in every later query, and the
    // reason-code distribution is the only place gaming becomes visible (R-007).
    expect(() =>
      validateReview(review({ decision: 'REJECT', reason: REVIEW_REASON.CONFIRMED_CORRECT })),
    ).toThrow(InvalidReviewError);
  });

  it('REFUSES an escalation reason on an acceptance', () => {
    expect(() =>
      validateReview(review({ decision: 'ACCEPT', reason: REVIEW_REASON.NEEDS_SENIOR_REVIEW })),
    ).toThrow(InvalidReviewError);
  });

  it('requires notes when accusing someone of fabrication', () => {
    // This affects a person's livelihood and must be substantiated.
    expect(() =>
      validateReview(
        review({ decision: 'REJECT', reason: REVIEW_REASON.SUSPECTED_FABRICATION }),
      ),
    ).toThrow(/requires notes/);
  });

  it('accepts a fabrication claim that IS substantiated', () => {
    expect(() =>
      validateReview(
        review({
          decision: 'REJECT',
          reason: REVIEW_REASON.SUSPECTED_FABRICATION,
          notes: 'Photo shows a different street; three prior observations identical.',
        }),
      ),
    ).not.toThrow();
  });

  it('requires notes when reporting unclear policy, so it names the policy', () => {
    expect(() =>
      validateReview(review({ decision: 'ESCALATE', reason: REVIEW_REASON.POLICY_UNCLEAR })),
    ).toThrow(/requires notes/);
  });

  it('does not demand notes for ordinary decisions', () => {
    // A taxonomy that needs a sentence every time is a taxonomy left blank.
    expect(() =>
      validateReview(review({ decision: 'REJECT', reason: REVIEW_REASON.WRONG_LOCATION })),
    ).not.toThrow();
  });

  it('rejects a negative or non-finite duration', () => {
    expect(() => validateReview(review({ durationMs: -1 }))).toThrow(InvalidReviewError);
    expect(() => validateReview(review({ durationMs: Number.NaN }))).toThrow(InvalidReviewError);
  });
});

describe('what a decision implies', () => {
  it('ACCEPT makes the observation canonical and accrues payment', () => {
    const effects = reviewEffects(review());
    expect(effects.observationStatus).toBe('ACCEPTED');
    expect(effects.accruePayment).toBe(true);
    expect(effects.materialise).toBe(true);
  });

  it('REJECT pays nothing', () => {
    // Paying for rejected work restores the per-submission incentive that destroys
    // data quality within one pay cycle.
    const effects = reviewEffects(
      review({ decision: 'REJECT', reason: REVIEW_REASON.WRONG_LOCATION }),
    );
    expect(effects.observationStatus).toBe('REJECTED');
    expect(effects.accruePayment).toBe(false);
    expect(effects.materialise).toBe(false);
  });

  it('ESCALATE keeps the work visible rather than resolving it', () => {
    // Not a third verdict — a reviewer declining to be the one who decides. The
    // observation must stay queued, not vanish into a state nobody watches.
    const effects = reviewEffects(
      review({ decision: 'ESCALATE', reason: REVIEW_REASON.NEEDS_SENIOR_REVIEW }),
    );
    expect(effects.observationStatus).toBe('FLAGGED');
    expect(effects.staysQueued).toBe(true);
    expect(effects.materialise).toBe(false);
    expect(effects.accruePayment).toBe(false);
  });

  it('surfaces a suspected fabrication to whoever manages collectors', () => {
    const effects = reviewEffects(
      review({
        decision: 'REJECT',
        reason: REVIEW_REASON.SUSPECTED_FABRICATION,
        notes: 'substantiated',
      }),
    );
    expect(effects.flagsCollector).toBe(true);
  });

  it('does not flag a collector for an ordinary rejection', () => {
    // Being wrong is not being dishonest, and conflating them would poison
    // reputation scores that are expensive to repair.
    const effects = reviewEffects(
      review({ decision: 'REJECT', reason: REVIEW_REASON.WRONG_ATTRIBUTES }),
    );
    expect(effects.flagsCollector).toBe(false);
  });

  it('returns frozen effects, so a caller cannot rewrite what a decision meant', () => {
    expect(Object.isFrozen(reviewEffects(review()))).toBe(true);
  });

  it('validates before computing effects', () => {
    expect(() =>
      reviewEffects(review({ decision: 'ACCEPT', reason: REVIEW_REASON.WRONG_LOCATION })),
    ).toThrow(InvalidReviewError);
  });
});

describe('keyboard bindings — 36 seconds does not survive reaching for a mouse', () => {
  it('binds every decision kind to at least one key', () => {
    const kinds = new Set(Object.values(REVIEW_KEYS).map((b) => b.decision));
    expect([...kinds].sort()).toEqual(['ACCEPT', 'ESCALATE', 'REJECT']);
  });

  it('resolves a keypress case-insensitively', () => {
    expect(decisionForKey('a')?.decision).toBe('ACCEPT');
    expect(decisionForKey('A')?.decision).toBe('ACCEPT');
  });

  it('returns null for an unbound key rather than guessing', () => {
    expect(decisionForKey('z')).toBeNull();
    expect(decisionForKey('')).toBeNull();
  });

  it('binds no key to SUSPECTED_FABRICATION', () => {
    // Accusing someone of fabricating data must not be one keystroke away in a
    // flow optimised for speed. It requires notes, so it requires deliberation.
    const bound = Object.values(REVIEW_KEYS).map((b) => b.reason);
    expect(bound).not.toContain(REVIEW_REASON.SUSPECTED_FABRICATION);
  });

  it('produces only valid decision/reason pairs', () => {
    for (const [key, binding] of Object.entries(REVIEW_KEYS)) {
      expect(
        () =>
          validateReview(
            review({ decision: binding.decision, reason: binding.reason, notes: 'x' }),
          ),
        `binding for "${key}"`,
      ).not.toThrow();
    }
  });

  it('assigns each key exactly once', () => {
    const keys = Object.keys(REVIEW_KEYS);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('throughput against the 100/hour target', () => {
  it('reports zero for no decisions', () => {
    const summary = summariseThroughput([]);
    expect(summary.decisions).toBe(0);
    expect(summary.meetsTarget).toBe(false);
  });

  it('meets the target at 36 seconds per observation', () => {
    const summary = summariseThroughput(Array(50).fill(36_000));
    expect(summary.perHour).toBe(THROUGHPUT_TARGET_PER_HOUR);
    expect(summary.meetsTarget).toBe(true);
  });

  it('misses the target when decisions take longer', () => {
    const summary = summariseThroughput(Array(20).fill(60_000));
    expect(summary.perHour).toBe(60);
    expect(summary.meetsTarget).toBe(false);
  });

  it('reports the median as well as the mean', () => {
    // A reviewer who waves through ninety and agonises over ten has a flattering
    // mean and a revealing median.
    const durations = [...Array(90).fill(1_000), ...Array(10).fill(300_000)];
    const summary = summariseThroughput(durations);
    expect(summary.medianSeconds).toBe(1);
    expect(summary.meanSeconds).toBeGreaterThan(25);
  });

  it('counts decisions too fast to have involved looking at anything', () => {
    const summary = summariseThroughput([500, 800, 1_500, 40_000, 50_000]);
    expect(summary.rubberStamped).toBe(3);
    expect(RUBBER_STAMP_MS).toBe(2_000);
  });

  it('handles an even-length sample when taking the median', () => {
    expect(summariseThroughput([10_000, 20_000, 30_000, 40_000]).medianSeconds).toBe(25);
  });

  it('does not mutate the input', () => {
    const durations = [30_000, 10_000, 20_000];
    const snapshot = [...durations];
    summariseThroughput(durations);
    expect(durations).toEqual(snapshot);
  });
});
