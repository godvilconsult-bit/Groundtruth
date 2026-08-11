/**
 * The QA pipeline's vocabulary.
 *
 * This pipeline is the product. The dataset is only worth licensing because
 * something decided, defensibly and repeatably, which observations became canonical
 * features — so every decision here carries a reason code, and reason codes are
 * enumerated rather than free text.
 *
 * That matters beyond tidiness. RISKS.md R-007 records the failure mode automated
 * checks cannot see: a collector who learns which values reviewers accept and
 * reports those regardless of what they observed. The data is internally plausible,
 * so only the DISTRIBUTION of reason codes across a collector's submissions reveals
 * it — and a distribution cannot be computed over prose.
 */

import type { FeatureClass, Provenance } from '@groundtruth/domain';

export type StageVerdict =
  /** Continue to the next stage. */
  | 'PASS'
  /** Continue, but route to human adjudication before acceptance. */
  | 'FLAG'
  /** Stop. The observation cannot become a feature as submitted. */
  | 'REJECT';

/**
 * Enumerated reason codes.
 *
 * Grouped by stage prefix so a reviewer reading a queue, or an analyst reading a
 * distribution, can tell at a glance which check fired.
 */
export const REASON = {
  // Stage 1 — schema
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  SCHEMA_UNKNOWN_VERSION: 'SCHEMA_UNKNOWN_VERSION',

  // Stage 2 — geometric plausibility
  GEO_ACCURACY_POOR: 'GEO_ACCURACY_POOR',
  GEO_ACCURACY_IMPLAUSIBLE: 'GEO_ACCURACY_IMPLAUSIBLE',
  GEO_OUTSIDE_ASSIGNED_WARD: 'GEO_OUTSIDE_ASSIGNED_WARD',
  GEO_FAR_OUTSIDE_ASSIGNED_WARD: 'GEO_FAR_OUTSIDE_ASSIGNED_WARD',
  GEO_NULL_ISLAND: 'GEO_NULL_ISLAND',
  GEO_IN_WATER: 'GEO_IN_WATER',
  GEO_WRONG_GEOMETRY_TYPE: 'GEO_WRONG_GEOMETRY_TYPE',
  GEO_FOOTPRINT_OVERLAP: 'GEO_FOOTPRINT_OVERLAP',

  // Stage 3 — temporal plausibility
  TIME_IMPOSSIBLE_SPEED: 'TIME_IMPOSSIBLE_SPEED',
  TIME_IMPLAUSIBLE_SPEED: 'TIME_IMPLAUSIBLE_SPEED',
  TIME_CAPTURE_IN_FUTURE: 'TIME_CAPTURE_IN_FUTURE',
  TIME_CLOCK_SKEW_LARGE: 'TIME_CLOCK_SKEW_LARGE',
  TIME_SEQUENCE_DISORDERED: 'TIME_SEQUENCE_DISORDERED',
  TIME_DWELL_TOO_SHORT: 'TIME_DWELL_TOO_SHORT',

  // Stage 4 — duplicates
  DUP_EXISTING_FEATURE: 'DUP_EXISTING_FEATURE',
  DUP_WITHIN_BATCH: 'DUP_WITHIN_BATCH',

  // Stage 5 — reputation
  REP_NEW_COLLECTOR: 'REP_NEW_COLLECTOR',
  REP_SUSPENDED_COLLECTOR: 'REP_SUSPENDED_COLLECTOR',
  REP_SAMPLED_REVIEW: 'REP_SAMPLED_REVIEW',
  REP_ANOMALOUS_ACCEPTANCE: 'REP_ANOMALOUS_ACCEPTANCE',

  // Stage 6 — re-survey
  RESURVEY_SELECTED: 'RESURVEY_SELECTED',

  // Provenance guard — never expected to fire, and loud if it does
  PROVENANCE_NOT_EXPORTABLE: 'PROVENANCE_NOT_EXPORTABLE',
} as const;

export type ReasonCode = (typeof REASON)[keyof typeof REASON];

export interface StageOutcome {
  readonly verdict: StageVerdict;
  readonly reasons: readonly {
    readonly code: ReasonCode;
    readonly detail: string;
  }[];
}

export const PASS: StageOutcome = Object.freeze({ verdict: 'PASS', reasons: Object.freeze([]) });

export function flag(code: ReasonCode, detail: string): StageOutcome {
  return Object.freeze({ verdict: 'FLAG', reasons: Object.freeze([{ code, detail }]) });
}

export function reject(code: ReasonCode, detail: string): StageOutcome {
  return Object.freeze({ verdict: 'REJECT', reasons: Object.freeze([{ code, detail }]) });
}

/** An observation as the pipeline sees it. */
export interface QaObservation {
  readonly id: string;
  readonly collectorId: string;
  readonly deviceId: string;
  readonly featureClass: FeatureClass;
  readonly specVersion: string;
  readonly provenance: Provenance;
  readonly lon: number;
  readonly lat: number;
  readonly geometryType: string;
  readonly gpsAccuracyM: number;
  /** Device clock — untrusted. */
  readonly capturedAt: number;
  /** Server clock — trusted. */
  readonly submittedAt: number;
  readonly deviceSequence: number;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly wardId: string | null;
  readonly mediaRefs: readonly string[];
  readonly consentRef: string | null;
}

export interface CollectorProfile {
  readonly id: string;
  readonly competency: 'TRAINEE' | 'PROVEN' | 'SUSPENDED';
  readonly qualityScore: number;
  /** Observations accepted / observations adjudicated, or null when too few to judge. */
  readonly acceptanceRate: number | null;
  readonly totalAccepted: number;
}

/** Ward extent as a bounding box. Operational geofence only (DECISIONS D-004). */
export interface WardEnvelope {
  readonly wardId: string;
  readonly minLon: number;
  readonly maxLon: number;
  readonly minLat: number;
  readonly maxLat: number;
  readonly isAuthoritative: boolean;
}

export interface QaContext {
  readonly now: number;
  readonly collector: CollectorProfile;
  readonly ward: WardEnvelope | null;
  /** The same collector's other observations in this batch, for track checks. */
  readonly track: readonly QaObservation[];
  /**
   * Device clock minus server clock, measured once per SYNC BATCH at ingest.
   *
   * Per batch, not per observation, and the distinction is not academic: this
   * product is offline-first, so an observation is routinely six hours old by the
   * time it syncs. Deriving skew from `submittedAt - capturedAt` would classify
   * every normal offline observation as a clock problem, drowning reviewers and
   * making the signal worthless. ADR-0002 records skew per batch for this reason.
   */
  readonly clockSkewMs: number;
  /** Deterministic in tests; unpredictable to collectors in production. */
  readonly random: () => number;
}
