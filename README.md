# Ground Truth

Verifiable geospatial data collection and licensing for East Africa.
First deployment: Tanga, Tanzania.

Ground Truth is not a mapping app. It is a machine that manufactures a proprietary,
verifiable, compounding dataset and licenses it. Field workers walk routes and record
verified attributes of real places; submissions are reviewed, scored, and either
accepted into the canonical dataset or rejected; customers license the result through
an API and bulk export.

The three assets, in order of value:

1. **The canonical dataset** — full provenance, confidence scoring
2. **The QA pipeline** — what makes the dataset trustworthy
3. **The collection app** — the least valuable and most replaceable part

---

## Two rules that govern everything

**Non-cadastral.** This system records descriptive attributes of places. It never
models, stores, computes, or outputs legal land extents, ownership, or title. Any
field, table, endpoint, or UI label implying such determination is a bug. Enforced in
CI by `tools/vocabulary-guard.mjs`, which fails the build on the prohibited
vocabulary *and* on the geometric operations that would manufacture the same outcome
under a different name.

**Provenance segregation.** Every geometry row carries a mandatory `provenance`.
OpenStreetMap data is ODbL-licensed and lives in a separate `osm_reference` schema,
used for basemap and navigation reference only. It can never reach a commercial
export. Enforced by five independent layers, the load-bearing one being PostgreSQL
privilege revocation — see [ADR-0001](docs/adr/0001-provenance-segregation.md).

Every export carries:

> Descriptive geospatial information. Not a cadastral survey. Does not determine or
> evidence any boundary, right, or interest in land.

---

## Quick start

Requires Docker and Node 24.

```bash
cp .env.example .env
```

Fill in the blank passwords in `.env` (`openssl rand -base64 24`), then:

```bash
docker compose up
```

That brings up Postgres+PostGIS, Redis, and MinIO, applies migrations, creates the
three login roles, and seeds a development ward in Tanga.

Without Docker, the domain suite and compliance guard still run:

```bash
npm ci && npm run verify
```

---

## Repository layout

```
packages/domain/       entities, value objects, business rules
                       zero dependencies — enforced by package.json and ESLint
packages/application/  use cases and ports                          (Phase 1)
packages/infrastructure/  Postgres, S3, Redis adapters              (Phase 1)
apps/api/              REST controllers, CLI, workers               (Phase 1)
apps/console/          review console — Next.js + MapLibre          (Phase 3)
apps/collector/        field collection app — Flutter, Android-first (Phase 2)

db/migrations/         plain SQL, run by node-pg-migrate
db/seed/               development fixtures (Tanga ward)
db/test/               privilege-barrier tests — need a live database

tools/                 vocabulary-guard.mjs — the compliance CI check
docs/adr/              architecture decision records
```

Dependencies point inward only. `@groundtruth/domain` declares no dependencies, so
importing a framework into it does not merely violate a convention — it fails to
resolve, and CI goes red. See [DECISIONS.md](DECISIONS.md) D-001.

---

## Commands

```bash
npm run verify
```

Runs the whole gate: compliance guard, lint, typecheck, tests. This is what CI runs.

| Command | What it does |
| --- | --- |
| `npm run guard` | Cadastral vocabulary check |
| `npm run lint` | ESLint, including the layer-dependency rules |
| `npm run typecheck` | `tsc -b` across the workspace |
| `npm test` | Vitest |
| `npm run test:coverage` | Coverage, with domain-layer thresholds enforced |
| `npm run migrate --workspace @groundtruth/db` | Apply migrations |

---

## Documentation

- **[DECISIONS.md](DECISIONS.md)** — choices with long-term consequences, and the
  three deliberate deviations from the original brief (D-006, D-007, D-008)
- **[RISKS.md](RISKS.md)** — what could bite later, logged when noticed
- **[ADR-0001](docs/adr/0001-provenance-segregation.md)** — provenance segregation
- **[ADR-0002](docs/adr/0002-offline-sync-and-conflict-resolution.md)** — offline
  sync and conflict resolution
- **[ADR-0003](docs/adr/0003-spec-versioning.md)** — spec versioning

---

## Build status

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Foundations: monorepo, Compose, migrations, CI, ADRs | **complete** |
| 1 | Canonical data core | not started |
| 2 | Field collection app | not started |
| 3 | QA pipeline and review console | not started |
| 4 | Licensing and delivery | not started |

## Licence

MIT — see [LICENSE](LICENSE). The licence covers this source code. It does not
cover the collected dataset, which is proprietary.
