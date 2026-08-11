#!/usr/bin/env node
/**
 * Apply development seed data, in filename order.
 *
 * Seeds are idempotent (ON CONFLICT DO NOTHING) and are development fixtures only.
 * They must never run against production — the guard below refuses to.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const SEED_DIR = fileURLToPath(new URL('../seed', import.meta.url));

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    process.stderr.write('DATABASE_URL is not set\n');
    process.exit(2);
  }

  // Seed data is approximate and explicitly non-authoritative (RISKS.md R-005).
  // Loading it into production would put fixture geometry into work assignment.
  if (process.env.NODE_ENV === 'production' && process.env.GT_ALLOW_PROD_SEED !== 'i-understand') {
    process.stderr.write(
      'Refusing to seed: NODE_ENV=production. Seed data is a development fixture '
        + 'and is not authoritative (RISKS.md R-005).\n',
    );
    process.exit(1);
  }

  const files = (await readdir(SEED_DIR)).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) {
    process.stdout.write('no seed files found\n');
    return;
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    for (const file of files) {
      const sql = await readFile(join(SEED_DIR, file), 'utf8');
      process.stdout.write(`applying ${file}\n`);
      await client.query(sql);
    }

    const { rows } = await client.query(
      `SELECT name_en, level, is_authoritative,
              round((ST_Area(geom::geography) / 1e6)::numeric, 2) AS area_km2
         FROM reference.admin_area
        ORDER BY CASE level WHEN 'REGION' THEN 1 WHEN 'DISTRICT' THEN 2 ELSE 3 END`,
    );
    process.stdout.write('\nseeded administrative areas:\n');
    for (const row of rows) {
      const flag = row.is_authoritative ? '' : '  [NOT AUTHORITATIVE — dev fixture]';
      process.stdout.write(
        `  ${row.level.padEnd(9)} ${row.name_en.padEnd(12)} ${String(row.area_km2).padStart(9)} km2${flag}\n`,
      );
    }
    process.stdout.write('\n');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`seed failed: ${error.message}\n`);
  process.exit(1);
});
