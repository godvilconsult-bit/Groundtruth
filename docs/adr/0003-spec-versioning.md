# ADR-0003: Spec Versioning Strategy

- **Status:** Accepted
- **Date:** 2026-08-11
- **Phase:** 0
- **Supersedes:** —

## Context

What mappers collect will change constantly. A customer will want seasonal road
passability broken into three categories instead of two; a water-point survey will
need a new attribute mid-campaign; a POI category will turn out to be useless in
Tanga and need removing.

If collection forms are hardcoded in the Flutter app, every such change costs an app
release plus a fleet update over 2G — days to weeks, and a period where the fleet is
split across versions collecting subtly different things with no record of which
device collected under which rules.

The brief is explicit: the Data Collection Specification lives in
`feature_class_schema` as data, not code. This ADR defines how that data is
versioned, distributed, and interpreted over time.

## Decision

### Per-class versioning, bundled for distribution

Versioning is **per feature class**, not global. Changing the POI schema must not
invalidate building footprints or force a re-download of everything.

`spec_version` is an opaque text identifier of the form `{feature_class}@{major}.{minor}`,
e.g. `road_segment@2.1`. It is stored **not-null on every observation and every
feature**, and it is never reused or mutated once published. A published version is
immutable; correcting a mistake means publishing a new version.

Distribution is by **spec bundle**: a named, versioned set pinning exactly one
version per feature class, e.g.
`tanga-2026-q3 → {building_footprint@1.0, access_point@1.2, road_segment@2.1, ...}`.
The client downloads a bundle, not individual schemas. A bundle is the unit of
"what we are collecting right now, here."

Bundles are assigned **per ward**, not globally. A schema change rolls out to one
ward, gets validated against real collection, and expands. A bad schema change
damages one ward's day, not the fleet's week.

### Compatibility rules

| Change                                        | Bump  | App impact              |
| --------------------------------------------- | ----- | ----------------------- |
| Add optional field                             | minor | none — tolerant clients |
| Widen an enum                                  | minor | none                    |
| Relax a constraint                             | minor | none                    |
| Add **required** field                         | major | requires app floor      |
| Remove or rename a field                       | major | requires app floor      |
| Narrow an enum / tighten a constraint          | major | requires app floor      |
| Change a field's type or semantic meaning      | major | requires app floor      |

Minor versions are **backward compatible by contract**: a client built against
`road_segment@2.0` collects correctly under `road_segment@2.1`, ignoring fields it
does not know. Clients must therefore be tolerant readers — unknown schema keys are
preserved verbatim in `raw_attributes` and passed through, never dropped. Dropping
unknown fields would silently lose data collected under a newer spec.

Each schema version declares `min_app_version`. A client below the floor **refuses
the bundle and continues on its last valid one**, reporting the condition to the
server. It does not attempt a partial or best-effort render. A form the app cannot
faithfully render must not be shown to a mapper — a half-rendered form produces
confidently wrong data, which is worse than no data and expensive to detect later.

### Interpretation is at read time, never by migration

Observations are immutable (ADR-0002). Their `raw_attributes` are **never migrated**
to a newer spec. A 2026 observation stays interpretable exactly as collected, forever.

Projection to the canonical `feature.attributes` happens at read/QA time through a
versioned projector that knows how to read every published version of its class.
This is the only place spec history accumulates as code, and it is deliberately
confined there.

The reason is evidentiary, not aesthetic. When a customer disputes an attribute, the
answer must be "here is the observation, here is the schema it was collected under,
here is the projector that produced the canonical value" — three immutable artefacts.
Rewriting historical `raw_attributes` to fit a new schema destroys the ability to
answer that question and, in a dispute, our credibility.

### Validation happens twice

- **On device, before queueing**, against the bundle's schema — so a mapper is told
  about a bad value while still standing at the gate, when fixing it costs seconds.
- **On the server, at QA stage 1**, against the schema named by the observation's own
  `spec_version` — never against the current one. The client is untrusted; an old or
  tampered client must not be able to inject invalid attributes.

Both use the same JSON Schema document, from the same table. One source of truth,
enforced at both ends.

### Storage

`feature_class_schema` holds `(feature_class, version, json_schema, ui_hints,
min_app_version, published_at, retired_at)`. `json_schema` is JSON Schema 2020-12,
validated as parseable at write time. `ui_hints` drives the dynamic form renderer —
widget type, ordering, grouping, Swahili and English labels — and is deliberately
separate from the validation schema so that presentation changes never risk altering
validation semantics.

**All labels for both locales live in `ui_hints`.** Adding a feature class must not
require an app release to obtain its Swahili strings. Swahili is the default; a
missing Swahili label is a publication-blocking error, not a fallback to English.

`retired_at` marks a version closed to *new* collection. Retired versions remain
readable forever, because observations reference them forever.

## Consequences

**Accepted:**

- The dynamic form renderer becomes the most complex component in the app, and its
  correctness is critical — a rendering bug corrupts collection across every class.
  It gets golden-file tests per widget type per locale, and is the app's most
  heavily tested unit.
- Projectors accumulate: every published major version of every class needs a read
  path maintained indefinitely. Bounded by publishing majors sparingly, and by the
  narrow v1 class list.
- We cannot express arbitrary conditional logic in JSON Schema alone. Cross-field
  rules ("width class required when surface is paved") use JSON Schema's
  `if/then/else`, and anything beyond it belongs in a QA stage, not the form.
- A misconfigured bundle can stall a ward's collection. Mitigated by per-ward
  rollout, and by clients holding their last valid bundle rather than failing open.
- Schema publication becomes a privileged, audited operation — effectively a
  production deployment performed through data. It requires MFA, is written to
  `audit_log`, and cannot be performed by reviewers.

**Rejected alternatives:**

- **Hardcoded forms in Flutter.** Explicitly listed as an anti-pattern in the brief,
  and correctly so: it couples what we collect to the release cadence of the least
  valuable asset.
- **Single global spec version.** Any change invalidates every class and forces a
  full re-download over 2G.
- **Migrating historical `raw_attributes` forward.** Destroys evidentiary value; a
  buggy migration silently corrupts history with no way to detect it.
- **Semantic versioning with patch.** No meaningful distinction between patch and
  minor for a data schema. Two components, less ambiguity.
