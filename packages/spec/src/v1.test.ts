import { describe, it, expect } from 'vitest';
import { V1_SPECS } from './v1.js';
import { SpecValidator, checkPublishable } from './validate.js';
import { specVersionOf } from './types.js';
import { ALL_FEATURE_CLASSES, parseSpecVersion } from '@groundtruth/domain';

describe('v1 specification completeness', () => {
  it('covers every v1 feature class exactly once', () => {
    const covered = V1_SPECS.map((s) => s.featureClass).sort();
    expect(covered).toEqual([...ALL_FEATURE_CLASSES].sort());
  });

  it.each(V1_SPECS.map((s) => [specVersionOf(s), s] as const))(
    '%s is publishable',
    (_version, spec) => {
      const result = checkPublishable(spec);
      // Print the issues, not just a boolean — a failure here should say why.
      expect(result.issues).toEqual([]);
      expect(result.valid).toBe(true);
    },
  );

  it.each(V1_SPECS.map((s) => [specVersionOf(s), s] as const))(
    '%s produces a spec version the domain and database both accept',
    (version, spec) => {
      expect(parseSpecVersion(version).featureClass).toBe(spec.featureClass);
      // fcs_version_shape in migration 1754870403000.
      expect(/^[a-z_]+@[0-9]+\.[0-9]+$/.test(version)).toBe(true);
    },
  );
});

describe('Swahili is the default locale, not a fallback', () => {
  // ADR-0003: a missing Swahili label blocks publication. An English form in front
  // of a Swahili-speaking mapper produces wrong data quietly.
  it.each(V1_SPECS.map((s) => [specVersionOf(s), s] as const))(
    '%s has Swahili for every label, help text and option',
    (_version, spec) => {
      for (const field of spec.uiHints.fields) {
        expect(field.labels.sw.trim(), `label for ${field.field}`).not.toBe('');
        if (field.help) {
          expect(field.help.sw.trim(), `help for ${field.field}`).not.toBe('');
        }
        for (const opt of field.options ?? []) {
          expect(opt.labels.sw.trim(), `option ${opt.value} of ${field.field}`).not.toBe('');
        }
      }
    },
  );

  it('never reuses the English string as the Swahili one', () => {
    // Catches the copy-paste that looks translated but is not. Allows genuine
    // coincidences, of which v1 has none.
    const lazy: string[] = [];
    for (const spec of V1_SPECS) {
      for (const field of spec.uiHints.fields) {
        if (field.labels.sw === field.labels.en) {
          lazy.push(`${spec.featureClass}.${field.field}`);
        }
      }
    }
    expect(lazy).toEqual([]);
  });
});

describe('non-cadastral discipline in the specification', () => {
  it('records no land extent, tenure or title attribute', () => {
    // The spec is where a cadastral field would most plausibly creep in, because it
    // is authored as data and reads like a form rather than like code.
    const banned = /parcel|plot|boundar|owner|tenure|land_area|lot_area|title_deed/i; // gt-vocab-allow: the pattern asserting these never appear in the spec
    const offenders: string[] = [];
    for (const spec of V1_SPECS) {
      for (const field of Object.keys(spec.jsonSchema.properties)) {
        if (banned.test(field)) offenders.push(`${spec.featureClass}.${field}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('measures buildings by storeys, never by ground area', () => {
    const building = V1_SPECS.find((s) => s.featureClass === 'BUILDING_FOOTPRINT')!;
    const fields = Object.keys(building.jsonSchema.properties);
    expect(fields).toContain('storeys');
    expect(fields.some((f) => /area/i.test(f))).toBe(false);
  });

  it('warns mappers away from recording personal names', () => {
    // PDPA 2022 minimisation, enforced at the point the mapper is typing.
    const poi = V1_SPECS.find((s) => s.featureClass === 'POI')!;
    const nameField = poi.uiHints.fields.find((f) => f.field === 'name_local')!;
    expect(nameField.help?.en.toLowerCase()).toContain('personal names');
    expect(nameField.help?.sw.toLowerCase()).toContain('majina ya watu');
  });
});

describe('SpecValidator against the published v1 schemas', () => {
  const validator = new SpecValidator(V1_SPECS);

  it('accepts a well-formed building footprint', () => {
    const result = validator.validate('building_footprint@1.0', {
      structure_use: 'residential',
      storeys: 2,
      roof_material: 'iron_sheet',
    });
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects a missing required field', () => {
    const result = validator.validate('building_footprint@1.0', {
      structure_use: 'residential',
      roof_material: 'iron_sheet',
    });
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result.issues)).toContain('storeys');
  });

  it('rejects a value outside the enum', () => {
    const result = validator.validate('building_footprint@1.0', {
      structure_use: 'palace',
      storeys: 1,
      roof_material: 'iron_sheet',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects an unknown attribute rather than silently keeping it', () => {
    // additionalProperties: false. An unexpected key means the client and the spec
    // disagree, which QA needs to see.
    const result = validator.validate('building_footprint@1.0', {
      structure_use: 'residential',
      storeys: 1,
      roof_material: 'iron_sheet',
      land_area_sqm: 240, // gt-vocab-allow: a cadastral field that must be rejected
    });
    expect(result.valid).toBe(false);
  });

  it('does not coerce a string into a number', () => {
    // "2" from a sloppy client must fail, not silently become 2.
    const result = validator.validate('building_footprint@1.0', {
      structure_use: 'residential',
      storeys: '2',
      roof_material: 'iron_sheet',
    });
    expect(result.valid).toBe(false);
  });

  it('enforces numeric bounds', () => {
    for (const storeys of [0, -1, 61]) {
      const result = validator.validate('building_footprint@1.0', {
        structure_use: 'residential',
        storeys,
        roof_material: 'iron_sheet',
      });
      expect(result.valid, `storeys=${storeys}`).toBe(false);
    }
  });

  it('FAILS an unknown spec version rather than passing it', () => {
    // An old or tampered client must not be able to inject anything by naming a
    // version we cannot find.
    const result = validator.validate('building_footprint@9.9', { anything: true });
    expect(result.valid).toBe(false);
    expect(result.issues[0]!.message).toContain('unknown spec version');
  });

  it('validates every class with a minimal valid payload', () => {
    const minimal: Record<string, Record<string, unknown>> = {
      'building_footprint@1.0': { structure_use: 'mixed', storeys: 1, roof_material: 'tile' },
      'access_point@1.0': { access_type: 'gate', reachable_on_foot: true },
      'road_segment@1.0': { surface: 'earth', width_class: 'single_lane', seasonal_passability: 'all_year' },
      'poi@1.0': { category: 'shop', open_to_public: true },
      'water_point@1.0': { water_source: 'handpump', functional: true },
      'address_anchor@1.0': { street_name_local: 'Mkwakwani' },
    };
    for (const spec of V1_SPECS) {
      const version = specVersionOf(spec);
      const result = validator.validate(version, minimal[version]);
      expect(result.issues, version).toEqual([]);
    }
  });
});

describe('checkPublishable rejects broken specifications', () => {
  const base = V1_SPECS[0]!;

  it('rejects a field that is validated but not renderable', () => {
    const broken = {
      ...base,
      jsonSchema: {
        ...base.jsonSchema,
        properties: { ...base.jsonSchema.properties, orphan: { type: 'string' } },
      },
    };
    const result = checkPublishable(broken);
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result.issues)).toContain('unrenderable');
  });

  it('rejects a field that is rendered but unvalidated', () => {
    const broken = {
      ...base,
      uiHints: {
        fields: [
          ...base.uiHints.fields,
          { field: 'ghost', widget: 'text' as const, labels: { sw: 'X', en: 'Y' }, order: 99 },
        ],
      },
    };
    const result = checkPublishable(broken);
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result.issues)).toContain('unvalidated');
  });

  it('rejects a missing Swahili label', () => {
    const broken = {
      ...base,
      uiHints: {
        fields: base.uiHints.fields.map((f, i) =>
          i === 0 ? { ...f, labels: { sw: '', en: f.labels.en } } : f,
        ),
      },
    };
    const result = checkPublishable(broken);
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result.issues)).toContain('missing Swahili label');
  });

  it('rejects ui options that disagree with the schema enum', () => {
    // The form would offer a value the server rejects, losing the mapper's work
    // after the fact, in the office, with no way to recover the visit.
    const broken = {
      ...base,
      uiHints: {
        fields: base.uiHints.fields.map((f) =>
          f.field === 'structure_use'
            ? { ...f, options: [{ value: 'castle', labels: { sw: 'Ngome', en: 'Castle' } }] }
            : f,
        ),
      },
    };
    const result = checkPublishable(broken);
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result.issues)).toContain('do not match schema enum');
  });

  it('rejects duplicate field ordering', () => {
    const broken = {
      ...base,
      uiHints: { fields: base.uiHints.fields.map((f) => ({ ...f, order: 1 })) },
    };
    expect(checkPublishable(broken).valid).toBe(false);
  });
});
