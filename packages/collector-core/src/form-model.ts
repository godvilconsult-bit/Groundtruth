/**
 * The observation form, as logic rather than as components.
 *
 * ADR-0003 makes the dynamic form renderer the most correctness-critical component
 * in the collector: a bug here corrupts collection across every feature class,
 * silently, in a ward, with no connectivity to notice it. So the decisions live
 * here — ordering, locale resolution, required-ness, validation, renderability —
 * and the Preact layer stays a dumb projection of this state.
 *
 * Two rules from ADR-0003 are load-bearing and easy to get subtly wrong:
 *
 *   1. **Tolerant reading.** Attributes collected under a newer minor version may
 *      contain keys this build does not know. They are preserved verbatim and
 *      round-tripped, never dropped. Dropping them silently loses data collected
 *      under a spec the server does understand.
 *
 *   2. **Refuse rather than approximate.** A field this build cannot faithfully
 *      render makes the whole form unrenderable. A half-rendered form produces
 *      confidently wrong data, which is worse than no data and far more expensive
 *      to detect later.
 */

import type {
  FeatureClassSpec,
  FieldUiHint,
  WidgetType,
  ValidationResult,
  SpecValidator,
} from '@groundtruth/spec';

export type Locale = 'sw' | 'en';

/** Widgets this build can render faithfully. Anything else makes a form unrenderable. */
export const SUPPORTED_WIDGETS: ReadonlySet<WidgetType> = Object.freeze(
  new Set<WidgetType>(['text', 'number', 'integer', 'select', 'multiselect', 'boolean', 'photo']),
);

export interface FormOption {
  readonly value: string;
  readonly label: string;
}

export interface FormField {
  readonly field: string;
  readonly widget: WidgetType;
  readonly label: string;
  readonly help: string | null;
  readonly options: readonly FormOption[] | null;
  readonly required: boolean;
  readonly value: unknown;
  readonly errors: readonly string[];
  readonly order: number;
}

/** Localised validation messages. An ajv string is useless to a mapper at a gate. */
function localiseIssue(message: string, label: string, locale: Locale): string {
  const sw = locale === 'sw';
  if (/required property/i.test(message)) {
    return sw ? `${label}: inahitajika` : `${label}: required`;
  }
  if (/allowed values/i.test(message)) {
    return sw ? `${label}: chagua moja ya chaguo` : `${label}: choose one of the options`;
  }
  if (/must be integer|must be number/i.test(message)) {
    return sw ? `${label}: andika namba` : `${label}: enter a number`;
  }
  if (/>=|<=|minimum|maximum/i.test(message)) {
    return sw ? `${label}: namba haiko katika kiwango` : `${label}: number out of range`;
  }
  if (/additional properties/i.test(message)) {
    return sw ? 'Kuna taarifa isiyotambulika' : 'Unrecognised attribute present';
  }
  // ajv phrases length violations as "must NOT have more than 120 characters",
  // which matches none of the obvious keywords. Missing it sent an over-long street
  // name to the generic fallback, telling the mapper only that something was wrong.
  if (/must be string|maxLength|minLength|(more|fewer) than \d+ characters/i.test(message)) {
    return sw ? `${label}: maandishi si sahihi` : `${label}: invalid text`;
  }
  return sw ? `${label}: si sahihi` : `${label}: invalid`;
}

export class ObservationForm {
  readonly #spec: FeatureClassSpec;
  readonly #locale: Locale;
  readonly #validator: SpecValidator;
  readonly #specVersion: string;

  /** Known field values, keyed by field name. */
  readonly #values = new Map<string, unknown>();
  /**
   * Values whose keys this build does not recognise.
   *
   * Held separately and merged back on read, so a tolerant reader cannot
   * accidentally drop them while editing the fields it does know.
   */
  readonly #unknownValues = new Map<string, unknown>();

  #issues: ValidationResult['issues'] = [];

  constructor(args: {
    spec: FeatureClassSpec;
    specVersion: string;
    locale: Locale;
    validator: SpecValidator;
    initialValues?: Readonly<Record<string, unknown>>;
  }) {
    this.#spec = args.spec;
    this.#locale = args.locale;
    this.#validator = args.validator;
    this.#specVersion = args.specVersion;

    const known = new Set(args.spec.uiHints.fields.map((f) => f.field));
    for (const [key, value] of Object.entries(args.initialValues ?? {})) {
      if (known.has(key)) this.#values.set(key, value);
      else this.#unknownValues.set(key, value);
    }
  }

  /**
   * Widgets in this spec that this build cannot render.
   *
   * Non-empty means the form must NOT be shown. The client keeps its previous
   * bundle and reports the condition rather than rendering a partial form.
   */
  unsupportedWidgets(): string[] {
    return [
      ...new Set(
        this.#spec.uiHints.fields
          .filter((f) => !SUPPORTED_WIDGETS.has(f.widget))
          .map((f) => String(f.widget)),
      ),
    ];
  }

  get renderable(): boolean {
    return this.unsupportedWidgets().length === 0;
  }

  /** Locale-resolved label. Never silently falls back across locales. */
  #label(hint: FieldUiHint): string {
    const label = hint.labels[this.#locale];
    if (label && label.trim()) return label;
    // Publication is supposed to make this impossible (checkPublishable). Surfacing
    // the field name is deliberately ugly: it must look broken, not merely English,
    // so it is reported rather than lived with.
    return `[${hint.field}]`;
  }

  #requiredFields(): Set<string> {
    return new Set(this.#spec.jsonSchema.required ?? []);
  }

  /** Fields in display order, with values, labels and any current errors. */
  fields(): FormField[] {
    const required = this.#requiredFields();
    const errorsByField = new Map<string, string[]>();

    for (const issue of this.#issues) {
      // ajv paths look like "/storeys"; required errors report the parent path.
      const match = /^\/([^/]+)/.exec(issue.path);
      const named = match?.[1] ?? this.#fieldFromRequiredMessage(issue.message);
      if (!named) continue;
      const list = errorsByField.get(named) ?? [];
      list.push(issue.message);
      errorsByField.set(named, list);
    }

    return [...this.#spec.uiHints.fields]
      .sort((a, b) => a.order - b.order)
      .map((hint) => {
        const label = this.#label(hint);
        const raw = errorsByField.get(hint.field) ?? [];
        return Object.freeze({
          field: hint.field,
          widget: hint.widget,
          label,
          help: hint.help?.[this.#locale]?.trim() || null,
          options:
            hint.options?.map((o) => ({
              value: o.value,
              label: o.labels[this.#locale]?.trim() || `[${o.value}]`,
            })) ?? null,
          required: required.has(hint.field),
          value: this.#values.get(hint.field),
          errors: Object.freeze(raw.map((m) => localiseIssue(m, label, this.#locale))),
          order: hint.order,
        });
      });
  }

  /** ajv reports a missing required property against the object, not the field. */
  #fieldFromRequiredMessage(message: string): string | null {
    return /required property '([^']+)'/.exec(message)?.[1] ?? null;
  }

  setValue(field: string, value: unknown): void {
    const known = this.#spec.uiHints.fields.some((f) => f.field === field);
    if (!known) {
      throw new TypeError(`"${field}" is not a field of ${this.#specVersion}`);
    }
    // Clearing a value removes the key entirely rather than storing null: JSON
    // Schema treats an explicit null as a type violation, not as absence.
    if (value === undefined || value === '' || value === null) this.#values.delete(field);
    else this.#values.set(field, value);
  }

  /**
   * The attributes to submit.
   *
   * Unknown keys are merged back in verbatim — the tolerant-reader contract. Known
   * values win on collision, since those are what the mapper just edited.
   */
  values(): Record<string, unknown> {
    return { ...Object.fromEntries(this.#unknownValues), ...Object.fromEntries(this.#values) };
  }

  /** Keys preserved but not understood by this build. Surfaced for diagnostics. */
  unknownKeys(): string[] {
    return [...this.#unknownValues.keys()];
  }

  /** Validate against the published schema, storing issues for `fields()`. */
  validate(): ValidationResult {
    const result = this.#validator.validate(this.#specVersion, this.values());
    this.#issues = result.issues;
    return result;
  }

  /** Required fields still empty. Drives the submit button without a full validate. */
  missingRequired(): string[] {
    return [...this.#requiredFields()].filter((f) => !this.#values.has(f));
  }

  get complete(): boolean {
    return this.missingRequired().length === 0;
  }

  /** Progress for the UI, so a mapper can see how much of the form remains. */
  progress(): { answered: number; total: number; fraction: number } {
    const total = this.#spec.uiHints.fields.length;
    const answered = this.#spec.uiHints.fields.filter((f) => this.#values.has(f.field)).length;
    return { answered, total, fraction: total === 0 ? 1 : answered / total };
  }
}
