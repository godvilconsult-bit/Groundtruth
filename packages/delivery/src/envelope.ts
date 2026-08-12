/**
 * Export envelopes.
 *
 * Every payload leaving this system must be self-describing and legally clean. That
 * is not a nicety: a GeoJSON file lands in a customer's GIS, gets copied, gets
 * emailed, and is read by someone who never saw the contract. The file itself has to
 * say what it is and what it is not.
 *
 * So every envelope carries, without exception:
 *   - the non-cadastral disclaimer, verbatim from the domain layer
 *   - the provenance of every feature in it
 *   - the spec version those features were collected under
 *   - the confidence formula version that produced their scores
 *   - an accuracy statement
 *
 * And every envelope passes through the provenance guard first (ADR-0001 layer 4).
 */

import {
  assertExportable,
  NON_CADASTRAL_DISCLAIMER,
  CONFIDENCE_FORMULA_VERSION,
  type Provenance,
} from '@groundtruth/domain';

export interface ExportFeature {
  readonly id: string;
  readonly featureClass: string;
  readonly geometry: Readonly<Record<string, unknown>>;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly provenance: Provenance;
  readonly confidenceScore: number | null;
  readonly specVersion: string;
  readonly firstObservedAt: string;
  readonly lastVerifiedAt: string | null;
}

export interface ExportMetadata {
  readonly generatedAt: string;
  readonly disclaimer: string;
  readonly confidenceFormulaVersion: string;
  readonly accuracyStatement: string;
  readonly featureCount: number;
  readonly specVersions: readonly string[];
  readonly provenanceSummary: Readonly<Record<string, number>>;
  readonly licence: string;
  /** Cursor to resume a delta feed from. Absent on a snapshot export. */
  readonly nextCursor?: string;
}

export interface GeoJsonExport {
  readonly type: 'FeatureCollection';
  readonly features: readonly {
    readonly type: 'Feature';
    readonly id: string;
    readonly geometry: Readonly<Record<string, unknown>>;
    readonly properties: Readonly<Record<string, unknown>>;
  }[];
  readonly metadata: ExportMetadata;
}

/**
 * The accuracy statement.
 *
 * Deliberately states what the confidence score is NOT. A customer who reads 0.87 as
 * "87% chance this is correct" will build decisions on a probability we never
 * claimed, and the misunderstanding surfaces in a dispute rather than in a meeting.
 */
export const ACCURACY_STATEMENT =
  'Confidence scores are a comparable ordinal measure of evidential strength under ' +
  'the stated formula version. They are not probabilities of correctness. ' +
  'Positional accuracy reflects consumer GNSS under field conditions. ' +
  'The published dataset accuracy metric is the independent re-survey disagreement ' +
  'rate, supplied separately.';

export const LICENCE_STATEMENT =
  'Licensed for the contracted purpose and extent. Redistribution is not permitted ' +
  'except as set out in the licence agreement.';

/**
 * Build a GeoJSON export.
 *
 * Runs the provenance guard before serialising anything. The guard throws rather
 * than filtering, and this function does not catch it: a contaminated batch must
 * abort the export loudly and produce no file at all. A partial file is worse than
 * no file, because it looks like a complete one.
 */
export function toGeoJson(
  features: readonly ExportFeature[],
  options: { generatedAt: Date; nextCursor?: string },
): GeoJsonExport {
  assertExportable(features);

  const specVersions = [...new Set(features.map((f) => f.specVersion))].sort();
  const provenanceSummary: Record<string, number> = {};
  for (const feature of features) {
    provenanceSummary[feature.provenance] = (provenanceSummary[feature.provenance] ?? 0) + 1;
  }

  return Object.freeze({
    type: 'FeatureCollection' as const,
    features: features.map((f) =>
      Object.freeze({
        type: 'Feature' as const,
        id: f.id,
        geometry: f.geometry,
        // Provenance and confidence travel on every feature, not just in the
        // metadata. A GIS user filtering or splitting the collection keeps them.
        properties: Object.freeze({
          ...f.attributes,
          feature_class: f.featureClass,
          provenance: f.provenance,
          confidence_score: f.confidenceScore,
          spec_version: f.specVersion,
          first_observed_at: f.firstObservedAt,
          last_verified_at: f.lastVerifiedAt,
        }),
      }),
    ),
    metadata: Object.freeze({
      generatedAt: options.generatedAt.toISOString(),
      disclaimer: NON_CADASTRAL_DISCLAIMER,
      confidenceFormulaVersion: CONFIDENCE_FORMULA_VERSION,
      accuracyStatement: ACCURACY_STATEMENT,
      featureCount: features.length,
      specVersions,
      provenanceSummary: Object.freeze(provenanceSummary),
      licence: LICENCE_STATEMENT,
      ...(options.nextCursor === undefined ? {} : { nextCursor: options.nextCursor }),
    }),
  });
}

/**
 * CSV export.
 *
 * The disclaimer is a leading comment row rather than a trailing one: spreadsheet
 * software truncates, users filter, and a footer is the first thing to be lost. A
 * header row survives being opened in Excel by someone who never saw the contract.
 */
export function toCsv(
  features: readonly ExportFeature[],
  options: { generatedAt: Date },
): string {
  assertExportable(features);

  const attributeKeys = [
    ...new Set(features.flatMap((f) => Object.keys(f.attributes))),
  ].sort();

  const header = [
    'id',
    'feature_class',
    'longitude',
    'latitude',
    'provenance',
    'confidence_score',
    'spec_version',
    'first_observed_at',
    'last_verified_at',
    ...attributeKeys,
  ];

  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const lines: string[] = [
    `# ${NON_CADASTRAL_DISCLAIMER}`,
    `# Generated ${options.generatedAt.toISOString()} · confidence ${CONFIDENCE_FORMULA_VERSION}`,
    `# ${LICENCE_STATEMENT}`,
    header.join(','),
  ];

  for (const feature of features) {
    const coords = (feature.geometry['coordinates'] as [number, number] | undefined) ?? [
      '',
      '',
    ];
    lines.push(
      [
        escape(feature.id),
        escape(feature.featureClass),
        escape(coords[0]),
        escape(coords[1]),
        escape(feature.provenance),
        escape(feature.confidenceScore),
        escape(feature.specVersion),
        escape(feature.firstObservedAt),
        escape(feature.lastVerifiedAt),
        ...attributeKeys.map((key) => escape(feature.attributes[key])),
      ].join(','),
    );
  }

  return lines.join('\n') + '\n';
}

/** Opaque cursor. Opaque so a customer cannot construct one and skip changes. */
export function encodeCursor(changeSeq: number): string {
  if (!Number.isInteger(changeSeq) || changeSeq < 0) {
    throw new RangeError('cursor must be a non-negative integer sequence');
  }
  return Buffer.from(`gt1:${changeSeq}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): number {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new TypeError('malformed cursor');
  }
  const match = /^gt1:(\d+)$/.exec(decoded);
  if (!match) throw new TypeError('malformed cursor');
  return Number(match[1]);
}
