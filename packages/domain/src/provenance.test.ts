import { describe, it, expect } from 'vitest';
import {
  PROVENANCE,
  ALL_PROVENANCE,
  EXPORTABLE_PROVENANCE,
  isProvenance,
  isExportable,
} from './provenance.js';

describe('provenance vocabulary', () => {
  it('contains exactly the five values defined in the data model', () => {
    expect([...ALL_PROVENANCE].sort()).toEqual([
      'DRONE_DERIVED',
      'FIELD_COLLECTED',
      'LICENSED_THIRD_PARTY',
      'OSM_ODBL',
      'PUBLIC_DOMAIN',
    ]);
  });

  it('recognises every defined value', () => {
    for (const value of ALL_PROVENANCE) {
      expect(isProvenance(value)).toBe(true);
    }
  });

  it.each([
    ['unknown string', 'SCRAPED_FROM_GOOGLE'],
    ['lowercase variant', 'field_collected'],
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['number', 1],
    ['object', { provenance: 'FIELD_COLLECTED' }],
  ])('rejects %s as a provenance value', (_label, value) => {
    expect(isProvenance(value)).toBe(false);
  });
});

describe('export eligibility of individual provenance values', () => {
  it('excludes OSM_ODBL from the exportable set', () => {
    expect(EXPORTABLE_PROVENANCE.has(PROVENANCE.OSM_ODBL)).toBe(false);
    expect(isExportable(PROVENANCE.OSM_ODBL)).toBe(false);
  });

  it.each([
    PROVENANCE.FIELD_COLLECTED,
    PROVENANCE.DRONE_DERIVED,
    PROVENANCE.LICENSED_THIRD_PARTY,
    PROVENANCE.PUBLIC_DOMAIN,
  ])('permits %s', (value) => {
    expect(isExportable(value)).toBe(true);
  });

  it('treats unknown values as non-exportable (default-deny)', () => {
    // A provenance value added to the enum later must be non-exportable until
    // someone deliberately clears it. This is the property that stops a future
    // share-alike source leaking into paid exports.
    expect(isExportable('SOME_FUTURE_SHARE_ALIKE_SOURCE')).toBe(false);
    expect(isExportable(undefined)).toBe(false);
    expect(isExportable(null)).toBe(false);
  });

  it('exports every value except OSM_ODBL, and no others', () => {
    const exportable = ALL_PROVENANCE.filter(isExportable).sort();
    const nonExportable = ALL_PROVENANCE.filter((v) => !isExportable(v));
    expect(nonExportable).toEqual(['OSM_ODBL']);
    expect(exportable).toHaveLength(4);
  });
});
