# DECISIONS

Append-only log of choices with long-term consequences. Substantial decisions get a
full ADR in `docs/adr/`; this file is the index plus the smaller calls that shape the
system but do not warrant their own document.

Newest last.

---

## ADRs

| #    | Decision                                  | Status   | Phase |
| ---- | ----------------------------------------- | -------- | ----- |
| 0001 | [Provenance segregation strategy](docs/adr/0001-provenance-segregation.md) | Accepted | 0 |
| 0002 | [Offline sync and conflict resolution](docs/adr/0002-offline-sync-and-conflict-resolution.md) | Accepted | 0 |
| 0003 | [Spec versioning strategy](docs/adr/0003-spec-versioning.md) | Accepted | 0 |

---

## D-001 — Clean Architecture layers are npm packages, not folders

**Date:** 2026-08-11 · **Phase:** 0

The brief mandates four layers with dependencies pointing inward only. Folder
conventions inside a single package rely on discipline and review to hold; a
misplaced import compiles fine and is caught only if someone notices.

`domain`, `application`, and `infrastructure` are therefore separate workspace
packages. `@groundtruth/domain` declares **zero dependencies** in its `package.json`,
so importing NestJS, `pg`, or anything else from the domain layer is not a style
violation — it fails to resolve, and CI goes red.

`interfaces` (REST controllers, CLI, workers) lives in `apps/api`, since it is the
composition root and is naturally per-deployable.

**Consequence:** more `package.json` files and a build graph to maintain. Accepted —
the dependency rule is the one architectural constraint most likely to erode
silently under delivery pressure, and this makes erosion impossible rather than
merely discouraged.

---

## D-002 — npm workspaces rather than pnpm

**Date:** 2026-08-11 · **Phase:** 0

The brief did not specify a package manager. pnpm is the better monorepo tool
(content-addressed store, strict hoisting that would catch phantom dependencies).
However pnpm is not installed on the current development machine, and npm 11 ships
with Node 24 which is already present.

npm workspaces is adequate for a five-package repo and removes a bootstrap step for
new contributors — relevant for a team we expect to onboard in Tanga.

**Revisit if:** phantom dependency bugs appear, or the package count exceeds ~15. The
migration is mechanical.

---

## D-003 — Plain SQL migrations via `node-pg-migrate`

**Date:** 2026-08-11 · **Phase:** 0

The schema needs PostGIS types, generated columns with projection functions, GiST and
GIN indexes, CHECK constraints, roles, grants, and default privileges. Prisma cannot
express most of this and would push it into unmanaged side-channel SQL. TypeORM
migrations are workable but drag in an ORM we do not otherwise want in the
infrastructure layer.

`node-pg-migrate` runs raw `.sql` files with up/down sections, keeps a proper
migrations table, and stays in the TypeScript toolchain (unlike Flyway, which needs a
JVM).

**Consequence:** no ORM-generated types. The infrastructure layer maps rows to domain
entities by hand. Accepted — that mapping is where provenance and invariants get
enforced, and it should be explicit and reviewable rather than generated.

---

## D-004 — Ward boundaries are operational geofences in a separate `reference` schema

**Date:** 2026-08-11 · **Phase:** 0

Tension: the system must never model land boundaries, but QA stage 2 needs to test
"not 200 km from the assigned ward", and collectors need ward assignment.

Administrative ward polygons are **operational geofences for work assignment and
plausibility checking**. They are not land tenure, not cadastral, and not ours — they
originate from national administrative sources.

They therefore live in a `reference` schema, distinct from both `gt` (canonical,
exportable) and `osm_reference` (ODbL). They are **never exported** and never appear
in a customer-facing payload. The table is named `admin_area`, not `boundary`.

**Consequence:** production requires authoritative ward geometry from NBS/TAMISEMI
before go-live. The Phase 0 seed is an explicitly-labelled approximation adequate
only for development. Logged in `RISKS.md` (R-005).

---

## D-005 — Cadastral vocabulary is enforced by CI, not by review

**Date:** 2026-08-11 · **Phase:** 0

The brief bans `parcel`, `plot`, `boundary`, `owner`, and `title` fields anywhere.
Relying on code review to catch these will fail eventually — the words are natural in
casual geospatial English, and a reviewer under time pressure reads past them.

`tools/vocabulary-guard.mjs` fails CI on any occurrence of the forbidden vocabulary in
source, SQL, or API surface, with a narrow, explicitly-justified allow-list for prose
that *discusses* the prohibition (this file, the ADRs, the guard itself).

**Naming convention this forces:** say *barrier*, *separation*, or *isolation* for
the privilege and schema concepts — never *boundary*. The word is banned outright, so
that every occurrence of it in the repository denotes a land boundary and is
therefore a real defect. Spending it on privilege separation would blunt precisely
the signal the guard exists to give, and would normalise suppression comments on
lines that are actually fine. The guard caught this during Phase 0 and the code was
renamed rather than suppressed.

**Extended beyond the brief:** the guard also bans geometric operations that
manufacture a de-facto cadastre from footprints — `ST_Union`, `ST_Dissolve`,
`ST_VoronoiPolygons`, `ST_ConcaveHull` and neighbours over feature geometry, plus
attribute names implying land area. Banning the noun `parcel` while permitting
`ST_Union` over adjacent building footprints would satisfy the letter of the
constraint and violate its purpose entirely. See ADR-0001.

---

## D-006 — Review console deferred out of the Phase 0 compose stack

**Date:** 2026-08-11 · **Phase:** 0

The brief lists `console` among the Phase 0 Docker Compose services, but the console
is a Phase 3 deliverable and there is nothing for it to display until the QA pipeline
exists.

Adding an empty Next.js container now is scaffolding that must be maintained,
rebuilt, and kept green for three phases while doing nothing. Compose therefore ships
Postgres+PostGIS, Redis, MinIO, and the API in Phase 0; the console joins in Phase 3.

**This is a deliberate deviation from the brief.** Flagged for objection — reversing
it is ten minutes' work if you want the placeholder.

---

## D-007 — Collection app is Android-first; Web is the console, not the collector

**Date:** 2026-08-11 · **Phase:** 0

The brief lists "iOS devices, Web, Android 9" as target devices, which conflicts with
the offline, battery, and on-device-blur constraints in the same section.

Flutter Web cannot satisfy Phase 2: browsers suspend background tabs and throttle
timers, there is no dependable multi-hour background geolocation, IndexedDB quotas
make per-ward MBTiles packs unreliable, and on-device face/plate blur under WASM on a
2 GB device is not viable. Shipping a Web collector would mean shipping a product
that silently loses field data — the worst possible failure for this dataset.

**Decision:** the collector targets Android (minSdk 28) first. Flutter keeps iOS
reachable as a later build target, and nothing in the design may assume Android-only
APIs without an abstraction — but iOS does not drive Phase 2 scope. Web is the review
console's platform, and the review console's alone.

**Status: SUPERSEDED by D-017.** Web was confirmed as a genuine requirement. The
capability analysis above holds — browsers cannot do multi-hour background GPS — but
the conclusion drawn from it was wrong, because it assumed Web meant *field
collection*. It does not. See D-017.

---

## D-008 — API service joins Compose in Phase 1, not Phase 0; pgvector deferred

**Date:** 2026-08-11 · **Phase:** 0

Two deferrals, same reasoning as D-006.

**API service.** The brief lists `api` among the Phase 0 Compose services. The API
has nothing to serve until the canonical data core exists in Phase 1. Shipping a
container whose only endpoint is a health check means maintaining a Dockerfile, a
dependency tree, and a green build for a service that does nothing — and the brief's
own anti-pattern list forbids marking placeholder work complete.

Phase 0's Compose stack is therefore the data platform: Postgres+PostGIS, Redis,
MinIO, and a one-shot `migrator` that applies migrations, creates login roles, and
seeds the Tanga ward. That is a genuinely "working empty system": you can connect to
it, and the privilege barrier is live and testable from the first minute.

**pgvector.** Needed only for imagery similarity search, which is Phase 4 at the
earliest. Deferred for a concrete reason beyond scheduling: the standard
`postgis/postgis` image does not ship pgvector, and the `pgvector/pgvector` image
does not ship PostGIS. Combining them needs a custom image — real work with real
maintenance cost, best done when the feature needs it rather than speculatively in
Phase 0, where it would add a build step to every developer's first `compose up`.

**Both are deliberate deviations from the brief.** Flagged for objection; each is
quick to reverse.

---

## D-009 — Supabase as the development Postgres; the privilege barrier survives it

**Date:** 2026-08-11 · **Phase:** 0
**Status: SUPERSEDED by D-010 the same day.** Retained because the platform analysis
below is the reusable part, and it is the checklist to re-run against any future
host. What killed it was operational, not architectural: Supabase's direct
connection is IPv6-only without a paid IPv4 add-on, and it was unreachable from the
development machine (verified — AAAA record present, no A record, `ENOTFOUND`).

Supabase was briefly the development database (project `qkvzjgcviehtpvtejere`).

**The question that mattered** was not price or developer experience. It was whether
ADR-0001's load-bearing control survives on managed Postgres. That control needs
`CREATE ROLE`, `REVOKE ALL ON SCHEMA … FROM PUBLIC`, `ALTER DEFAULT PRIVILEGES`, and
`CREATE EXTENSION postgis`. A platform that withholds these does not merely
inconvenience us — it removes the mechanism that keeps ODbL data out of commercial
exports, and the licensing guarantee reverts to an application-layer promise.

Supabase passes. Its `postgres` role is not a true superuser (`supabase_admin` alone
is), but `supautils` retains the privileges we need: custom roles are supported, and
PostGIS and pgvector are both first-class. The only documented unsupported operations
are `COPY … FROM PROGRAM` and `ALTER USER … WITH SUPERUSER`, neither of which we use.

**Two adjustments were required:**

1. `COMMENT ON ROLE` does need true superuser, so those statements in migration
   `1754870400000` are now wrapped and skipped on privilege failure. They are
   documentation; documentation must never be why a migration fails to apply.
2. Supabase installs PostGIS into the `extensions` schema, so the `geometry` type
   does not resolve for a role whose `search_path` omits it. Migration
   `1754870402000` sets `search_path` per role. The same statement is correct on a
   vanilla cluster, where PostgreSQL simply ignores the absent schema.

**A side benefit worth recording:** Supabase ships PostGIS and pgvector together,
which removes the reason pgvector was deferred in D-008 — there is no longer a custom
image to build. D-008's deferral now rests only on "Phase 4 doesn't need it yet",
which is a much weaker reason. Revisit when Phase 4 starts.

**The serious cost**, and it is serious: Supabase's Data API is default-open, and
`anon` is a published credential. See RISKS.md R-010 for the full analysis and the
hardening migration. This is the single largest platform-introduced risk to the
licensing model, and it is mitigated in depth rather than by configuration alone.

**Not settled by this decision:** production hosting. R-011 records that the
project's region is already fixed and needs a residency answer before any real field
data lands in it. Development against synthetic fixtures is unaffected.

---

## D-010 — Railway as the hosted development database

**Date:** 2026-08-11 · **Phase:** 0 · **Supersedes:** D-009

Railway hosts the development Postgres.

**Why it clears the bar that matters.** ADR-0001's load-bearing control needs
`CREATE ROLE`, `REVOKE ALL ON SCHEMA … FROM PUBLIC`, `ALTER DEFAULT PRIVILEGES`, and
`CREATE EXTENSION postgis`. Railway runs actual PostgreSQL containers, so we get a
real superuser — strictly more capable than Supabase's `postgres` role (not a true
superuser; `supabase_admin` alone is) and than RDS or Cloud SQL, which give
`rds_superuser` and an allow-listed extension set. A platform that withholds these
does not merely inconvenience us: it removes the mechanism keeping ODbL data out of
commercial exports, reducing the licensing guarantee to an application-layer promise.

**Why Supabase lost, and it was not architectural.** Its direct connection is
IPv6-only unless the IPv4 add-on is purchased, and the development machine has no
IPv6 route — verified by DNS (AAAA present, no A record) and a failed TCP connect.
The session pooler would have worked, but Railway's TCP proxy is plain IPv4 and needs
no such workaround. Railway also has no auto-generated data API, which removes an
entire category of exposure risk (R-010) rather than mitigating it.

**The cost we take on:** Railway's stock Postgres template ships no extensions, so
`CREATE EXTENSION postgis` fails on it. Postgres must be deployed from a
PostGIS-carrying template. This is a setup-time footgun with a confusing failure
mode, and it is why `.env.example` leads with it.

**Consequence for D-008:** templates bundling PostGIS *and* pgvector exist, so the
"combining them needs a custom image" justification for deferring pgvector no longer
holds. D-008 now rests only on "Phase 4 doesn't need it yet". Revisit at Phase 4.

**Unchanged by this decision:**

- **Local Docker remains the primary development path.** `docker-compose.yml` is
  unmodified. Railway is the shared/hosted database, useful once a physical handset
  and the review console need something to point at (Phase 2–3). Working against a
  local database stays faster and works offline, which matters for a team building an
  offline-first product.
- **Production hosting is still undecided and still blocked on data residency.**
  Railway has no African region. See R-011.
- **The data-API hardening migration is retained**, as a no-op on Railway. It costs
  one `DO` block and means the protection is already present if the database is ever
  moved to a platform that has such an API.

**Status: SUPERSEDED by D-011.** The platform analysis above stands and remains the
comparison of record; the choice was reversed for reasons recorded there.

---

## D-011 — Supabase as the hosted development database, via the session pooler

**Date:** 2026-08-11 · **Phase:** 0 · **Supersedes:** D-010 (which superseded D-009)

Supabase is the hosted development database, project `qkvzjgcviehtpvtejere`,
connected through the **session pooler** rather than the direct connection.

**What this fixes.** D-009 failed operationally, not architecturally: Supabase's
direct connection is IPv6-only without the paid IPv4 add-on and was unreachable from
the development machine. The session pooler is IPv4-reachable and resolves that
without buying anything. The platform capability analysis in D-009 was never the
problem and still holds — custom roles, PostGIS, and pgvector are all supported, and
`supautils` retains the privileges ADR-0001 requires.

**Cost of the reversal: near zero, by design.** The migrations were written
platform-conditional rather than platform-specific — `COMMENT ON ROLE` wrapped
against privilege failure, extensions installed into `extensions` where that schema
exists, `search_path` naming both possible PostGIS locations, and data-API roles
revoked where they exist. Every one of those is a no-op on a platform that does not
need it. Nothing in `db/migrations/` changed when moving to Railway, and nothing
changed moving back.

That is the argument for writing platform adaptations as conditionals rather than as
branches: this project has now changed hosted database three times in one day, and
the schema layer has been indifferent to all of it.

**What comes back into force:**

- **R-010 is active again.** Supabase auto-generates a PostgREST API and provisions
  `anon` — a credential published by design. The hardening migration revokes it from
  all three schemas, but the two dashboard settings ("Exposed schemas",
  "Automatically expose new tables") cannot be asserted from a migration and must be
  verified by hand.
- **`service_role` must never ship** to the collection app or the console front end;
  it bypasses RLS entirely.

**Unchanged:** local Docker remains the primary development path
(`docker-compose.yml` untouched); production hosting stays undecided and blocked on
the data-residency answer in R-011; and D-008's pgvector deferral is again reducible,
since Supabase ships PostGIS and pgvector together.

---

## D-012 — The `provenance` type lives in `public`, not `gt`

**Date:** 2026-08-11 · **Phase:** 0

Provenance labels rows in all three schemas. `osm_reference` rows in particular must
be labelled honestly (ADR-0001), which means `osm_reference` tables reference the
type — and referencing a type requires USAGE on the schema holding it.

Created unqualified, the type landed in `gt`, because that is first on the migration
session's `search_path`. That would have forced a grant of `gt` to `gt_tileserv`
purely so the tile role could describe its own reference tables, trading away the
clean "`gt_tileserv` has no `gt` access" property for nothing.

`public` is the neutral namespace: on every role's `search_path` by default, and
otherwise empty — migration `1754870400000` revokes PUBLIC's rights on it and we
create no tables there. All three roles get `USAGE ON SCHEMA public`, which conveys
no table access; it permits naming the type and nothing else.

**Caught by a failing integration test, not by review.** The type resolved fine in
every migration because migrations run with `gt` on the path; the flaw only surfaced
when a client connected with a default `search_path`. Worth remembering when Phase 1
adds cross-schema references: *unqualified DDL silently inherits the migration
runner's `search_path`*, which is not the path any application role will use.

**Consequence:** Phase 1 should schema-qualify type references in DDL rather than
rely on `search_path`, and any future shared type belongs in `public` alongside this
one.

---

## D-013 — `geom_utm` is maintained by trigger, not a GENERATED column

**Date:** 2026-08-11 · **Phase:** 1

The brief asks for a generated ARC 1960 / UTM 37S column (EPSG:21037, the correct
zone for Tanga at ~39°E). PostgreSQL rejects it: `ST_Transform` is `STABLE`, not
`IMMUTABLE`, because it reads `spatial_ref_sys`, and generated columns require
immutability.

The common workaround is an `IMMUTABLE`-marked wrapper. That is a lie to the planner
with a real consequence: an index could silently retain values computed under a
superseded projection definition, and nothing would report the inconsistency.

A `BEFORE INSERT OR UPDATE OF geom` trigger costs one function call per write and
keeps the column correct by construction. Applied to both `feature` and `observation`.

---

## D-014 — `sha256_hex` domain for content-addressed media

**Date:** 2026-08-11 · **Phase:** 1

`media_refs` is an array of SHA-256 digests. Validating each element with a CHECK
constraint is not expressible — CHECK cannot contain a subquery, and there is no
scalar way to test every element of an array inline.

A domain applies its constraint per element as the array is constructed, so one
malformed digest fails the insert. This matters because content addressing is what
makes media uploads dedupe and resume over 2G (ADR-0002); a malformed digest means
the client's addressing is broken, which should fail loudly at ingest rather than
surface later as an unresumable upload.

---

## D-015 — Single-link clustering for Phase 1 matching, with tolerances widened by reported GPS accuracy

**Date:** 2026-08-11 · **Phase:** 1

Observation-to-feature matching uses single-link agglomeration over per-class
distance tolerances (6–25 m), with the tolerance widened by the better of the two
observations' reported GPS accuracy.

**Why accuracy-aware.** Two readings 10 m apart taken with ±15 m fixes are entirely
consistent with one gate; the same 10 m gap with ±2 m fixes is two gates. A fixed
tolerance is wrong in both directions at once.

**Why single-link.** Observations strung along a road segment are a legitimate chain,
and centroid-link would split them arbitrarily. The known weakness is excessive
chaining in dense data; accepted at these tolerances, and exactly what QA stage 4 and
human adjudication exist to catch.

**Why tolerances are conservative.** Merging two distinct places is far more damaging
than failing to merge one: a wrong merge destroys a real place and averages two
truths into a falsehood, while a missed merge leaves two lower-confidence records
that re-survey reconciles. The 1,000-observation ingest shows **+8 drift on 493 true
places — under-merging, the safe direction.**

---

## D-016 — Ingest batches its writes; sequential round trips dominated everything

**Date:** 2026-08-11 · **Phase:** 1

The first working ingest took **373 seconds** for 1,000 observations. The cause was
not query cost but network latency: three round trips per feature (insert, link
observations, accrue payment) against a database in Frankfurt is ~1,500 sequential
round trips at ~230 ms each.

Resolving all clusters in memory, minting feature ids client-side, and writing three
bulk statements per chunk inside one transaction brought it to **10.2 seconds — 37×
— with byte-identical output** (501 clusters, 309 accepted, 0.575 mean confidence).

Two things worth carrying forward:

- **Client-minted ids are what make batching possible.** Reading ids back from
  `RETURNING` also forced a per-row round trip *and* was unsound: PostgreSQL does not
  guarantee `RETURNING` order matches a multi-row `VALUES` list, so zipping by index
  would eventually attach observations to the wrong features. Fixed alongside.
- **One transaction, not many.** A half-materialised batch is worse than none: the
  observations look processed while their features do not exist.

Phase 3's QA pipeline processes far more per run than this. Getting the write shape
right before that arrives is cheaper than retrofitting it into seven job stages.

---

## D-017 — Web is supervisor/office and belongs to the review console; the collector is a TypeScript PWA wrapped with Capacitor

**Date:** 2026-08-11 · **Phase:** 1 → 2 · **Supersedes:** D-007

Two decisions, confirmed after raising D-007's objection.

### Web is required, but not for field walking

Web is for **ward supervisors, desk verification, and correcting flagged
observations** — not for mappers walking routes. This resolves the capability
tension in D-007 rather than fighting it: the thing browsers genuinely cannot do
(multi-hour background GPS with the screen off) is not asked of them.

**Consequence, and it removes work rather than adding it: there is no separate
supervisor web app.** That surface is the Phase 3 review console with a ward-scoped
supervisor role. The console already needs a map, an observation queue, side-by-side
photo and attribute comparison, and keyboard-driven accept/reject — which is the
supervisor's job description. A distinct third client would duplicate all of it and
then drift, so that two surfaces disagree about what a flagged observation means.

Supervisors get a role and a ward scope, not an application.

### The collector is a TypeScript PWA, wrapped with Capacitor for Android

Deviates from the brief's Flutter choice. The brief permits this with a stated
reason, and there are two.

**One codebase for the most correctness-critical component.** The spec-driven form
renderer is where a bug corrupts collection across every feature class, silently and
in the field. Flutter would put it in Dart while the server, the console, and the
domain package are TypeScript — two implementations, two chances to diverge, no
shared tests.

**`@groundtruth/domain` becomes importable by the collector directly.** Feature
classes and their required geometry, spec-version parsing and compatibility, and the
provenance guard are already written, tested, and dependency-free. The device and the
server then enforce identical rules from one source, which is exactly what ADR-0003's
validate-twice design asks for and what a Dart client could only approximate.

Capacitor supplies native Android background geolocation through a plugin, which is
where continuous tracking is actually possible.

**The cost, stated plainly because it is real and I recommended this:** a WebView UI
on a 2 GB Android 9 handset is heavier than Flutter's native rendering, in both CPU
and battery. This makes R-004's already-tight budget harder, not easier. It is the
main argument against this choice, and it is not a small one. Logged against R-004.

**Unchanged by this:** ADR-0002's sync design and ADR-0003's spec versioning are both
client-agnostic and survive intact. Nothing in `db/` or `packages/domain/` changes.
