/**
 * Proves ADR-0001 layer 2: the ODbL barrier is a PostgreSQL privilege barrier, not
 * an application convention.
 *
 * Note on wording — this file says "barrier" throughout. The vocabulary guard bans
 * the land-extent noun outright, so that every occurrence of it in this repository
 * denotes a real defect. Spending that word on privilege separation would blunt
 * exactly the signal the guard exists to give. See DECISIONS.md D-005.
 *
 * These tests need a live database. They skip when DATABASE_URL is unset — which is
 * the case on a workstation without Docker — and run in CI against the PostGIS
 * service container. A skipped run is reported as skipped, never as passed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
const EXPORT_URL = process.env.GT_EXPORT_DATABASE_URL;

const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';

describe.skipIf(!DATABASE_URL || !EXPORT_URL)(
  'ODbL privilege barrier (ADR-0001)',
  () => {
    /** @type {pg.Client} */ let admin;
    /** @type {pg.Client} */ let exporter;

    beforeAll(async () => {
      admin = new pg.Client({ connectionString: DATABASE_URL });
      await admin.connect();

      // A table in osm_reference for the exporter to fail to read.
      await admin.query(`
        CREATE TABLE IF NOT EXISTS osm_reference.osm_probe (
          id bigint PRIMARY KEY,
          name text,
          provenance public.provenance NOT NULL DEFAULT 'OSM_ODBL'
        )`);
      await admin.query(
        `INSERT INTO osm_reference.osm_probe (id, name) VALUES (1, 'Mkwakwani Road')
         ON CONFLICT (id) DO NOTHING`,
      );

      // The positive control: a table in gt, created with NO explicit grant. If the
      // exporter can read it, ALTER DEFAULT PRIVILEGES is working — which is the
      // same mechanism that must keep osm_reference unreadable. Testing only the
      // denials would leave open the possibility that gt_export simply cannot read
      // anything, which would pass every negative test while being useless.
      await admin.query(`
        CREATE TABLE IF NOT EXISTS gt.export_probe (
          id bigint PRIMARY KEY,
          name text,
          provenance public.provenance NOT NULL DEFAULT 'FIELD_COLLECTED'
        )`);
      await admin.query(
        `INSERT INTO gt.export_probe (id, name) VALUES (1, 'Chumbageni gate')
         ON CONFLICT (id) DO NOTHING`,
      );

      exporter = new pg.Client({ connectionString: EXPORT_URL });
      await exporter.connect();
    });

    afterAll(async () => {
      await exporter?.end();
      await admin?.query('DROP TABLE IF EXISTS osm_reference.osm_probe');
      await admin?.query('DROP TABLE IF EXISTS gt.export_probe');
      await admin?.end();
    });

    it('LETS the export role read a gt table it was never explicitly granted', async () => {
      const { rows } = await exporter.query('SELECT id, name FROM gt.export_probe');
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Chumbageni gate');
    });

    it('DENIES the export role the reference schema (operational, never exported)', async () => {
      // Not an oversight — administrative areas are work-assignment geofences and QA
      // plausibility envelopes. They are not part of the licensed product and must
      // not appear in a customer payload. See DECISIONS.md D-004.
      await expect(
        exporter.query('SELECT 1 FROM reference.admin_area LIMIT 1'),
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });

    it('DENIES the export role USAGE on osm_reference', async () => {
      await expect(
        exporter.query('SELECT * FROM osm_reference.osm_probe'),
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });

    it('DENIES the export role a join across the barrier', async () => {
      // The realistic contamination shape: an innocent-looking enrichment join.
      await expect(
        exporter.query(`
          SELECT a.name_en, o.name
            FROM reference.admin_area a
            LEFT JOIN osm_reference.osm_probe o ON true
           LIMIT 1`),
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });

    it('DENIES the export role even a bare existence check', async () => {
      await expect(
        exporter.query('SELECT count(*) FROM osm_reference.osm_probe'),
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });

    it('keeps a NEWLY created osm_reference table unreadable without further action', async () => {
      // Default privileges must hold for tables that did not exist when the grants
      // were written. This is the drift that would otherwise reopen the barrier.
      await admin.query(
        'CREATE TABLE osm_reference.osm_probe_new (id bigint PRIMARY KEY)',
      );
      try {
        await expect(
          exporter.query('SELECT * FROM osm_reference.osm_probe_new'),
        ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      } finally {
        await admin.query('DROP TABLE IF EXISTS osm_reference.osm_probe_new');
      }
    });
  },
);

describe.skipIf(!DATABASE_URL)('OSM_ODBL is unwritable in operational schemas', () => {
  /** @type {pg.Client} */ let admin;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
  });

  afterAll(async () => {
    await admin?.end();
  });

  it('rejects an OSM_ODBL row in reference.admin_area at write time', async () => {
    await expect(
      admin.query(`
        INSERT INTO reference.admin_area
          (code, name_en, name_sw, level, geom, provenance, source)
        VALUES
          ('X', 'X', 'X', 'WARD',
           ST_Multi(ST_GeomFromText('POLYGON((39 -5, 39.1 -5, 39.1 -5.1, 39 -5.1, 39 -5))', 4326)),
           'OSM_ODBL', 'should not be insertable')`),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('accepts a non-OSM provenance in the same table', async () => {
    await admin.query('BEGIN');
    try {
      await expect(
        admin.query(`
          INSERT INTO reference.admin_area
            (code, name_en, name_sw, level, geom, provenance, source)
          VALUES
            ('TEST-OK', 'Test', 'Test', 'WARD',
             ST_Multi(ST_GeomFromText('POLYGON((39 -5, 39.1 -5, 39.1 -5.1, 39 -5.1, 39 -5))', 4326)),
             'PUBLIC_DOMAIN', 'test')`),
      ).resolves.toBeTruthy();
    } finally {
      await admin.query('ROLLBACK');
    }
  });
});
