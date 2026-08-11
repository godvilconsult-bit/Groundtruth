/**
 * QA stage 3 — temporal plausibility.
 *
 * Reconstructs the walk and asks whether a human could have made it. The signal it
 * exists to catch is the one no other stage can see: a collector sitting somewhere
 * comfortable, entering plausible values for places they never visited. Fabricated
 * data is internally consistent by construction — but it is rarely consistent with
 * the PHYSICS of walking between the coordinates it claims.
 *
 * The device clock is untrusted throughout (ADR-0002). Ordering comes from
 * `deviceSequence`, which a user cannot wind back; the wall clock is corroborating
 * evidence, and disagreement between them is itself a signal.
 */

import { distanceMetres } from './geometric.js';
import {
  PASS,
  flag,
  reject,
  REASON,
  type QaObservation,
  type QaContext,
  type StageOutcome,
} from '../types.js';

/** Faster than this on foot between adjacent observations is not walking. */
export const WALKING_FLAG_MPS = 2.5;
/** Faster than a car in a dense ward. Physically possible only in a vehicle. */
export const VEHICLE_FLAG_MPS = 15;
/** Beyond this nothing terrestrial explains it: the positions or times are false. */
export const IMPOSSIBLE_MPS = 90;

/** Device clocks drift; beyond this the skew itself is worth recording. */
export const CLOCK_SKEW_FLAG_MS = 30 * 60 * 1000;

/** A capture claiming to be in the future is a wrong clock, by definition. */
export const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Minimum time to actually observe a place.
 *
 * Below this the mapper cannot have looked at a building and recorded its roof
 * material — they are advancing through a form. Not proof of fabrication, which is
 * why it flags rather than rejects: a second visit to a place already surveyed is
 * legitimately fast.
 */
export const MIN_DWELL_MS = 4_000;

export function temporalPlausibility(
  observation: QaObservation,
  context: QaContext,
): StageOutcome {
  if (observation.capturedAt > context.now + FUTURE_TOLERANCE_MS) {
    return flag(
      REASON.TIME_CAPTURE_IN_FUTURE,
      `captured_at is ${Math.round((observation.capturedAt - context.now) / 60_000)} min in the future`,
    );
  }

  // A repeated sequence number for one device means the client's monotonic counter
  // was reset or reused — a replayed batch, or a reinstall that lost its sequence
  // store. Server-side uniqueness rejects it, but QA should say WHY.
  const duplicate = context.track.find(
    (candidate) =>
      candidate.id !== observation.id &&
      candidate.deviceId === observation.deviceId &&
      candidate.deviceSequence === observation.deviceSequence,
  );
  if (duplicate) {
    return flag(
      REASON.TIME_SEQUENCE_DISORDERED,
      `sequence ${observation.deviceSequence} is reused by ${duplicate.id} on the same device`,
    );
  }

  const previous = previousInTrack(observation, context);
  if (previous) {
    const metres = distanceMetres(previous, observation);
    // Use the device clock for the interval: both endpoints share the same clock,
    // so a constant offset cancels. Only clock CHANGES between them distort this,
    // which the skew check below is for.
    const seconds = (observation.capturedAt - previous.capturedAt) / 1000;

    if (seconds <= 0) {
      return flag(
        REASON.TIME_SEQUENCE_DISORDERED,
        `no time elapsed between sequence ${previous.deviceSequence} and ${observation.deviceSequence}`,
      );
    }

    const speed = metres / seconds;

    if (speed > IMPOSSIBLE_MPS) {
      return reject(
        REASON.TIME_IMPOSSIBLE_SPEED,
        `${Math.round(speed)} m/s between consecutive observations — positions or times are false`,
      );
    }
    if (speed > VEHICLE_FLAG_MPS) {
      return flag(
        REASON.TIME_IMPLAUSIBLE_SPEED,
        `${Math.round(speed)} m/s implies a vehicle between observations`,
      );
    }
    if (speed > WALKING_FLAG_MPS && metres > 50) {
      return flag(
        REASON.TIME_IMPLAUSIBLE_SPEED,
        `${speed.toFixed(1)} m/s over ${Math.round(metres)} m is faster than walking`,
      );
    }

    if (seconds * 1000 < MIN_DWELL_MS && metres < 5) {
      return flag(
        REASON.TIME_DWELL_TOO_SHORT,
        `${Math.round(seconds * 1000)} ms at the same place — too fast to have observed it`,
      );
    }
  }

  // Batch-level skew, measured at ingest. A wrong clock is a device problem rather
  // than a collector problem, so it is recorded to correct the reconstructed
  // timeline — not held against whoever was carrying the phone.
  if (Math.abs(context.clockSkewMs) > CLOCK_SKEW_FLAG_MS) {
    return flag(
      REASON.TIME_CLOCK_SKEW_LARGE,
      `device clock differs from server by ~${Math.round(context.clockSkewMs / 60_000)} min for this batch`,
    );
  }

  return PASS;
}

/**
 * The preceding observation from the same device.
 *
 * Same device, not same collector: a collector may carry two handsets, and their
 * sequences are independent. Comparing across devices would manufacture impossible
 * speeds from perfectly ordinary work.
 */
function previousInTrack(
  observation: QaObservation,
  context: QaContext,
): QaObservation | null {
  let best: QaObservation | null = null;
  for (const candidate of context.track) {
    if (candidate.id === observation.id) continue;
    if (candidate.deviceId !== observation.deviceId) continue;
    if (candidate.deviceSequence >= observation.deviceSequence) continue;
    if (!best || candidate.deviceSequence > best.deviceSequence) best = candidate;
  }
  return best;
}
