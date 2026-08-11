/**
 * The v1 Data Collection Specification.
 *
 * This file is the source of truth for what we PUBLISH. The live specification is
 * whatever sits in `gt.feature_class_schema` — publishing is a deliberate, audited
 * act, and a version once published is immutable (ADR-0003).
 *
 * Two rules govern everything here:
 *
 *   1. Swahili is the default locale, not a translation. Every label and every
 *      option carries `sw` and `en`, and a missing `sw` blocks publication rather
 *      than falling back to English. Falling back would put an English form in front
 *      of a Swahili-speaking mapper standing at a gate, which produces wrong data
 *      quietly.
 *
 *   2. Nothing describes land extent, tenure, or title. Every attribute below is a
 *      descriptive property of a structure or place. `storeys` counts floors;
 *      nothing counts square metres of ground.
 */

import { FEATURE_CLASS } from '@groundtruth/domain';
import type { FeatureClassSpec, SelectOption } from './types.js';

const option = (value: string, sw: string, en: string): SelectOption => ({
  value,
  labels: { sw, en },
});

/** Build the JSON Schema enum from the ui options, so the two cannot drift apart. */
const enumOf = (options: readonly SelectOption[]): string[] => options.map((o) => o.value);

// ---------------------------------------------------------------------------
// BUILDING_FOOTPRINT
// ---------------------------------------------------------------------------

const STRUCTURE_USE = [
  option('residential', 'Makazi', 'Residential'),
  option('commercial', 'Biashara', 'Commercial'),
  option('mixed', 'Mchanganyiko', 'Mixed use'),
  option('institutional', 'Taasisi', 'Institutional'),
] as const;

const ROOF_MATERIAL = [
  option('iron_sheet', 'Bati', 'Iron sheet'),
  option('tile', 'Vigae', 'Tile'),
  option('concrete', 'Zege', 'Concrete'),
  option('thatch', 'Makuti', 'Thatch'),
] as const;

const WALL_MATERIAL = [
  option('block', 'Tofali za saruji', 'Cement block'),
  option('brick', 'Tofali za kuchoma', 'Fired brick'),
  option('mud_brick', 'Tofali za udongo', 'Mud brick'),
  option('timber', 'Mbao', 'Timber'),
] as const;

const buildingFootprint: FeatureClassSpec = {
  featureClass: FEATURE_CLASS.BUILDING_FOOTPRINT,
  major: 1,
  minor: 0,
  minAppVersion: '1.0.0',
  jsonSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      structure_use: { type: 'string', enum: enumOf(STRUCTURE_USE) },
      storeys: { type: 'integer', minimum: 1, maximum: 60 },
      roof_material: { type: 'string', enum: enumOf(ROOF_MATERIAL) },
      wall_material: { type: 'string', enum: enumOf(WALL_MATERIAL) },
      under_construction: { type: 'boolean' },
    },
    required: ['structure_use', 'storeys', 'roof_material'],
    additionalProperties: false,
  },
  uiHints: {
    fields: [
      {
        field: 'structure_use',
        widget: 'select',
        labels: { sw: 'Matumizi ya jengo', en: 'Building use' },
        help: {
          sw: 'Jengo hili linatumikaje kwa sasa?',
          en: 'How is this building currently used?',
        },
        options: STRUCTURE_USE,
        order: 1,
      },
      {
        field: 'storeys',
        widget: 'integer',
        labels: { sw: 'Idadi ya ghorofa', en: 'Number of storeys' },
        help: {
          sw: 'Hesabu ghorofa ya chini kama moja.',
          en: 'Count the ground floor as one.',
        },
        order: 2,
      },
      {
        field: 'roof_material',
        widget: 'select',
        labels: { sw: 'Aina ya paa', en: 'Roof material' },
        options: ROOF_MATERIAL,
        order: 3,
      },
      {
        field: 'wall_material',
        widget: 'select',
        labels: { sw: 'Aina ya ukuta', en: 'Wall material' },
        options: WALL_MATERIAL,
        order: 4,
      },
      {
        field: 'under_construction',
        widget: 'boolean',
        labels: { sw: 'Bado linajengwa?', en: 'Under construction?' },
        order: 5,
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// ACCESS_POINT — an entrance with reachable coordinates
// ---------------------------------------------------------------------------

const ACCESS_TYPE = [
  option('gate', 'Lango', 'Gate'),
  option('doorway', 'Mlango', 'Doorway'),
  option('vehicle_entrance', 'Kiingilio cha magari', 'Vehicle entrance'),
  option('footpath', 'Njia ya miguu', 'Footpath entrance'),
] as const;

const accessPoint: FeatureClassSpec = {
  featureClass: FEATURE_CLASS.ACCESS_POINT,
  major: 1,
  minor: 0,
  minAppVersion: '1.0.0',
  jsonSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      access_type: { type: 'string', enum: enumOf(ACCESS_TYPE) },
      vehicle_accessible: { type: 'boolean' },
      reachable_on_foot: { type: 'boolean' },
      obstructed: { type: 'boolean' },
    },
    required: ['access_type', 'reachable_on_foot'],
    additionalProperties: false,
  },
  uiHints: {
    fields: [
      {
        field: 'access_type',
        widget: 'select',
        labels: { sw: 'Aina ya kiingilio', en: 'Access type' },
        options: ACCESS_TYPE,
        order: 1,
      },
      {
        field: 'reachable_on_foot',
        widget: 'boolean',
        labels: { sw: 'Inafikika kwa miguu?', en: 'Reachable on foot?' },
        order: 2,
      },
      {
        field: 'vehicle_accessible',
        widget: 'boolean',
        labels: { sw: 'Gari linaweza kufika?', en: 'Vehicle can reach?' },
        order: 3,
      },
      {
        field: 'obstructed',
        widget: 'boolean',
        labels: { sw: 'Imezuiliwa kwa sasa?', en: 'Currently obstructed?' },
        order: 4,
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// ROAD_SEGMENT
// ---------------------------------------------------------------------------

const SURFACE = [
  option('asphalt', 'Lami', 'Asphalt'),
  option('gravel', 'Kokoto', 'Gravel'),
  option('earth', 'Udongo', 'Earth'),
  option('concrete', 'Zege', 'Concrete'),
] as const;

const WIDTH_CLASS = [
  option('single_track', 'Njia nyembamba', 'Single track'),
  option('single_lane', 'Njia moja', 'Single lane'),
  option('two_lane', 'Njia mbili', 'Two lane'),
] as const;

const PASSABILITY = [
  option('all_year', 'Mwaka mzima', 'All year'),
  option('dry_season_only', 'Kiangazi tu', 'Dry season only'),
  option('impassable_when_wet', 'Haipitiki wakati wa mvua', 'Impassable when wet'),
] as const;

const roadSegment: FeatureClassSpec = {
  featureClass: FEATURE_CLASS.ROAD_SEGMENT,
  major: 1,
  minor: 0,
  minAppVersion: '1.0.0',
  jsonSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      surface: { type: 'string', enum: enumOf(SURFACE) },
      width_class: { type: 'string', enum: enumOf(WIDTH_CLASS) },
      seasonal_passability: { type: 'string', enum: enumOf(PASSABILITY) },
      street_name_local: { type: 'string', maxLength: 120 },
    },
    required: ['surface', 'width_class', 'seasonal_passability'],
    additionalProperties: false,
  },
  uiHints: {
    fields: [
      {
        field: 'surface',
        widget: 'select',
        labels: { sw: 'Aina ya uso wa barabara', en: 'Surface' },
        options: SURFACE,
        order: 1,
      },
      {
        field: 'width_class',
        widget: 'select',
        labels: { sw: 'Upana', en: 'Width class' },
        options: WIDTH_CLASS,
        order: 2,
      },
      {
        field: 'seasonal_passability',
        widget: 'select',
        labels: { sw: 'Upitikaji wa msimu', en: 'Seasonal passability' },
        help: {
          sw: 'Je, barabara hii hupitika wakati wa masika?',
          en: 'Is this road passable during the rains?',
        },
        options: PASSABILITY,
        order: 3,
      },
      {
        field: 'street_name_local',
        widget: 'text',
        labels: { sw: 'Jina la mtaa', en: 'Local street name' },
        order: 4,
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// POI
// ---------------------------------------------------------------------------

const POI_CATEGORY = [
  option('shop', 'Duka', 'Shop'),
  option('pharmacy', 'Duka la dawa', 'Pharmacy'),
  option('school', 'Shule', 'School'),
  option('clinic', 'Zahanati', 'Clinic'),
  option('place_of_worship', 'Mahali pa ibada', 'Place of worship'),
  option('market', 'Soko', 'Market'),
  option('government_office', 'Ofisi ya serikali', 'Government office'),
] as const;

const poi: FeatureClassSpec = {
  featureClass: FEATURE_CLASS.POI,
  major: 1,
  minor: 0,
  minAppVersion: '1.0.0',
  jsonSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      category: { type: 'string', enum: enumOf(POI_CATEGORY) },
      name_local: { type: 'string', maxLength: 160 },
      open_to_public: { type: 'boolean' },
    },
    required: ['category', 'open_to_public'],
    additionalProperties: false,
  },
  uiHints: {
    fields: [
      {
        field: 'category',
        widget: 'select',
        labels: { sw: 'Aina ya mahali', en: 'Category' },
        options: POI_CATEGORY,
        order: 1,
      },
      {
        field: 'name_local',
        widget: 'text',
        labels: { sw: 'Jina la mahali', en: 'Place name' },
        help: {
          sw: 'Andika jina kama lilivyo kwenye bango. Usiandike majina ya watu.',
          en: 'Copy the name as written on the sign. Do not record personal names.',
        },
        order: 2,
      },
      {
        field: 'open_to_public',
        widget: 'boolean',
        labels: { sw: 'Ipo wazi kwa umma?', en: 'Open to the public?' },
        order: 3,
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// WATER_POINT
// ---------------------------------------------------------------------------

const WATER_SOURCE = [
  option('borehole', 'Kisima kirefu', 'Borehole'),
  option('handpump', 'Pampu ya mkono', 'Handpump'),
  option('standpipe', 'Bomba la maji', 'Standpipe'),
  option('protected_well', 'Kisima kilichohifadhiwa', 'Protected well'),
] as const;

const waterPoint: FeatureClassSpec = {
  featureClass: FEATURE_CLASS.WATER_POINT,
  major: 1,
  minor: 0,
  minAppVersion: '1.0.0',
  jsonSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      water_source: { type: 'string', enum: enumOf(WATER_SOURCE) },
      functional: { type: 'boolean' },
      publicly_accessible: { type: 'boolean' },
    },
    required: ['water_source', 'functional'],
    additionalProperties: false,
  },
  uiHints: {
    fields: [
      {
        field: 'water_source',
        widget: 'select',
        labels: { sw: 'Chanzo cha maji', en: 'Water source' },
        options: WATER_SOURCE,
        order: 1,
      },
      {
        field: 'functional',
        widget: 'boolean',
        labels: { sw: 'Inafanya kazi sasa?', en: 'Functional today?' },
        order: 2,
      },
      {
        field: 'publicly_accessible',
        widget: 'boolean',
        labels: { sw: 'Inatumika na umma?', en: 'Publicly accessible?' },
        order: 3,
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// ADDRESS_ANCHOR
// ---------------------------------------------------------------------------

const addressAnchor: FeatureClassSpec = {
  featureClass: FEATURE_CLASS.ADDRESS_ANCHOR,
  major: 1,
  minor: 0,
  minAppVersion: '1.0.0',
  jsonSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      street_name_local: { type: 'string', maxLength: 120 },
      house_reference: { type: 'string', maxLength: 40 },
      signage_present: { type: 'boolean' },
    },
    required: ['street_name_local'],
    additionalProperties: false,
  },
  uiHints: {
    fields: [
      {
        field: 'street_name_local',
        widget: 'text',
        labels: { sw: 'Jina la mtaa', en: 'Street name' },
        order: 1,
      },
      {
        field: 'house_reference',
        widget: 'text',
        labels: { sw: 'Namba ya nyumba', en: 'House reference' },
        help: {
          sw: 'Namba iliyoandikwa kwenye jengo, kama ipo.',
          en: 'The reference written on the building, if any.',
        },
        order: 2,
      },
      {
        field: 'signage_present',
        widget: 'boolean',
        labels: { sw: 'Kuna bango la mtaa?', en: 'Street signage present?' },
        order: 3,
      },
    ],
  },
};

/** The complete v1 specification bundle. */
export const V1_SPECS: readonly FeatureClassSpec[] = Object.freeze([
  buildingFootprint,
  accessPoint,
  roadSegment,
  poi,
  waterPoint,
  addressAnchor,
]);
