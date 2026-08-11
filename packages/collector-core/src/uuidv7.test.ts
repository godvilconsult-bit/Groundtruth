import { describe, it, expect } from 'vitest';
import { Uuidv7Generator, uuidv7, isUuidv7, timestampOf } from './uuidv7.js';

const fixed = (ms: number) => new Uuidv7Generator({ now: () => ms, random: () => 0.5 });

describe('format', () => {
  it('produces a well-formed v7 uuid', () => {
    expect(isUuidv7(uuidv7())).toBe(true);
  });

  it('sets the version nibble to 7', () => {
    expect(fixed(1_754_870_400_000).next()[14]).toBe('7');
  });

  it('sets the variant bits to 0b10', () => {
    const variant = fixed(1_754_870_400_000).next()[19];
    expect(['8', '9', 'a', 'b']).toContain(variant);
  });

  it('rejects a v4 uuid, so a regression to randomUUID is caught', () => {
    expect(isUuidv7('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe(false);
  });

  it.each([['not-a-uuid'], [''], [null], [42], [{}]])('rejects %p', (value) => {
    expect(isUuidv7(value)).toBe(false);
  });
});

describe('time ordering — the whole reason for choosing v7', () => {
  it('embeds the timestamp readably', () => {
    const ms = 1_754_870_400_123;
    expect(timestampOf(fixed(ms).next())).toBe(ms);
  });

  it('sorts lexicographically in capture order', () => {
    // This is the property the database index depends on: ids that sort by time
    // append to the index hot end instead of scattering across every page.
    let ms = 1_754_870_400_000;
    const generator = new Uuidv7Generator({ now: () => (ms += 1_000), random: () => 0.5 });
    const ids = Array.from({ length: 50 }, () => generator.next());
    expect([...ids].sort()).toEqual(ids);
  });

  it('keeps ordering across a full day of collection', () => {
    let ms = 1_754_870_400_000;
    const generator = new Uuidv7Generator({ now: () => (ms += 25_000), random: () => 0.5 });
    const ids = Array.from({ length: 200 }, () => generator.next());
    expect([...ids].sort()).toEqual(ids);
  });

  it('preserves ordering within a single millisecond', () => {
    // Routine when a form submits programmatically. Two ids in the same
    // millisecond must still order, or the index locality argument breaks down.
    const generator = fixed(1_754_870_400_000);
    const ids = Array.from({ length: 100 }, () => generator.next());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(100);
  });

  it('never issues a duplicate under a stopped clock', () => {
    const generator = fixed(1_754_870_400_000);
    const ids = new Set(Array.from({ length: 4096 }, () => generator.next()));
    expect(ids.size).toBe(4096);
  });

  it('survives counter exhaustion within one millisecond', () => {
    // 12 bits of counter is 4096 ids per millisecond. Beyond that it borrows from
    // the next millisecond rather than colliding.
    const generator = fixed(1_754_870_400_000);
    const ids = Array.from({ length: 5_000 }, () => generator.next());
    expect(new Set(ids).size).toBe(5_000);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('hostile clocks', () => {
  it('keeps ordering when the clock jumps backwards', () => {
    // Cheap Android hardware does this after an NTP correction, and users change
    // the time by hand. An id that sorts backwards would silently reorder a walk.
    const times = [1_754_870_400_000, 1_754_870_399_000, 1_754_870_398_000, 1_754_870_401_000];
    let i = 0;
    const generator = new Uuidv7Generator({ now: () => times[i++] ?? 0, random: () => 0.5 });
    const ids = times.map(() => generator.next());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(4);
  });

  it('rejects a non-finite clock rather than emitting a corrupt id', () => {
    const generator = new Uuidv7Generator({ now: () => Number.NaN, random: () => 0.5 });
    expect(() => generator.next()).toThrow(RangeError);
  });

  it('rejects a negative clock', () => {
    const generator = new Uuidv7Generator({ now: () => -1, random: () => 0.5 });
    expect(() => generator.next()).toThrow(RangeError);
  });

  it('rejects a random source outside [0,1)', () => {
    const generator = new Uuidv7Generator({ now: () => 1_754_870_400_000, random: () => 1 });
    expect(() => generator.next()).toThrow(RangeError);
  });
});

describe('uniqueness', () => {
  it('produces no collisions across a large batch with a real random source', () => {
    let ms = 1_754_870_400_000;
    const generator = new Uuidv7Generator({ now: () => (ms += 1) });
    const ids = new Set(Array.from({ length: 10_000 }, () => generator.next()));
    expect(ids.size).toBe(10_000);
  });

  it('produces distinct ids from independent generators at the same instant', () => {
    // Two devices, same millisecond. The 62 random bits carry this, not the counter.
    const a = new Uuidv7Generator({ now: () => 1_754_870_400_000 });
    const b = new Uuidv7Generator({ now: () => 1_754_870_400_000 });
    expect(a.next()).not.toBe(b.next());
  });
});

describe('timestampOf', () => {
  it('refuses a non-v7 id rather than returning a plausible number', () => {
    expect(() => timestampOf('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toThrow(TypeError);
  });
});
