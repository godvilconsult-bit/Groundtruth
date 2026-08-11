import { describe, it, expect } from 'vitest';
import {
  backoffDelayMs,
  backoffCeilingMs,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  describeSyncState,
  type SyncState,
} from './backoff.js';

describe('backoff ceiling', () => {
  it('grows exponentially from the 2 s base', () => {
    expect(backoffCeilingMs(0)).toBe(BACKOFF_BASE_MS);
    expect(backoffCeilingMs(1)).toBe(BACKOFF_BASE_MS * 2);
    expect(backoffCeilingMs(3)).toBe(BACKOFF_BASE_MS * 8);
  });

  it('caps at 15 minutes', () => {
    expect(backoffCeilingMs(50)).toBe(BACKOFF_CAP_MS);
    expect(backoffCeilingMs(1000)).toBe(BACKOFF_CAP_MS);
  });

  it('never overflows into a nonsensical delay', () => {
    expect(Number.isFinite(backoffCeilingMs(2000))).toBe(true);
  });

  it('rejects a negative or fractional attempt', () => {
    expect(() => backoffCeilingMs(-1)).toThrow(RangeError);
    expect(() => backoffDelayMs(1.5)).toThrow(RangeError);
  });
});

describe('full jitter', () => {
  it('returns 0 at the bottom of the jitter window', () => {
    expect(backoffDelayMs(5, () => 0)).toBe(0);
  });

  it('stays below the ceiling at the top of the window', () => {
    const delay = backoffDelayMs(5, () => 0.999999);
    expect(delay).toBeLessThan(backoffCeilingMs(5));
  });

  it('spreads a synchronised cohort across the whole window', () => {
    // The scenario this exists for: a ward's mappers walk back into coverage at the
    // same tower at the same time. Undithered backoff would land them all on
    // identical retry instants and hammer the cell in lockstep.
    const cohort = Array.from({ length: 500 }, (_, i) =>
      backoffDelayMs(6, () => (i + 0.5) / 500),
    );
    const ceiling = backoffCeilingMs(6);
    const buckets = new Set(cohort.map((d) => Math.floor((d / ceiling) * 10)));
    // Every decile of the window should be occupied.
    expect(buckets.size).toBeGreaterThanOrEqual(9);
  });

  it('produces no two identical delays for distinct random draws', () => {
    const a = backoffDelayMs(8, () => 0.25);
    const b = backoffDelayMs(8, () => 0.75);
    expect(a).not.toBe(b);
  });

  it('never returns a negative delay', () => {
    for (const attempt of [0, 1, 5, 20, 30]) {
      expect(backoffDelayMs(attempt, () => 0)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('sync state is always visible', () => {
  const base: SyncState = {
    phase: 'IDLE',
    pendingItems: 0,
    pendingBytes: 0,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    nextAttemptAt: null,
    lastError: null,
  };

  it('confirms plainly when nothing is outstanding', () => {
    expect(describeSyncState(base, 'sw')).toBe('Kila kitu kimetumwa');
    expect(describeSyncState(base, 'en')).toBe('Everything sent');
  });

  it('always states the pending count, so nothing is left to guess', () => {
    // A mapper must never have to wonder whether a day's walking is safe.
    for (const phase of ['SYNCING', 'WAITING', 'OFFLINE', 'IDLE'] as const) {
      const state = { ...base, phase, pendingItems: 42 };
      expect(describeSyncState(state, 'en')).toContain('42');
      expect(describeSyncState(state, 'sw')).toContain('42');
    }
  });

  it('says the phone is holding the data when offline, not that something failed', () => {
    const state: SyncState = { ...base, phase: 'OFFLINE', pendingItems: 87 };
    expect(describeSyncState(state, 'sw')).toContain('zimehifadhiwa');
    expect(describeSyncState(state, 'en')).toContain('saved on device');
  });

  it('has a distinct Swahili string for every phase', () => {
    const phrases = (['SYNCING', 'WAITING', 'OFFLINE', 'IDLE'] as const).map((phase) =>
      describeSyncState({ ...base, phase, pendingItems: 3 }, 'sw'),
    );
    expect(new Set(phrases).size).toBe(phrases.length);
  });

  it('never falls back to English for a Swahili request', () => {
    for (const phase of ['SYNCING', 'WAITING', 'OFFLINE', 'IDLE'] as const) {
      const sw = describeSyncState({ ...base, phase, pendingItems: 5 }, 'sw');
      const en = describeSyncState({ ...base, phase, pendingItems: 5 }, 'en');
      expect(sw).not.toBe(en);
    }
  });
});
