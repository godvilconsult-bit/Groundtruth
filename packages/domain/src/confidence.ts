/**
 * Confidence scoring.
 *
 * A customer buying this dataset is buying the confidence score as much as the
 * geometry. The formula is therefore versioned, published, and changed only by
 * publishing a new version — never by editing this one in place. See
 * `docs/confidence-score-v1.md`, which this file implements exactly.
 *
 * Every constant below is named and justified. A magic number in a scoring function
 * customers can audit is a liability.
 */

export const CONFIDENCE_FORMULA_VERSION = 'confidence@1.0';

/** One observation from a perfectly-reputed collector scores ~0.59 on evidence. */
const EVIDENCE_K = 0.9;

/** GPS accuracy at or below this is not penalised at all. */
const ACCURACY_FLOOR_M = 5;
/** GPS accuracy at or above this receives the maximum penalty. */
const ACCURACY_CEILING_M = 50;
/** Multiplier at and beyond ACCURACY_CEILING_M. Never zero: a coarse fix is still evidence. */
const ACCURACY_MIN_FACTOR = 0.3;

/** Days over which unverified confidence halves. 18 months. */
const RECENCY_HALF_LIFE_DAYS = 540;
/** Floor on decay: old data that was well-verified stays useful. */
const RECENCY_MIN_FACTOR = 0.4;

/** Independent re-survey agreement is the strongest signal available. */
const RESURVEY_AGREED_FACTOR = 1.1;
/** Disagreement is severe: two mappers walked the same place and disagreed. */
const RESURVEY_DISAGREED_FACTOR = 0.5;

/** `numeric(4,3)` in the database — three decimal places, no more. */
const SCORE_DECIMALS = 3;

export interface ConfidenceInputs {
  /**
   * Quality scores, in [0,1], of the distinct collectors who independently observed
   * this feature. One entry per collector, not per observation: three visits by the
   * same mapper are one opinion, and counting them three times is how a dataset
   * talks itself into false confidence.
   */
  readonly collectorReputations: readonly number[];
  /** Best (lowest) GPS accuracy in metres across contributing observations. */
  readonly bestGpsAccuracyM: number;
  /** Days since last verification. */
  readonly daysSinceLastVerified: number;
  /** Independent re-survey outcome, or null when never re-surveyed. */
  readonly resurvey: { readonly agreed: boolean } | null;
}

export interface ConfidenceBreakdown {
  readonly score: number;
  readonly formulaVersion: string;
  readonly evidenceFactor: number;
  readonly accuracyFactor: number;
  readonly recencyFactor: number;
  readonly resurveyFactor: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round = (v: number): number => Number(v.toFixed(SCORE_DECIMALS));

/**
 * Saturating evidence curve over reputation-weighted independent observations.
 *
 * Saturating rather than linear because the tenth independent observation of a
 * building tells you far less than the second. Linear growth would also let volume
 * substitute for quality, which is the incentive we are trying not to create.
 */
function evidenceFactor(reputations: readonly number[]): number {
  const weight = reputations.reduce<number>((sum, r) => sum + clamp(r, 0, 1), 0);
  return 1 - Math.exp(-EVIDENCE_K * weight);
}

/** Linear penalty between the floor and ceiling. Linear because it must be explainable. */
function accuracyFactor(accuracyM: number): number {
  if (!Number.isFinite(accuracyM) || accuracyM <= ACCURACY_FLOOR_M) return 1;
  if (accuracyM >= ACCURACY_CEILING_M) return ACCURACY_MIN_FACTOR;
  const span = ACCURACY_CEILING_M - ACCURACY_FLOOR_M;
  const traveled = (accuracyM - ACCURACY_FLOOR_M) / span;
  return 1 - traveled * (1 - ACCURACY_MIN_FACTOR);
}

/** Exponential decay with a floor. The world changes; an old observation is weaker. */
function recencyFactor(days: number): number {
  if (!Number.isFinite(days) || days <= 0) return 1;
  return Math.max(RECENCY_MIN_FACTOR, Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS));
}

function resurveyFactor(resurvey: ConfidenceInputs['resurvey']): number {
  if (resurvey === null) return 1;
  return resurvey.agreed ? RESURVEY_AGREED_FACTOR : RESURVEY_DISAGREED_FACTOR;
}

/**
 * Compute a confidence score in [0,1], with its component factors.
 *
 * The breakdown is returned, not just the score, because "why is this 0.62?" is a
 * question a customer will ask and a reviewer needs answered without re-deriving it.
 */
export function computeConfidence(inputs: ConfidenceInputs): ConfidenceBreakdown {
  if (inputs.collectorReputations.length === 0) {
    // No observation, no confidence. Not a degenerate case worth a special score.
    return Object.freeze({
      score: 0,
      formulaVersion: CONFIDENCE_FORMULA_VERSION,
      evidenceFactor: 0,
      accuracyFactor: 0,
      recencyFactor: 0,
      resurveyFactor: 0,
    });
  }

  const evidence = evidenceFactor(inputs.collectorReputations);
  const accuracy = accuracyFactor(inputs.bestGpsAccuracyM);
  const recency = recencyFactor(inputs.daysSinceLastVerified);
  const resurvey = resurveyFactor(inputs.resurvey);

  return Object.freeze({
    score: round(clamp(evidence * accuracy * recency * resurvey, 0, 1)),
    formulaVersion: CONFIDENCE_FORMULA_VERSION,
    evidenceFactor: round(evidence),
    accuracyFactor: round(accuracy),
    recencyFactor: round(recency),
    resurveyFactor: round(resurvey),
  });
}
