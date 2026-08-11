# ADR-0001: Provenance Segregation Strategy

- **Status:** Accepted
- **Date:** 2026-08-11
- **Phase:** 0
- **Supersedes:** —

## Context

Ground Truth's commercial value rests on the canonical dataset being *proprietary and
licensable*. OpenStreetMap data is published under the Open Database Licence (ODbL),
which imposes share-alike obligations on any "Derivative Database". If OSM-derived
geometry or attributes are merged into the canonical dataset, the resulting database
is arguably a Derivative Database and must itself be published under ODbL. That
outcome would destroy the licensing business in a single commit.

We nevertheless need OSM for basemap tiles and navigation reference, because building
a basemap for Tanga from scratch is not a viable use of Phase 2.

The naive mitigation — "be careful, and check `provenance` before export" — is a
single application-layer check. One ORM `leftJoin`, one `UNION ALL` in a reporting
query, one well-meaning "enrich missing road names from OSM" ticket, and the
contamination is permanent and undetectable after the fact.

We also face a second, subtler contamination vector: a field mapper who traces
geometry off an OSM basemap rather than walking it. This produces a row correctly
labelled `FIELD_COLLECTED` that is in fact OSM-derived. Schema separation does
nothing about this.

## Decision

Contamination is prevented **structurally**, in five independent layers. No single
layer is trusted. Layers 1–3 make contamination impossible to *write*; layer 4 makes
it impossible to *export*; layer 5 catches human copying.

### Layer 1 — Physical separation by schema

OSM reference data lives in a dedicated `osm_reference` schema. Canonical data lives
in `gt`. Both live in the same PostgreSQL cluster, deliberately:

- A separate *database* would require an FDW or dblink to join across — but FDWs get
  installed by DBAs solving unrelated problems, and once installed the barrier is
  gone with no audit trail.
- A separate *schema* in the same cluster lets us enforce the barrier with the
  privilege system, which is auditable, testable in CI, and cannot be bypassed by
  application code regardless of what it does.

`search_path` for all application roles excludes `osm_reference`. Referencing it
requires explicit qualification, which is greppable and reviewable.

### Layer 2 — Privilege revocation (the load-bearing layer)

Three `NOLOGIN` group roles, granted to login users by deployment:

| Role          | `gt` schema  | `osm_reference` schema |
| ------------- | ------------ | ---------------------- |
| `gt_app`      | read + write | **no grants**          |
| `gt_export`   | read only    | **no grants**          |
| `gt_tileserv` | no grants    | read only              |

The export pipeline connects as `gt_export`. A query touching `osm_reference` fails
with `ERROR: permission denied for schema osm_reference` — a hard database error at
the connection's privilege barrier, not a conditional the application can get wrong,
forget, or short-circuit. This is the layer that actually holds.

`REVOKE ALL ON SCHEMA osm_reference FROM PUBLIC` is applied, and default privileges
are set so future tables in `osm_reference` inherit the revocation. New tables cannot
silently become readable.

### Layer 3 — Write-time CHECK constraint

The `provenance` enum is shared across both schemas and contains all five values,
including `OSM_ODBL`. But `gt.feature` and `gt.observation` carry:

```sql
CONSTRAINT feature_provenance_not_osm CHECK (provenance <> 'OSM_ODBL')
```

`OSM_ODBL` is therefore representable in the type system but unwritable in the
canonical schema. An `INSERT` carrying it fails at the database, at write time —
the earliest possible point, with the smallest possible blast radius.

We keep the value in the enum rather than defining two enums because
`osm_reference` rows must be labelled with it, and a single shared vocabulary means
a row's provenance is comparable across the barrier. Two enums would invite a cast.

### Layer 4 — Export pipeline assertion

Despite layers 1–3, the export pipeline re-validates every row's `provenance` against
an explicit allow-list before serialisation, and raises
`ProvenanceContaminationError` on violation. This aborts the export job loudly,
emits a critical-severity alert, and writes no partial output file.

This layer is redundant *by design*. It exists because layers 1–3 are database
guarantees, and a future change — a materialised view, a read replica with different
grants, a CSV built by an analyst's script — can route around the database without
routing around the domain code. It is also the layer that produces a comprehensible
error message and an alert, where layer 2 produces a permission error in a stack
trace.

Redundancy between layer 3 and layer 4 is accepted cost. Both are cheap; the failure
they prevent is terminal.

### Layer 5 — Armchair-copying detection in QA

Structural separation cannot detect a mapper who traced OSM instead of walking. QA
stage 2 (geometric plausibility) therefore includes an OSM-similarity check:
submitted geometry is compared against `osm_reference` — read via `gt_tileserv`, in a
QA-only code path that never touches export — and flagged for human adjudication when
it is near-identical within epsilon (Hausdorff distance below threshold, or vertex
sequences matching beyond coincidence).

A flag is not a rejection. Genuine ground truth and good OSM data *should* agree
closely. The signal is *suspicious exactness*: identical vertex counts, identical
coordinate precision, or agreement tighter than the collector's own GPS accuracy
permits. A footprint matching OSM to 6 decimal places when the device reported ±8 m
accuracy was not walked.

## Consequences

**Accepted:**

- Canonical features can never be enriched from OSM. Conflation is forbidden
  outright, not case-by-case. Missing road names stay missing until a mapper walks
  the road. This is the correct trade: the dataset's value *is* that it was walked.
- Basemap tiles are served from a separate endpoint carrying ODbL attribution.
  Attribution obligations are the tile server's responsibility and are documented in
  its deployment.
- The export pipeline's `gt_export` role cannot be reused for internal analytics that
  legitimately need OSM context. Those get `gt_tileserv` plus a read-only `gt` grant
  through a distinct role, and their output is marked non-exportable.
- Three roles instead of one is more deployment surface, more Terraform, more chance
  of a misconfigured grant in prod. Mitigated by CI proving the grants (below).

**Risks accepted and logged:** see `RISKS.md` — production grant drift, and the
possibility that a read replica is provisioned without the revocations.

## Verification

Phase 0 ships tests proving:

1. `gt_export` cannot `SELECT` from `osm_reference` (expects SQLSTATE `42501`).
2. Inserting `provenance = 'OSM_ODBL'` into `gt.feature` violates the CHECK
   constraint (expects SQLSTATE `23514`).
3. The export pipeline raises `ProvenanceContaminationError` when handed a row
   bearing `OSM_ODBL`, and writes no output. *(Domain-level test, no DB — ships in
   Phase 0; wired to the real pipeline in Phase 4.)*
4. Default privileges cause a newly created `osm_reference` table to be unreadable by
   `gt_export` without further action.

Tests 1, 2, and 4 require a live PostgreSQL and run in CI against a PostGIS service
container. Test 3 runs in the domain unit suite with no infrastructure.

## Alternatives rejected

- **Separate database cluster.** Strongest isolation, but doubles operational cost
  and backup surface for Phase 0–4 scale, and the FDW escape hatch means it is not
  actually stronger than privilege revocation. Revisit if a customer contract
  requires physical separation.
- **Application-layer check only.** Rejected: one line of code between the business
  and an unlicensable database.
- **No OSM at all.** Rejected: basemap cost in Phase 2 is prohibitive, and
  navigation reference materially improves collection throughput.
