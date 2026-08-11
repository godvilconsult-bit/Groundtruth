/**
 * Capturing an observation, and correcting one.
 *
 * An observation is an immutable claim: *at time T, collector C standing at position
 * P with accuracy A recorded these attributes*. That claim is true or false on its
 * own terms, so it is never edited and never deleted (ADR-0002).
 *
 * A correction is therefore a new observation that RETRACTS an earlier one by id,
 * carrying a reason. The original survives, the audit trail survives, and a pattern
 * of retractions becomes a reputation signal rather than a silent rewrite. The
 * delete button in the UI writes one of these.
 */

import { Uuidv7Generator } from './uuidv7.js';
import type { Outbox } from './outbox.js';
import type { DailyByteBudget } from './byte-budget.js';

export interface Position {
  readonly lon: number;
  readonly lat: number;
  readonly accuracyM: number;
}

export interface CaptureInput {
  readonly featureClass: string;
  readonly specVersion: string;
  readonly position: Position;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly wardId: string;
  /** SHA-256 digests of blurred, re-encoded images already written to local store. */
  readonly mediaRefs?: readonly string[];
  /** Required where the observation involves identifiable persons or private premises. */
  readonly consentRef?: string | null;
}

export interface CapturedObservation {
  readonly id: string;
  readonly featureClass: string;
  readonly specVersion: string;
  readonly appVersion: string;
  readonly deviceId: string;
  readonly deviceSequence: number;
  readonly lon: number;
  readonly lat: number;
  readonly gpsAccuracyM: number;
  /** Device clock. Untrusted by the server; recorded because it is what we know. */
  readonly capturedAt: string;
  /** Monotonic, not user-settable. What makes ordering recoverable when the clock lies. */
  readonly monotonicMs: number;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly mediaRefs: readonly string[];
  readonly consentRef: string | null;
  readonly wardId: string;
  readonly retractsId: string | null;
  readonly retractionReason: string | null;
}

/** Persists the per-device sequence across restarts. */
export interface SequenceStore {
  next(deviceId: string): Promise<number>;
}

export class MemorySequenceStore implements SequenceStore {
  #value = 0;
  async next(): Promise<number> {
    this.#value += 1;
    return this.#value;
  }
}

export interface CaptureSessionOptions {
  readonly outbox: Outbox;
  readonly budget: DailyByteBudget;
  readonly sequences: SequenceStore;
  readonly deviceId: string;
  readonly appVersion: string;
  readonly clock?: () => Date;
  /** Monotonic elapsed milliseconds — `performance.now()` on device. Not wall time. */
  readonly monotonic?: () => number;
  readonly ids?: Uuidv7Generator;
}

/** Rough serialised size, for chunking and the daily byte budget. */
function estimateBytes(observation: CapturedObservation): number {
  return new TextEncoder().encode(JSON.stringify(observation)).length;
}

export class CaptureSession {
  readonly #outbox: Outbox;
  readonly #budget: DailyByteBudget;
  readonly #sequences: SequenceStore;
  readonly #deviceId: string;
  readonly #appVersion: string;
  readonly #clock: () => Date;
  readonly #monotonic: () => number;
  readonly #ids: Uuidv7Generator;

  constructor(options: CaptureSessionOptions) {
    this.#outbox = options.outbox;
    this.#budget = options.budget;
    this.#sequences = options.sequences;
    this.#deviceId = options.deviceId;
    this.#appVersion = options.appVersion;
    this.#clock = options.clock ?? (() => new Date());
    this.#monotonic = options.monotonic ?? (() => Date.now());
    this.#ids = options.ids ?? new Uuidv7Generator();
  }

  /**
   * Record an observation and queue it.
   *
   * Queueing is unconditional. The daily byte budget governs when bytes leave the
   * device, never whether a visit is recorded — an observation that does not fit
   * today waits for tomorrow rather than being refused (R-003).
   */
  async capture(input: CaptureInput): Promise<CapturedObservation> {
    this.#assertPosition(input.position);

    const now = this.#clock();
    const observation: CapturedObservation = Object.freeze({
      id: this.#ids.next(),
      featureClass: input.featureClass,
      specVersion: input.specVersion,
      appVersion: this.#appVersion,
      deviceId: this.#deviceId,
      deviceSequence: await this.#sequences.next(this.#deviceId),
      lon: input.position.lon,
      lat: input.position.lat,
      gpsAccuracyM: input.position.accuracyM,
      capturedAt: now.toISOString(),
      monotonicMs: this.#monotonic(),
      attributes: Object.freeze({ ...input.attributes }),
      mediaRefs: Object.freeze([...(input.mediaRefs ?? [])]),
      consentRef: input.consentRef ?? null,
      wardId: input.wardId,
      retractsId: null,
      retractionReason: null,
    });

    await this.#enqueue(observation, 'OBSERVATION', now);
    return observation;
  }

  /**
   * Correct an earlier observation.
   *
   * Writes a NEW observation that retracts the original. Nothing is deleted: the
   * original claim was still made, and the fact that it was withdrawn is itself
   * evidence — both for the audit trail and for collector reputation, where a
   * pattern of retractions means something.
   */
  async retract(args: {
    originalId: string;
    reason: string;
    /** Replacement attributes, when the mapper is correcting rather than withdrawing. */
    replacement?: CaptureInput;
  }): Promise<CapturedObservation> {
    if (!args.reason.trim()) {
      // An unexplained retraction is indistinguishable from data loss when someone
      // reviews the trail months later.
      throw new TypeError('a retraction must carry a reason');
    }

    const now = this.#clock();
    const source = args.replacement;

    if (source) this.#assertPosition(source.position);

    const observation: CapturedObservation = Object.freeze({
      id: this.#ids.next(),
      featureClass: source?.featureClass ?? '',
      specVersion: source?.specVersion ?? '',
      appVersion: this.#appVersion,
      deviceId: this.#deviceId,
      deviceSequence: await this.#sequences.next(this.#deviceId),
      lon: source?.position.lon ?? 0,
      lat: source?.position.lat ?? 0,
      gpsAccuracyM: source?.position.accuracyM ?? 0,
      capturedAt: now.toISOString(),
      monotonicMs: this.#monotonic(),
      attributes: Object.freeze({ ...(source?.attributes ?? {}) }),
      mediaRefs: Object.freeze([...(source?.mediaRefs ?? [])]),
      consentRef: source?.consentRef ?? null,
      wardId: source?.wardId ?? '',
      retractsId: args.originalId,
      retractionReason: args.reason,
    });

    await this.#enqueue(observation, 'RETRACTION', now);
    return observation;
  }

  async #enqueue(
    observation: CapturedObservation,
    kind: 'OBSERVATION' | 'RETRACTION',
    now: Date,
  ): Promise<void> {
    await this.#outbox.enqueue({
      id: observation.id,
      kind,
      byteSize: estimateBytes(observation),
      createdAt: now.getTime(),
    });

    // Media is queued separately and content-addressed, so an identical photo is
    // uploaded once however many observations reference it (ADR-0002).
    for (const digest of observation.mediaRefs) {
      await this.#outbox.enqueue({
        id: `media:${digest}`,
        kind: 'MEDIA',
        byteSize: 0,
        createdAt: now.getTime() + 1,
        observationId: observation.id,
      });
    }
  }

  #assertPosition(position: Position): void {
    const { lon, lat, accuracyM } = position;
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      throw new RangeError(`longitude out of range: ${lon}`);
    }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new RangeError(`latitude out of range: ${lat}`);
    }
    if (!Number.isFinite(accuracyM) || accuracyM <= 0) {
      // A non-positive accuracy means the fix is fabricated or the sensor is
      // broken. Recording it would let a QA stage treat a bogus position as
      // perfectly precise.
      throw new RangeError(`gps accuracy must be positive: ${accuracyM}`);
    }
  }

  /** Image byte ceiling for the next capture, given how much of the day remains. */
  imageBudget(expectedRemainingObservations: number): number {
    return this.#budget.imageBudgetFor(expectedRemainingObservations, this.#clock());
  }
}
