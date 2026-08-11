# RISKS

Append-only register of things that could bite later. Logged when noticed, not when
convenient. A risk stays here after mitigation, with its mitigation recorded — the
history of *why* a control exists is as useful as the control.

Severity: **critical** (kills the business or breaks the law) · **high** (expensive
to recover from) · **medium** (costly but survivable) · **low** (annoying).

Newest last.

---

## R-001 — ODbL contamination via a route that bypasses the database

**Severity:** critical · **Phase noticed:** 0 · **Status:** partially mitigated

ADR-0001's load-bearing control is PostgreSQL privilege revocation. It does not cover
paths that never touch the `gt_export` role: an analyst's ad-hoc script run as a
superuser, a read replica provisioned without the revocations, a backup restored into
a cluster where roles were not recreated, or a future materialised view built by a
role holding both grants.

**Mitigation so far:** layered CHECK constraint and domain-level export assertion
(ADR-0001 layers 3 and 4) catch the common cases regardless of role.

**Outstanding:** Terraform must assert grants on replicas as well as the primary, and
CI must verify grants against a *restored backup*, not only a freshly-migrated
database. Not yet built. Owner: Phase 4 infra work at the latest — earlier if a
replica is provisioned before then.

---

## R-002 — Hash-chained `audit_log` is not tamper-evident without an external anchor

**Severity:** high · **Phase noticed:** 0 · **Status:** open

A hash chain proves that no *interior* record was altered without recomputation. It
does not stop an actor with database write access from recomputing the entire chain
from the point of alteration forward. Since the chain head lives in the same database
as the records, an attacker who can edit rows can also fix the head. The property we
actually sell — "this dataset's history is verifiable" — does not hold.

**Proposed mitigation:** periodically anchor the chain head externally, so that
recomputation is detectable. Cheapest credible option is writing the head plus a
timestamp to append-only object storage under a separate credential (WORM /
object-lock bucket) every N minutes. Stronger options (public timestamping authority,
notarisation) are available if a customer contract demands it.

Anchoring cadence bounds the tamper window: an attacker can only rewrite history back
to the last anchor.

**Decide before Phase 1 ships the audit log**, because retrofitting anchoring means
the pre-anchor history is permanently unverifiable.

---

## R-003 — The 15 MB/day budget is dominated by imagery and is tighter than it appears

**Severity:** high · **Phase noticed:** 0 · **Status:** open, design constraint set

200 observations/day against a 15 MB ceiling allows ~75 KB per observation *including*
imagery. After gzipped attributes and sync overhead, the practical image budget is
roughly 55–65 KB. That implies ~800 px longest edge at JPEG q60, and **one photo per
observation by default** — a second photo halves the day's collection capacity.

The risk is that this is treated as guidance and breached silently: a well-intentioned
"let's capture the signboard too" ticket doubles data cost across the fleet, and
nobody notices until an airtime invoice arrives.

**Mitigation required in Phase 2:** a hard byte budget enforced in code, with the
encoder degrading quality before the app degrades observation count, and per-day
cumulative tracking surfaced in the UI. Specified in ADR-0002; not yet built.

**Second-order risk:** on-device face/plate blur must survive aggressive
re-compression. Blur applied *before* downscaling can be partially undone by
sharpening if the blur radius is small relative to the final resolution. The blur
must be applied at final resolution with a radius proportional to the detected
region, and this needs an adversarial test, not a visual check.

---

## R-004 — Battery target is achievable but has almost no headroom

**Severity:** medium · **Phase noticed:** 0 · **Status:** open, needs measurement

6 hours continuous GPS at ≤40% of a 4000 mAh battery permits ~1600 mAh, i.e. a
~265 mA average draw for the *entire device* — GNSS, screen, CPU, radio, and the OS.
On a cheap Android 9 handset a continuously-on GNSS receiver alone runs 40–90 mA, and
the screen at usable outdoor brightness can exceed 300 mA on its own.

The target is therefore only reachable with the screen off or dim for most of the
session, which is realistic for track recording but not for form entry.

**Implication for Phase 2:** duty-cycled GNSS (reduced fix rate while walking between
observations, full rate on approach and during capture), aggressive screen-off
behaviour during tracking, and no wake locks held longer than a capture.

**This must be measured on target hardware, not modelled.** Budget for a physical
device in Tanga or an equivalent handset early — a spec-compliant emulator figure
would be worthless. If the target proves unreachable, the honest response is to
revise the target, not to quietly ship a device that dies at 14:00 mid-ward.

---

## R-005 — No authoritative ward geometry; Phase 0 seed is an approximation

**Severity:** medium · **Phase noticed:** 0 · **Status:** open

QA stage 2 tests observations against assigned ward extent, and collectors are
assigned by ward. The Phase 0 seed for Tanga uses an **approximate, hand-drawn
rectangle** clearly labelled as a development fixture. It is not authoritative and
must never reach production.

Authoritative administrative geometry is needed from NBS / TAMISEMI, along with its
licence terms — which must be recorded as `provenance` on ingest, and which may not
be `PUBLIC_DOMAIN` merely because the source is governmental.

**Blocking for:** first real collection in Tanga. A wrong ward extent produces
false QA rejections of good field data, which damages collector trust and reputation
scores — and reputation scores are hard to un-damage.

---

## R-006 — Re-survey disagreement rate is a sales asset and a reputational liability

**Severity:** medium · **Phase noticed:** 0 · **Status:** open

The brief correctly identifies the independent re-survey disagreement rate as the most
valuable sales asset. It is also the number that, if it moves the wrong way, a
customer can cite in a dispute or a competitor can cite in a bid.

Two specific hazards:

1. **Selection bias.** If re-survey sampling is not genuinely random — if it
   over-samples easy features, or if mappers can tell which features are sampled —
   the published rate is not the true rate, and the discrepancy is discoverable by
   any customer who audits. Sampling must be server-side, unpredictable to the
   collector, and its methodology documented and versioned.
2. **Definition drift.** "Disagreement" needs a fixed, versioned definition per
   feature class before the first number is published. Changing the definition later
   makes the time series meaningless, and customers will have built expectations on
   it.

**Action:** version the accuracy methodology document alongside the confidence-score
formula, and treat both as published contracts, not internal notes.

---

## R-007 — Collector reputation scoring is a compensation mechanism and will be gamed

**Severity:** medium · **Phase noticed:** 0 · **Status:** open

Payment accrues per *accepted* observation, which correctly aligns incentives against
volume-spam. But it creates a second-order incentive: collectors optimise for
acceptance probability, not truth. Predictable failure modes include favouring easy,
low-dispute feature classes, avoiding ambiguous or hard-to-reach places, and — worst —
learning which attribute values reviewers accept and reporting those regardless of
observation.

The last one is invisible to every automated QA stage, because the data is internally
plausible. Only independent re-survey catches it, which makes re-survey sampling rate
a fraud control and not merely a quality metric.

**Design implications for Phase 3:** re-survey sampling should weight toward
collectors whose acceptance rate is anomalously high, not only toward random draw;
"hard" features need a rate premium so that avoiding them is not rational; and
reason codes must be granular enough to detect a collector converging on
reviewer preferences.

---

## R-008 — Consent capture for identifiable persons and private premises is unspecified

**Severity:** high · **Phase noticed:** 0 · **Status:** open

The data model carries `consent_ref` on observations involving identifiable persons or
private premises, satisfying the Personal Data Protection Act 2022 on the storage
side. What is not yet specified is the *process*: how a mapper obtains consent
standing at a gate, what they show the data subject, in what language, what is
recorded as evidence, and what happens when consent is refused or later withdrawn.

Withdrawal is the sharp edge. If consent is withdrawn after an observation has been
projected into a canonical feature and exported to a customer, we need a defined path
to erase the observation and its media, recompute the feature, and notify licensees —
without breaking the append-only audit chain.

**This is a legal and product design question, not only an engineering one, and it
blocks first real collection.** Engineering prerequisite: media deletion must be
possible without breaking content-addressed reference counting (ADR-0002), and
`audit_log` must be able to record an erasure as an event rather than by deleting
history.

---

## R-009 — Building footprints are one geometric operation away from a de-facto cadastre

**Severity:** critical · **Phase noticed:** 0 · **Status:** mitigated by CI guard

Prohibiting the words `parcel`, `plot`, `boundary`, and `owner` does not prevent the
prohibited *outcome*. A union of adjacent building footprints, a Voronoi tessellation
seeded on footprint centroids, or a concave hull over a cluster produces polygons that
partition land and will be read as boundary determination regardless of what the
column is called or what the export footer says.

The legal exposure does not depend on our labelling. It depends on what a customer can
reasonably do with what we ship.

**Mitigation:** `tools/vocabulary-guard.mjs` fails CI on tessellation and
dissolve-family PostGIS calls over feature geometry, alongside the banned nouns
(D-005). Footprints are typed as *structure extent*, never land extent, and no
attribute expresses land area.

**Residual risk:** a customer can perform these operations themselves on exported
data. The export disclaimer addresses this contractually, but contractual mitigation
is weaker than technical mitigation and should be reviewed by counsel before the
first commercial export in Phase 4.

---

## R-010 — Auto-generated data APIs are default-open, and their `anon` role is a published credential

**Severity:** critical · **Phase noticed:** 0 · **Status:** ACTIVE — mitigated in
depth in the database; two console settings still require manual verification

**Update history, all 2026-08-11:**

1. Raised against Supabase (D-009).
2. Went dormant when the platform moved to Railway (D-010), which generates no REST
   API and provisions no `anon`/`authenticated`/`service_role` roles.
3. **Active again** on the move back to Supabase (D-011).

Kept in full throughout rather than deleted at step 2 — and that judgement paid off
within hours. A platform change is precisely the circumstance under which a
"resolved" risk gets silently reintroduced, and the mitigation was still in the
migration when it became necessary again.

Supabase auto-generates a PostgREST API over the database. Tables created in `public`
receive SELECT/INSERT/UPDATE/DELETE for `anon`, `authenticated` and `service_role` by
default. The `anon` key is **published by design** — it ships inside client
applications.

If the canonical dataset ever becomes reachable by `anon`, it is free to anyone
holding the project URL. That is not a data breach in the usual sense; it is the
entire licensing business evaporating through a dashboard checkbox, silently, with no
code change and no code review.

The exposure paths are all mundane:

1. Someone adds `gt` to "Exposed schemas" in the dashboard to debug something.
2. Someone creates a table in `public` instead of `gt` — a one-word mistake.
3. "Automatically expose new tables" is left enabled, and the Phase 1 feature table
   inherits exposure at creation.

**Mitigations in place:**

- All our objects live in named schemas (`gt`, `reference`, `osm_reference`), never
  `public`. Named schemas are not exposed unless explicitly listed. This is the
  primary protection — and it is a dashboard setting, so it is not sufficient alone.
- Migration `1754870402000_supabase-hardening.sql` revokes all privileges on those
  three schemas from `anon`, `authenticated` and `service_role`, including
  `ALTER DEFAULT PRIVILEGES` so that tables not yet created inherit the revocation.
  Exposing a schema now yields an authenticated-but-unprivileged role and an empty
  API. The dashboard setting is no longer load-bearing.
- Migration `1754870400000` revokes PUBLIC's rights on the `public` schema.

**Outstanding:**

- "Automatically expose new tables" must be unchecked in project settings. This is a
  console action and cannot be asserted from a migration — verify it manually, and
  re-verify after any project setting change.
- No test currently proves the Data API returns nothing for `gt`. Worth adding in
  Phase 1 as an HTTP-level assertion against the project URL with the `anon` key,
  because that tests the thing customers could actually do rather than the thing we
  believe we configured.
- Supabase's `service_role` key bypasses RLS entirely. It must never be deployed to
  the collection app or the review console front end.

---

## R-011 — No hosting region near Tanzania, and production residency is undecided

**Severity:** high · **Phase noticed:** 0 · **Status:** open

The canonical database will hold GPS traces of named collectors, `consent_ref`
records, and imagery of private premises — all squarely within the Personal Data
Protection Act 2022. Whether hosting it outside Tanzania creates a cross-border
transfer obligation is a legal question that has not been answered.

**Confirmed 2026-08-11:** the active Supabase project (D-011) is in **eu-central-1,
Frankfurt**. Personal data collected in Tanzania would therefore be processed and
stored in Germany. Whether that is permissible, and under what safeguard, is a legal
question that has not been answered.

Neither candidate platform offers an African region: Supabase (current, D-011) and
Railway (D-010, superseded) are both US/EU-only. The brief's own instruction to keep
a self-hosted MinIO path open for data-residency requirements points at the same
unresolved question for object storage, where the imagery lives.

This is cheapest to answer **now**, while the database holds nothing but synthetic
Tanga fixtures and moving costs one `npm run migrate:up`. It becomes expensive after
first real collection, and worse after first customer delivery — at which point the
data is both irreplaceable and already disclosed.

**Action:** get a legal answer on permissible hosting locations for PDPA-scoped
personal data *before* Phase 2 puts real observations in the database. If the answer
forbids the current arrangement, the options are an in-country or nearest-region
managed Postgres, or self-hosting — all of which must still satisfy the ADR-0001
privilege requirements in D-010.

**Note:** this concerns *production* data only. Development against synthetic
fixtures raises none of it, so it does not block Phase 1.
