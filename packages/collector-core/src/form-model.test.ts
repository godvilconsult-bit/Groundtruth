import { describe, it, expect } from 'vitest';
import { ObservationForm, SUPPORTED_WIDGETS } from './form-model.js';
import { SpecValidator, V1_SPECS, specVersionOf, type FeatureClassSpec } from '@groundtruth/spec';

const validator = new SpecValidator(V1_SPECS);
const building = V1_SPECS.find((s) => s.featureClass === 'BUILDING_FOOTPRINT') as FeatureClassSpec;
const water = V1_SPECS.find((s) => s.featureClass === 'WATER_POINT') as FeatureClassSpec;

const form = (
  spec: FeatureClassSpec = building,
  locale: 'sw' | 'en' = 'sw',
  initialValues: Record<string, unknown> = {},
) =>
  new ObservationForm({
    spec,
    specVersion: specVersionOf(spec),
    locale,
    validator,
    initialValues,
  });

describe('field projection', () => {
  it('returns fields in display order, not authoring order', () => {
    const orders = form().fields().map((f) => f.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it('exposes every field in the specification', () => {
    expect(form().fields().map((f) => f.field).sort()).toEqual(
      building.uiHints.fields.map((f) => f.field).sort(),
    );
  });

  it('marks required fields from the JSON Schema, not from the ui hints', () => {
    const required = form().fields().filter((f) => f.required).map((f) => f.field).sort();
    expect(required).toEqual([...(building.jsonSchema.required ?? [])].sort());
  });

  it('carries select options with resolved labels', () => {
    const use = form().fields().find((f) => f.field === 'structure_use');
    expect(use?.options?.map((o) => o.value)).toContain('residential');
    expect(use?.options?.find((o) => o.value === 'residential')?.label).toBe('Makazi');
  });

  it('reports progress so a mapper can see what remains', () => {
    const f = form();
    expect(f.progress().answered).toBe(0);
    f.setValue('structure_use', 'residential');
    expect(f.progress().answered).toBe(1);
    expect(f.progress().total).toBe(building.uiHints.fields.length);
  });
});

describe('Swahili is the default, and locales never silently mix', () => {
  it('renders Swahili labels by default', () => {
    const f = form(building, 'sw').fields();
    expect(f.find((x) => x.field === 'structure_use')?.label).toBe('Matumizi ya jengo');
    expect(f.find((x) => x.field === 'storeys')?.label).toBe('Idadi ya ghorofa');
  });

  it('renders English when asked', () => {
    const f = form(building, 'en').fields();
    expect(f.find((x) => x.field === 'structure_use')?.label).toBe('Building use');
  });

  it('localises option labels too, not just field labels', () => {
    const sw = form(water, 'sw').fields().find((f) => f.field === 'water_source');
    const en = form(water, 'en').fields().find((f) => f.field === 'water_source');
    expect(sw?.options?.find((o) => o.value === 'handpump')?.label).toBe('Pampu ya mkono');
    expect(en?.options?.find((o) => o.value === 'handpump')?.label).toBe('Handpump');
  });

  it('makes a missing label look broken rather than quietly English', () => {
    // checkPublishable should prevent this reaching a device. If it ever does, it
    // must be reported, not lived with — so it renders conspicuously wrong.
    const broken: FeatureClassSpec = {
      ...water,
      uiHints: {
        fields: water.uiHints.fields.map((f, i) =>
          i === 0 ? { ...f, labels: { sw: '', en: 'Water source' } } : f,
        ),
      },
    };
    const label = form(broken, 'sw').fields()[0]?.label;
    expect(label).toMatch(/^\[.+\]$/);
    expect(label).not.toBe('Water source');
  });

  it('localises validation errors, since an ajv string is useless at a gate', () => {
    const f = form(building, 'sw');
    f.validate();
    const storeys = f.fields().find((x) => x.field === 'storeys');
    expect(storeys?.errors[0]).toContain('inahitajika');

    const en = form(building, 'en');
    en.validate();
    expect(en.fields().find((x) => x.field === 'storeys')?.errors[0]).toContain('required');
  });
});

describe('every error message a mapper can hit, in both locales', () => {
  // These strings are what someone reads standing at a gate with no connectivity
  // and no one to ask. An untested localisation branch ships as an ajv string.
  const anchor = V1_SPECS.find((s) => s.featureClass === 'ADDRESS_ANCHOR') as FeatureClassSpec;

  const errorsFor = (
    spec: FeatureClassSpec,
    values: Record<string, unknown>,
    field: string,
    locale: 'sw' | 'en',
  ): string[] => {
    const f = form(spec, locale);
    for (const [k, v] of Object.entries(values)) f.setValue(k, v);
    f.validate();
    return [...(f.fields().find((x) => x.field === field)?.errors ?? [])];
  };

  it('missing required', () => {
    expect(errorsFor(building, {}, 'storeys', 'sw').join()).toContain('inahitajika');
    expect(errorsFor(building, {}, 'storeys', 'en').join()).toContain('required');
  });

  it('value outside the offered options', () => {
    const values = { structure_use: 'residential', storeys: 1, roof_material: 'tile', wall_material: 'unobtanium' };
    expect(errorsFor(building, values, 'wall_material', 'sw').join()).toContain('chagua');
    expect(errorsFor(building, values, 'wall_material', 'en').join()).toContain('choose one');
  });

  it('text where a number belongs', () => {
    const values = { structure_use: 'residential', storeys: 'two', roof_material: 'tile' };
    expect(errorsFor(building, values, 'storeys', 'sw').join()).toContain('namba');
    expect(errorsFor(building, values, 'storeys', 'en').join()).toContain('number');
  });

  it('number out of range', () => {
    const values = { structure_use: 'residential', storeys: 999, roof_material: 'tile' };
    expect(errorsFor(building, values, 'storeys', 'sw').join()).toMatch(/kiwango/);
    expect(errorsFor(building, values, 'storeys', 'en').join()).toMatch(/range/);
  });

  it('text too long', () => {
    const values = { street_name_local: 'M'.repeat(200) };
    expect(errorsFor(anchor, values, 'street_name_local', 'sw').join()).toContain('maandishi');
    expect(errorsFor(anchor, values, 'street_name_local', 'en').join()).toContain('invalid text');
  });

  it('number where text belongs', () => {
    const values = { street_name_local: 12345 };
    expect(errorsFor(anchor, values, 'street_name_local', 'sw').length).toBeGreaterThan(0);
    expect(errorsFor(anchor, values, 'street_name_local', 'en').join()).toContain('invalid text');
  });

  it('never leaves a raw ajv string in front of a mapper', () => {
    // The failure this guards against: a message like
    // "must have required property 'storeys'" reaching a Swahili-speaking user.
    const f = form(building, 'sw');
    f.setValue('structure_use', 'residential');
    f.setValue('storeys', 'two');
    f.setValue('wall_material', 'unobtanium');
    f.validate();
    const all = f.fields().flatMap((x) => x.errors);
    expect(all.length).toBeGreaterThan(0);
    for (const message of all) {
      expect(message).not.toMatch(/must (be|have|NOT)/);
    }
  });

  it('prefixes each message with the field label so it is actionable', () => {
    const f = form(building, 'sw');
    f.validate();
    const storeys = f.fields().find((x) => x.field === 'storeys');
    expect(storeys?.errors[0]).toContain('Idadi ya ghorofa');
  });
});

describe('refuse rather than approximate', () => {
  it('treats every widget in the v1 specification as supported', () => {
    for (const spec of V1_SPECS) {
      for (const field of spec.uiHints.fields) {
        expect(SUPPORTED_WIDGETS.has(field.widget), `${spec.featureClass}.${field.field}`).toBe(true);
      }
    }
    expect(form().renderable).toBe(true);
  });

  it('marks the whole form unrenderable when one widget is unknown', () => {
    // A half-rendered form produces confidently wrong data. ADR-0003 requires the
    // client to keep its previous bundle rather than render an approximation.
    const future: FeatureClassSpec = {
      ...building,
      uiHints: {
        fields: building.uiHints.fields.map((f, i) =>
          i === 0 ? { ...f, widget: 'signature_pad' as never } : f,
        ),
      },
    };
    const f = form(future);
    expect(f.renderable).toBe(false);
    expect(f.unsupportedWidgets()).toEqual(['signature_pad']);
  });

  it('names every unsupported widget once, for a useful report', () => {
    const future: FeatureClassSpec = {
      ...building,
      uiHints: {
        fields: building.uiHints.fields.map((f) => ({ ...f, widget: 'hologram' as never })),
      },
    };
    expect(form(future).unsupportedWidgets()).toEqual(['hologram']);
  });
});

describe('tolerant reading of newer minor versions', () => {
  it('preserves unknown keys instead of dropping them', () => {
    // Collected under a newer minor version this build does not know. Dropping
    // these would silently lose data the server understands perfectly well.
    const f = form(building, 'sw', {
      structure_use: 'residential',
      solar_panels: true,
      balcony_count: 2,
    });
    expect(f.unknownKeys().sort()).toEqual(['balcony_count', 'solar_panels']);
    expect(f.values()).toMatchObject({ solar_panels: true, balcony_count: 2 });
  });

  it('keeps unknown keys through editing of known fields', () => {
    const f = form(building, 'sw', { solar_panels: true });
    f.setValue('storeys', 3);
    f.setValue('structure_use', 'commercial');
    expect(f.values()).toMatchObject({ solar_panels: true, storeys: 3, structure_use: 'commercial' });
  });

  it('does not offer unknown keys as editable fields', () => {
    const f = form(building, 'sw', { solar_panels: true });
    expect(f.fields().some((x) => x.field === 'solar_panels')).toBe(false);
  });

  it('lets an edited known value win over an initial one', () => {
    const f = form(building, 'sw', { storeys: 1 });
    f.setValue('storeys', 4);
    expect(f.values()['storeys']).toBe(4);
  });
});

describe('value handling', () => {
  it('rejects setting a field the specification does not define', () => {
    expect(() => form().setValue('parcel_ref', 'x')).toThrow(TypeError); // gt-vocab-allow: asserts a cadastral field is rejected
  });

  it('removes the key rather than storing null when a value is cleared', () => {
    // JSON Schema treats an explicit null as a type violation, not as absence, so
    // clearing a field must delete it or every cleared optional becomes an error.
    const f = form();
    f.setValue('wall_material', 'brick');
    expect(f.values()).toHaveProperty('wall_material');
    f.setValue('wall_material', '');
    expect(f.values()).not.toHaveProperty('wall_material');
  });

  it.each([undefined, null, ''])('treats %p as clearing the field', (empty) => {
    const f = form();
    f.setValue('storeys', 2);
    f.setValue('storeys', empty);
    expect(f.values()).not.toHaveProperty('storeys');
  });

  it('keeps false, which is a real answer and not an empty one', () => {
    const f = form(water);
    f.setValue('functional', false);
    expect(f.values()['functional']).toBe(false);
  });

  it('keeps zero, which is also a real answer', () => {
    const f = form();
    f.setValue('storeys', 0);
    expect(f.values()['storeys']).toBe(0);
  });
});

describe('completeness and validation', () => {
  it('reports the required fields still missing', () => {
    const f = form();
    expect(f.complete).toBe(false);
    expect(f.missingRequired().sort()).toEqual(['roof_material', 'storeys', 'structure_use']);
  });

  it('becomes complete once required fields are answered', () => {
    const f = form();
    f.setValue('structure_use', 'residential');
    f.setValue('storeys', 2);
    f.setValue('roof_material', 'iron_sheet');
    expect(f.complete).toBe(true);
    expect(f.missingRequired()).toEqual([]);
  });

  it('validates a complete form against the published schema', () => {
    const f = form();
    f.setValue('structure_use', 'residential');
    f.setValue('storeys', 2);
    f.setValue('roof_material', 'iron_sheet');
    expect(f.validate().valid).toBe(true);
  });

  it('catches a value the mapper could not have picked from the options', () => {
    const f = form();
    f.setValue('structure_use', 'residential');
    f.setValue('storeys', 2);
    f.setValue('roof_material', 'iron_sheet');
    f.setValue('wall_material', 'unobtanium');
    const result = f.validate();
    expect(result.valid).toBe(false);
    expect(f.fields().find((x) => x.field === 'wall_material')?.errors.length).toBeGreaterThan(0);
  });

  it('catches an out-of-range number and localises the message', () => {
    const f = form(building, 'sw');
    f.setValue('structure_use', 'residential');
    f.setValue('storeys', 999);
    f.setValue('roof_material', 'tile');
    expect(f.validate().valid).toBe(false);
    const errors = f.fields().find((x) => x.field === 'storeys')?.errors ?? [];
    expect(errors.join(' ')).toMatch(/kiwango|sahihi/);
  });

  it('reports validation failure when unknown keys break the schema', () => {
    // additionalProperties: false means a tolerantly-preserved key from a NEWER
    // minor version will fail against THIS build's older schema. That is correct:
    // the device flags it, the server validates against the version the
    // observation actually names, and QA adjudicates.
    const f = form(building, 'sw', { solar_panels: true });
    f.setValue('structure_use', 'residential');
    f.setValue('storeys', 1);
    f.setValue('roof_material', 'tile');
    expect(f.validate().valid).toBe(false);
    expect(f.values()).toHaveProperty('solar_panels');
  });

  it('validates every v1 class with a minimal complete answer set', () => {
    const answers: Record<string, Record<string, unknown>> = {
      'building_footprint@1.0': { structure_use: 'mixed', storeys: 1, roof_material: 'tile' },
      'access_point@1.0': { access_type: 'gate', reachable_on_foot: true },
      'road_segment@1.0': { surface: 'earth', width_class: 'single_lane', seasonal_passability: 'all_year' },
      'poi@1.0': { category: 'shop', open_to_public: true },
      'water_point@1.0': { water_source: 'handpump', functional: true },
      'address_anchor@1.0': { street_name_local: 'Mkwakwani' },
    };
    for (const spec of V1_SPECS) {
      const version = specVersionOf(spec);
      const f = form(spec);
      for (const [field, value] of Object.entries(answers[version] ?? {})) {
        f.setValue(field, value);
      }
      expect(f.complete, version).toBe(true);
      expect(f.validate().issues, version).toEqual([]);
    }
  });
});
