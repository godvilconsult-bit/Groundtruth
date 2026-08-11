/**
 * Run the QA pipeline over pending observations.
 *
 * The interfaces layer for Phase 3: loads what the pipeline needs from PostgreSQL,
 * runs pure decision logic, and writes the verdicts back. It decides nothing itself.
 *
 * Phase 3's worker layer wraps this in BullMQ jobs with per-stage metrics. The
 * decomposition is deliberate — the rules are already exhaustively tested without a
 * queue, so the queue only has to schedule them.
 */

import type pg from 'pg';
import {
  QaPipeline,
  stage,
  geometricPlausibility,
  temporalPlausibility,
  reputationRouting,
  resurveySelection,
  type QaObservation,
  type QaContext,
  type CollectorProfile,
  type WardEnvelope,
  type PipelineResult,
  type PipelineMetrics,
} from '@groundtruth/qa';

export const PIPELINE_VERSION = 'qa@1.0';

export interface QaRunReport {
  readonly evaluated: number;
  readonly passed: number;
  readonly flagged: number;
  readonly rejected: number;
  readonly selectedForResurvey: number;
  readonly metrics: PipelineMetrics;
  readonly elapsedMs: number;
}

function buildPipeline(): QaPipeline {
  return new QaPipeline([
    stage('geometric-plausibility', geometricPlausibility),
    stage('temporal-plausibility', temporalPlausibility),
    stage('reputation-routing', reputationRouting),
    stage('resurvey-sampling', resurveySelection),
  ]);
}

/** Ward extents as envelopes. Operational geofences only (DECISIONS D-004). */
async function loadWards(client: pg.Client): Promise<Map<string, WardEnvelope>> {
  const { rows } = await client.query(
    `SELECT id,
            ST_XMin(geom::geometry) AS min_lon, ST_XMax(geom::geometry) AS max_lon,
            ST_YMin(geom::geometry) AS min_lat, ST_YMax(geom::geometry) AS max_lat,
            is_authoritative
       FROM reference.admin_area
      WHERE level = 'WARD'`,
  );
  return new Map(
    rows.map((r) => [
      r.id as string,
      {
        wardId: r.id as string,
        minLon: Number(r.min_lon),
        maxLon: Number(r.max_lon),
        minLat: Number(r.min_lat),
        maxLat: Number(r.max_lat),
        isAuthoritative: r.is_authoritative as boolean,
      },
    ]),
  );
}

/**
 * Collector standing, read from the derived view.
 *
 * The view rather than stored columns, so the acceptance rate cannot drift out of
 * step with the observations it is computed from.
 */
async function loadCollectors(client: pg.Client): Promise<Map<string, CollectorProfile>> {
  const { rows } = await client.query(
    `SELECT collector_id, competency_status, quality_score, total_accepted, acceptance_rate
       FROM gt.collector_standing`,
  );
  return new Map(
    rows.map((r) => [
      r.collector_id as string,
      {
        id: r.collector_id as string,
        competency: r.competency_status as CollectorProfile['competency'],
        qualityScore: Number(r.quality_score),
        acceptanceRate: r.acceptance_rate === null ? null : Number(r.acceptance_rate),
        totalAccepted: Number(r.total_accepted),
      },
    ]),
  );
}

interface Row {
  id: string;
  collector_id: string;
  device_id: string;
  feature_class: string;
  spec_version: string;
  provenance: string;
  lon: number;
  lat: number;
  geometry_type: string;
  gps_accuracy_m: string;
  captured_at: Date;
  submitted_at: Date;
  device_sequence: string;
  raw_attributes: Record<string, unknown>;
  ward_id: string | null;
  media_refs: string[];
  consent_ref: string | null;
  sync_batch_id: string;
}

function toObservation(row: Row): QaObservation {
  return {
    id: row.id,
    collectorId: row.collector_id,
    deviceId: row.device_id,
    featureClass: row.feature_class as QaObservation['featureClass'],
    specVersion: row.spec_version,
    provenance: row.provenance as QaObservation['provenance'],
    lon: Number(row.lon),
    lat: Number(row.lat),
    geometryType: row.geometry_type,
    gpsAccuracyM: Number(row.gps_accuracy_m),
    capturedAt: row.captured_at.getTime(),
    submittedAt: row.submitted_at.getTime(),
    deviceSequence: Number(row.device_sequence),
    attributes: row.raw_attributes,
    wardId: row.ward_id,
    mediaRefs: row.media_refs ?? [],
    consentRef: row.consent_ref,
  };
}

/**
 * Evaluate every PENDING observation.
 *
 * Tracks are assembled per (collector, device) so temporal checks compare a walk
 * against itself. Comparing across devices would manufacture impossible speeds from
 * a collector legitimately carrying two handsets.
 */
export async function runQa(
  client: pg.Client,
  options: { limit?: number; now?: Date } = {},
): Promise<QaRunReport> {
  const started = Date.now();
  const now = options.now ?? new Date();
  const limit = options.limit ?? 5_000;

  await client.query('SET search_path = gt, reference, extensions, public');
  await client.query("SELECT set_config('gt.actor', $1, false)", [`cli:qa:${PIPELINE_VERSION}`]);

  const [wards, collectors] = await Promise.all([loadWards(client), loadCollectors(client)]);

  const { rows } = await client.query(
    `SELECT id, collector_id, device_id, feature_class::text, spec_version,
            provenance::text, ST_X(ST_Centroid(geom)) AS lon, ST_Y(ST_Centroid(geom)) AS lat,
            GeometryType(geom) AS geometry_type, gps_accuracy_m, captured_at, submitted_at,
            device_sequence, raw_attributes, ward_id, media_refs::text[], consent_ref,
            sync_batch_id
       FROM gt.observation
      WHERE qa_status = 'PENDING'
      ORDER BY collector_id, device_id, device_sequence
      LIMIT $1`,
    [limit],
  );

  const observations = (rows as Row[]).map(toObservation);

  // Group into tracks: one walk per device.
  const tracks = new Map<string, QaObservation[]>();
  for (const observation of observations) {
    const key = `${observation.collectorId}:${observation.deviceId}`;
    const track = tracks.get(key) ?? [];
    track.push(observation);
    tracks.set(key, track);
  }

  const pipeline = buildPipeline();
  const results: PipelineResult[] = [];

  for (const observation of observations) {
    const collector = collectors.get(observation.collectorId);
    if (!collector) continue;

    const context: QaContext = {
      now: now.getTime(),
      collector,
      ward: observation.wardId ? (wards.get(observation.wardId) ?? null) : null,
      track: tracks.get(`${observation.collectorId}:${observation.deviceId}`) ?? [],
      // Batch-level skew. Synthetic ingest has none; a real client reports its
      // clock at submission and ingest computes the difference (ADR-0002).
      clockSkewMs: 0,
      random: Math.random,
    };

    results.push(pipeline.run(observation, context));
  }

  await persist(client, results);

  const metrics = pipeline.metrics();
  return {
    evaluated: results.length,
    passed: results.filter((r) => r.verdict === 'PASS').length,
    flagged: results.filter((r) => r.verdict === 'FLAG').length,
    rejected: results.filter((r) => r.verdict === 'REJECT').length,
    selectedForResurvey: results.filter((r) => r.selectedForResurvey).length,
    metrics,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Write verdicts and update observation status, in one transaction.
 *
 * A half-applied QA run is worse than none: observations would carry a status with
 * no verdict explaining it, and the next run would skip them as already judged.
 */
async function persist(client: pg.Client, results: readonly PipelineResult[]): Promise<void> {
  if (results.length === 0) return;

  await client.query('BEGIN');
  try {
    const CHUNK = 200;
    for (let start = 0; start < results.length; start += CHUNK) {
      const chunk = results.slice(start, start + CHUNK);

      const values: unknown[] = [];
      const tuples: string[] = [];
      chunk.forEach((result, i) => {
        const b = i * 6;
        tuples.push(
          `($${b + 1}::uuid,$${b + 2}::public.qa_verdict,$${b + 3}::text[],$${b + 4}::jsonb,$${b + 5},$${b + 6})`,
        );
        values.push(
          result.observationId,
          result.verdict,
          result.reasonCodes,
          JSON.stringify(result.stages),
          PIPELINE_VERSION,
          result.selectedForResurvey,
        );
      });

      await client.query(
        `INSERT INTO gt.qa_verdict
           (observation_id, verdict, reason_codes, stage_records, pipeline_version,
            selected_for_resurvey)
         VALUES ${tuples.join(',')}`,
        values,
      );

      // A FLAG becomes FLAGGED rather than REJECTED: the observation is retained
      // for adjudication, because an observation is a fact even when it fails a
      // check. Nothing is discarded here.
      const statusValues: unknown[] = [];
      const statusTuples: string[] = [];
      chunk.forEach((result, i) => {
        const b = i * 2;
        statusTuples.push(`($${b + 1}::uuid,$${b + 2}::public.observation_qa_status)`);
        statusValues.push(
          result.observationId,
          result.verdict === 'PASS' ? 'ACCEPTED' : result.verdict === 'FLAG' ? 'FLAGGED' : 'REJECTED',
        );
      });

      await client.query(
        `UPDATE gt.observation o
            SET qa_status = v.status
           FROM (VALUES ${statusTuples.join(',')}) AS v(id, status)
          WHERE o.id = v.id`,
        statusValues,
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
