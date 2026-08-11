/**
 * Phase 1 canonical core: the invariants the dataset's trustworthiness rests on.
 *
 * These run against a live database and skip when DATABASE_URL is unset.
 * Run with: npm run test:db
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const DATABASE_URL = process.env.DATABASE_URL;

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
// PostgreSQL class 23 (integrity constraint violation); `restrict_violation` is the
// code the append-only triggers raise. Not 2F004, which is in the SQL-routine class.
const RESTRICT_VIOLATION = '23001';
const CHUMBAGENI = '00000000-0000-4000-8000-000000000003';

/** A small polygon inside the seeded Chumbageni ward. */
const FOOTPRINT =
  'POLYGON((39.0950 -5.0700, 39.0952 -5.0700, 39.0952 -5.0698, 39.0950 -5.0698, 39.0950 -5.0700))';
const GATE = 'POINT(39.0951 -5.0699)';

describe.skipIf(!DATABASE_URL)('canonical data core', () => {
  /** @type {pg.Client} */ let db;
  let collectorId;
  const createdFeatures = [];
  const createdObservations = [];

  const newFeature = async (overrides = {}) => {
    const o = {
      feature_class: 'BUILDING_FOOTPRINT',
      geom: FOOTPRINT,
      provenance: 'FIELD_COLLECTED',
      status: 'PENDING',
      confidence: null,
      spec_version: 'building_footprint@1.0',
      ...overrides,
    };
    const { rows } = await db.query(
      `INSERT INTO gt.feature
         (feature_class, geom, provenance, status, confidence_score,
          first_observed_at, spec_version, ward_id)
       VALUES ($1, ST_GeomFromText($2, 4326), $3, $4, $5, now(), $6, $7)
       RETURNING id`,
      [o.feature_class, o.geom, o.provenance, o.status, o.confidence, o.spec_version, CHUMBAGENI],
    );
    createdFeatures.push(rows[0].id);
    return rows[0].id;
  };

  beforeAll(async () => {
    db = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 20000 });
    await db.connect();
    await db.query('SET search_path = gt, reference, extensions, public');

    const { rows } = await db.query(
      `INSERT INTO gt.collector (external_ref, display_name, assigned_ward_id)
       VALUES ($1, 'Test Collector', $2) RETURNING id`,
      [`test-${randomUUID()}`, CHUMBAGENI],
    );
    collectorId = rows[0].id;
  });

  afterAll(async () => {
    if (!db) return;

    // The ledger is append-only and correctly refuses DELETE, so teardown must
    // bypass its guard as the role that owns the table. A deliberate test-only escape:
    // the guard doing its job is exactly why cleanup cannot be ordinary SQL, and a
    // test suite that left rows behind would poison later runs through the
    // one-accrual-per-observation unique index.
    //
    // audit_log rows are NOT removed. They record the mutations these tests made,
    // and deleting them would break the hash chain for every subsequent row — which
    // is the entire point of the design.
    await db.query('ALTER TABLE gt.payment_ledger DISABLE TRIGGER payment_ledger_append_only');
    try {
      await db.query('DELETE FROM gt.payment_ledger WHERE collector_id = $1', [collectorId]);
    } finally {
      await db.query('ALTER TABLE gt.payment_ledger ENABLE TRIGGER payment_ledger_append_only');
    }

    // Observations reference features; both reference the collector.
    if (createdObservations.length) {
      await db.query('DELETE FROM gt.observation WHERE id = ANY($1)', [createdObservations]);
    }
    if (createdFeatures.length) {
      await db.query('DELETE FROM gt.feature WHERE id = ANY($1)', [createdFeatures]);
    }
    await db.query('DELETE FROM gt.collector WHERE id = $1', [collectorId]);
    await db.end();
  });

  describe('provenance (ADR-0001 layer 3)', () => {
    it('rejects OSM_ODBL on feature at write time', async () => {
      await expect(newFeature({ provenance: 'OSM_ODBL' })).rejects.toMatchObject({
        code: CHECK_VIOLATION,
        constraint: 'feature_provenance_not_osm',
      });
    });

    it('accepts the four cleared provenance values', async () => {
      for (const p of ['FIELD_COLLECTED', 'DRONE_DERIVED', 'LICENSED_THIRD_PARTY', 'PUBLIC_DOMAIN']) {
        await expect(newFeature({ provenance: p })).resolves.toBeTruthy();
      }
    });
  });

  describe('geometry must match its feature class', () => {
    it('rejects a BUILDING_FOOTPRINT submitted as a point', async () => {
      await expect(
        newFeature({ feature_class: 'BUILDING_FOOTPRINT', geom: GATE }),
      ).rejects.toMatchObject({ constraint: 'feature_geometry_matches_class' });
    });

    it('rejects an ACCESS_POINT submitted as a polygon', async () => {
      await expect(
        newFeature({
          feature_class: 'ACCESS_POINT',
          geom: FOOTPRINT,
          spec_version: 'access_point@1.0',
        }),
      ).rejects.toMatchObject({ constraint: 'feature_geometry_matches_class' });
    });

    it('accepts a correctly typed access point', async () => {
      await expect(
        newFeature({ feature_class: 'ACCESS_POINT', geom: GATE, spec_version: 'access_point@1.0' }),
      ).resolves.toBeTruthy();
    });
  });

  describe('confidence and status', () => {
    it('refuses to mark a feature ACCEPTED without a confidence score', async () => {
      // An accepted feature with no confidence is not a licensable product.
      await expect(
        newFeature({ status: 'ACCEPTED', confidence: null }),
      ).rejects.toMatchObject({ constraint: 'feature_accepted_requires_confidence' });
    });

    it('allows ACCEPTED with a confidence score', async () => {
      await expect(newFeature({ status: 'ACCEPTED', confidence: 0.875 })).resolves.toBeTruthy();
    });

    it('rejects a confidence score outside [0,1]', async () => {
      await expect(newFeature({ status: 'PENDING', confidence: 1.5 })).rejects.toMatchObject({
        constraint: 'feature_confidence_range',
      });
    });
  });

  describe('national grid alignment', () => {
    it('populates geom_utm in EPSG:21037 by trigger', async () => {
      const id = await newFeature();
      const { rows } = await db.query(
        `SELECT ST_SRID(geom_utm) AS srid,
                ST_X(ST_Centroid(geom_utm)) AS x,
                ST_Y(ST_Centroid(geom_utm)) AS y
           FROM gt.feature WHERE id = $1`,
        [id],
      );
      expect(rows[0].srid).toBe(21037);
      // Tanga sits in UTM zone 37S; eastings run ~100k–900k and southern-hemisphere
      // northings are large positives under the false northing.
      expect(Number(rows[0].x)).toBeGreaterThan(100_000);
      expect(Number(rows[0].x)).toBeLessThan(900_000);
      expect(Number(rows[0].y)).toBeGreaterThan(9_000_000);
    });

    it('recomputes geom_utm when geom changes', async () => {
      const id = await newFeature();
      const before = await db.query('SELECT ST_AsText(geom_utm) AS g FROM gt.feature WHERE id=$1', [id]);
      await db.query(
        `UPDATE gt.feature SET geom = ST_GeomFromText($2, 4326) WHERE id = $1`,
        [id, 'POLYGON((39.1000 -5.0700, 39.1002 -5.0700, 39.1002 -5.0698, 39.1000 -5.0698, 39.1000 -5.0700))'],
      );
      const after = await db.query('SELECT ST_AsText(geom_utm) AS g FROM gt.feature WHERE id=$1', [id]);
      expect(after.rows[0].g).not.toBe(before.rows[0].g);
    });
  });

  describe('observation invariants', () => {
    const insertObservation = async (overrides = {}) => {
      const o = {
        id: randomUUID(),
        device_id: `dev-${randomUUID().slice(0, 8)}`,
        sequence: 1,
        accuracy: 6.5,
        media: [],
        ...overrides,
      };
      const { rows } = await db.query(
        `INSERT INTO gt.observation
           (id, collector_id, device_id, feature_class, geom, gps_accuracy_m,
            captured_at, device_sequence, app_version, spec_version, sync_batch_id,
            ward_id, media_refs)
         VALUES ($1,$2,$3,'ACCESS_POINT',ST_GeomFromText($4,4326),$5,
                 now(),$6,'1.0.0','access_point@1.0',$7,$8,$9)
         RETURNING id`,
        [o.id, collectorId, o.device_id, GATE, o.accuracy, o.sequence, randomUUID(), CHUMBAGENI, o.media],
      );
      createdObservations.push(rows[0].id);
      return rows[0].id;
    };

    it('accepts a well-formed observation', async () => {
      await expect(insertObservation()).resolves.toBeTruthy();
    });

    it('rejects a non-positive GPS accuracy', async () => {
      await expect(insertObservation({ accuracy: 0 })).rejects.toMatchObject({
        constraint: 'observation_gps_accuracy_positive',
      });
    });

    it('rejects a malformed media digest via the sha256_hex domain', async () => {
      // The domain validates each array element, which a CHECK constraint cannot do.
      await expect(insertObservation({ media: ['not-a-digest'] })).rejects.toMatchObject({
        code: CHECK_VIOLATION,
      });
    });

    it('accepts a well-formed media digest', async () => {
      await expect(insertObservation({ media: ['a'.repeat(64)] })).resolves.toBeTruthy();
    });

    it('enforces one sequence number per device', async () => {
      const device = `dev-${randomUUID().slice(0, 8)}`;
      await insertObservation({ device_id: device, sequence: 7 });
      await expect(insertObservation({ device_id: device, sequence: 7 })).rejects.toMatchObject({
        code: UNIQUE_VIOLATION,
      });
    });
  });

  describe('payment ledger', () => {
    it('pays at most once per accepted observation', async () => {
      const obsId = (
        await db.query(
          `INSERT INTO gt.observation
             (id, collector_id, device_id, feature_class, geom, gps_accuracy_m,
              captured_at, device_sequence, app_version, spec_version, sync_batch_id, ward_id)
           VALUES ($1,$2,$3,'ACCESS_POINT',ST_GeomFromText($4,4326),5.0,
                   now(),$5,'1.0.0','access_point@1.0',$6,$7) RETURNING id`,
          [randomUUID(), collectorId, `dev-${randomUUID().slice(0, 8)}`, GATE, 99, randomUUID(), CHUMBAGENI],
        )
      ).rows[0].id;
      createdObservations.push(obsId);

      const accrue = () =>
        db.query(
          `INSERT INTO gt.payment_ledger (collector_id, observation_id, amount_minor, reason)
           VALUES ($1,$2,50000,'OBSERVATION_ACCEPTED')`,
          [collectorId, obsId],
        );

      await expect(accrue()).resolves.toBeTruthy();
      // A retried QA job must not pay twice.
      await expect(accrue()).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });

    it('refuses an acceptance accrual with no observation', async () => {
      await expect(
        db.query(
          `INSERT INTO gt.payment_ledger (collector_id, amount_minor, reason)
           VALUES ($1, 50000, 'OBSERVATION_ACCEPTED')`,
          [collectorId],
        ),
      ).rejects.toMatchObject({ constraint: 'ledger_accrual_references_observation' });
    });

    it('is append-only', async () => {
      await expect(
        db.query('UPDATE gt.payment_ledger SET amount_minor = 1 WHERE collector_id = $1', [collectorId]),
      ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    });
  });

  describe('hash-chained audit log', () => {
    it('records every feature mutation', async () => {
      const id = await newFeature();
      await db.query(`UPDATE gt.feature SET status = 'DISPUTED' WHERE id = $1`, [id]);

      const { rows } = await db.query(
        `SELECT action, before, after FROM gt.audit_log
          WHERE entity_type = 'feature' AND entity_id = $1 ORDER BY id`,
        [id],
      );
      expect(rows.map((r) => r.action)).toEqual(['FEATURE_INSERT', 'FEATURE_UPDATE']);
      expect(rows[0].before).toBeNull();
      expect(rows[1].before.status).toBe('PENDING');
      expect(rows[1].after.status).toBe('DISPUTED');
    });

    it('links each row to its predecessor', async () => {
      await newFeature();
      const { rows } = await db.query(
        'SELECT id, prev_hash, hash FROM gt.audit_log ORDER BY id DESC LIMIT 2',
      );
      expect(rows).toHaveLength(2);
      // rows[0] is newest; its prev_hash must equal rows[1].hash.
      expect(rows[0].prev_hash.equals(rows[1].hash)).toBe(true);
    });

    it('reports an intact chain', async () => {
      const { rows } = await db.query('SELECT * FROM gt.verify_audit_chain()');
      expect(rows).toEqual([]);
    });

    it('is append-only', async () => {
      await expect(
        db.query('UPDATE gt.audit_log SET actor = $1 WHERE id = (SELECT max(id) FROM gt.audit_log)', ['mallory']),
      ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

      await expect(
        db.query('DELETE FROM gt.audit_log WHERE id = (SELECT max(id) FROM gt.audit_log)'),
      ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    });

    it('DETECTS tampering when the append-only guard is bypassed', async () => {
      // The realistic threat: an actor with enough privilege to drop the trigger.
      // Verification must catch the edit even then — otherwise the chain is
      // decoration. We disable the guard exactly as such an actor would.
      const target = (await db.query('SELECT id, actor FROM gt.audit_log ORDER BY id DESC LIMIT 1')).rows[0];
      await db.query('ALTER TABLE gt.audit_log DISABLE TRIGGER audit_log_append_only');
      try {
        await db.query('UPDATE gt.audit_log SET actor = $1 WHERE id = $2', ['mallory', target.id]);

        const broken = (await db.query('SELECT * FROM gt.verify_audit_chain()')).rows;
        expect(broken).toHaveLength(1);
        expect(String(broken[0].broken_at)).toBe(String(target.id));
        expect(broken[0].reason).toMatch(/does not match its recorded hash/);

        // Restore the original value; the chain becomes valid again, which itself
        // demonstrates the check is a pure function of row content.
        await db.query('UPDATE gt.audit_log SET actor = $1 WHERE id = $2', [target.actor, target.id]);
        expect((await db.query('SELECT * FROM gt.verify_audit_chain()')).rows).toEqual([]);
      } finally {
        await db.query('ALTER TABLE gt.audit_log ENABLE TRIGGER audit_log_append_only');
      }
    });
  });
});
