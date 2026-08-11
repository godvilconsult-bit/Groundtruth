/**
 * The v1 feature classes.
 *
 * Deliberately narrow. Note what is absent and must stay absent: nothing here
 * describes land extent, tenure, or title. BUILDING_FOOTPRINT records the extent
 * of a STRUCTURE, never of the land beneath it — that distinction is the whole of
 * the non-cadastral position, and it lives or dies on how this class is treated.
 */

export const FEATURE_CLASS = {
  BUILDING_FOOTPRINT: 'BUILDING_FOOTPRINT',
  ACCESS_POINT: 'ACCESS_POINT',
  ROAD_SEGMENT: 'ROAD_SEGMENT',
  POI: 'POI',
  WATER_POINT: 'WATER_POINT',
  ADDRESS_ANCHOR: 'ADDRESS_ANCHOR',
} as const;

export type FeatureClass = (typeof FEATURE_CLASS)[keyof typeof FEATURE_CLASS];

export const ALL_FEATURE_CLASSES: readonly FeatureClass[] = Object.freeze(
  Object.values(FEATURE_CLASS),
);

/** OGC geometry type names, as returned by PostGIS `GeometryType()`. */
export const GEOMETRY_TYPE = {
  POINT: 'POINT',
  LINESTRING: 'LINESTRING',
  POLYGON: 'POLYGON',
} as const;

export type GeometryType = (typeof GEOMETRY_TYPE)[keyof typeof GEOMETRY_TYPE];

/**
 * The geometry each class must carry.
 *
 * Enforced identically here and by a CHECK constraint on `gt.feature`. The
 * duplication is intentional: the database is the last line and cannot be bypassed,
 * while this one gives the collection app and the QA pipeline the same answer
 * without a round trip — on a device that may have no connectivity for eight hours.
 */
const REQUIRED_GEOMETRY: Readonly<Record<FeatureClass, GeometryType>> = Object.freeze({
  BUILDING_FOOTPRINT: GEOMETRY_TYPE.POLYGON,
  ROAD_SEGMENT: GEOMETRY_TYPE.LINESTRING,
  ACCESS_POINT: GEOMETRY_TYPE.POINT,
  POI: GEOMETRY_TYPE.POINT,
  WATER_POINT: GEOMETRY_TYPE.POINT,
  ADDRESS_ANCHOR: GEOMETRY_TYPE.POINT,
});

export function isFeatureClass(value: unknown): value is FeatureClass {
  return typeof value === 'string' && (ALL_FEATURE_CLASSES as string[]).includes(value);
}

export function requiredGeometryType(featureClass: FeatureClass): GeometryType {
  return REQUIRED_GEOMETRY[featureClass];
}

/**
 * True when `geometryType` is the one this class requires.
 *
 * Case-insensitive on the geometry name only, because PostGIS and GeoJSON disagree
 * on casing (`POLYGON` vs `Polygon`) and that difference is never meaningful.
 */
export function geometryMatchesClass(
  featureClass: FeatureClass,
  geometryType: string,
): boolean {
  return REQUIRED_GEOMETRY[featureClass] === geometryType.toUpperCase();
}

/**
 * Classes whose geometry is an area.
 *
 * Exported so that area-producing operations can be gated in one reviewable place
 * rather than rediscovered case by case. Any operation combining these across
 * features — union, dissolve, tessellation, gap-filling — manufactures a de-facto
 * cadastre regardless of what it is called, and is banned (RISKS.md R-009).
 */
export const AREAL_CLASSES: ReadonlySet<FeatureClass> = Object.freeze(
  new Set<FeatureClass>([FEATURE_CLASS.BUILDING_FOOTPRINT]),
);
