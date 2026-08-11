import { describe, it, expect } from 'vitest';
import {
  DailyByteBudget,
  DAILY_BYTE_BUDGET,
  MIN_VIABLE_IMAGE_BYTES,
  MAX_IMAGE_BYTES,
  dayKey,
} from './byte-budget.js';

const morning = new Date('2026-08-11T06:00:00');
const evening = new Date('2026-08-11T18:00:00');
const nextDay = new Date('2026-08-12T06:00:00');

describe('daily budget', () => {
  it('starts with the full 15 MB', () => {
    const budget = new DailyByteBudget(morning);
    expect(budget.remainingBytes(morning)).toBe(DAILY_BYTE_BUDGET);
    expect(DAILY_BYTE_BUDGET).toBe(15 * 1024 * 1024);
  });

  it('decrements as bytes are recorded', () => {
    const budget = new DailyByteBudget(morning);
    budget.record(1_000_000, morning);
    expect(budget.remainingBytes(morning)).toBe(DAILY_BYTE_BUDGET - 1_000_000);
  });

  it('never reports negative remaining', () => {
    const budget = new DailyByteBudget(morning);
    budget.record(DAILY_BYTE_BUDGET * 2, morning);
    expect(budget.remainingBytes(morning)).toBe(0);
  });

  it('resets at local midnight', () => {
    const budget = new DailyByteBudget(morning);
    budget.record(DAILY_BYTE_BUDGET, evening);
    expect(budget.remainingBytes(evening)).toBe(0);
    expect(budget.remainingBytes(nextDay)).toBe(DAILY_BYTE_BUDGET);
  });

  it('uses the local day, since that is the day the mapper is working', () => {
    expect(dayKey(new Date('2026-08-11T23:59:00'))).toBe('2026-08-11');
    expect(dayKey(new Date('2026-08-12T00:01:00'))).toBe('2026-08-12');
  });

  it('survives an app restart via restore', () => {
    // On a 2 GB device the OS kills the app routinely. A budget that resets on
    // every restart is not a budget.
    const budget = new DailyByteBudget(morning);
    budget.restore('2026-08-11', 10 * 1024 * 1024);
    expect(budget.remainingBytes(evening)).toBe(DAILY_BYTE_BUDGET - 10 * 1024 * 1024);
  });

  it('discards restored usage from a previous day', () => {
    const budget = new DailyByteBudget(morning);
    budget.restore('2026-08-10', DAILY_BYTE_BUDGET);
    expect(budget.remainingBytes(morning)).toBe(DAILY_BYTE_BUDGET);
  });

  it('rejects nonsense input rather than silently corrupting the count', () => {
    const budget = new DailyByteBudget(morning);
    expect(() => budget.record(-1, morning)).toThrow(RangeError);
    expect(() => budget.record(Number.NaN, morning)).toThrow(RangeError);
    expect(() => new DailyByteBudget(morning, 0)).toThrow(RangeError);
  });

  it('reports a usable snapshot for the UI', () => {
    const budget = new DailyByteBudget(morning);
    budget.record(DAILY_BYTE_BUDGET / 2, morning);
    const snap = budget.snapshot(morning);
    expect(snap.usedFraction).toBeCloseTo(0.5, 3);
    expect(snap.day).toBe('2026-08-11');
    expect(Object.isFrozen(snap)).toBe(true);
  });
});

describe('image budget — degrade quality before losing a visit', () => {
  it('allows a usable image early in the day', () => {
    const budget = new DailyByteBudget(morning);
    const allowance = budget.imageBudgetFor(200, morning);
    expect(allowance).toBeGreaterThanOrEqual(MIN_VIABLE_IMAGE_BYTES);
    expect(allowance).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
  });

  it('matches the ~55-65 KB per observation that R-003 predicted', () => {
    const budget = new DailyByteBudget(morning);
    const allowance = budget.imageBudgetFor(200, morning);
    expect(allowance).toBeGreaterThan(50_000);
    expect(allowance).toBeLessThan(70_000);
  });

  it('shrinks the allowance as the budget is consumed', () => {
    const budget = new DailyByteBudget(morning);
    const fresh = budget.imageBudgetFor(100, morning);
    budget.record(DAILY_BYTE_BUDGET * 0.8, morning);
    const late = budget.imageBudgetFor(100, morning);
    expect(late).toBeLessThan(fresh);
  });

  it('caps a single image even when budget is plentiful', () => {
    const budget = new DailyByteBudget(morning);
    expect(budget.imageBudgetFor(1, morning)).toBe(MAX_IMAGE_BYTES);
  });

  it('returns 0 rather than a useless image when budget runs low', () => {
    // 0 means "record the observation with no photo" — never "skip the observation".
    const budget = new DailyByteBudget(morning);
    budget.record(DAILY_BYTE_BUDGET - 1000, morning);
    expect(budget.imageBudgetFor(50, morning)).toBe(0);
  });

  it('returns 0 when the budget is fully spent', () => {
    const budget = new DailyByteBudget(morning);
    budget.record(DAILY_BYTE_BUDGET, morning);
    expect(budget.imageBudgetFor(10, morning)).toBe(0);
  });

  it('handles an absurd or zero remaining-observation estimate', () => {
    const budget = new DailyByteBudget(morning);
    expect(budget.imageBudgetFor(0, morning)).toBe(MAX_IMAGE_BYTES);
    expect(budget.imageBudgetFor(-5, morning)).toBe(MAX_IMAGE_BYTES);
    expect(budget.imageBudgetFor(1_000_000, morning)).toBe(0);
  });

  it('reserves headroom so late observations can still send their attributes', () => {
    // Imagery is elastic; observation records are not. If images could consume the
    // whole budget, the day's last visits would have no room even for attributes.
    const budget = new DailyByteBudget(morning);
    const perImage = budget.imageBudgetFor(200, morning);
    expect(perImage * 200).toBeLessThan(DAILY_BYTE_BUDGET);
  });
});

describe('fits', () => {
  it('reports whether a payload fits today', () => {
    const budget = new DailyByteBudget(morning);
    expect(budget.fits(1_000, morning)).toBe(true);
    budget.record(DAILY_BYTE_BUDGET - 500, morning);
    expect(budget.fits(1_000, morning)).toBe(false);
    expect(budget.fits(400, morning)).toBe(true);
  });
});
