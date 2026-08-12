import { describe, it, expect } from 'vitest';
import {
  toGeoJson,
  toCsv,
  encodeCursor,
  decodeCursor,
  ACCURACY_STATEMENT,
  type ExportFeature,
} from './envelope.js';
import {
  ProvenanceContaminationError,
  NON_CADASTRAL_DISCLAIMER,
  CONFIDENCE_FORMULA_VERSION,
} from '@groundtruth/domain';

const GENERATED_AT = new Date('2026-08-12T08:00:00Z');

const feature = (over: Partial<ExportFeature> = {}): ExportFeature => ({
  id: 'f-1',
  featureClass: 'ACCESS_POINT',
  geometry: { type: 'Point', coordinates: [39.0951, -5.0699] },
  attributes: { access_type: 'gate', reachable_on_foot: true },
  provenance: 'FIELD_COLLECTED',
  confidenceScore: 0.83,
  specVersion: 'access_point@1.0',
  firstObservedAt: '2026-08-10T07:15:00Z',
  lastVerifiedAt: '2026-08-11T09:00:00Z',
  ...over,
});

describe('the ODbL guard at the delivery edge (ADR-0001 layer 4)', () => {
  // The test the brief explicitly demands: an OSM_ODBL row must cause a hard
  // failure in the export pipeline.
  it('HARD FAILS a GeoJSON export containing one OSM_ODBL feature among many', () => {
    const features = [
      ...Array.from({ length: 500 }, (_, i) => feature({ id: `clean-${i}` })),
      feature({ id: 'contaminated', provenance: 'OSM_ODBL' }),
    ];
    expect(() => toGeoJson(features, { generatedAt: GENERATED_AT })).toThrow(
      ProvenanceContaminationError,
    );
  });

  it('HARD FAILS a CSV export the same way', () => {
    expect(() =>
      toCsv([feature(), feature({ id: 'bad', provenance: 'OSM_ODBL' })], {
        generatedAt: GENERATED_AT,
      }),
    ).toThrow(ProvenanceContaminationError);
  });

  it('produces NO output at all when contaminated — a partial file is worse', () => {
    // A partial export looks like a complete one. It must not exist.
    let output: unknown = 'not-overwritten';
    try {
      output = toGeoJson([feature({ provenance: 'OSM_ODBL' })], { generatedAt: GENERATED_AT });
    } catch {
      /* expected */
    }
    expect(output).toBe('not-overwritten');
  });

  it('HARD FAILS on a missing provenance rather than treating it as clean', () => {
    expect(() =>
      toGeoJson([feature({ provenance: undefined as never })], { generatedAt: GENERATED_AT }),
    ).toThrow(ProvenanceContaminationError);
  });

  it('exports cleanly when every provenance is cleared', () => {
    const features = [
      feature({ provenance: 'FIELD_COLLECTED' }),
      feature({ id: 'f-2', provenance: 'DRONE_DERIVED' }),
      feature({ id: 'f-3', provenance: 'LICENSED_THIRD_PARTY' }),
      feature({ id: 'f-4', provenance: 'PUBLIC_DOMAIN' }),
    ];
    expect(() => toGeoJson(features, { generatedAt: GENERATED_AT })).not.toThrow();
  });
});

describe('every export is legally self-describing', () => {
  it('carries the non-cadastral disclaimer verbatim', () => {
    // A GeoJSON file lands in a GIS, gets copied, gets emailed, and is read by
    // someone who never saw the contract. The file has to say what it is not.
    const result = toGeoJson([feature()], { generatedAt: GENERATED_AT });
    expect(result.metadata.disclaimer).toBe(NON_CADASTRAL_DISCLAIMER);
  });

  it('states the confidence formula version, so a score is interpretable', () => {
    const result = toGeoJson([feature()], { generatedAt: GENERATED_AT });
    expect(result.metadata.confidenceFormulaVersion).toBe(CONFIDENCE_FORMULA_VERSION);
  });

  it('says explicitly that confidence is NOT a probability', () => {
    // A customer reading 0.87 as "87% likely correct" builds on a claim we never
    // made, and the misunderstanding surfaces in a dispute.
    expect(ACCURACY_STATEMENT).toContain('not probabilities');
  });

  it('lists the spec versions the features were collected under', () => {
    const result = toGeoJson(
      [feature(), feature({ id: 'f-2', specVersion: 'poi@1.0' })],
      { generatedAt: GENERATED_AT },
    );
    expect(result.metadata.specVersions).toEqual(['access_point@1.0', 'poi@1.0']);
  });

  it('summarises provenance across the payload', () => {
    const result = toGeoJson(
      [feature(), feature({ id: 'f-2', provenance: 'DRONE_DERIVED' })],
      { generatedAt: GENERATED_AT },
    );
    expect(result.metadata.provenanceSummary).toEqual({
      FIELD_COLLECTED: 1,
      DRONE_DERIVED: 1,
    });
  });

  it('puts provenance on EVERY feature, not only in the metadata', () => {
    // A GIS user who filters or splits the collection keeps the provenance.
    const result = toGeoJson([feature()], { generatedAt: GENERATED_AT });
    expect(result.features[0]?.properties['provenance']).toBe('FIELD_COLLECTED');
    expect(result.features[0]?.properties['spec_version']).toBe('access_point@1.0');
    expect(result.features[0]?.properties['confidence_score']).toBe(0.83);
  });

  it('preserves the collected attributes alongside the metadata', () => {
    const result = toGeoJson([feature()], { generatedAt: GENERATED_AT });
    expect(result.features[0]?.properties['access_type']).toBe('gate');
  });
});

describe('CSV', () => {
  it('leads with the disclaimer rather than trailing it', () => {
    // Spreadsheets truncate and users filter; a footer is the first thing lost.
    const csv = toCsv([feature()], { generatedAt: GENERATED_AT });
    expect(csv.split('\n')[0]).toContain(NON_CADASTRAL_DISCLAIMER);
  });

  it('includes provenance and confidence as columns', () => {
    const csv = toCsv([feature()], { generatedAt: GENERATED_AT });
    const header = csv.split('\n').find((l) => l.startsWith('id,')) ?? '';
    expect(header).toContain('provenance');
    expect(header).toContain('confidence_score');
    expect(header).toContain('spec_version');
  });

  it('escapes values containing commas and quotes', () => {
    const csv = toCsv(
      [feature({ attributes: { name_local: 'Duka la "Mama", Chumbageni' } })],
      { generatedAt: GENERATED_AT },
    );
    expect(csv).toContain('"Duka la ""Mama"", Chumbageni"');
  });

  it('emits a column for every attribute present anywhere in the batch', () => {
    const csv = toCsv(
      [
        feature({ attributes: { a: 1 } }),
        feature({ id: 'f-2', attributes: { b: 2 } }),
      ],
      { generatedAt: GENERATED_AT },
    );
    const header = csv.split('\n').find((l) => l.startsWith('id,')) ?? '';
    expect(header).toContain(',a');
    expect(header).toContain(',b');
  });

  it('handles an empty batch without producing a headerless file', () => {
    const csv = toCsv([], { generatedAt: GENERATED_AT });
    expect(csv).toContain(NON_CADASTRAL_DISCLAIMER);
    expect(csv).toContain('id,feature_class');
  });
});

describe('delta cursors', () => {
  it('round-trips a sequence', () => {
    expect(decodeCursor(encodeCursor(4_827))).toBe(4_827);
  });

  it('is opaque, so a customer cannot hand-craft one and skip changes', () => {
    const cursor = encodeCursor(100);
    expect(cursor).not.toContain('100');
  });

  it('rejects a malformed cursor rather than defaulting to zero', () => {
    // Defaulting to 0 would silently re-send the entire dataset; defaulting to the
    // head would silently skip everything. Both are worse than an error.
    expect(() => decodeCursor('not-a-cursor')).toThrow(TypeError);
    expect(() => decodeCursor(Buffer.from('gt9:5').toString('base64url'))).toThrow(TypeError);
    expect(() => decodeCursor('')).toThrow(TypeError);
  });

  it('rejects a negative or fractional sequence', () => {
    expect(() => encodeCursor(-1)).toThrow(RangeError);
    expect(() => encodeCursor(1.5)).toThrow(RangeError);
  });

  it('carries the next cursor in the metadata when one is supplied', () => {
    const result = toGeoJson([feature()], {
      generatedAt: GENERATED_AT,
      nextCursor: encodeCursor(42),
    });
    expect(decodeCursor(result.metadata.nextCursor as string)).toBe(42);
  });

  it('omits the cursor on a snapshot export', () => {
    const result = toGeoJson([feature()], { generatedAt: GENERATED_AT });
    expect(result.metadata.nextCursor).toBeUndefined();
  });
});
