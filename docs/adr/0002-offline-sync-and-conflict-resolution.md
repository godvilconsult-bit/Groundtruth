# ADR-0002: Offline Sync and Conflict Resolution Strategy

- **Status:** Accepted
- **Date:** 2026-08-11
- **Phase:** 0
- **Supersedes:** —

## Context

The collection app must run 8+ hours with zero connectivity, then sync. Target
hardware is Android 9 / 2 GB RAM on intermittent 2G/3G. A full collection day must
sync in under 15 MB. Nothing may be lost.

Most offline-first designs get hard here because they treat the client as holding a
*mutable replica* of server state. That forces last-writer-wins, vector clocks, or
CRDTs, and every one of those either loses data or ships merge semantics that field
staff cannot reason about.

## Decision

### The central insight: observations are immutable facts, not mutable rows

An `observation` is a claim: *"at time T, collector C standing at position P with
accuracy A recorded these attributes."* That claim is true or false on its own terms.
It is never edited and never overwritten, by anyone, ever.

This dissolves the sync conflict problem rather than solving it. Two mappers
recording the same gate produce two observations, both valid, neither in conflict.
Reconciliation — deciding what the *canonical feature* says — happens server-side in
the QA pipeline, with reputation weighting and human adjudication, where the domain
expertise and the audit trail live.

**Sync is therefore append-only replication of an immutable log.** There is no
write-write conflict, no merge function, no LWW, no CRDT. The client never mutates
server state; it only ever adds facts to it.

Corollaries, all of which fall out for free:

- **Retries are safe.** Re-sending an observation is idempotent by construction.
- **Corrections are new facts.** A mapper who realises they mistyped writes a
  *retraction* observation referencing the original by id, with a reason. The
  original is never deleted. The audit trail survives, and a pattern of retractions
  becomes a reputation signal.
- **There are no client deletes.** The delete button writes a retraction.
- **Ordering does not need to be preserved across the wire.** Each observation
  carries its own timestamps.

### Identity and idempotency

Observation ids are **client-generated UUIDv7**, minted at capture time on the phone.

- Client-generated, so the record has a stable identity from the moment it exists,
  before any server has seen it. Media, retractions, and local queue entries can
  reference it offline.
- **v7 rather than v4** because v7 is time-ordered. Random v4 keys on a B-tree
  primary index scatter inserts across the whole index, and a 200-row batch touches
  200 pages. v7 keys append to the index hot end. This matters at ingest scale and
  costs nothing to adopt now — retrofitting it after the table has millions of rows
  is a migration nobody wants.
- UUIDv7 embeds a device-clock millisecond. This is **not** trusted as a timestamp
  (see clock skew below); it is used only for index locality.

Server ingest is `INSERT ... ON CONFLICT (id) DO NOTHING`, returning the set of ids
accepted. A duplicate batch is a no-op that reports success. The client marks a
queue row synced only on explicit server acknowledgement of that id.

### Media: content-addressed, uploaded separately

Photographs dominate the byte budget and dominate failure probability on 2G.

- Media is addressed by **SHA-256 of the blurred, re-encoded bytes**. The observation
  row references the hash; it does not embed the image.
- Upload is a separate, resumable channel. The client asks `HEAD /media/{sha256}`
  first; an already-present blob is skipped entirely. This deduplicates the common
  case of the same signboard photographed twice, and makes an interrupted upload
  resumable at no extra bookkeeping cost.
- **Only blurred, re-encoded bytes are ever hashed or uploaded.** The raw camera
  buffer is blurred, re-encoded, and the original discarded before the file is
  written to disk. Raw imagery has no code path off the device — this is a
  Personal Data Protection Act 2022 requirement, not an optimisation.
- An observation is ingestible before its media arrives. Media completes
  asynchronously; QA stages requiring imagery wait on it.

### Chunking, ordering and the byte budget

- Observation batches are gzipped JSON, chunked at **64 KB**. This is
  small enough that a 2G connection dropping mid-chunk loses under a second of
  transfer, and large enough that per-request overhead stays under ~5%.
- JSON over a binary codec (protobuf/msgpack) for v1: after gzip, attribute payloads
  are a rounding error beside imagery, and JSON stays debuggable in the field where
  debugging is hardest. Revisit only if measurement shows the budget breached by
  non-media bytes.
- **The 15 MB/day budget is enforced in code, not documented as a guideline.** The
  client tracks cumulative bytes per calendar day and per sync batch, and the image
  encoder targets a per-observation byte ceiling derived from it. Exceeding the
  ceiling degrades image quality before it degrades observation count — losing a
  photo is recoverable, losing the visit is not.

### Clock skew

Device clocks on cheap Android hardware are unreliable and user-settable. Therefore:

- `captured_at` is device time and is **untrusted input**.
- Every observation also carries a **monotonic per-device sequence number** and the
  device's uptime-based elapsed clock, neither of which a user can wind back.
- `submitted_at` is server time and is trusted.
- The server records the observed skew per sync batch. QA stage 3 (temporal
  plausibility) uses the sequence number for *ordering* and the skew estimate to
  reconstruct a corrected capture time, then tests for impossible movement speeds
  between consecutive observations.

Ordering within a device is therefore always recoverable even when the wall clock is
nonsense. Ordering *between* devices is not, and is not needed.

### Backoff and connectivity

- Exponential backoff with full jitter: base 2 s, cap 15 min. Jitter is mandatory —
  a ward's worth of mappers regaining signal at the same tower simultaneously is the
  expected case, not the edge case.
- Sync is opportunistic and never blocks the UI. The app is fully functional with a
  permanently failing sync.
- Sync state is **always visible**: pending count, last successful sync, and current
  backoff state. A mapper must never have to guess whether their day's work is safe.
- Battery- and metered-connection-aware: bulk media upload defers to unmetered
  connections by default, with a manual override, and defers below a battery
  threshold.

### Downlink: ward packs

The client pulls a **ward pack**: MBTiles basemap + `feature_class_schema` bundle +
existing accepted features for the ward. Packs are versioned and fetched with
`ETag`/`If-None-Match`. Incremental updates use `changes-since` — the same delta
endpoint Phase 4 sells to customers, which means the mechanism is exercised daily by
our own client before a customer depends on it.

### Conflict surfacing

The one case needing user-visible handling: a mapper collects against a feature the
server has since superseded. The server never rejects the observation for this — the
fact is still a fact. On next sync the client is informed the referenced feature was
superseded, and surfaces it. The observation stands; QA reconciles. **The app never
silently discards or overwrites a mapper's work.**

## Consequences

**Accepted:**

- The observation table grows monotonically and never shrinks. Retractions add rows.
  This is the cost of an audit trail, and it is the right cost — but it means
  partitioning by `captured_at` becomes necessary earlier than table size alone would
  suggest. Planned for Phase 1's index design.
- Storage cost is higher than a mutable model. Cheap relative to re-walking Tanga.
- Reconciliation complexity moves server-side into QA, which is where we want it —
  it is the product (see the brief's asset ranking), and it is where we can change
  the rules without an app release.
- Client-generated ids mean a hostile client can attempt id collision. `ON CONFLICT
  DO NOTHING` makes this a denial of *its own* write, not a corruption of anyone
  else's. Ids are additionally namespaced by `device_id` in the audit trail.
- Content-addressed media means an identical photo submitted by two collectors is
  stored once, so media rows must be many-to-many with observations. Reference
  counting is required before any blob deletion.

**Rejected alternatives:**

- **CRDTs / vector clocks.** Solving a conflict problem we have designed out of
  existence. Substantial complexity, opaque semantics for reviewers.
- **Last-writer-wins on mutable rows.** Silently destroys field data. The single
  worst choice available here.
- **Server-assigned ids.** Requires connectivity at capture time. Non-starter.
- **Embedding media in the observation payload.** One failed upload loses the
  observation; no dedupe; no resumability.
