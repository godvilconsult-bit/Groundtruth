/**
 * Synthetic observation generator for the Phase 1 ingest deliverable.
 *
 * Generates observations that behave like real Tanga collection: a set of true
 * places, each visited by one or more collectors, whose recorded position is
 * scattered by GPS error proportional to the reported accuracy.
 *
 * The point is to produce data that exercises the matching rule honestly. Data where
 * every repeat visit lands on identical coordinates would make clustering look
 * flawless and prove nothing.
 */

import {
  FEATURE_CLASS,
  type FeatureClass,
  formatSpecVersion,
} from '@groundtruth/domain';

/** Deterministic PRNG (mulberry32), so a failing run can be reproduced exactly. */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Chumbageni ward extent from the Phase 0 seed. */
const WARD = { minLon: 39.09, maxLon: 39.1055, minLat: -5.075, maxLat: -5.062 };

const CLASS_MIX: readonly { featureClass: FeatureClass; weight: number }[] = [
  { featureClass: FEATURE_CLASS.BUILDING_FOOTPRINT, weight: 0.45 },
  { featureClass: FEATURE_CLASS.ACCESS_POINT, weight: 0.2 },
  { featureClass: FEATURE_CLASS.POI, weight: 0.15 },
  { featureClass: FEATURE_CLASS.ROAD_SEGMENT, weight: 0.1 },
  { featureClass: FEATURE_CLASS.WATER_POINT, weight: 0.05 },
  { featureClass: FEATURE_CLASS.ADDRESS_ANCHOR, weight: 0.05 },
];

export interface SyntheticObservation {
  readonly featureClass: FeatureClass;
  readonly wkt: string;
  readonly lon: number;
  readonly lat: number;
  readonly gpsAccuracyM: number;
  readonly capturedAt: Date;
  readonly deviceSequence: number;
  readonly collectorIndex: number;
  readonly specVersion: string;
  readonly rawAttributes: Record<string, unknown>;
  /** Index of the true place this observation describes — the ground truth for scoring. */
  readonly truePlaceId: number;
}

export interface GeneratorOptions {
  readonly count: number;
  readonly collectors: number;
  readonly seed?: number;
  /** Mean observations per true place. >1 produces the repeat visits matching must resolve. */
  readonly observationsPerPlace?: number;
}

const METRES_PER_DEG_LAT = 111_320;

export function generateObservations(options: GeneratorOptions): SyntheticObservation[] {
  const { count, collectors } = options;
  const random = makeRandom(options.seed ?? 20260811);
  const perPlace = options.observationsPerPlace ?? 1.6;
  const placeCount = Math.max(1, Math.round(count / perPlace));

  const pickClass = (): FeatureClass => {
    let r = random();
    for (const entry of CLASS_MIX) {
      if (r < entry.weight) return entry.featureClass;
      r -= entry.weight;
    }
    return FEATURE_CLASS.POI;
  };

  // The true places. Observations scatter around these.
  const places = Array.from({ length: placeCount }, () => ({
    lon: WARD.minLon + random() * (WARD.maxLon - WARD.minLon),
    lat: WARD.minLat + random() * (WARD.maxLat - WARD.minLat),
    featureClass: pickClass(),
  }));

  const start = new Date('2026-08-10T06:00:00Z').getTime();
  const sequences = new Array<number>(collectors).fill(0);
  const observations: SyntheticObservation[] = [];

  // Each collector walks their own route, and time advances with distance.
  //
  // The naive version — a random place every 25 seconds — makes mappers teleport
  // across the ward, and QA's temporal stage correctly rejected a third of it. Test
  // data that cannot pass the pipeline tells you nothing about the pipeline; worse,
  // it trains you to ignore a real signal as noise.
  const WALKING_SPEED_MPS = 1.2;
  const DWELL_MS = 45_000;
  const METRES_PER_DEG = 111_320;

  // Deal places to collectors, then order each collector's list as a nearest-
  // neighbour walk so consecutive observations are actually adjacent.
  const routes: number[][] = Array.from({ length: collectors }, () => []);
  for (let placeId = 0; placeId < placeCount; placeId += 1) {
    routes[placeId % collectors]!.push(placeId);
  }
  for (const route of routes) {
    for (let i = 1; i < route.length; i += 1) {
      let nearest = i;
      let best = Number.POSITIVE_INFINITY;
      const from = places[route[i - 1]!]!;
      for (let j = i; j < route.length; j += 1) {
        const candidate = places[route[j]!]!;
        const d = (candidate.lon - from.lon) ** 2 + (candidate.lat - from.lat) ** 2;
        if (d < best) {
          best = d;
          nearest = j;
        }
      }
      [route[i], route[nearest]] = [route[nearest]!, route[i]!];
    }
  }

  const routeCursor = new Array<number>(collectors).fill(0);
  const clockMs = new Array<number>(collectors).fill(start);
  const lastPlace: ({ lon: number; lat: number } | null)[] = new Array(collectors).fill(null);

  for (let i = 0; i < count; i += 1) {
    const collectorIndex = i % collectors;
    const route = routes[collectorIndex]!;
    if (route.length === 0) continue;

    // Revisits happen: a mapper returns to a place, which is how independent
    // observations of one feature arise in the first place.
    const revisit = random() < 0.35 && routeCursor[collectorIndex]! > 0;
    const cursor = revisit
      ? Math.floor(random() * routeCursor[collectorIndex]!)
      : routeCursor[collectorIndex]! % route.length;
    if (!revisit) routeCursor[collectorIndex] = routeCursor[collectorIndex]! + 1;

    const placeId = route[cursor]!;
    const place = places[placeId]!;

    // Advance the clock by how long the walk would actually take.
    const previous = lastPlace[collectorIndex];
    const metres = previous
      ? Math.hypot(
          (place.lon - previous.lon) * METRES_PER_DEG * Math.cos((place.lat * Math.PI) / 180),
          (place.lat - previous.lat) * METRES_PER_DEG,
        )
      : 0;
    clockMs[collectorIndex] =
      clockMs[collectorIndex]! + (metres / WALKING_SPEED_MPS) * 1000 + DWELL_MS;
    lastPlace[collectorIndex] = { lon: place.lon, lat: place.lat };

    // Reported accuracy: mostly good, with a realistic tail of poor urban fixes.
    const gpsAccuracyM = Number((2 + random() ** 3 * 28).toFixed(2));

    // Scatter within roughly the reported accuracy — the honest relationship
    // between a reported fix and where the device actually thought it was.
    const bearing = random() * 2 * Math.PI;
    const radius = random() * gpsAccuracyM * 0.8;
    const dLat = (radius * Math.cos(bearing)) / METRES_PER_DEG_LAT;
    const dLon =
      (radius * Math.sin(bearing)) /
      (METRES_PER_DEG_LAT * Math.cos((place.lat * Math.PI) / 180));

    const lon = place.lon + dLon;
    const lat = place.lat + dLat;

    sequences[collectorIndex] = (sequences[collectorIndex] ?? 0) + 1;

    observations.push({
      featureClass: place.featureClass,
      wkt: geometryFor(place.featureClass, lon, lat),
      lon,
      lat,
      gpsAccuracyM,
      // Derived from the walk, not from a fixed cadence: time advances by the
      // distance covered at walking pace plus the dwell needed to observe.
      capturedAt: new Date(clockMs[collectorIndex] as number),
      deviceSequence: sequences[collectorIndex] as number,
      collectorIndex,
      specVersion: formatSpecVersion(place.featureClass, 1, 0),
      rawAttributes: attributesFor(place.featureClass, random),
      truePlaceId: placeId,
    });
  }

  // Sorted by capture time so the batch resembles a real sync: several collectors'
  // days interleaved, each internally ordered.
  return observations.sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
}

/** WKT matching the geometry each class requires. */
function geometryFor(featureClass: FeatureClass, lon: number, lat: number): string {
  const d = 0.00012; // ~13 m
  switch (featureClass) {
    case FEATURE_CLASS.BUILDING_FOOTPRINT:
      return (
        `POLYGON((${lon} ${lat}, ${lon + d} ${lat}, ${lon + d} ${lat + d}, ` +
        `${lon} ${lat + d}, ${lon} ${lat}))`
      );
    case FEATURE_CLASS.ROAD_SEGMENT:
      return `LINESTRING(${lon} ${lat}, ${lon + d * 4} ${lat + d})`;
    default:
      return `POINT(${lon} ${lat})`;
  }
}

/**
 * Plausible attributes per class.
 *
 * Note what is absent everywhere: no land extent, no tenure, no title. Even
 * synthetic fixtures must not model concepts the system is forbidden to record —
 * fixtures have a way of becoming the template someone copies.
 */
function attributesFor(
  featureClass: FeatureClass,
  random: () => number,
): Record<string, unknown> {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)] as T;

  switch (featureClass) {
    case FEATURE_CLASS.BUILDING_FOOTPRINT:
      return {
        structure_use: pick(['residential', 'commercial', 'mixed', 'institutional']),
        storeys: 1 + Math.floor(random() * 4),
        roof_material: pick(['iron_sheet', 'tile', 'concrete', 'thatch']),
        wall_material: pick(['block', 'brick', 'mud_brick', 'timber']),
      };
    case FEATURE_CLASS.ACCESS_POINT:
      return {
        access_type: pick(['gate', 'doorway', 'vehicle_entrance']),
        vehicle_accessible: random() > 0.4,
        reachable_on_foot: true,
      };
    case FEATURE_CLASS.ROAD_SEGMENT:
      return {
        surface: pick(['asphalt', 'gravel', 'earth', 'concrete']),
        width_class: pick(['single_track', 'single_lane', 'two_lane']),
        seasonal_passability: pick(['all_year', 'dry_season_only', 'impassable_when_wet']),
      };
    case FEATURE_CLASS.WATER_POINT:
      return {
        water_source: pick(['borehole', 'handpump', 'standpipe', 'protected_well']),
        functional: random() > 0.25,
      };
    case FEATURE_CLASS.POI:
      return {
        category: pick(['shop', 'pharmacy', 'school', 'clinic', 'place_of_worship', 'market']),
        open_to_public: true,
      };
    case FEATURE_CLASS.ADDRESS_ANCHOR:
      return { street_name_local: pick(['Mkwakwani', 'Usagara', 'Ngamiani', 'Chumbageni']) };
    default:
      return {};
  }
}
