/**
 * The daily data budget, enforced in code.
 *
 * A full day of collection must sync in under 15 MB. RISKS.md R-003 records why this
 * cannot be a guideline: a well-meaning "let's capture the signboard too" ticket
 * doubles data cost across the fleet, and nobody notices until an airtime invoice
 * arrives weeks later, by which point the habit is established.
 *
 * The governing rule, from ADR-0002: **degrade image quality before degrading
 * observation count.** Losing a photo is recoverable — the attributes, position and
 * timestamp still describe the place. Losing the visit is not: it means someone walks
 * that street again.
 */

/** 15 MB per collector per calendar day. */
export const DAILY_BYTE_BUDGET = 15 * 1024 * 1024;

/**
 * Reserve held back for attribute payloads, retractions and sync overhead.
 *
 * Imagery is elastic; the observation records themselves are not. If images were
 * allowed to consume the whole budget, the day's last observations would have no
 * room even for their attributes — the exact inversion of the rule above.
 */
export const NON_MEDIA_RESERVE_FRACTION = 0.15;

/**
 * Below this an image is not worth the bytes: too small to show a signboard,
 * a roof material, or a gate. Better to record the observation with no photo than
 * to spend budget on something a reviewer cannot use.
 */
export const MIN_VIABLE_IMAGE_BYTES = 15_000;

/** Never spend more than this on a single image, however much budget remains. */
export const MAX_IMAGE_BYTES = 90_000;

/** A local calendar day key. Budgets reset at local midnight, where the mapper is. */
export function dayKey(at: Date): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface BudgetSnapshot {
  readonly day: string;
  readonly limitBytes: number;
  readonly usedBytes: number;
  readonly remainingBytes: number;
  /** Fraction of the day's budget consumed, clamped to [0,1] for display. */
  readonly usedFraction: number;
}

/**
 * Tracks bytes consumed per local day.
 *
 * Deliberately holds no clock of its own: every method takes `now`. A budget that
 * reads the system clock cannot be tested across midnight, and midnight is exactly
 * where the interesting behaviour is.
 */
export class DailyByteBudget {
  #day: string;
  #used = 0;
  readonly #limit: number;

  constructor(now: Date, limitBytes: number = DAILY_BYTE_BUDGET) {
    if (!Number.isFinite(limitBytes) || limitBytes <= 0) {
      throw new RangeError('limitBytes must be a positive number');
    }
    this.#limit = limitBytes;
    this.#day = dayKey(now);
  }

  /** Roll over automatically when the local day changes. */
  #sync(now: Date): void {
    const today = dayKey(now);
    if (today !== this.#day) {
      this.#day = today;
      this.#used = 0;
    }
  }

  snapshot(now: Date): BudgetSnapshot {
    this.#sync(now);
    const remaining = Math.max(0, this.#limit - this.#used);
    return Object.freeze({
      day: this.#day,
      limitBytes: this.#limit,
      usedBytes: this.#used,
      remainingBytes: remaining,
      usedFraction: Math.min(1, this.#used / this.#limit),
    });
  }

  remainingBytes(now: Date): number {
    return this.snapshot(now).remainingBytes;
  }

  /** Record bytes actually sent. Negative or non-finite input is a caller bug. */
  record(bytes: number, now: Date): void {
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new RangeError('bytes must be a non-negative finite number');
    }
    this.#sync(now);
    this.#used += bytes;
  }

  /**
   * Restore persisted state across an app restart.
   *
   * Usage from earlier today must survive being killed by the OS — on a 2 GB device
   * that happens routinely, and a budget that resets on every restart is no budget.
   */
  restore(day: string, usedBytes: number): void {
    if (!Number.isFinite(usedBytes) || usedBytes < 0) {
      throw new RangeError('usedBytes must be a non-negative finite number');
    }
    this.#day = day;
    this.#used = usedBytes;
  }

  /**
   * Byte ceiling for the next image.
   *
   * Divides the media share of what remains across the observations still expected
   * today. Returns 0 when the share falls below what a usable image costs — meaning
   * *capture the observation without a photo*, never *skip the observation*.
   */
  imageBudgetFor(expectedRemainingObservations: number, now: Date): number {
    const remaining = this.remainingBytes(now);
    const mediaShare = remaining * (1 - NON_MEDIA_RESERVE_FRACTION);
    const observations = Math.max(1, Math.floor(expectedRemainingObservations));
    const perObservation = Math.floor(mediaShare / observations);

    if (perObservation < MIN_VIABLE_IMAGE_BYTES) return 0;
    return Math.min(perObservation, MAX_IMAGE_BYTES);
  }

  /**
   * Whether a payload of `bytes` still fits today.
   *
   * Callers must NOT use this to drop observations. An observation that does not fit
   * still gets queued — it simply waits for tomorrow's budget or an unmetered
   * connection. The budget governs when bytes are spent, never whether a visit is
   * recorded.
   */
  fits(bytes: number, now: Date): boolean {
    return bytes <= this.remainingBytes(now);
  }
}
