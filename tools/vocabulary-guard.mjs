#!/usr/bin/env node
/**
 * Cadastral vocabulary guard.
 *
 * Ground Truth records descriptive attributes of places. It must never model, store,
 * compute, or output legal land boundaries, parcel extents, ownership, or title.
 *
 * Code review will not reliably enforce this. The banned words are natural English
 * in a geospatial codebase, and a reviewer under delivery pressure reads straight
 * past them. So it is enforced here, in CI, where it cannot be forgotten.
 *
 * The guard checks two things:
 *
 *   1. BANNED NOUNS — parcel, plot, boundary, owner, title. The brief's explicit
 *      prohibition.
 *
 *   2. BANNED OPERATIONS — the PostGIS calls that manufacture a de-facto cadastre
 *      out of building footprints. Banning the noun `parcel` while permitting
 *      ST_Union over adjacent footprints satisfies the letter of the constraint and
 *      violates its entire purpose: the output partitions land, and will be read as
 *      boundary determination no matter what the column is called. See RISKS.md
 *      R-009 and ADR-0001.
 *
 * Usage:  node tools/vocabulary-guard.mjs [--json]
 * Exit:   0 clean · 1 violations found · 2 guard itself failed
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const SCANNED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.dart', '.sql', '.json', '.yaml', '.yml', '.graphql', '.proto',
]);

const SKIPPED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.dart_tool',
  '.next', '.turbo', '.volumes', 'pgdata', 'minio-data',
]);

/**
 * Generated files. We do not control their contents and cannot act on a finding in
 * them — the npm registry contains a bundler called Parcel, whose funding URL would
 * otherwise fail every build.
 */
const SKIPPED_FILENAMES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'pubspec.lock',
]);

/**
 * The guard's own source and test define and exercise the banned vocabulary as
 * fixtures. They are the one place the words and operations must appear verbatim,
 * so they are skipped entirely.
 *
 * Enumerated by exact path, never by glob — a pattern here would eventually swallow
 * real source, and this exemption is the single point at which the whole control can
 * be defeated. Adding an entry must be justified in review.
 *
 * Markdown is not scanned at all (see SCANNED_EXTENSIONS), so prose that discusses
 * the prohibition — the ADRs, DECISIONS.md, RISKS.md — needs no exemption.
 */
const FULLY_EXEMPT = new Set([
  'tools/vocabulary-guard.mjs',
  'tools/vocabulary-guard.test.mjs',
]);

/**
 * Identifier-aware word boundaries.
 *
 * `\b` is wrong here: `_` is a word character to a regex engine, so `\bparcel\b`
 * does NOT match `parcel_id` — which is precisely the form these words take in a
 * SQL schema, the place they matter most. These lookarounds treat `_` as a
 * separator while still refusing to match inside a longer word (`reparcelling`).
 */
const L = '(?<![A-Za-z0-9])';
const R = '(?![A-Za-z0-9])';
const word = (body) => new RegExp(`${L}(?:${body})${R}`, 'gi');

const BANNED_NOUNS = [
  {
    id: 'parcel',
    pattern: word('parcels?'),
    why: 'implies a land parcel — a cadastral concept excluded from v1 entirely',
  },
  {
    id: 'plot',
    pattern: word('plots?'),
    why: 'implies a land plot — cadastral. (For charting, use "chart"/"graph".)',
  },
  {
    id: 'boundary',
    pattern: word('boundar(?:y|ies)'),
    why: 'implies boundary determination, which this system must never perform',
  },
  {
    id: 'owner',
    pattern: word('owner(?:s|ship)?'),
    why: 'implies land ownership — never modelled, never stored',
  },
  {
    id: 'title',
    pattern: word('title_?deeds?|land_?titles?|title_?holders?'),
    why: 'implies land title. (Plain "title" for a UI label is permitted.)',
  },
  {
    id: 'land-area',
    pattern: word('(?:land|lot|site)_?area'),
    why: 'expresses land extent; footprints record structure extent only',
  },
];

const BANNED_OPERATIONS = [
  {
    id: 'st-union',
    pattern: /\bST_Union\s*\(/gi,
    why: 'unioning footprints produces land-partitioning polygons (RISKS R-009)',
  },
  {
    id: 'st-dissolve',
    pattern: /\bST_Dissolve\s*\(/gi,
    why: 'dissolving footprint geometry manufactures a de-facto cadastre',
  },
  {
    id: 'st-voronoi',
    pattern: /\bST_Voronoi\w*\s*\(/gi,
    why: 'Voronoi tessellation over features partitions all land between them',
  },
  {
    id: 'st-concavehull',
    pattern: /\bST_ConcaveHull\s*\(/gi,
    why: 'hulls over feature clusters read as land extent',
  },
  {
    id: 'st-convexhull',
    pattern: /\bST_ConvexHull\s*\(/gi,
    why: 'hulls over feature clusters read as land extent',
  },
  {
    id: 'st-subdivide',
    pattern: /\bST_Subdivide\s*\(/gi,
    why: 'subdivision language and output are cadastral in effect',
  },
  {
    id: 'st-polygonize',
    pattern: /\bST_Polygonize\s*\(/gi,
    why: 'building polygons from road/edge geometry yields block-level land units',
  },
];

/**
 * Per-line suppression for a genuinely justified use.
 *   `-- gt-vocab-allow: <reason>`  or  `// gt-vocab-allow: <reason>`
 * A reason is mandatory; a bare marker does not suppress. This keeps the escape
 * hatch usable but self-documenting, and greppable at audit time.
 */
const ALLOW_MARKER = /gt-vocab-allow:\s*\S+/;

export { BANNED_NOUNS, BANNED_OPERATIONS };

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      if (SKIPPED_FILENAMES.has(entry.name)) continue;
      const dot = entry.name.lastIndexOf('.');
      if (dot === -1) continue;
      if (!SCANNED_EXTENSIONS.has(entry.name.slice(dot))) continue;
      yield full;
    }
  }
}

export function scanText(text, rules) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (ALLOW_MARKER.test(line)) return;
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      const match = rule.pattern.exec(line);
      if (match) {
        findings.push({
          rule: rule.id,
          why: rule.why,
          line: index + 1,
          column: match.index + 1,
          text: line.trim().slice(0, 160),
        });
      }
    }
  });
  return findings;
}

export async function runGuard(root = ROOT) {
  const violations = [];
  for await (const absolute of walk(root)) {
    const rel = relative(root, absolute).split(sep).join(posix.sep);
    if (FULLY_EXEMPT.has(rel)) continue;
    const rules = [...BANNED_NOUNS, ...BANNED_OPERATIONS];
    const text = await readFile(absolute, 'utf8');
    for (const finding of scanText(text, rules)) {
      violations.push({ file: rel, ...finding });
    }
  }
  return violations;
}

async function main() {
  const asJson = process.argv.includes('--json');
  const violations = await runGuard();

  if (asJson) {
    process.stdout.write(JSON.stringify({ violations }, null, 2) + '\n');
  } else if (violations.length === 0) {
    process.stdout.write('vocabulary-guard: clean — no cadastral vocabulary found\n');
  } else {
    process.stderr.write(
      `\nvocabulary-guard: ${violations.length} violation(s)\n` +
        'Ground Truth must never model land boundaries, extents, ownership, or title.\n\n',
    );
    for (const v of violations) {
      process.stderr.write(`  ${v.file}:${v.line}:${v.column}  [${v.rule}]\n`);
      process.stderr.write(`      ${v.why}\n`);
      process.stderr.write(`      > ${v.text}\n\n`);
    }
    process.stderr.write(
      'If a use is genuinely justified, append to that line:\n' +
        '  gt-vocab-allow: <reason>\n' +
        'A reason is mandatory. Suppressions are reviewed.\n\n',
    );
  }

  process.exitCode = violations.length === 0 ? 0 : 1;
}

// pathToFileURL rather than string concatenation: the repo path contains a space
// ("D:\GROUND TRUTH"), which must be percent-encoded to match import.meta.url.
// Hand-built file:// strings silently fail this comparison and the guard never runs.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`vocabulary-guard: failed to run: ${String(error)}\n`);
    process.exitCode = 2;
  });
}
