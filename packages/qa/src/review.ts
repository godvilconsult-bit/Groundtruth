/**
 * Human adjudication — QA stage 7.
 *
 * What a reviewer's decision MEANS, as pure logic. The database writes that follow
 * are mechanical; the rules about what a decision implies are not, and they are the
 * ones that will be argued about when a customer disputes a feature.
 *
 * The throughput target is 100 observations per hour — 36 seconds each. That number
 * shapes the design more than it looks: every decision must be reachable by keyboard,
 * every reason code must be selectable in one keystroke, and nothing may require the
 * reviewer to type prose in the common case. A reason taxonomy that needs a sentence
 * is a taxonomy that will be left blank.
 */

export type ReviewDecisionKind = 'ACCEPT' | 'REJECT' | 'ESCALATE';

/**
 * Reason codes a reviewer can choose, and what each implies.
 *
 * Deliberately small. A long list slows the decision below the throughput target and
 * produces inconsistent coding between reviewers, which destroys the distribution
 * that makes the codes useful in the first place (R-007).
 */
export const REVIEW_REASON = {
  // ACCEPT
  CONFIRMED_CORRECT: 'CONFIRMED_CORRECT',
  ACCEPTED_WITH_MINOR_ISSUE: 'ACCEPTED_WITH_MINOR_ISSUE',

  // REJECT
  WRONG_LOCATION: 'WRONG_LOCATION',
  WRONG_ATTRIBUTES: 'WRONG_ATTRIBUTES',
  DUPLICATE_OF_EXISTING: 'DUPLICATE_OF_EXISTING',
  NOT_OBSERVABLE: 'NOT_OBSERVABLE',
  MEDIA_UNUSABLE: 'MEDIA_UNUSABLE',
  SUSPECTED_FABRICATION: 'SUSPECTED_FABRICATION',

  // ESCALATE
  NEEDS_SENIOR_REVIEW: 'NEEDS_SENIOR_REVIEW',
  NEEDS_FIELD_RECHECK: 'NEEDS_FIELD_RECHECK',
  POLICY_UNCLEAR: 'POLICY_UNCLEAR',
} as const;

export type ReviewReason = (typeof REVIEW_REASON)[keyof typeof REVIEW_REASON];

const ALLOWED_BY_DECISION: Readonly<Record<ReviewDecisionKind, ReadonlySet<ReviewReason>>> =
  Object.freeze({
    ACCEPT: new Set<ReviewReason>([
      REVIEW_REASON.CONFIRMED_CORRECT,
      REVIEW_REASON.ACCEPTED_WITH_MINOR_ISSUE,
    ]),
    REJECT: new Set<ReviewReason>([
      REVIEW_REASON.WRONG_LOCATION,
      REVIEW_REASON.WRONG_ATTRIBUTES,
      REVIEW_REASON.DUPLICATE_OF_EXISTING,
      REVIEW_REASON.NOT_OBSERVABLE,
      REVIEW_REASON.MEDIA_UNUSABLE,
      REVIEW_REASON.SUSPECTED_FABRICATION,
    ]),
    ESCALATE: new Set<ReviewReason>([
      REVIEW_REASON.NEEDS_SENIOR_REVIEW,
      REVIEW_REASON.NEEDS_FIELD_RECHECK,
      REVIEW_REASON.POLICY_UNCLEAR,
    ]),
  });

/**
 * Reason codes that require the reviewer to write something.
 *
 * Kept to the two where a bare code is not actionable: an accusation of fabrication
 * has consequences for someone's livelihood and must be substantiated, and an
 * unclear policy is useless as a signal unless it says which policy.
 */
const REQUIRES_NOTES: ReadonlySet<ReviewReason> = Object.freeze(
  new Set<ReviewReason>([REVIEW_REASON.SUSPECTED_FABRICATION, REVIEW_REASON.POLICY_UNCLEAR]),
);

export interface ReviewInput {
  readonly observationId: string;
  readonly reviewerId: string;
  readonly decision: ReviewDecisionKind;
  readonly reason: ReviewReason;
  readonly notes?: string | null;
  /** Milliseconds of reviewer attention. Feeds the throughput target. */
  readonly durationMs: number;
}

/** What a decision implies, for the caller to apply. */
export interface ReviewEffects {
  readonly observationStatus: 'ACCEPTED' | 'REJECTED' | 'FLAGGED';
  /** Payment accrues on acceptance ONLY, never on submission. */
  readonly accruePayment: boolean;
  /** Whether this observation may now contribute to a canonical feature. */
  readonly materialise: boolean;
  /** Escalated work stays in the queue, for someone more senior. */
  readonly staysQueued: boolean;
  /** Worth surfacing to whoever manages collectors. */
  readonly flagsCollector: boolean;
}

export class InvalidReviewError extends Error {
  readonly code = 'INVALID_REVIEW';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReviewError';
  }
}

/** Sub-two-second decisions are a held-down key, not adjudication. */
export const RUBBER_STAMP_MS = 2_000;

/** 100 observations per hour. */
export const THROUGHPUT_TARGET_PER_HOUR = 100;

export function validateReview(input: ReviewInput): void {
  const allowed = ALLOWED_BY_DECISION[input.decision];
  if (!allowed) {
    throw new InvalidReviewError(`unknown decision "${input.decision}"`);
  }
  if (!allowed.has(input.reason)) {
    // A reason that does not match its decision makes the distribution
    // uninterpretable: "rejected as CONFIRMED_CORRECT" is noise in every later query.
    throw new InvalidReviewError(
      `reason "${input.reason}" is not valid for decision "${input.decision}"`,
    );
  }
  if (REQUIRES_NOTES.has(input.reason) && !input.notes?.trim()) {
    throw new InvalidReviewError(`reason "${input.reason}" requires notes`);
  }
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) {
    throw new InvalidReviewError('durationMs must be a non-negative finite number');
  }
}

/**
 * What follows from a decision.
 *
 * ESCALATE deliberately leaves the observation FLAGGED and queued. It is not a
 * third verdict — it is a reviewer declining to be the one who decides, and the
 * work must remain visible rather than disappearing into a state nobody watches.
 */
export function reviewEffects(input: ReviewInput): ReviewEffects {
  validateReview(input);

  switch (input.decision) {
    case 'ACCEPT':
      return Object.freeze({
        observationStatus: 'ACCEPTED',
        accruePayment: true,
        materialise: true,
        staysQueued: false,
        flagsCollector: false,
      });

    case 'REJECT':
      return Object.freeze({
        observationStatus: 'REJECTED',
        // No payment. Paying for rejected work would restore the per-submission
        // incentive that destroys data quality within one pay cycle.
        accruePayment: false,
        materialise: false,
        staysQueued: false,
        flagsCollector: input.reason === REVIEW_REASON.SUSPECTED_FABRICATION,
      });

    case 'ESCALATE':
    default:
      return Object.freeze({
        observationStatus: 'FLAGGED',
        accruePayment: false,
        materialise: false,
        staysQueued: true,
        flagsCollector: input.reason === REVIEW_REASON.NEEDS_FIELD_RECHECK,
      });
  }
}

export interface ThroughputSummary {
  readonly decisions: number;
  readonly perHour: number;
  readonly meanSeconds: number;
  readonly medianSeconds: number;
  readonly rubberStamped: number;
  readonly meetsTarget: boolean;
}

/**
 * Throughput over a set of decisions.
 *
 * Reports the median alongside the mean because they answer different questions: a
 * reviewer who waves through ninety and agonises over ten has a flattering mean and
 * a revealing median. `rubberStamped` counts decisions too fast to have involved
 * looking at anything.
 */
export function summariseThroughput(durationsMs: readonly number[]): ThroughputSummary {
  if (durationsMs.length === 0) {
    return Object.freeze({
      decisions: 0,
      perHour: 0,
      meanSeconds: 0,
      medianSeconds: 0,
      rubberStamped: 0,
      meetsTarget: false,
    });
  }

  const sorted = [...durationsMs].sort((a, b) => a - b);
  const total = sorted.reduce((sum, d) => sum + d, 0);
  const mean = total / sorted.length;
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number);

  return Object.freeze({
    decisions: sorted.length,
    perHour: mean === 0 ? 0 : Math.round(3_600_000 / mean),
    meanSeconds: Number((mean / 1000).toFixed(1)),
    medianSeconds: Number((median / 1000).toFixed(1)),
    rubberStamped: sorted.filter((d) => d < RUBBER_STAMP_MS).length,
    meetsTarget: mean > 0 && 3_600_000 / mean >= THROUGHPUT_TARGET_PER_HOUR,
  });
}

/**
 * Keyboard bindings.
 *
 * Every decision reachable without a mouse, because 36 seconds per observation does
 * not survive reaching for one. Defined here rather than in the component so the
 * mapping is testable and cannot drift between the console and the supervisor
 * surface.
 */
export const REVIEW_KEYS: Readonly<Record<string, { decision: ReviewDecisionKind; reason: ReviewReason }>> =
  Object.freeze({
    a: { decision: 'ACCEPT', reason: REVIEW_REASON.CONFIRMED_CORRECT },
    s: { decision: 'ACCEPT', reason: REVIEW_REASON.ACCEPTED_WITH_MINOR_ISSUE },
    l: { decision: 'REJECT', reason: REVIEW_REASON.WRONG_LOCATION },
    t: { decision: 'REJECT', reason: REVIEW_REASON.WRONG_ATTRIBUTES },
    d: { decision: 'REJECT', reason: REVIEW_REASON.DUPLICATE_OF_EXISTING },
    n: { decision: 'REJECT', reason: REVIEW_REASON.NOT_OBSERVABLE },
    m: { decision: 'REJECT', reason: REVIEW_REASON.MEDIA_UNUSABLE },
    e: { decision: 'ESCALATE', reason: REVIEW_REASON.NEEDS_SENIOR_REVIEW },
    r: { decision: 'ESCALATE', reason: REVIEW_REASON.NEEDS_FIELD_RECHECK },
  });

/**
 * Resolve a keypress to a decision.
 *
 * Notably absent: a single key for SUSPECTED_FABRICATION. Accusing someone of
 * fabricating data affects their livelihood and requires notes, so it is
 * deliberately NOT one keystroke away in a flow optimised for speed.
 */
export function decisionForKey(
  key: string,
): { decision: ReviewDecisionKind; reason: ReviewReason } | null {
  return REVIEW_KEYS[key.toLowerCase()] ?? null;
}
