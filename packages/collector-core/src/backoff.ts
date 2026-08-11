/**
 * Retry pacing for sync.
 *
 * Exponential backoff with **full jitter**, base 2 s, cap 15 minutes (ADR-0002).
 *
 * The jitter is not a refinement. A ward's mappers regain signal at the same tower
 * at the same time — walking back into coverage together at the end of a shift is
 * the expected case, not an edge case. Undithered exponential backoff synchronises
 * that whole cohort onto identical retry instants, and they then hammer the same
 * cell and the same API in lockstep. Full jitter spreads them across the interval.
 */

export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_CAP_MS = 15 * 60 * 1_000;

/** Beyond this, `2^attempt` overflows into meaninglessness; the cap applies anyway. */
const MAX_MEANINGFUL_ATTEMPT = 30;

/**
 * Delay before retry number `attempt` (0-based: 0 is the first retry).
 *
 * Full jitter: uniform in `[0, min(cap, base * 2^attempt))`. Chosen over
 * equal-jitter or decorrelated jitter because it gives the widest spread for a
 * synchronised cohort, and because it is trivial to reason about when a mapper asks
 * why the app has not retried yet.
 *
 * `random` is injected so the distribution can be tested rather than trusted.
 */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new RangeError('attempt must be a non-negative integer');
  }
  const exponent = Math.min(attempt, MAX_MEANINGFUL_ATTEMPT);
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** exponent);
  return Math.floor(random() * ceiling);
}

/** Upper bound of the jitter window for `attempt`, useful for UI and for tests. */
export function backoffCeilingMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new RangeError('attempt must be a non-negative integer');
  }
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempt, MAX_MEANINGFUL_ATTEMPT));
}

export type SyncPhase = 'IDLE' | 'SYNCING' | 'WAITING' | 'OFFLINE';

export interface SyncState {
  readonly phase: SyncPhase;
  readonly pendingItems: number;
  readonly pendingBytes: number;
  readonly lastSuccessAt: number | null;
  readonly consecutiveFailures: number;
  /** When the next attempt is due, for a visible countdown. */
  readonly nextAttemptAt: number | null;
  readonly lastError: string | null;
}

/**
 * Sync state must be visible at all times (ADR-0002).
 *
 * A mapper must never have to guess whether a day's walking is safe. This shape is
 * what the UI renders; it deliberately includes `nextAttemptAt` so the app can show
 * a countdown rather than an opaque spinner, and `pendingItems` so "nothing is lost"
 * is a number the mapper can watch reach zero.
 */
export function describeSyncState(state: SyncState, locale: 'sw' | 'en'): string {
  const sw = locale === 'sw';
  if (state.pendingItems === 0) {
    return sw ? 'Kila kitu kimetumwa' : 'Everything sent';
  }
  switch (state.phase) {
    case 'SYNCING':
      return sw
        ? `Inatuma… ${state.pendingItems} zimebaki`
        : `Sending… ${state.pendingItems} remaining`;
    case 'WAITING':
      return sw
        ? `${state.pendingItems} zinasubiri kutumwa`
        : `${state.pendingItems} waiting to send`;
    case 'OFFLINE':
      return sw
        ? `Hakuna mtandao — ${state.pendingItems} zimehifadhiwa`
        : `No network — ${state.pendingItems} saved on device`;
    case 'IDLE':
    default:
      return sw
        ? `${state.pendingItems} hazijatumwa`
        : `${state.pendingItems} not yet sent`;
  }
}
