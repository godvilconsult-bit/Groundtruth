import { describe, it, expect } from 'vitest';
import { SpecValidator, checkPublishable } from './validate.js';
import { V1_SPECS } from './v1.js';
import { specVersionOf, type FeatureClassSpec } from './types.js';

/**
 * Edge cases of the publication guards.
 *
 * These paths run rarely — only when someone authors a broken specification — which
 * is exactly why they need tests. A guard whose failure branches have never executed
 * is a guard nobody has confirmed works.
 */

const base = V1_SPECS.find((s) => s.featureClass === 'WATER_POINT') as FeatureClassSpec;

const messagesOf = (spec: FeatureClassSpec) =>
  JSON.stringify(checkPublishable(spec).issues);

describe('checkPublishable — identity', () => {
  it('rejects an unknown feature class', () => {
    const broken = { ...base, featureClass: 'LAND_REGISTER' } as unknown as FeatureClassSpec;
    expect(messagesOf(broken)).toContain('unknown feature class');
  });

  it.each([
    ['negative major', { major: -1 }],
    ['fractional major', { major: 1.5 }],
    ['negative minor', { minor: -2 }],
    ['fractional minor', { minor: 0.1 }],
  ])('rejects a %s', (_label, patch) => {
    const broken = { ...base, ...patch } as FeatureClassSpec;
    expect(checkPublishable(broken).valid).toBe(false);
  });
});

describe('checkPublishable — renderability', () => {
  it('rejects a select with no options, which cannot be answered', () => {
    const broken: FeatureClassSpec = {
      ...base,
      uiHints: {
        fields: base.uiHints.fields.map((f) =>
          f.widget === 'select' ? { ...f, options: [] } : f,
        ),
      },
    };
    expect(messagesOf(broken)).toContain('has no options');
  });

  it('rejects a required field the mapper is never shown', () => {
    // Required but unrendered means the form can never be completed, and the failure
    // appears as a server rejection long after the mapper has walked away.
    const broken: FeatureClassSpec = {
      ...base,
      jsonSchema: { ...base.jsonSchema, required: [...(base.jsonSchema.required ?? []), 'ghost'] },
    };
    expect(messagesOf(broken)).toContain('required but not rendered');
  });

  it('rejects help text present in one locale only', () => {
    const broken: FeatureClassSpec = {
      ...base,
      uiHints: {
        fields: base.uiHints.fields.map((f, i) =>
          i === 0 ? { ...f, help: { sw: 'Maelezo', en: '' } } : f,
        ),
      },
    };
    expect(messagesOf(broken)).toContain('help text is missing a locale');
  });

  it('rejects a missing English label as well as a missing Swahili one', () => {
    const broken: FeatureClassSpec = {
      ...base,
      uiHints: {
        fields: base.uiHints.fields.map((f, i) =>
          i === 0 ? { ...f, labels: { sw: f.labels.sw, en: '   ' } } : f,
        ),
      },
    };
    expect(messagesOf(broken)).toContain('missing English label');
  });

  it('rejects an option missing a locale', () => {
    const broken: FeatureClassSpec = {
      ...base,
      uiHints: {
        fields: base.uiHints.fields.map((f) =>
          f.options
            ? { ...f, options: f.options.map((o, i) => (i === 0 ? { ...o, labels: { sw: '', en: o.labels.en } } : o)) }
            : f,
        ),
      },
    };
    expect(messagesOf(broken)).toContain('option is missing a locale');
  });

  it('accepts the unmodified specification, confirming these tests break it deliberately', () => {
    expect(checkPublishable(base).valid).toBe(true);
  });
});

describe('SpecValidator lifecycle', () => {
  it('reports which versions it knows', () => {
    const validator = new SpecValidator(V1_SPECS);
    expect(validator.has('water_point@1.0')).toBe(true);
    expect(validator.has('water_point@2.0')).toBe(false);
  });

  it('knows nothing when constructed empty', () => {
    // The signal that matters at ingest: an empty validator rejects everything
    // rather than silently passing it.
    const validator = new SpecValidator();
    expect(validator.has('water_point@1.0')).toBe(false);
    expect(validator.validate('water_point@1.0', { water_source: 'handpump', functional: true }).valid)
      .toBe(false);
  });

  it('registering the same version twice is a no-op, not a recompile', () => {
    const validator = new SpecValidator();
    validator.register(base);
    validator.register(base);
    expect(validator.has(specVersionOf(base))).toBe(true);
    expect(validator.validate(specVersionOf(base), { water_source: 'borehole', functional: false }).valid)
      .toBe(true);
  });

  it('validates each registered class independently', () => {
    const validator = new SpecValidator(V1_SPECS);
    // A payload valid for one class must not pass as another.
    const waterPayload = { water_source: 'handpump', functional: true };
    expect(validator.validate('water_point@1.0', waterPayload).valid).toBe(true);
    expect(validator.validate('poi@1.0', waterPayload).valid).toBe(false);
  });

  it('reports the offending path so a reviewer can act on it', () => {
    const validator = new SpecValidator(V1_SPECS);
    const result = validator.validate('water_point@1.0', {
      water_source: 'river',
      functional: true,
    });
    expect(result.valid).toBe(false);
    expect(result.issues[0]!.path).toContain('water_source');
  });
});
