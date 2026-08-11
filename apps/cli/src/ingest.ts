/**
 * Ingest: synthetic observations in, canonical features out.
 *
 * The Phase 1 deliverable. This is the interfaces layer — it moves data between
 * PostgreSQL and the domain rules and contains no business rules of its own. Every
 * decision it appears to make (which observations describe one place, what a feature
 * is worth) is delegated to `@groundtruth/domain`.
 *
 * Phase 3 replaces the materialisation step below with the full seven-stage QA
 * pipeline. The seam is deliberate: this reads observations and writes features, and
 * a real pipeline does the same thing with more stages in between.
 */

import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  clusterObservations,
  computeConfidence,
  CONFIDENCE_FORMULA_VERSION,
  isExportable,
  type MatchCandidate,
} from '@groundtruth/domain';
import { SpecValidator, type FeatureClassSpec } from '@groundtruth/spec';
import { generateObservations, type SyntheticObservation } from './synthetic.js';

const CHUMBAGENI = '00000000-0000-4000-8000-000000000003';

export interface IngestOptions {
  readonly count: number;
  readonly collectors: number;
  readonly seed?: number;
  readonly batchSize?: number;
}

export interface IngestReport {
  readonly syncBatchId: string;
  readonly observationsInserted: number;
  readonly featuresCreated: number;
  readonly clustersFormed: number;
  readonly truePlaces: number;
  readonly acceptedFeatures: number;
  readonly meanConfidence: number;
  readonly auditRowsWritten: number;
  readonly schemaRejected: number;
  readonly elapsedMs: number;
}

/**
 * Load the LIVE specification from the database, not from the repo.
 *
 * ADR-0003: the spec is data. What the repo holds is what we intend to publish;
 * what `feature_class_schema` holds is what is actually in force. Validating against
 * the repo would let a server validate observations under a spec no client was ever
 * given.
 */
async function loadLiveValidator(client: pg.Client): Promise<SpecValidator> {
  const { rows } = await client.query(
    `SELECT feature_class, spec_version, major, minor, json_schema, ui_hints, min_app_version
       FROM gt.feature_class_schema
      WHERE retired_at IS NULL`,
  );
  const validator = new SpecValidator();
  for (const row of rows) {
    validator.register({
      featureClass: row.feature_class,
      major: row.major,
      minor: row.minor,
      minAppVersion: row.min_app_version,
      jsonSchema: row.json_schema,
      uiHints: row.ui_hints,
    } as FeatureClassSpec);
  }
  return validator;
}

export async function ingest(client: pg.Client, options: IngestOptions): Promise<IngestReport> {
  const started = Date.now();
  const batchSize = options.batchSize ?? 250;
  const syncBatchId = randomUUID();

  await client.query('SET search_path = gt, reference, extensions, public');
  // Attribute every audit row to this run rather than to a database login.
  await client.query("SELECT set_config('gt.actor', $1, false)", [`cli:ingest:${syncBatchId}`]);

  const generated = generateObservations(options);
  const collectorIds = await ensureCollectors(client, options.collectors);

  // QA stage 1 in embryo: schema validation against the spec version each
  // observation was collected under — never against the current one. Phase 3 moves
  // this into a BullMQ stage with per-stage metrics; the rule does not change.
  //
  // Rejected observations are dropped here rather than stored, because the Phase 1
  // ingest has no review queue to route them to. That is a deliberate Phase 1
  // limitation, not the eventual behaviour: an observation is a fact even when it
  // fails validation, and Phase 3 must persist it as FLAGGED for adjudication.
  const validator = await loadLiveValidator(client);
  const observations: SyntheticObservation[] = [];
  let schemaRejected = 0;
  for (const observation of generated) {
    const result = validator.validate(observation.specVersion, observation.rawAttributes);
    if (result.valid) observations.push(observation);
    else schemaRejected += 1;
  }

  const observationIds = await insertObservations(
    client, observations, collectorIds, syncBatchId, batchSize,
  );

  const materialised = await materialise(client, observations, observationIds, collectorIds);

  const audit = await client.query(
    `SELECT count(*)::int AS n FROM gt.audit_log
      WHERE actor = $1`,
    [`cli:ingest:${syncBatchId}`],
  );

  return {
    syncBatchId,
    observationsInserted: observationIds.length,
    featuresCreated: materialised.featuresCreated,
    clustersFormed: materialised.clusters,
    truePlaces: new Set(observations.map((o) => o.truePlaceId)).size,
    acceptedFeatures: materialised.accepted,
    meanConfidence: materialised.meanConfidence,
    auditRowsWritten: audit.rows[0].n as number,
    schemaRejected,
    elapsedMs: Date.now() - started,
  };
}

/** Reuse the ingest collectors across runs; reputations vary so evidence weighting bites. */
async function ensureCollectors(client: pg.Client, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const externalRef = `synthetic-collector-${i}`;
    // Spread across the competency range: trainees, average, proven.
    const quality = Number((0.35 + (i / Math.max(1, count - 1)) * 0.6).toFixed(3));
    const status = quality > 0.75 ? 'PROVEN' : 'TRAINEE';
    const { rows } = await client.query(
      `INSERT INTO gt.collector (external_ref, display_name, quality_score,
                                 competency_status, assigned_ward_id, payment_rate_minor)
       VALUES ($1, $2, $3, $4, $5, 50000)
       ON CONFLICT (external_ref) DO UPDATE SET quality_score = EXCLUDED.quality_score
       RETURNING id`,
      [externalRef, `Synthetic Collector ${i}`, quality, status, CHUMBAGENI],
    );
    ids.push(rows[0].id as string);
  }
  return ids;
}

/**
 * Insert observations in chunks, idempotently.
 *
 * ON CONFLICT DO NOTHING because observation ids are client-generated and a re-sent
 * batch must be a no-op that reports success, not a duplicate walk (ADR-0002).
 */
async function insertObservations(
  client: pg.Client,
  observations: readonly SyntheticObservation[],
  collectorIds: readonly string[],
  syncBatchId: string,
  batchSize: number,
): Promise<string[]> {
  const inserted: string[] = [];

  for (let start = 0; start < observations.length; start += batchSize) {
    const chunk = observations.slice(start, start + batchSize);
    const values: unknown[] = [];
    const tuples: string[] = [];

    // Ids are minted here and kept, never read back from RETURNING. PostgreSQL does
    // not guarantee RETURNING preserves the order of a multi-row VALUES list, so
    // zipping its output against the input array by index is unsound — it works
    // until one day it silently attaches observations to the wrong features.
    // Client-minted ids are the ADR-0002 design anyway: a record has a stable
    // identity from the moment it exists, before any server sees it.
    const chunkIds = chunk.map(() => randomUUID());

    chunk.forEach((o, i) => {
      const b = i * 12;
      tuples.push(
        `($${b + 1},$${b + 2},$${b + 3},$${b + 4},ST_GeomFromText($${b + 5},4326),` +
          `$${b + 6},$${b + 7},$${b + 8},'1.0.0',$${b + 9},$${b + 10},$${b + 11},$${b + 12})`,
      );
      values.push(
        chunkIds[i],
        collectorIds[o.collectorIndex],
        // Device identity is per run. Sequence numbers restart at 1 each run, and
        // (device_id, device_sequence) is unique — reusing a device id across runs
        // collides, which is the constraint correctly refusing to let a replayed
        // batch masquerade as a second walk. Each run is a distinct handset.
        `synthetic-${syncBatchId.slice(0, 8)}-${o.collectorIndex}`,
        o.featureClass,
        o.wkt,
        o.gpsAccuracyM,
        o.capturedAt,
        o.deviceSequence,
        o.specVersion,
        syncBatchId,
        CHUMBAGENI,
        JSON.stringify(o.rawAttributes),
      );
    });

    await client.query(
      `INSERT INTO gt.observation
         (id, collector_id, device_id, feature_class, geom, gps_accuracy_m,
          captured_at, device_sequence, app_version, spec_version, sync_batch_id,
          ward_id, raw_attributes)
       VALUES ${tuples.join(',')}
       ON CONFLICT (id) DO NOTHING`,
      values,
    );

    inserted.push(...chunkIds);
  }

  return inserted;
}

/**
 * Resolve observations into canonical features.
 *
 * Phase 1 scope: cluster by the domain matching rule, create one feature per cluster,
 * score it, and link its observations. The seven QA stages arrive in Phase 3 — until
 * then features are ACCEPTED only when the confidence formula supports it, so nothing
 * enters the canonical set unscored.
 */
async function materialise(
  client: pg.Client,
  observations: readonly SyntheticObservation[],
  observationIds: readonly string[],
  collectorIds: readonly string[],
): Promise<{ featuresCreated: number; clusters: number; accepted: number; meanConfidence: number }> {
  const reputations = new Map<string, number>();
  for (const { rows } of [await client.query('SELECT id, quality_score FROM gt.collector')]) {
    for (const r of rows) reputations.set(r.id as string, Number(r.quality_score));
  }

  const candidates: (MatchCandidate & { index: number })[] = observations.map((o, i) => ({
    id: observationIds[i] ?? `unsent-${i}`,
    featureClass: o.featureClass,
    lon: o.lon,
    lat: o.lat,
    gpsAccuracyM: o.gpsAccuracyM,
    index: i,
  }));

  const clusters = clusterObservations(candidates) as (MatchCandidate & { index: number })[][];

  // Resolve everything in memory first, then write in three bulk statements.
  //
  // The naive shape — INSERT feature, UPDATE observations, INSERT ledger, per
  // cluster — costs three network round trips per feature. Against a database in
  // another continent that is ~1,500 sequential round trips for a thousand
  // observations, and it dominated runtime completely (373 s) before this change.
  // Feature ids are minted client-side so the links can be built before any write.
  const plans: {
    featureId: string;
    observation: SyntheticObservation;
    status: 'ACCEPTED' | 'PENDING';
    confidence: number;
    independentObservations: number;
    firstSeen: Date;
    lastSeen: Date;
    memberIds: string[];
  }[] = [];

  let accepted = 0;
  let confidenceTotal = 0;

  for (const cluster of clusters) {
    const members = cluster.map((c) => ({ candidate: c, observation: observations[c.index]! }));
    const first = members[0]!.observation;

    // One opinion per collector, not per visit — the confidence contract.
    const distinctCollectors = new Set(members.map((m) => m.observation.collectorIndex));
    const collectorReputations = [...distinctCollectors].map(
      (idx) => reputations.get(collectorIds[idx] ?? '') ?? 0.5,
    );

    const bestAccuracy = Math.min(...members.map((m) => m.observation.gpsAccuracyM));
    const newest = Math.max(...members.map((m) => m.observation.capturedAt.getTime()));
    const daysSince = Math.max(0, (Date.now() - newest) / 86_400_000);

    const confidence = computeConfidence({
      collectorReputations,
      bestGpsAccuracyM: bestAccuracy,
      daysSinceLastVerified: daysSince,
      resurvey: null,
    });

    // ADR-0001 layer 4: nothing enters the canonical set unless its provenance is
    // cleared for export. Synthetic data is FIELD_COLLECTED, but the guard runs
    // regardless — a guard that only runs on suspicious input is not a guard.
    if (!isExportable('FIELD_COLLECTED')) {
      throw new Error('provenance guard rejected FIELD_COLLECTED — refusing to ingest');
    }

    // A feature is ACCEPTED only with meaningful evidence behind it. Below that it
    // is retained as PENDING for QA rather than discarded: the observation is still
    // a fact, it is simply not yet a product.
    const status = confidence.score >= 0.5 ? 'ACCEPTED' : 'PENDING';

    plans.push({
      featureId: randomUUID(),
      observation: first,
      status,
      confidence: confidence.score,
      independentObservations: distinctCollectors.size,
      firstSeen: new Date(Math.min(...members.map((m) => m.observation.capturedAt.getTime()))),
      lastSeen: new Date(newest),
      memberIds: members.map((m) => m.candidate.id).filter((id) => !id.startsWith('unsent-')),
    });

    confidenceTotal += confidence.score;
    if (status === 'ACCEPTED') accepted += 1;
  }

  // One transaction: a half-materialised batch is worse than none, because the
  // observations look processed while their features do not exist.
  await client.query('BEGIN');
  try {
    const CHUNK = 200;

    for (let start = 0; start < plans.length; start += CHUNK) {
      const chunk = plans.slice(start, start + CHUNK);
      const values: unknown[] = [];
      const tuples: string[] = [];

      chunk.forEach((p, i) => {
        const b = i * 10;
        tuples.push(
          `($${b + 1},$${b + 2},ST_GeomFromText($${b + 3},4326),$${b + 4},` +
            `'FIELD_COLLECTED',$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10})`,
        );
        values.push(
          p.featureId,
          p.observation.featureClass,
          p.observation.wkt,
          JSON.stringify({
            ...p.observation.rawAttributes,
            confidence_formula_version: CONFIDENCE_FORMULA_VERSION,
            independent_observations: p.independentObservations,
          }),
          p.confidence,
          p.status,
          p.firstSeen,
          p.lastSeen,
          p.observation.specVersion,
          CHUMBAGENI,
        );
      });

      await client.query(
        `INSERT INTO gt.feature
           (id, feature_class, geom, attributes, provenance, confidence_score, status,
            first_observed_at, last_verified_at, spec_version, ward_id)
         VALUES ${tuples.join(',')}`,
        values,
      );

      // Link observations to their feature in one statement per chunk.
      const linkValues: unknown[] = [];
      const linkTuples: string[] = [];
      let n = 0;
      for (const p of chunk) {
        for (const obsId of p.memberIds) {
          linkTuples.push(`($${n + 1}::uuid,$${n + 2}::uuid,$${n + 3}::public.observation_qa_status)`);
          linkValues.push(obsId, p.featureId, p.status);
          n += 3;
        }
      }
      if (linkTuples.length > 0) {
        await client.query(
          `UPDATE gt.observation o
              SET feature_id = v.feature_id, qa_status = v.qa
             FROM (VALUES ${linkTuples.join(',')}) AS v(obs_id, feature_id, qa)
            WHERE o.id = v.obs_id`,
          linkValues,
        );
      }
    }

    // Payment accrues on ACCEPTANCE only, never on submission. One statement for
    // the whole batch; the partial unique index makes a retry a no-op.
    const acceptedObservationIds = plans
      .filter((p) => p.status === 'ACCEPTED')
      .flatMap((p) => p.memberIds);

    if (acceptedObservationIds.length > 0) {
      await client.query(
        `INSERT INTO gt.payment_ledger (collector_id, observation_id, amount_minor, reason)
         SELECT o.collector_id, o.id, c.payment_rate_minor, 'OBSERVATION_ACCEPTED'
           FROM gt.observation o
           JOIN gt.collector c ON c.id = o.collector_id
          WHERE o.id = ANY($1)
         ON CONFLICT (observation_id) WHERE reason = 'OBSERVATION_ACCEPTED' DO NOTHING`,
        [acceptedObservationIds],
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }

  return {
    featuresCreated: plans.length,
    clusters: clusters.length,
    accepted,
    meanConfidence: plans.length === 0 ? 0 : Number((confidenceTotal / plans.length).toFixed(3)),
  };
}
