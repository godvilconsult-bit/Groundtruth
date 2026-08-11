import { describe, it, expect } from 'vitest';
import {
  FEATURE_CLASS,
  ALL_FEATURE_CLASSES,
  AREAL_CLASSES,
  GEOMETRY_TYPE,
  isFeatureClass,
  requiredGeometryType,
  geometryMatchesClass,
} from './feature-class.js';

describe('feature class vocabulary', () => {
  it('contains exactly the six v1 classes', () => {
    expect([...ALL_FEATURE_CLASSES].sort()).toEqual([
      'ACCESS_POINT',
      'ADDRESS_ANCHOR',
      'BUILDING_FOOTPRINT',
      'POI',
      'ROAD_SEGMENT',
      'WATER_POINT',
    ]);
  });

  it('excludes every cadastral concept', () => {
    // Not a style check. A class named for land tenure would be a compliance
    // failure, and this is the list a reviewer would scan first. The banned terms
    // must appear literally here — asserting their absence is the whole test.
    const forbidden = ['PARCEL', 'PLOT', 'BOUNDARY', 'OWNER', 'TITLE', 'LAND']; // gt-vocab-allow: fixtures asserting these are absent
    for (const term of forbidden) {
      expect(ALL_FEATURE_CLASSES.some((c) => c.includes(term))).toBe(false);
    }
  });

  it.each([['PARCEL'], ['parcel'], ['LAND_EXTENT'], [''], [null], [42]])( // gt-vocab-allow: cadastral names as rejected inputs — the point of the test
    'rejects %s as a feature class',
    (value) => {
      expect(isFeatureClass(value)).toBe(false);
    },
  );
});

describe('required geometry per class', () => {
  it.each([
    [FEATURE_CLASS.BUILDING_FOOTPRINT, GEOMETRY_TYPE.POLYGON],
    [FEATURE_CLASS.ROAD_SEGMENT, GEOMETRY_TYPE.LINESTRING],
    [FEATURE_CLASS.ACCESS_POINT, GEOMETRY_TYPE.POINT],
    [FEATURE_CLASS.POI, GEOMETRY_TYPE.POINT],
    [FEATURE_CLASS.WATER_POINT, GEOMETRY_TYPE.POINT],
    [FEATURE_CLASS.ADDRESS_ANCHOR, GEOMETRY_TYPE.POINT],
  ])('%s requires %s', (featureClass, geometry) => {
    expect(requiredGeometryType(featureClass)).toBe(geometry);
  });

  it('defines a geometry for every class, with no gaps', () => {
    for (const c of ALL_FEATURE_CLASSES) {
      expect(requiredGeometryType(c)).toBeDefined();
    }
  });

  it('matches case-insensitively, since PostGIS and GeoJSON disagree on casing', () => {
    expect(geometryMatchesClass(FEATURE_CLASS.BUILDING_FOOTPRINT, 'Polygon')).toBe(true);
    expect(geometryMatchesClass(FEATURE_CLASS.BUILDING_FOOTPRINT, 'POLYGON')).toBe(true);
    expect(geometryMatchesClass(FEATURE_CLASS.ROAD_SEGMENT, 'LineString')).toBe(true);
  });

  it('rejects a footprint submitted as a point', () => {
    expect(geometryMatchesClass(FEATURE_CLASS.BUILDING_FOOTPRINT, 'POINT')).toBe(false);
  });

  it('rejects an access point submitted as a polygon', () => {
    expect(geometryMatchesClass(FEATURE_CLASS.ACCESS_POINT, 'POLYGON')).toBe(false);
  });

  it('agrees with the database CHECK constraint for every class', () => {
    // Mirrors feature_geometry_matches_class in migration 1754870404000. If these
    // ever diverge, the app and the database disagree about what is valid, and the
    // app is the one that will be wrong in the field with no connectivity.
    const dbRule = (c: string) =>
      c === 'BUILDING_FOOTPRINT' ? 'POLYGON' : c === 'ROAD_SEGMENT' ? 'LINESTRING' : 'POINT';
    for (const c of ALL_FEATURE_CLASSES) {
      expect(requiredGeometryType(c)).toBe(dbRule(c));
    }
  });
});

describe('areal classes', () => {
  it('identifies building footprints as the only areal class in v1', () => {
    expect([...AREAL_CLASSES]).toEqual(['BUILDING_FOOTPRINT']);
  });

  it('does not treat point or line classes as areal', () => {
    for (const c of [FEATURE_CLASS.ACCESS_POINT, FEATURE_CLASS.ROAD_SEGMENT, FEATURE_CLASS.POI]) {
      expect(AREAL_CLASSES.has(c)).toBe(false);
    }
  });
});
