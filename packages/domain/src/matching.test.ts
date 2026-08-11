import { describe, it, expect } from 'vitest';
import {
  distanceMetres,
  isSameFeature,
  clusterObservations,
  matchToleranceM,
  type MatchCandidate,
} from './matching.js';
import { FEATURE_CLASS, ALL_FEATURE_CLASSES } from './feature-class.js';

// Central Tanga, inside the seeded Chumbageni ward.
const ORIGIN = { lon: 39.0951, lat: -5.0699 };

/** Offset a point by metres. ~111.32 km per degree latitude. */
const offset = (base: { lon: number; lat: number }, eastM: number, northM: number) => ({
  lon: base.lon + eastM / (111_320 * Math.cos((base.lat * Math.PI) / 180)),
  lat: base.lat + northM / 111_320,
});

const candidate = (
  id: string,
  point: { lon: number; lat: number },
  overrides: Partial<MatchCandidate> = {},
): MatchCandidate => ({
  id,
  featureClass: FEATURE_CLASS.ACCESS_POINT,
  lon: point.lon,
  lat: point.lat,
  gpsAccuracyM: 3,
  ...overrides,
});

describe('distanceMetres', () => {
  it('is zero for identical points', () => {
    expect(distanceMetres(ORIGIN, ORIGIN)).toBe(0);
  });

  it('measures a known offset accurately', () => {
    expect(distanceMetres(ORIGIN, offset(ORIGIN, 100, 0))).toBeCloseTo(100, 0);
    expect(distanceMetres(ORIGIN, offset(ORIGIN, 0, 250))).toBeCloseTo(250, 0);
  });

  it('is symmetric', () => {
    const b = offset(ORIGIN, 40, 30);
    expect(distanceMetres(ORIGIN, b)).toBeCloseTo(distanceMetres(b, ORIGIN), 6);
  });

  it('handles the antimeridian and poles without producing NaN', () => {
    expect(Number.isFinite(distanceMetres({ lon: 179.9, lat: 0 }, { lon: -179.9, lat: 0 }))).toBe(true);
    expect(Number.isFinite(distanceMetres({ lon: 0, lat: 90 }, { lon: 180, lat: -90 }))).toBe(true);
  });
});

describe('match tolerances', () => {
  it('defines a tolerance for every feature class', () => {
    for (const c of ALL_FEATURE_CLASSES) {
      expect(matchToleranceM(c)).toBeGreaterThan(0);
    }
  });

  it('keeps building footprints tightest, since adjacent buildings are metres apart', () => {
    expect(matchToleranceM(FEATURE_CLASS.BUILDING_FOOTPRINT)).toBeLessThan(
      matchToleranceM(FEATURE_CLASS.POI),
    );
  });

  it('allows road segments the widest tolerance', () => {
    const road = matchToleranceM(FEATURE_CLASS.ROAD_SEGMENT);
    for (const c of ALL_FEATURE_CLASSES) {
      expect(road).toBeGreaterThanOrEqual(matchToleranceM(c));
    }
  });
});

describe('isSameFeature', () => {
  it('matches two near-identical observations', () => {
    expect(isSameFeature(candidate('a', ORIGIN), candidate('b', offset(ORIGIN, 2, 0)))).toBe(true);
  });

  it('never matches across feature classes', () => {
    // A gate and a water point at the same coordinates are two different things.
    const gate = candidate('a', ORIGIN, { featureClass: FEATURE_CLASS.ACCESS_POINT });
    const water = candidate('b', ORIGIN, { featureClass: FEATURE_CLASS.WATER_POINT });
    expect(isSameFeature(gate, water)).toBe(false);
  });

  it('separates observations beyond tolerance', () => {
    expect(isSameFeature(candidate('a', ORIGIN), candidate('b', offset(ORIGIN, 60, 0)))).toBe(false);
  });

  it('widens tolerance when the GPS fixes were poor', () => {
    // 10 m apart with sharp fixes: two different gates.
    const sharpA = candidate('a', ORIGIN, { gpsAccuracyM: 2 });
    const sharpB = candidate('b', offset(ORIGIN, 10, 0), { gpsAccuracyM: 2 });
    expect(isSameFeature(sharpA, sharpB)).toBe(false);

    // Same 10 m gap with ±15 m fixes: entirely consistent with one gate.
    const vagueA = candidate('a', ORIGIN, { gpsAccuracyM: 15 });
    const vagueB = candidate('b', offset(ORIGIN, 10, 0), { gpsAccuracyM: 15 });
    expect(isSameFeature(vagueA, vagueB)).toBe(true);
  });

  it('uses the better of the two fixes, not the worse', () => {
    // A precise observation should not be dragged into a match by a sloppy one.
    const precise = candidate('a', ORIGIN, { gpsAccuracyM: 1 });
    const sloppy = candidate('b', offset(ORIGIN, 30, 0), { gpsAccuracyM: 40 });
    expect(isSameFeature(precise, sloppy)).toBe(false);
  });

  it('is symmetric', () => {
    const a = candidate('a', ORIGIN, { gpsAccuracyM: 4 });
    const b = candidate('b', offset(ORIGIN, 8, 0), { gpsAccuracyM: 9 });
    expect(isSameFeature(a, b)).toBe(isSameFeature(b, a));
  });
});

describe('clusterObservations', () => {
  it('returns nothing for an empty input', () => {
    expect(clusterObservations([])).toEqual([]);
  });

  it('puts a lone observation in its own cluster', () => {
    expect(clusterObservations([candidate('a', ORIGIN)])).toHaveLength(1);
  });

  it('groups three observations of the same gate', () => {
    const clusters = clusterObservations([
      candidate('a', ORIGIN),
      candidate('b', offset(ORIGIN, 2, 1)),
      candidate('c', offset(ORIGIN, 1, 2)),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(3);
  });

  it('separates two distinct gates', () => {
    const clusters = clusterObservations([
      candidate('a', ORIGIN),
      candidate('b', offset(ORIGIN, 1, 0)),
      candidate('c', offset(ORIGIN, 200, 0)),
      candidate('d', offset(ORIGIN, 201, 0)),
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.length).sort()).toEqual([2, 2]);
  });

  it('splits by feature class even at identical coordinates', () => {
    const clusters = clusterObservations([
      candidate('a', ORIGIN, { featureClass: FEATURE_CLASS.ACCESS_POINT }),
      candidate('b', ORIGIN, { featureClass: FEATURE_CLASS.WATER_POINT }),
      candidate('c', ORIGIN, { featureClass: FEATURE_CLASS.POI }),
    ]);
    expect(clusters).toHaveLength(3);
  });

  it('assigns every observation exactly once', () => {
    const observations = Array.from({ length: 40 }, (_, i) =>
      candidate(`o${i}`, offset(ORIGIN, i * 7, (i % 5) * 3)),
    );
    const clusters = clusterObservations(observations);
    const assigned = clusters.flat().map((c) => c.id);
    expect(assigned).toHaveLength(observations.length);
    expect(new Set(assigned).size).toBe(observations.length);
  });

  it('chains transitively via single-link, as documented', () => {
    // a—b and b—c are each within tolerance; a—c is not. Single-link joins all three.
    // This is the known weakness, accepted at Phase 1 and caught by QA stage 4.
    const clusters = clusterObservations([
      candidate('a', ORIGIN),
      candidate('b', offset(ORIGIN, 7, 0)),
      candidate('c', offset(ORIGIN, 14, 0)),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(3);
  });

  it('does not mutate its input', () => {
    const observations = [candidate('a', ORIGIN), candidate('b', offset(ORIGIN, 500, 0))];
    const snapshot = structuredClone(observations);
    clusterObservations(observations);
    expect(observations).toEqual(snapshot);
  });
});
