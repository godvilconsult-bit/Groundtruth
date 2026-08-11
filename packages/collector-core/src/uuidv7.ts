/**
 * UUIDv7 — time-ordered identifiers, minted on the device at capture time.
 *
 * ADR-0002 requires v7 rather than v4, and the reason is a database one. Random v4
 * keys scatter inserts across the whole primary-key index, so a 200-row sync batch
 * touches 200 index pages. v7 keys sort by time and append to the index hot end.
 * The cost of adopting it now is nothing; retrofitting it after the observation
 * table has millions of rows is a migration nobody wants.
 *
 * Layout (RFC 9562):
 *
 *   48 bits  unix timestamp, milliseconds
 *    4 bits  version (7)
 *   12 bits  counter, for ordering within a single millisecond
 *    2 bits  variant (0b10)
 *   62 bits  random
 *
 * The embedded timestamp is NOT trusted as evidence of when something happened —
 * device clocks are user-settable and treated as untrusted input everywhere else in
 * this system. It exists for index locality. `captured_at` and `device_sequence`
 * carry the temporal claims, and QA validates them.
 */

/** 12 bits of counter space within a millisecond. */
const COUNTER_MAX = 0xfff;

export interface Uuidv7Options {
  /** Injected so ordering and collision behaviour can be tested, not trusted. */
  readonly now?: () => number;
  /** Fills the 62 random bits. Must produce values in [0,1). */
  readonly random?: () => number;
}

/**
 * A generator rather than a bare function, because monotonicity within a
 * millisecond requires state. Two observations captured in the same millisecond —
 * routine when a form is submitted programmatically — must still order correctly.
 */
export class Uuidv7Generator {
  readonly #now: () => number;
  readonly #random: () => number;
  #lastMs = -1;
  #counter = 0;

  constructor(options: Uuidv7Options = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#random = options.random ?? Math.random;
  }

  next(): string {
    let ms = this.#now();

    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError('clock produced a non-finite or negative timestamp');
    }
    ms = Math.floor(ms);

    if (ms > this.#lastMs) {
      this.#lastMs = ms;
      this.#counter = 0;
    } else {
      // Same millisecond, or the clock went backwards — which happens on cheap
      // hardware after an NTP correction or a user changing the time. Either way,
      // keep issuing ids that sort after the previous one rather than emitting a
      // duplicate or an id that sorts backwards.
      this.#counter += 1;
      if (this.#counter > COUNTER_MAX) {
        // Counter space exhausted within one millisecond: borrow from the next.
        this.#lastMs += 1;
        this.#counter = 0;
      }
      ms = this.#lastMs;
    }

    return this.#format(ms, this.#counter);
  }

  #format(ms: number, counter: number): string {
    const hex: string[] = [];

    // 48-bit timestamp, big-endian.
    const timeHigh = Math.floor(ms / 2 ** 32) & 0xffff;
    const timeLow = ms >>> 0;
    hex.push(timeHigh.toString(16).padStart(4, '0'));
    hex.push(timeLow.toString(16).padStart(8, '0'));

    // Version 7 + 12-bit counter.
    hex.push((0x7000 | (counter & COUNTER_MAX)).toString(16).padStart(4, '0'));

    // Variant 0b10 + 14 random bits.
    const variantChunk = 0x8000 | (this.#randomBits(14) & 0x3fff);
    hex.push(variantChunk.toString(16).padStart(4, '0'));

    // Remaining 48 random bits.
    const tailHigh = this.#randomBits(24);
    const tailLow = this.#randomBits(24);
    hex.push(tailHigh.toString(16).padStart(6, '0') + tailLow.toString(16).padStart(6, '0'));

    const raw = hex.join('');
    return [
      raw.slice(0, 8),
      raw.slice(8, 12),
      raw.slice(12, 16),
      raw.slice(16, 20),
      raw.slice(20, 32),
    ].join('-');
  }

  #randomBits(bits: number): number {
    const value = this.#random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new RangeError('random source must produce values in [0,1)');
    }
    return Math.floor(value * 2 ** bits);
  }
}

const shared = new Uuidv7Generator();

/** Mint an id using the shared generator. */
export function uuidv7(): string {
  return shared.next();
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** True for a well-formed v7 uuid with the correct version and variant bits. */
export function isUuidv7(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Read the embedded timestamp.
 *
 * For diagnostics and index reasoning only. Never use this as evidence of when an
 * observation was captured: the device clock is untrusted input.
 */
export function timestampOf(id: string): number {
  if (!isUuidv7(id)) throw new TypeError(`not a uuidv7: ${id}`);
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}
