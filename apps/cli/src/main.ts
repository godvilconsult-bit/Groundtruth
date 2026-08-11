#!/usr/bin/env node
/**
 * Ground Truth operational CLI.
 *
 * Usage:
 *   gt ingest [--count N] [--collectors N] [--seed N]
 *   gt verify-chain
 */

import pg from 'pg';
import { ingest } from './ingest.js';

function parseArgs(argv: readonly string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token?.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args.set(key, next);
        i += 1;
      } else {
        args.set(key, 'true');
      }
    }
  }
  return args;
}

function connect(): pg.Client {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    process.stderr.write('DATABASE_URL is not set\n');
    process.exit(2);
  }
  return new pg.Client({ connectionString, connectionTimeoutMillis: 30_000 });
}

async function commandIngest(args: Map<string, string>): Promise<void> {
  const count = Number(args.get('count') ?? 1000);
  const collectors = Number(args.get('collectors') ?? 8);
  const seed = args.has('seed') ? Number(args.get('seed')) : undefined;

  if (!Number.isInteger(count) || count < 1) throw new Error('--count must be a positive integer');
  if (!Number.isInteger(collectors) || collectors < 1) throw new Error('--collectors must be a positive integer');

  const client = connect();
  await client.connect();
  try {
    process.stdout.write(`ingesting ${count} synthetic observations from ${collectors} collectors...\n\n`);
    const report = await ingest(client, {
      count,
      collectors,
      ...(seed === undefined ? {} : { seed }),
    });

    const row = (label: string, value: string | number) =>
      process.stdout.write(`  ${label.padEnd(28)} ${String(value)}\n`);

    row('sync batch', report.syncBatchId);
    row('observations inserted', report.observationsInserted);
    row('true places (generator)', report.truePlaces);
    row('clusters formed', report.clustersFormed);
    row('features created', report.featuresCreated);
    row('features ACCEPTED', `${report.acceptedFeatures} (${
      report.featuresCreated === 0 ? 0 : Math.round((report.acceptedFeatures / report.featuresCreated) * 100)
    }%)`);
    row('mean confidence', report.meanConfidence);
    row('audit rows written', report.auditRowsWritten);
    row('elapsed', `${report.elapsedMs} ms`);

    // Clustering quality: how close the resolver got to the generator's truth.
    // Not a pass/fail — a number to watch as the matching rule evolves.
    const drift = report.clustersFormed - report.truePlaces;
    process.stdout.write(
      `\n  clustering drift ${drift >= 0 ? '+' : ''}${drift} ` +
        `(${report.clustersFormed} clusters vs ${report.truePlaces} true places)\n`,
    );
    process.stdout.write(
      drift > 0
        ? '  positive drift = under-merging: repeat visits left as separate features\n'
        : drift < 0
          ? '  negative drift = OVER-merging: distinct places collapsed together\n'
          : '  exact match\n',
    );
  } finally {
    await client.end();
  }
}

async function commandVerifyChain(): Promise<void> {
  const client = connect();
  await client.connect();
  try {
    const { rows } = await client.query('SELECT * FROM gt.verify_audit_chain()');
    const total = await client.query('SELECT count(*)::int AS n FROM gt.audit_log');
    if (rows.length === 0) {
      process.stdout.write(`audit chain intact across ${total.rows[0].n} rows\n`);
      process.stdout.write(
        'note: this detects edits, not a full recomputation by an actor with write\n' +
          'access. That requires an external anchor — see gt.audit_anchor, RISKS R-002.\n',
      );
    } else {
      process.stderr.write(`AUDIT CHAIN BROKEN at row ${rows[0].broken_at}: ${rows[0].reason}\n`);
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case 'ingest':
      await commandIngest(args);
      break;
    case 'verify-chain':
      await commandVerifyChain();
      break;
    default:
      process.stderr.write(
        'Ground Truth CLI\n\n' +
          '  gt ingest [--count N] [--collectors N] [--seed N]\n' +
          '  gt verify-chain\n',
      );
      process.exitCode = command === undefined ? 1 : 2;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
