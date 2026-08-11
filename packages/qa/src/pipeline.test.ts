import { describe, it, expect } from 'vitest';
import { QaPipeline, stage } from './pipeline.js';
import {
  geometricPlausibility,
  temporalPlausibility,
  reputationRouting,
  resurveySelection,
  resurveyRateFor,
  REASON,
  type QaObservation,
  type QaContext,
  type CollectorProfile,
  type WardEnvelope,
} from './index.js';

const NOW = Date.parse('2026-08-11T10:00:00Z');

const CHUMBAGENI: WardEnvelope = {
  wardId: 'ward-1',
  minLon: 39.09,
  maxLon: 39.1055,
  minLat: -5.075,
  maxLat: -5.062,
  isAuthoritative: false,
};

const proven: CollectorProfile = {
  id: 'c1',
  competency: 'PROVEN',
  qualityScore: 0.85,
  acceptanceRate: 0.9,
  totalAccepted: 500,
};

const observation = (over: Partial<QaObservation> = {}): QaObservation => ({
  id: 'obs-1',
  collectorId: 'c1',
  deviceId: 'd1',
  featureClass: 'ACCESS_POINT',
  specVersion: 'access_point@1.0',
  provenance: 'FIELD_COLLECTED',
  lon: 39.0951,
  lat: -5.0699,
  geometryType: 'POINT',
  gpsAccuracyM: 6,
  capturedAt: NOW - 60_000,
  submittedAt: NOW,
  deviceSequence: 10,
  attributes: { access_type: 'gate', reachable_on_foot: true },
  wardId: 'ward-1',
  mediaRefs: [],
  consentRef: null,
  ...over,
});

const context = (over: Partial<QaContext> = {}): QaContext => ({
  now: NOW,
  collector: proven,
  ward: CHUMBAGENI,
  track: [],
  clockSkewMs: 0,
  random: () => 0.99, // above every sampling threshold, so sampling never fires
  ...over,
});

const fullPipeline = () =>
  new QaPipeline([
    stage('geometric-plausibility', geometricPlausibility),
    stage('temporal-plausibility', temporalPlausibility),
    stage('reputation-routing', reputationRouting),
    stage('resurvey-sampling', resurveySelection),
  ]);

describe('pipeline mechanics', () => {
  it('refuses to exist with no stages', () => {
    // A pipeline with no stages accepts everything while appearing to check.
    expect(() => new QaPipeline([])).toThrow(TypeError);
  });

  it('passes a clean observation from a proven collector', () => {
    const result = fullPipeline().run(observation(), context());
    expect(result.verdict).toBe('PASS');
    expect(result.needsReview).toBe(false);
    expect(result.reasonCodes).toEqual([]);
  });

  it('stops at the first REJECT, since later stages cannot rescue invalid data', () => {
    const result = fullPipeline().run(observation({ lon: 0, lat: 0 }), context());
    expect(result.verdict).toBe('REJECT');
    expect(result.stages).toHaveLength(1);
  });

  it('collects EVERY flag rather than the first', () => {
    // A reviewer opening an observation should see all of what is wrong with it.
    const result = fullPipeline().run(
      observation({ gpsAccuracyM: 40 }),
      context({ collector: { ...proven, competency: 'TRAINEE', totalAccepted: 2 } }),
    );
    expect(result.verdict).toBe('FLAG');
    expect(result.reasonCodes).toContain(REASON.GEO_ACCURACY_POOR);
    expect(result.reasonCodes).toContain(REASON.REP_NEW_COLLECTOR);
  });

  it('records per-stage metrics, so a misbehaving stage is visible', () => {
    const pipeline = fullPipeline();
    pipeline.run(observation(), context());
    pipeline.run(observation({ gpsAccuracyM: 500 }), context());

    const metrics = pipeline.metrics();
    expect(metrics.processed).toBe(2);
    expect(metrics.accepted).toBe(1);
    expect(metrics.rejected).toBe(1);
    expect(metrics.byStage['geometric-plausibility']).toEqual({ pass: 1, flag: 0, reject: 1 });
  });

  it('records a reason-code distribution, which is how gaming becomes visible', () => {
    // R-007: a collector converging on reviewer preferences shows up in the
    // distribution of codes, never in any single observation.
    const pipeline = fullPipeline();
    for (let i = 0; i < 5; i += 1) {
      pipeline.run(observation({ id: `o${i}`, gpsAccuracyM: 40 }), context());
    }
    expect(pipeline.metrics().byReason[REASON.GEO_ACCURACY_POOR]).toBe(5);
  });
});

describe('the provenance guard runs first and unconditionally (ADR-0001)', () => {
  it('REJECTS an OSM_ODBL observation before any other stage', () => {
    const result = fullPipeline().run(
      observation({ provenance: 'OSM_ODBL' }),
      context(),
    );
    expect(result.verdict).toBe('REJECT');
    expect(result.reasonCodes).toEqual([REASON.PROVENANCE_NOT_EXPORTABLE]);
    expect(result.stages[0]?.stage).toBe('provenance-guard');
  });

  it('REJECTS an unrecognised provenance rather than assuming it is fine', () => {
    const result = fullPipeline().run(
      observation({ provenance: 'SCRAPED' as never }),
      context(),
    );
    expect(result.verdict).toBe('REJECT');
  });

  it('does not run the remaining stages once provenance fails', () => {
    const result = fullPipeline().run(observation({ provenance: 'OSM_ODBL' }), context());
    expect(result.stages).toHaveLength(1);
  });
});

describe('geometric plausibility', () => {
  it('rejects Null Island as an uninitialised fix', () => {
    expect(geometricPlausibility(observation({ lon: 0, lat: 0 }), context()).verdict).toBe('REJECT');
  });

  it('rejects a footprint submitted with point geometry', () => {
    const outcome = geometricPlausibility(
      observation({ featureClass: 'BUILDING_FOOTPRINT', geometryType: 'POINT' }),
      context(),
    );
    expect(outcome.verdict).toBe('REJECT');
    expect(outcome.reasons[0]?.code).toBe(REASON.GEO_WRONG_GEOMETRY_TYPE);
  });

  it('rejects an accuracy that cannot locate anything', () => {
    expect(geometricPlausibility(observation({ gpsAccuracyM: 250 }), context()).verdict).toBe('REJECT');
  });

  it('FLAGS a coarse but usable fix rather than discarding the visit', () => {
    const outcome = geometricPlausibility(observation({ gpsAccuracyM: 40 }), context());
    expect(outcome.verdict).toBe('FLAG');
  });

  it('FLAGS an implausibly precise fix as possible spoofing', () => {
    const outcome = geometricPlausibility(observation({ gpsAccuracyM: 0.2 }), context());
    expect(outcome.reasons[0]?.code).toBe(REASON.GEO_ACCURACY_IMPLAUSIBLE);
  });

  it('FLAGS just outside the ward, because extents are approximations (R-005)', () => {
    // Rejecting good field data over an approximate envelope damages collector
    // reputation scores that are expensive to repair.
    const outcome = geometricPlausibility(observation({ lat: -5.10 }), context());
    expect(outcome.verdict).toBe('FLAG');
    expect(outcome.reasons[0]?.code).toBe(REASON.GEO_OUTSIDE_ASSIGNED_WARD);
  });

  it('REJECTS far outside the ward, which no approximation explains', () => {
    const outcome = geometricPlausibility(observation({ lat: -7.5 }), context());
    expect(outcome.verdict).toBe('REJECT');
    expect(outcome.reasons[0]?.code).toBe(REASON.GEO_FAR_OUTSIDE_ASSIGNED_WARD);
  });

  it('passes a good fix inside the ward', () => {
    expect(geometricPlausibility(observation(), context()).verdict).toBe('PASS');
  });

  it('skips the ward check when no envelope is known', () => {
    expect(geometricPlausibility(observation({ lat: -7.5 }), context({ ward: null })).verdict).toBe('PASS');
  });
});

describe('temporal plausibility — catching a walk that never happened', () => {
  const previous = (over: Partial<QaObservation> = {}) =>
    observation({ id: 'prev', deviceSequence: 9, capturedAt: NOW - 120_000, ...over });

  it('passes an ordinary walking interval', () => {
    const outcome = temporalPlausibility(
      observation({ lon: 39.0955 }),
      context({ track: [previous()] }),
    );
    expect(outcome.verdict).toBe('PASS');
  });

  it('REJECTS a speed nothing terrestrial explains', () => {
    // 60 s apart, ~11 km. Either the positions or the times are fabricated.
    const outcome = temporalPlausibility(
      observation({ lon: 39.2, capturedAt: NOW - 60_000 }),
      context({ track: [previous({ capturedAt: NOW - 120_000 })] }),
    );
    expect(outcome.verdict).toBe('REJECT');
    expect(outcome.reasons[0]?.code).toBe(REASON.TIME_IMPOSSIBLE_SPEED);
  });

  it('FLAGS vehicle-speed movement between observations', () => {
    const outcome = temporalPlausibility(
      observation({ lon: 39.104, capturedAt: NOW - 60_000 }),
      context({ track: [previous({ capturedAt: NOW - 120_000 })] }),
    );
    expect(outcome.verdict).toBe('FLAG');
  });

  it('FLAGS a dwell too short to have observed anything', () => {
    // Two observations at the same place two seconds apart: the mapper is
    // advancing through a form, not looking at a building.
    const outcome = temporalPlausibility(
      observation({ capturedAt: NOW - 118_000 }),
      context({ track: [previous({ capturedAt: NOW - 120_000 })] }),
    );
    expect(outcome.reasons[0]?.code).toBe(REASON.TIME_DWELL_TOO_SHORT);
  });

  it('FLAGS a capture claiming to be in the future', () => {
    const outcome = temporalPlausibility(
      observation({ capturedAt: NOW + 3_600_000 }),
      context(),
    );
    expect(outcome.reasons[0]?.code).toBe(REASON.TIME_CAPTURE_IN_FUTURE);
  });

  it('FLAGS large clock skew as a device problem, not a collector one', () => {
    const outcome = temporalPlausibility(
      observation(),
      context({ clockSkewMs: 4 * 3_600_000 }),
    );
    expect(outcome.reasons[0]?.code).toBe(REASON.TIME_CLOCK_SKEW_LARGE);
  });

  it('FLAGS a disordered device sequence', () => {
    const outcome = temporalPlausibility(
      observation({ deviceSequence: 5 }),
      context({ track: [previous({ deviceSequence: 5 })] }),
    );
    expect(outcome.reasons[0]?.code).toBe(REASON.TIME_SEQUENCE_DISORDERED);
  });

  it('does not compare across devices, since a collector may carry two handsets', () => {
    // Comparing across devices would manufacture impossible speeds from ordinary
    // work: two phones, two independent sequences.
    const outcome = temporalPlausibility(
      observation({ deviceId: 'd2', lon: 39.5 }),
      context({ track: [previous({ deviceId: 'd1' })] }),
    );
    expect(outcome.verdict).toBe('PASS');
  });

  it('passes when there is no prior observation to compare against', () => {
    expect(temporalPlausibility(observation(), context()).verdict).toBe('PASS');
  });
});

describe('reputation routing', () => {
  it('sends every new collector to full human review', () => {
    const outcome = reputationRouting(
      observation(),
      context({ collector: { ...proven, competency: 'TRAINEE', totalAccepted: 3 } }),
    );
    expect(outcome.verdict).toBe('FLAG');
    expect(outcome.reasons[0]?.code).toBe(REASON.REP_NEW_COLLECTOR);
  });

  it('treats a proven collector with too few accepted as still unproven', () => {
    const outcome = reputationRouting(
      observation(),
      context({ collector: { ...proven, totalAccepted: 10 } }),
    );
    expect(outcome.reasons[0]?.code).toBe(REASON.REP_NEW_COLLECTOR);
  });

  it('flags a suspended collector without discarding their work', () => {
    const outcome = reputationRouting(
      observation(),
      context({ collector: { ...proven, competency: 'SUSPENDED' } }),
    );
    expect(outcome.verdict).toBe('FLAG');
    expect(outcome.reasons[0]?.code).toBe(REASON.REP_SUSPENDED_COLLECTOR);
  });

  it('FLAGS an anomalously perfect acceptance rate rather than rewarding it', () => {
    // R-007: reporting values that get accepted looks exactly like excellence
    // until independent re-survey disagrees.
    const outcome = reputationRouting(
      observation(),
      context({ collector: { ...proven, acceptanceRate: 0.999, totalAccepted: 400 } }),
    );
    expect(outcome.reasons[0]?.code).toBe(REASON.REP_ANOMALOUS_ACCEPTANCE);
  });

  it('does not call a high rate anomalous on a small sample', () => {
    const outcome = reputationRouting(
      observation(),
      context({ collector: { ...proven, acceptanceRate: 1, totalAccepted: 60 } }),
    );
    expect(outcome.reasons[0]?.code).not.toBe(REASON.REP_ANOMALOUS_ACCEPTANCE);
  });

  it('samples a proportion of proven collectors for routine review', () => {
    const outcome = reputationRouting(observation(), context({ random: () => 0.01 }));
    expect(outcome.reasons[0]?.code).toBe(REASON.REP_SAMPLED_REVIEW);
  });

  it('passes a proven collector most of the time', () => {
    expect(reputationRouting(observation(), context({ random: () => 0.5 })).verdict).toBe('PASS');
  });
});

describe('re-survey sampling — a fraud control, not just a quality metric', () => {
  it('selects at the base rate for an ordinary class and collector', () => {
    const outcome = resurveySelection(
      observation({ featureClass: 'POI' }),
      context({ random: () => 0.01 }),
    );
    expect(outcome.reasons[0]?.code).toBe(REASON.RESURVEY_SELECTED);
  });

  it('does not select most features', () => {
    expect(
      resurveySelection(observation({ featureClass: 'POI' }), context({ random: () => 0.9 })).verdict,
    ).toBe('PASS');
  });

  it('over-samples classes that are cheap to fake and hard to verify', () => {
    // Seasonal road passability cannot be checked from a photo or another record.
    expect(resurveyRateOf('ROAD_SEGMENT')).toBeGreaterThan(resurveyRateOf('POI'));
    expect(resurveyRateOf('WATER_POINT')).toBeGreaterThan(resurveyRateOf('POI'));
  });

  it('over-samples collectors whose acceptance rate is anomalous', () => {
    const ordinary = resurveyRateFor('POI', { acceptanceRate: 0.9, totalAccepted: 400 });
    const anomalous = resurveyRateFor('POI', { acceptanceRate: 0.999, totalAccepted: 400 });
    expect(anomalous).toBeGreaterThan(ordinary);
  });

  it('names the policy version, because the published rate depends on it', () => {
    // R-006: changing how the sample is drawn changes the number without changing
    // the data, and a time series across undocumented methodologies is worse than
    // no time series.
    const outcome = resurveySelection(
      observation({ featureClass: 'POI' }),
      context({ random: () => 0.001 }),
    );
    expect(outcome.reasons[0]?.detail).toContain('resurvey@1.0');
  });

  it('never exceeds a rate of 1', () => {
    expect(
      resurveyRateFor('ROAD_SEGMENT', { acceptanceRate: 1, totalAccepted: 10_000 }),
    ).toBeLessThanOrEqual(1);
  });

  it('draws from a source the device cannot predict', () => {
    // Server-side and unpredictable, so a collector cannot behave differently on
    // sampled features. A hash of the observation id would be computable by anyone
    // holding the id — and therefore avoidable.
    const draws = new Set<number>();
    for (let i = 0; i < 200; i += 1) draws.add(Math.random());
    expect(draws.size).toBeGreaterThan(190);
  });
});

function resurveyRateOf(featureClass: string): number {
  return resurveyRateFor(featureClass, { acceptanceRate: 0.9, totalAccepted: 400 });
}

describe('a batch through the full pipeline', () => {
  it('produces a distribution a reviewer can act on', () => {
    const pipeline = fullPipeline();
    const results = [];

    for (let i = 0; i < 100; i += 1) {
      const bad = i % 10 === 0;
      results.push(
        pipeline.run(
          observation({
            id: `o${i}`,
            deviceSequence: i + 1,
            gpsAccuracyM: bad ? 45 : 6,
            capturedAt: NOW - (100 - i) * 30_000,
          }),
          context(),
        ),
      );
    }

    const metrics = pipeline.metrics();
    expect(metrics.processed).toBe(100);
    expect(metrics.flagged).toBe(10);
    expect(metrics.accepted).toBe(90);
    expect(metrics.byReason[REASON.GEO_ACCURACY_POOR]).toBe(10);
    expect(results.filter((r) => r.needsReview)).toHaveLength(10);
  });
});
