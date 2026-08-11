/**
 * Shapes for the Data Collection Specification.
 *
 * The spec is DATA, not code (ADR-0003). These types describe the documents that get
 * published into `gt.feature_class_schema`; the repo holds the source of truth for
 * what we publish, the database holds what is actually live.
 */

import type { FeatureClass } from '@groundtruth/domain';

/** Both locales, always. Swahili is the default; English is the secondary. */
export interface Localised {
  readonly sw: string;
  readonly en: string;
}

export type WidgetType =
  | 'text'
  | 'number'
  | 'integer'
  | 'select'
  | 'multiselect'
  | 'boolean'
  | 'photo';

export interface SelectOption {
  readonly value: string;
  readonly labels: Localised;
}

/**
 * How one field is presented.
 *
 * Deliberately separate from the JSON Schema that validates it, so a label change
 * can never alter validation semantics — the failure mode where someone "fixes a
 * typo" and silently widens what the field accepts.
 */
export interface FieldUiHint {
  readonly field: string;
  readonly widget: WidgetType;
  readonly labels: Localised;
  readonly help?: Localised;
  readonly options?: readonly SelectOption[];
  /** Display order within the form. Lower first. */
  readonly order: number;
}

export interface UiHints {
  readonly fields: readonly FieldUiHint[];
}

/** A minimal JSON Schema 2020-12 object, typed only as far as we author it. */
export interface JsonSchemaObject {
  readonly $schema?: string;
  readonly type: 'object';
  readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly allOf?: readonly Readonly<Record<string, unknown>>[];
}

export interface FeatureClassSpec {
  readonly featureClass: FeatureClass;
  readonly major: number;
  readonly minor: number;
  /** Clients below this refuse the bundle and keep their last valid one. */
  readonly minAppVersion: string;
  readonly jsonSchema: JsonSchemaObject;
  readonly uiHints: UiHints;
}

/** `{feature_class}@{major}.{minor}` — matches the database CHECK. */
export function specVersionOf(spec: FeatureClassSpec): string {
  return `${spec.featureClass.toLowerCase()}@${spec.major}.${spec.minor}`;
}
