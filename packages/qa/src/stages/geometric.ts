/**
 * QA stage 2 — geometric plausibility.
 *
 * Catches positions that cannot be what they claim: a fix too coarse to locate a
 * gate, a point in the Indian Ocean, a footprint recorded 200 km from the assigned
 * ward, a class arriving with the wrong geometry.
 *
 * The distinction between FLAG and REJECT is the load-bearing design choice here.
 * REJECT is for physically impossible or definitionally wrong data. FLAG is for
 * suspicious-but-possible, because a mapper standing somewhere unexpected is
 * sometimes right — ward extents in the reference data are approximations, and
 * rejecting good field data outright damages collector trust and reputation scores
 * that are expensive to repair (RISKS.md R-005).
 */

import { geometryMatchesClass } from '@groundtruth/domain';
import {
  PASS,
  flag,
  reject,
  REASON,
  type QaObservation,
  type QaContext,
  type StageOutcome,
} from '../types.js';

/** Beyond this a fix cannot distinguish adjacent gates on the same compound wall. */
export const ACCURACY_FLAG_M = 25;
/** Beyond this the fix is not locating anything; it is a cell-tower estimate. */
export const ACCURACY_REJECT_M = 100;
/** A sub-metre fix from a phone GNSS is not credible. */
export const ACCURACY_IMPLAUSIBLE_M = 0.5;

/** Slack around a ward envelope: extents are approximations, not surveys. */
export const WARD_SLACK_DEGREES = 0.02;
/** Roughly 20 km beyond the ward — no longer an envelope-approximation issue. */
export const WARD_FAR_DEGREES = 0.2;

/** Great-circle distance in metres. */
export function distanceMetres(
  a: { lon: number; lat: number },
  b: { lon: number; lat: number },
): number {
  const R = 6_371_008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function geometricPlausibility(
  observation: QaObservation,
  context: QaContext,
): StageOutcome {
  const { lon, lat, gpsAccuracyM } = observation;

  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return reject(REASON.GEO_NULL_ISLAND, `non-finite coordinates (${lon}, ${lat})`);
  }

  // Null Island. A 0,0 fix is the classic signature of an uninitialised GPS
  // structure, not a real position in the Gulf of Guinea.
  if (Math.abs(lon) < 0.0001 && Math.abs(lat) < 0.0001) {
    return reject(REASON.GEO_NULL_ISLAND, 'coordinates at 0,0 — uninitialised fix');
  }

  if (!geometryMatchesClass(observation.featureClass, observation.geometryType)) {
    // A footprint arriving as a point breaks the structure-extent guarantee the
    // non-cadastral position rests on, so this is definitional, not suspicious.
    return reject(
      REASON.GEO_WRONG_GEOMETRY_TYPE,
      `${observation.featureClass} requires a different geometry, got ${observation.geometryType}`,
    );
  }

  if (!Number.isFinite(gpsAccuracyM) || gpsAccuracyM <= 0) {
    return reject(REASON.GEO_ACCURACY_IMPLAUSIBLE, `accuracy must be positive, got ${gpsAccuracyM}`);
  }

  if (gpsAccuracyM < ACCURACY_IMPLAUSIBLE_M) {
    // Sub-metre from a handset means a fabricated value or a spoofed provider —
    // suspicious rather than impossible, so a human looks.
    return flag(
      REASON.GEO_ACCURACY_IMPLAUSIBLE,
      `reported ${gpsAccuracyM} m is better than handset GNSS achieves`,
    );
  }

  if (gpsAccuracyM > ACCURACY_REJECT_M) {
    return reject(
      REASON.GEO_ACCURACY_POOR,
      `accuracy ${gpsAccuracyM} m cannot locate a feature`,
    );
  }

  const ward = context.ward;
  if (ward) {
    const outsideBy = envelopeOvershoot(observation, ward);
    if (outsideBy > WARD_FAR_DEGREES) {
      return reject(
        REASON.GEO_FAR_OUTSIDE_ASSIGNED_WARD,
        `~${Math.round(outsideBy * 111)} km outside assigned ward ${ward.wardId}`,
      );
    }
    if (outsideBy > WARD_SLACK_DEGREES) {
      // Ward extents are approximations (R-005). Outside-but-near is a question
      // for a human, not grounds to discard a walk.
      return flag(
        REASON.GEO_OUTSIDE_ASSIGNED_WARD,
        `outside assigned ward ${ward.wardId} by ~${Math.round(outsideBy * 111_000)} m`,
      );
    }
  }

  if (gpsAccuracyM > ACCURACY_FLAG_M) {
    return flag(
      REASON.GEO_ACCURACY_POOR,
      `accuracy ${gpsAccuracyM} m is too coarse to distinguish adjacent features`,
    );
  }

  return PASS;
}

/** Degrees by which a point falls outside an envelope; 0 when inside. */
function envelopeOvershoot(
  point: { lon: number; lat: number },
  ward: { minLon: number; maxLon: number; minLat: number; maxLat: number },
): number {
  const dLon = Math.max(ward.minLon - point.lon, point.lon - ward.maxLon, 0);
  const dLat = Math.max(ward.minLat - point.lat, point.lat - ward.maxLat, 0);
  return Math.max(dLon, dLat);
}

/**
 * Footprint overlap against already-accepted features.
 *
 * Kept separate because it needs a spatial query the pure stage cannot perform. The
 * caller supplies candidates; this decides.
 *
 * Note what this deliberately does NOT do: it does not merge, union, or adjust
 * geometry to resolve the overlap. Doing so would compute land extents from
 * footprints, which is exactly the operation RISKS.md R-009 forbids. Overlap is
 * reported for a human to adjudicate, never silently reconciled.
 */
export function footprintOverlap(
  observation: QaObservation,
  acceptedNearby: readonly { id: string; lon: number; lat: number }[],
  toleranceM = 3,
): StageOutcome {
  if (observation.featureClass !== 'BUILDING_FOOTPRINT') return PASS;

  const conflicting = acceptedNearby.filter(
    (candidate) => distanceMetres(observation, candidate) < toleranceM,
  );

  if (conflicting.length === 0) return PASS;

  return flag(
    REASON.GEO_FOOTPRINT_OVERLAP,
    `overlaps ${conflicting.length} accepted footprint(s): ${conflicting
      .slice(0, 3)
      .map((c) => c.id)
      .join(', ')}`,
  );
}
