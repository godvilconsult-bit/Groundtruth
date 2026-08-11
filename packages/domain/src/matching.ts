/**
 * Observation-to-feature matching.
 *
 * Many observations resolve to one canonical feature. Deciding which observations
 * describe the same real-world thing is the first step of that resolution, and it
 * happens server-side — never on the device (ADR-0002).
 *
 * This is the Phase 1 rule: spatial proximity within a per-class tolerance, same
 * feature class. Phase 3 adds attribute similarity, collector reputation weighting,
 * and human adjudication on top. The thresholds live here because they are business
 * rules about the physical world, not implementation detail.
 */

import { FEATURE_CLASS, type FeatureClass } from './feature-class.js';

/**
 * How far apart two observations can be and still describe the same feature.
 *
 * These are deliberately conservative. Merging two distinct things is far more
 * damaging than failing to merge one thing: a wrong merge silently destroys a real
 * place and averages two truths into a falsehood, while a missed merge leaves two
 * lower-confidence records that a later re-survey reconciles.
 */
const MATCH_TOLERANCE_M: Readonly<Record<FeatureClass, number>> = Object.freeze({
  // Footprints are matched on centroid distance; adjacent buildings in dense Tanga
  // wards can be under 3 m apart, so this stays tight.
  BUILDING_FOOTPRINT: 8,
  // Gates on the same compound wall can be genuinely close together.
  ACCESS_POINT: 6,
  // Road segments are matched loosely; the geometry is linear and endpoints vary.
  ROAD_SEGMENT: 25,
  POI: 10,
  // Handpumps and standpipes are well separated in practice.
  WATER_POINT: 12,
  ADDRESS_ANCHOR: 10,
});

export function matchToleranceM(featureClass: FeatureClass): number {
  return MATCH_TOLERANCE_M[featureClass];
}

export interface MatchCandidate {
  readonly id: string;
  readonly featureClass: FeatureClass;
  /** Representative point: centroid for areal and linear classes. */
  readonly lon: number;
  readonly lat: number;
  readonly gpsAccuracyM: number;
}

/**
 * Great-circle distance in metres.
 *
 * Haversine on a spherical earth. Accurate to ~0.5% — irrelevant at the 6–25 m
 * tolerances above, and it avoids a projection round trip in the hot path of
 * clustering a thousand observations. PostGIS geography is the authority when exact
 * distance matters.
 */
export function distanceMetres(
  a: { lon: number; lat: number },
  b: { lon: number; lat: number },
): number {
  const R = 6_371_008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Whether two observations plausibly describe the same feature.
 *
 * The tolerance is widened by the observations' own reported GPS accuracy: two
 * readings 10 m apart taken with ±15 m fixes are entirely consistent with the same
 * gate, while the same 10 m gap with ±2 m fixes is two different gates. Ignoring
 * reported accuracy here would make the rule wrong in both directions at once.
 */
export function isSameFeature(a: MatchCandidate, b: MatchCandidate): boolean {
  if (a.featureClass !== b.featureClass) return false;
  const base = matchToleranceM(a.featureClass);
  const slack = Math.min(a.gpsAccuracyM, b.gpsAccuracyM);
  return distanceMetres(a, b) <= base + slack;
}

/**
 * Group observations into clusters, each becoming one canonical feature.
 *
 * Single-link agglomeration: an observation joins a cluster if it matches ANY member.
 * Chosen over centroid-link because a row of observations along a road segment is a
 * legitimate chain, and centroid-link would split it arbitrarily.
 *
 * Single-link can chain excessively in dense data — the known weakness. It is
 * acceptable at Phase 1 tolerances (6–25 m) and is exactly what QA stage 4 and human
 * adjudication exist to catch. Revisit if chaining shows up in Tanga's densest wards.
 */
export function clusterObservations(
  observations: readonly MatchCandidate[],
): MatchCandidate[][] {
  const unassigned = [...observations];
  const clusters: MatchCandidate[][] = [];

  while (unassigned.length > 0) {
    const seed = unassigned.shift() as MatchCandidate;
    const cluster: MatchCandidate[] = [seed];

    // Re-scan after each addition: a newly added member can bring others into range.
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = unassigned.length - 1; i >= 0; i -= 1) {
        const candidate = unassigned[i] as MatchCandidate;
        if (cluster.some((member) => isSameFeature(member, candidate))) {
          cluster.push(candidate);
          unassigned.splice(i, 1);
          grew = true;
        }
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}

export { FEATURE_CLASS };
