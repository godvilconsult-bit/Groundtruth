import { describe, it, expect } from 'vitest';
import {
  parseSpecVersion,
  trySpecVersion,
  formatSpecVersion,
  compareSpecVersions,
  isCompatible,
  InvalidSpecVersionError,
} from './spec-version.js';
import { FEATURE_CLASS } from './feature-class.js';

describe('parsing', () => {
  it('parses a well-formed version', () => {
    const v = parseSpecVersion('road_segment@2.1');
    expect(v.featureClass).toBe('ROAD_SEGMENT');
    expect(v.major).toBe(2);
    expect(v.minor).toBe(1);
    expect(v.raw).toBe('road_segment@2.1');
  });

  it('parses every feature class', () => {
    for (const c of Object.values(FEATURE_CLASS)) {
      expect(parseSpecVersion(`${c.toLowerCase()}@1.0`).featureClass).toBe(c);
    }
  });

  it('handles multi-digit versions', () => {
    const v = parseSpecVersion('poi@12.34');
    expect(v.major).toBe(12);
    expect(v.minor).toBe(34);
  });

  it.each([
    ['missing minor', 'poi@1'],
    ['missing class', '@1.0'],
    ['no at-sign', 'poi-1.0'],
    ['patch component', 'poi@1.0.0'],
    ['unknown class', 'parcel@1.0'], // gt-vocab-allow: asserts a cadastral class name is rejected
    ['uppercase class', 'POI@1.0'],
    ['negative major', 'poi@-1.0'],
    ['empty', ''],
    ['whitespace', ' poi@1.0'],
  ])('rejects %s', (_label, value) => {
    expect(() => parseSpecVersion(value)).toThrow(InvalidSpecVersionError);
    expect(trySpecVersion(value)).toBeNull();
  });

  it('rejects leading zeros, which would let two strings mean one version', () => {
    expect(() => parseSpecVersion('poi@01.0')).toThrow(InvalidSpecVersionError);
    expect(() => parseSpecVersion('poi@1.00')).toThrow(InvalidSpecVersionError);
    // Single zero is legitimate.
    expect(parseSpecVersion('poi@0.0').major).toBe(0);
  });

  it('round-trips through formatSpecVersion', () => {
    const raw = formatSpecVersion(FEATURE_CLASS.WATER_POINT, 3, 7);
    expect(raw).toBe('water_point@3.7');
    expect(parseSpecVersion(raw).major).toBe(3);
  });

  it('matches the database CHECK pattern', () => {
    // fcs_version_shape / feature_spec_version_shape: ^[a-z_]+@[0-9]+\.[0-9]+$
    const dbPattern = /^[a-z_]+@[0-9]+\.[0-9]+$/;
    expect(dbPattern.test(formatSpecVersion(FEATURE_CLASS.BUILDING_FOOTPRINT, 1, 0))).toBe(true);
    expect(dbPattern.test(formatSpecVersion(FEATURE_CLASS.ADDRESS_ANCHOR, 10, 2))).toBe(true);
  });

  it('rejects non-integer or negative components when formatting', () => {
    expect(() => formatSpecVersion(FEATURE_CLASS.POI, -1, 0)).toThrow(RangeError);
    expect(() => formatSpecVersion(FEATURE_CLASS.POI, 1.5, 0)).toThrow(RangeError);
  });
});

describe('ordering', () => {
  const v = (s: string) => parseSpecVersion(s);

  it('orders by major then minor', () => {
    expect(compareSpecVersions(v('poi@1.0'), v('poi@2.0'))).toBeLessThan(0);
    expect(compareSpecVersions(v('poi@2.0'), v('poi@1.9'))).toBeGreaterThan(0);
    expect(compareSpecVersions(v('poi@1.2'), v('poi@1.10'))).toBeLessThan(0);
    expect(compareSpecVersions(v('poi@1.0'), v('poi@1.0'))).toBe(0);
  });

  it('sorts a list correctly', () => {
    const sorted = ['poi@2.0', 'poi@1.10', 'poi@1.2', 'poi@10.0']
      .map(v)
      .sort(compareSpecVersions)
      .map((x) => x.raw);
    expect(sorted).toEqual(['poi@1.2', 'poi@1.10', 'poi@2.0', 'poi@10.0']);
  });

  it('refuses to order versions of different classes', () => {
    // Returning a number here would let a sort produce confident nonsense.
    expect(() => compareSpecVersions(v('poi@3.0'), v('water_point@1.0'))).toThrow(TypeError);
  });
});

describe('client compatibility', () => {
  const v = (s: string) => parseSpecVersion(s);

  it('accepts a differing minor version in either direction', () => {
    expect(isCompatible(v('road_segment@2.0'), v('road_segment@2.1'))).toBe(true);
    expect(isCompatible(v('road_segment@2.3'), v('road_segment@2.1'))).toBe(true);
  });

  it('rejects a differing major version', () => {
    // The client must refuse the bundle and keep its last valid one. A
    // half-rendered form produces confidently wrong data.
    expect(isCompatible(v('road_segment@1.9'), v('road_segment@2.0'))).toBe(false);
    expect(isCompatible(v('road_segment@3.0'), v('road_segment@2.0'))).toBe(false);
  });

  it('rejects a differing feature class outright', () => {
    expect(isCompatible(v('poi@1.0'), v('water_point@1.0'))).toBe(false);
  });
});
