import { describe, it, expect } from 'vitest';
import { scanText, BANNED_NOUNS, BANNED_OPERATIONS } from './vocabulary-guard.mjs';

const ALL = [...BANNED_NOUNS, ...BANNED_OPERATIONS];
const ids = (text) => scanText(text, ALL).map((f) => f.rule).sort();

describe('cadastral noun detection', () => {
  it.each([
    ['parcel_id UUID NOT NULL,', 'parcel'],
    ['const parcels = await repo.findAll();', 'parcel'],
    ['plot_number TEXT,', 'plot'],
    ['ALTER TABLE feature ADD COLUMN boundary geometry;', 'boundary'],
    ['/// Returns the ward boundaries', 'boundary'],
    ['owner_name TEXT,', 'owner'],
    ['final String ownership;', 'owner'],
    ['title_deed_ref TEXT,', 'title'],
    ['land_title VARCHAR(64),', 'title'],
    ['land_area NUMERIC,', 'land-area'],
    ['siteArea: number;', 'land-area'],
  ])('flags %s as [%s]', (line, expected) => {
    expect(ids(line)).toContain(expected);
  });

  it.each([
    ['title: "Sync status"', 'a UI title is not a land title'],
    ['<title>Ground Truth</title>', 'an HTML title is not a land title'],
    ['floor_area NUMERIC', 'floor area is structure extent, not land extent'],
    ['plotting the disagreement rate', 'not a whole-word match for "plot"'],
    ['const downloader = new PackDownloader();', 'no banned token present'],
    ['building_footprint geometry(Polygon, 4326)', 'footprints are permitted'],
  ])('does not flag %s (%s)', (line) => {
    expect(scanText(line, ALL)).toHaveLength(0);
  });

  it('is case-insensitive', () => {
    expect(ids('PARCEL_ID')).toContain('parcel');
    expect(ids('Boundary')).toContain('boundary');
  });

  it('matches whole words only', () => {
    // "ownership" is caught by design; these must not be.
    expect(scanText('const subplotter = 1;', ALL)).toHaveLength(0);
    expect(scanText('reparcelling', ALL)).toHaveLength(0);
  });
});

describe('cadastre-manufacturing operation detection', () => {
  it.each([
    ['SELECT ST_Union(geom) FROM gt.feature;', 'st-union'],
    ['ST_VoronoiPolygons(ST_Collect(geom))', 'st-voronoi'],
    ['ST_ConcaveHull(geom, 0.8)', 'st-concavehull'],
    ['ST_ConvexHull(geom)', 'st-convexhull'],
    ['ST_Subdivide(geom, 256)', 'st-subdivide'],
    ['ST_Polygonize(edges)', 'st-polygonize'],
    ['st_dissolve(footprints)', 'st-dissolve'],
  ])('flags %s as [%s]', (line, expected) => {
    expect(ids(line)).toContain(expected);
  });

  it('permits PostGIS calls that do not partition land', () => {
    const safe = [
      'ST_Intersects(a.geom, b.geom)',
      'ST_DWithin(geom, $1, 50)',
      'ST_Area(geom)',
      'ST_Transform(geom, 21037)',
      'ST_Centroid(geom)',
      'ST_HausdorffDistance(a.geom, b.geom)',
    ].join('\n');
    expect(scanText(safe, ALL)).toHaveLength(0);
  });
});

describe('suppression marker', () => {
  it('suppresses a line carrying a justified allow marker', () => {
    const line = 'boundary_kind TEXT, -- gt-vocab-allow: ward geofence, never exported';
    expect(scanText(line, ALL)).toHaveLength(0);
  });

  it('does NOT suppress on a bare marker with no reason', () => {
    const line = 'parcel_id UUID, -- gt-vocab-allow:';
    expect(scanText(line, ALL).length).toBeGreaterThan(0);
  });

  it('suppresses only the marked line, not its neighbours', () => {
    const text = [
      'owner_ref TEXT, // gt-vocab-allow: legacy import shim, removed in Phase 1',
      'parcel_ref TEXT,',
    ].join('\n');
    const found = scanText(text, ALL);
    expect(found).toHaveLength(1);
    expect(found[0].rule).toBe('parcel');
    expect(found[0].line).toBe(2);
  });
});

describe('finding metadata', () => {
  it('reports line and column, and explains why', () => {
    const text = ['ok();', 'const parcel = 1;'].join('\n');
    const [finding] = scanText(text, ALL);
    expect(finding.line).toBe(2);
    expect(finding.column).toBe(7);
    expect(finding.why).toMatch(/cadastral/i);
  });
});
