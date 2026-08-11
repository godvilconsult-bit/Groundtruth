/**
 * QA stage 5 — collector reputation routing, and stage 6 — re-survey sampling.
 *
 * These two decide how much human attention an observation receives, and which
 * accepted features get independently re-walked. Together they produce the
 * disagreement rate, which the brief correctly identifies as the most valuable
 * sales asset in the business.
 *
 * That makes them adversarial surfaces, not merely operational ones. RISKS.md R-007
 * describes the incentive precisely: payment accrues on acceptance, so a collector
 * optimises for acceptance probability rather than truth. The worst version —
 * reporting values a reviewer will accept without observing them — is invisible to
 * every automated check, because the data is internally plausible. Only independent
 * re-survey catches it, which makes sampling a FRAUD CONTROL and not just a quality
 * metric.
 */

import {
  PASS,
  flag,
  REASON,
  type QaObservation,
  type QaContext,
  type StageOutcome,
} from '../types.js';

/** A collector with fewer accepted observations than this is still unproven. */
export const PROVEN_THRESHOLD = 50;

/** Sampled review rate for a proven collector. */
export const PROVEN_REVIEW_RATE = 0.1;

/**
 * An acceptance rate above this, sustained, is anomalous rather than excellent.
 *
 * Real field collection produces ambiguity: gates that are hard to classify, roofs
 * obscured, places that turn out not to exist. A collector who is essentially never
 * wrong is either exceptional or is reporting what gets accepted. Both deserve a
 * look; only one is good news.
 */
export const ANOMALOUS_ACCEPTANCE_RATE = 0.995;

/**
 * Below this many adjudications, an acceptance rate is noise.
 *
 * Deliberately ABOVE `PROVEN_THRESHOLD`. Set below it, this check could never fire
 * independently — every collector with too few adjudications to judge would already
 * have been flagged as unproven, and the anomaly detector would be dead code that
 * looked alive.
 */
export const MIN_SAMPLE_FOR_ANOMALY = 100;

/**
 * Route an observation to the right level of scrutiny.
 *
 * A new collector's work goes to 100% human review — not as distrust, but because
 * there is no evidence yet either way, and the first weeks are when a
 * misunderstanding of the spec is cheapest to correct.
 */
export function reputationRouting(
  _observation: QaObservation,
  context: QaContext,
): StageOutcome {
  const collector = context.collector;

  if (collector.competency === 'SUSPENDED') {
    return flag(
      REASON.REP_SUSPENDED_COLLECTOR,
      'collector is suspended; submissions are recorded but never auto-accepted',
    );
  }

  if (collector.competency === 'TRAINEE' || collector.totalAccepted < PROVEN_THRESHOLD) {
    return flag(
      REASON.REP_NEW_COLLECTOR,
      `unproven collector (${collector.totalAccepted} accepted) — full review`,
    );
  }

  if (
    collector.acceptanceRate !== null &&
    collector.totalAccepted >= MIN_SAMPLE_FOR_ANOMALY &&
    collector.acceptanceRate >= ANOMALOUS_ACCEPTANCE_RATE
  ) {
    // Deliberately routed to review rather than rewarded. See R-007: the failure
    // mode looks exactly like excellence until re-survey disagrees.
    return flag(
      REASON.REP_ANOMALOUS_ACCEPTANCE,
      `acceptance rate ${(collector.acceptanceRate * 100).toFixed(1)}% over ${collector.totalAccepted} is anomalously high`,
    );
  }

  if (context.random() < PROVEN_REVIEW_RATE) {
    return flag(REASON.REP_SAMPLED_REVIEW, 'routine sampled review of a proven collector');
  }

  return PASS;
}

export interface ResurveyPolicy {
  /** Baseline share of accepted features independently re-walked. */
  readonly baseRate: number;
  /** Extra weight for collectors whose acceptance rate is anomalously high. */
  readonly anomalyMultiplier: number;
  /** Extra weight for classes that are hard to judge and cheap to fake. */
  readonly hardClassMultiplier: number;
  /** Versioned, because the published disagreement rate depends on it. */
  readonly version: string;
}

/**
 * The published sampling methodology.
 *
 * Versioned deliberately. RISKS.md R-006 records why: the disagreement rate is a
 * number customers build expectations on, and changing how the sample is drawn
 * changes the number without changing the data. A time series across two
 * undocumented methodologies is worse than no time series.
 */
export const RESURVEY_POLICY_V1: ResurveyPolicy = Object.freeze({
  baseRate: 0.05,
  anomalyMultiplier: 4,
  hardClassMultiplier: 2,
  version: 'resurvey@1.0',
});

/**
 * Classes where fabrication is cheap and verification is hard.
 *
 * A road's seasonal passability cannot be checked from a photo or from another
 * record — you have to have been there, in that season. A building's storey count
 * can be checked against imagery. The first kind needs more independent re-walking.
 */
const HARD_TO_VERIFY = new Set(['ROAD_SEGMENT', 'WATER_POINT', 'ACCESS_POINT']);

/**
 * Decide whether an accepted feature should be independently re-surveyed.
 *
 * Three properties this must have, all from R-006 and R-007:
 *
 *   1. **Server-side.** The device never learns it was sampled, so a collector
 *      cannot behave differently on sampled features.
 *   2. **Unpredictable to the collector.** Not a hash of the observation id, which
 *      anyone holding the id could compute and then avoid.
 *   3. **Weighted, not uniform.** Anomalously-high acceptance and hard-to-verify
 *      classes draw more scrutiny, so the sample is where fraud would hide rather
 *      than merely where it is convenient.
 *
 * The weighting means the raw selection rate is NOT the published disagreement
 * denominator; the published metric must be computed over the uniform stratum. That
 * is a documented consequence, not an oversight.
 */
export function resurveySelection(
  observation: QaObservation,
  context: QaContext,
  policy: ResurveyPolicy = RESURVEY_POLICY_V1,
): StageOutcome {
  let rate = policy.baseRate;

  const collector = context.collector;
  if (
    collector.acceptanceRate !== null &&
    collector.totalAccepted >= MIN_SAMPLE_FOR_ANOMALY &&
    collector.acceptanceRate >= ANOMALOUS_ACCEPTANCE_RATE
  ) {
    rate *= policy.anomalyMultiplier;
  }

  if (HARD_TO_VERIFY.has(observation.featureClass)) {
    rate *= policy.hardClassMultiplier;
  }

  rate = Math.min(1, rate);

  if (context.random() < rate) {
    return flag(
      REASON.RESURVEY_SELECTED,
      `selected for independent re-survey at ${(rate * 100).toFixed(1)}% (${policy.version})`,
    );
  }

  return PASS;
}

/**
 * Effective sampling rate for a given situation.
 *
 * Exposed so the rate can be asserted in tests and reported to customers without
 * re-deriving it from the selection function — the published methodology and the
 * running code must not be able to drift apart.
 */
export function resurveyRateFor(
  featureClass: string,
  collector: Pick<QaContext['collector'], 'acceptanceRate' | 'totalAccepted'>,
  policy: ResurveyPolicy = RESURVEY_POLICY_V1,
): number {
  let rate = policy.baseRate;
  if (
    collector.acceptanceRate !== null &&
    collector.totalAccepted >= MIN_SAMPLE_FOR_ANOMALY &&
    collector.acceptanceRate >= ANOMALOUS_ACCEPTANCE_RATE
  ) {
    rate *= policy.anomalyMultiplier;
  }
  if (HARD_TO_VERIFY.has(featureClass)) rate *= policy.hardClassMultiplier;
  return Math.min(1, rate);
}
