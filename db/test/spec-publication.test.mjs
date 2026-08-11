/**
 * Publication of the Data Collection Specification.
 *
 * Publishing is a production deployment performed through data (ADR-0003), and it
 * has two independent guards that are easy to confuse:
 *
 *   1. PUBLISHABILITY — is this specification internally coherent? Returns a
 *      rejection report; nothing is written.
 *   2. IMMUTABILITY — does this version already exist with different content?
 *      Throws, because it means someone edited a published version in place.
 *
 * Both are tested here, separately, because a test that only exercises one while
 * believing it exercises both is worse than no test.
 *
 * Imports the built CLI output, so run `npm run build` first.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { publishSpecs } from '../../apps/cli/dist/publish-spec.js';
import { V1_SPECS, specVersionOf, checkPublishable } from '@groundtruth/spec';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('specification publication', () => {
  /** @type {pg.Client} */ let db;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 20000 });
    await db.connect();
    // The v1 bundle is expected to be live already; publish is idempotent.
    await publishSpecs(db, V1_SPECS);
  });

  afterAll(async () => {
    await db?.end();
  });

  it('has all six v1 classes live', async () => {
    const { rows } = await db.query(
      'SELECT spec_version FROM gt.feature_class_schema ORDER BY spec_version',
    );
    expect(rows.map((r) => r.spec_version).sort()).toEqual(
      V1_SPECS.map(specVersionOf).sort(),
    );
  });

  it('is idempotent — republishing the same bundle writes nothing', async () => {
    // jsonb normalises key order on storage, so a naive JSON.stringify comparison
    // reports drift on every republish. That false positive would make the
    // immutability guard fire constantly and train people to bypass it.
    const report = await publishSpecs(db, V1_SPECS);
    expect(report.published).toEqual([]);
    expect(report.rejected).toEqual([]);
    expect(report.alreadyPresent.sort()).toEqual(V1_SPECS.map(specVersionOf).sort());
  });

  describe('guard 1: publishability', () => {
    it('REJECTS a spec whose ui options disagree with its schema enum, without writing', async () => {
      // The form would offer a value the server rejects, losing a mapper's visit
      // after the fact, in the office, with no way to recover it.
      const tampered = V1_SPECS.map((s) =>
        s.featureClass !== 'POI'
          ? s
          : {
              ...s,
              jsonSchema: {
                ...s.jsonSchema,
                properties: {
                  ...s.jsonSchema.properties,
                  category: { type: 'string', enum: ['shop', 'casino'] },
                },
              },
            },
      );

      const before = await db.query('SELECT count(*)::int n FROM gt.feature_class_schema');
      const report = await publishSpecs(db, tampered);
      const after = await db.query('SELECT count(*)::int n FROM gt.feature_class_schema');

      expect(report.rejected).toHaveLength(1);
      expect(report.rejected[0].version).toBe('poi@1.0');
      expect(JSON.stringify(report.rejected[0].issues)).toContain('do not match schema enum');
      expect(report.published).toEqual([]);
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it('REJECTS the whole bundle when one class is bad, not just the bad one', async () => {
      // Shipping four of six classes leaves mappers unable to collect the others
      // with no signal about why.
      const tampered = V1_SPECS.map((s) =>
        s.featureClass !== 'POI'
          ? s
          : { ...s, uiHints: { fields: s.uiHints.fields.map((f) => ({ ...f, order: 1 })) } },
      );
      const report = await publishSpecs(db, tampered);
      expect(report.published).toEqual([]);
      expect(report.alreadyPresent).toEqual([]);
    });

    it('rejects a missing Swahili label before it can reach a ward', async () => {
      const tampered = V1_SPECS.map((s) =>
        s.featureClass !== 'WATER_POINT'
          ? s
          : {
              ...s,
              uiHints: {
                fields: s.uiHints.fields.map((f, i) =>
                  i === 0 ? { ...f, labels: { sw: '', en: f.labels.en } } : f,
                ),
              },
            },
      );
      const report = await publishSpecs(db, tampered);
      expect(JSON.stringify(report.rejected)).toContain('missing Swahili label');
    });
  });

  describe('guard 2: immutability', () => {
    it('THROWS when a published version is edited in place', async () => {
      // A label change is internally valid — it passes guard 1 — but the version is
      // already published, and observations reference it forever. Editing it would
      // silently change what a historical observation meant.
      const edited = V1_SPECS.map((s) =>
        s.featureClass !== 'ADDRESS_ANCHOR'
          ? s
          : {
              ...s,
              uiHints: {
                fields: s.uiHints.fields.map((f, i) =>
                  i === 0
                    ? { ...f, labels: { sw: 'Jina la barabara', en: f.labels.en } }
                    : f,
                ),
              },
            },
      );

      // Confirm guard 1 passes, so we are genuinely testing guard 2.
      expect(checkPublishable(edited.find((s) => s.featureClass === 'ADDRESS_ANCHOR')).valid).toBe(true);

      await expect(publishSpecs(db, edited)).rejects.toThrow(/already published and differs/);
    });

    it('leaves the live specification untouched after a rejected edit', async () => {
      const { rows } = await db.query(
        `SELECT ui_hints FROM gt.feature_class_schema WHERE spec_version = 'address_anchor@1.0'`,
      );
      expect(rows[0].ui_hints.fields[0].labels.sw).toBe('Jina la mtaa');
    });

    it('accepts a genuinely NEW version of an existing class', async () => {
      // The correct way to change a published spec: publish a new version.
      const anchor = V1_SPECS.find((s) => s.featureClass === 'ADDRESS_ANCHOR');
      const next = {
        ...anchor,
        minor: 1,
        uiHints: {
          fields: anchor.uiHints.fields.map((f, i) =>
            i === 0 ? { ...f, help: { sw: 'Kama lilivyo kwenye bango.', en: 'As written on the sign.' } } : f,
          ),
        },
      };

      try {
        const report = await publishSpecs(db, [next]);
        expect(report.published).toEqual(['address_anchor@1.1']);

        const { rows } = await db.query(
          `SELECT spec_version FROM gt.feature_class_schema
            WHERE feature_class = 'ADDRESS_ANCHOR' ORDER BY major, minor`,
        );
        // Both versions coexist. The old one stays readable forever.
        expect(rows.map((r) => r.spec_version)).toEqual(['address_anchor@1.0', 'address_anchor@1.1']);
      } finally {
        await db.query(
          `DELETE FROM gt.feature_class_schema WHERE spec_version = 'address_anchor@1.1'`,
        );
      }
    });
  });
});
