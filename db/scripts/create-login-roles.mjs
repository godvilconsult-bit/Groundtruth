#!/usr/bin/env node
/**
 * Create login users and grant them the NOLOGIN group roles defined in migration
 * 1754870400000.
 *
 * This is deliberately NOT a migration. Migrations define structure that is
 * identical everywhere; login users and their credentials differ per environment
 * and must never appear in version-controlled SQL. Migrations create the groups,
 * this creates the members.
 *
 * Idempotent. Run after `migrate:up`.
 */

import pg from 'pg';

const LOGIN_ROLES = [
  { user: 'gt_api', group: 'gt_app', env: 'GT_API_PASSWORD' },
  { user: 'gt_exporter', group: 'gt_export', env: 'GT_EXPORT_PASSWORD' },
  { user: 'gt_tiles', group: 'gt_tileserv', env: 'GT_TILESERV_PASSWORD' },
];

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    process.stderr.write('DATABASE_URL is not set\n');
    process.exit(2);
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    for (const { user, group, env } of LOGIN_ROLES) {
      const password = process.env[env];
      if (!password) {
        throw new Error(
          `${env} is not set. Login roles must have explicit passwords; ` +
            'there is no default.',
        );
      }

      const { rowCount } = await client.query(
        'SELECT 1 FROM pg_roles WHERE rolname = $1',
        [user],
      );

      // PostgreSQL does not accept bind parameters in utility statements, so
      // `CREATE ROLE ... PASSWORD $1` is a syntax error — parameters are a DML-only
      // facility. Both the identifier and the password must therefore be escaped
      // client-side and interpolated.
      //
      // escapeLiteral/escapeIdentifier are node-postgres's own implementations of
      // PostgreSQL's quoting rules. Hand-rolled quote-doubling is the classic way to
      // get this subtly wrong, and a password is exactly the value you do not want
      // to be the exception that breaks it.
      //
      // The role names are additionally checked against a strict pattern: they are
      // constants in this file, and a failure here means the file was edited
      // carelessly rather than that input was hostile.
      if (!/^[a-z_][a-z0-9_]*$/.test(user)) throw new Error(`unsafe role name: ${user}`);
      if (!/^[a-z_][a-z0-9_]*$/.test(group)) throw new Error(`unsafe role name: ${group}`);

      const userIdent = client.escapeIdentifier(user);
      const groupIdent = client.escapeIdentifier(group);
      const passwordLiteral = client.escapeLiteral(password);

      if (rowCount === 0) {
        await client.query(`CREATE ROLE ${userIdent} LOGIN PASSWORD ${passwordLiteral}`);
        process.stdout.write(`created login role ${user}\n`);
      } else {
        await client.query(`ALTER ROLE ${userIdent} WITH LOGIN PASSWORD ${passwordLiteral}`);
        process.stdout.write(`updated login role ${user}\n`);
      }

      await client.query(`GRANT ${groupIdent} TO ${userIdent}`);
      process.stdout.write(`  granted ${group} to ${user}\n`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`create-login-roles failed: ${error.message}\n`);
  process.exit(1);
});
