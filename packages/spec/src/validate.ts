/**
 * Validation of collected attributes against a published specification, and of a
 * specification against publication rules.
 *
 * The same JSON Schema document validates on the device before queueing and on the
 * server at QA stage 1 (ADR-0003). One source of truth, enforced at both ends: the
 * device catches a bad value while the mapper is still standing at the gate, and the
 * server never trusts that it did.
 */

import _Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { isFeatureClass } from '@groundtruth/domain';
import { type FeatureClassSpec, type FieldUiHint, specVersionOf } from './types.js';

/**
 * ajv ships CommonJS with `export =` semantics, so under NodeNext resolution the
 * default import lands on the module namespace rather than the constructor. At
 * runtime both the module object and its `.default` are the class; this cast
 * recovers the constructor type without an `any`.
 */
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
type Ajv2020Instance = InstanceType<typeof Ajv2020>;

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

const OK: ValidationResult = Object.freeze({ valid: true, issues: Object.freeze([]) });

/**
 * Compiles and caches schemas by spec version.
 *
 * Cached because the collector validates on every keystroke-ish interaction and the
 * server validates every observation in a batch; recompiling a schema per call is
 * the kind of waste that only shows up as battery drain in the field.
 */
export class SpecValidator {
  readonly #ajv: Ajv2020Instance;
  readonly #compiled = new Map<string, ValidateFunction>();

  constructor(specs: readonly FeatureClassSpec[] = []) {
    this.#ajv = new Ajv2020({
      allErrors: true,
      // Unknown keywords are an authoring error, not something to tolerate silently.
      strictSchema: true,
      // Attributes arrive as JSON from the wire; nothing is coerced on our behalf.
      coerceTypes: false,
      useDefaults: false,
    });
    for (const spec of specs) this.register(spec);
  }

  register(spec: FeatureClassSpec): void {
    const version = specVersionOf(spec);
    if (this.#compiled.has(version)) return;
    this.#compiled.set(version, this.#ajv.compile(spec.jsonSchema));
  }

  has(specVersion: string): boolean {
    return this.#compiled.has(specVersion);
  }

  /**
   * Validate attributes against the schema named by `specVersion`.
   *
   * An unknown version is a failure, never a pass. Observations reference the version
   * they were collected under forever; if we cannot find it we cannot judge the data,
   * and treating that as valid would let an old or tampered client inject anything.
   */
  validate(specVersion: string, attributes: unknown): ValidationResult {
    const validator = this.#compiled.get(specVersion);
    if (!validator) {
      return {
        valid: false,
        issues: [{ path: '', message: `unknown spec version "${specVersion}"` }],
      };
    }

    if (validator(attributes)) return OK;

    return {
      valid: false,
      issues: (validator.errors ?? []).map((e) => ({
        path: e.instancePath || '/',
        message: e.message ?? 'invalid',
      })),
    };
  }
}

// ---------------------------------------------------------------------------
// Publication rules
// ---------------------------------------------------------------------------

function checkLocales(hint: FieldUiHint, issues: ValidationIssue[]): void {
  const at = `field "${hint.field}"`;
  if (!hint.labels.sw?.trim()) {
    issues.push({ path: at, message: 'missing Swahili label' });
  }
  if (!hint.labels.en?.trim()) {
    issues.push({ path: at, message: 'missing English label' });
  }
  if (hint.help && (!hint.help.sw?.trim() || !hint.help.en?.trim())) {
    issues.push({ path: at, message: 'help text is missing a locale' });
  }
  for (const opt of hint.options ?? []) {
    if (!opt.labels.sw?.trim() || !opt.labels.en?.trim()) {
      issues.push({ path: `${at} option "${opt.value}"`, message: 'option is missing a locale' });
    }
  }
}

/**
 * Whether a specification may be published.
 *
 * Enforced here rather than left to review, because these are the failures that are
 * invisible until a mapper is standing in a ward with a form they cannot read.
 */
export function checkPublishable(spec: FeatureClassSpec): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!isFeatureClass(spec.featureClass)) {
    issues.push({ path: 'featureClass', message: `unknown feature class "${spec.featureClass}"` });
  }
  if (!Number.isInteger(spec.major) || spec.major < 0) {
    issues.push({ path: 'major', message: 'major must be a non-negative integer' });
  }
  if (!Number.isInteger(spec.minor) || spec.minor < 0) {
    issues.push({ path: 'minor', message: 'minor must be a non-negative integer' });
  }

  const schemaFields = Object.keys(spec.jsonSchema.properties);
  const hintFields = spec.uiHints.fields.map((f) => f.field);

  // Every validated field must be renderable, and every rendered field must be
  // validated. A field in one but not the other is either invisible to the mapper or
  // silently unconstrained.
  for (const field of schemaFields) {
    if (!hintFields.includes(field)) {
      issues.push({ path: field, message: 'in json_schema but has no ui hint — unrenderable' });
    }
  }
  for (const field of hintFields) {
    if (!schemaFields.includes(field)) {
      issues.push({ path: field, message: 'has a ui hint but is not in json_schema — unvalidated' });
    }
  }

  for (const hint of spec.uiHints.fields) {
    checkLocales(hint, issues);

    // A select with no options cannot be answered.
    if ((hint.widget === 'select' || hint.widget === 'multiselect') && !hint.options?.length) {
      issues.push({ path: `field "${hint.field}"`, message: `${hint.widget} has no options` });
    }

    // Options must match the schema enum exactly, or the form offers a value the
    // server will reject — the mapper's work is lost after the fact, in the office.
    const property = spec.jsonSchema.properties[hint.field];
    const schemaEnum = property?.['enum'];
    if (Array.isArray(schemaEnum) && hint.options) {
      const uiValues = hint.options.map((o) => o.value).sort();
      const schemaValues = [...(schemaEnum as string[])].sort();
      if (JSON.stringify(uiValues) !== JSON.stringify(schemaValues)) {
        issues.push({
          path: `field "${hint.field}"`,
          message: `ui options ${JSON.stringify(uiValues)} do not match schema enum ${JSON.stringify(schemaValues)}`,
        });
      }
    }
  }

  const orders = spec.uiHints.fields.map((f) => f.order);
  if (new Set(orders).size !== orders.length) {
    issues.push({ path: 'uiHints', message: 'duplicate field order values' });
  }

  // A required field the mapper is never shown cannot be filled in.
  for (const required of spec.jsonSchema.required ?? []) {
    if (!hintFields.includes(required)) {
      issues.push({ path: required, message: 'required but not rendered' });
    }
  }

  return issues.length === 0 ? OK : { valid: false, issues };
}
