/**
 * Publish the Data Collection Specification into `gt.feature_class_schema`.
 *
 * Publication is a production deployment performed through data (ADR-0003), so it
 * behaves like one:
 *
 *   - every spec is checked against the publication rules BEFORE anything is written
 *   - a published version is immutable; re-publishing an existing version is refused
 *     rather than updated, because observations reference it forever
 *   - the whole bundle lands in one transaction, so a ward never sees half a spec
 */

import type pg from 'pg';
import { V1_SPECS, checkPublishable, specVersionOf, type FeatureClassSpec } from '@groundtruth/spec';

export interface PublishReport {
  readonly published: string[];
  readonly alreadyPresent: string[];
  readonly rejected: { version: string; issues: string[] }[];
}

/**
 * Serialise with keys sorted recursively.
 *
 * `jsonb` normalises key order on storage — it is a parsed representation, not the
 * text we sent — so a stored document round-trips with keys in PostgreSQL's order,
 * not ours. Comparing `JSON.stringify` output against it reports drift on every
 * single republish, which would make the immutability check below fire constantly
 * and teach whoever hits it to work around the guard.
 *
 * Sorting both sides makes the comparison mean what it is supposed to mean: did the
 * CONTENT change.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export async function publishSpecs(
  client: pg.Client,
  specs: readonly FeatureClassSpec[] = V1_SPECS,
): Promise<PublishReport> {
  await client.query('SET search_path = gt, reference, extensions, public');

  // Validate everything first. A bundle that is partly publishable is not
  // publishable: shipping four of six classes leaves mappers unable to collect the
  // other two, with no signal about why.
  const rejected: PublishReport['rejected'] = [];
  for (const spec of specs) {
    const result = checkPublishable(spec);
    if (!result.valid) {
      rejected.push({
        version: specVersionOf(spec),
        issues: result.issues.map((i) => `${i.path}: ${i.message}`),
      });
    }
  }
  if (rejected.length > 0) {
    return { published: [], alreadyPresent: [], rejected };
  }

  const published: string[] = [];
  const alreadyPresent: string[] = [];

  await client.query('BEGIN');
  try {
    for (const spec of specs) {
      const version = specVersionOf(spec);

      const existing = await client.query(
        `SELECT json_schema, ui_hints FROM gt.feature_class_schema
          WHERE feature_class = $1 AND spec_version = $2`,
        [spec.featureClass, version],
      );

      if ((existing.rowCount ?? 0) > 0) {
        // Immutability is the point, so a drifted local edit must be surfaced rather
        // than silently ignored or silently applied.
        const live = existing.rows[0];
        const sameSchema =
          canonical(live.json_schema) === canonical(spec.jsonSchema) &&
          canonical(live.ui_hints) === canonical(spec.uiHints);
        if (!sameSchema) {
          throw new Error(
            `${version} is already published and differs from the local definition. ` +
              'Published versions are immutable — publish a new version instead of ' +
              'editing this one (ADR-0003).',
          );
        }
        alreadyPresent.push(version);
        continue;
      }

      await client.query(
        `INSERT INTO gt.feature_class_schema
           (feature_class, spec_version, major, minor, json_schema, ui_hints, min_app_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          spec.featureClass,
          version,
          spec.major,
          spec.minor,
          JSON.stringify(spec.jsonSchema),
          JSON.stringify(spec.uiHints),
          spec.minAppVersion,
        ],
      );
      published.push(version);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }

  return { published, alreadyPresent, rejected: [] };
}
