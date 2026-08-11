/**
 * The outbox: everything captured but not yet acknowledged by the server.
 *
 * This is where "eight hours offline, nothing lost" is actually enforced, so its
 * rules are deliberately severe:
 *
 *   - An item leaves the outbox on **explicit server acknowledgement only**. Not on
 *     a 2xx with an ambiguous body, not on a timeout, not on a crash, and never on
 *     an error path.
 *   - A failed send returns the item to PENDING. Nothing is discarded because it
 *     failed repeatedly — a permanently failing item is a bug to surface, not data
 *     to drop.
 *   - Enqueue is idempotent by client-generated id (ADR-0002), so a double-tap or a
 *     replayed capture cannot duplicate a walk.
 *
 * Storage is a port. The queue's rules must hold identically over IndexedDB, OPFS,
 * or SQLite, and must be testable without any of them.
 */

export type OutboxItemKind = 'OBSERVATION' | 'MEDIA' | 'RETRACTION';

/**
 * PENDING → IN_FLIGHT → (acknowledged, removed) or back to PENDING.
 *
 * There is no FAILED terminal state, deliberately. A terminal failure state is a
 * bin, and bins get emptied.
 */
export type OutboxItemState = 'PENDING' | 'IN_FLIGHT';

export interface OutboxItem {
  /** Client-generated; the idempotency key end to end. */
  readonly id: string;
  readonly kind: OutboxItemKind;
  /** Serialised size, used for chunking and for the daily budget. */
  readonly byteSize: number;
  readonly createdAt: number;
  readonly state: OutboxItemState;
  readonly attempts: number;
  readonly lastError: string | null;
  /** MEDIA items reference their observation so ordering can be preserved. */
  readonly observationId: string | null;
}

/** Persistence port. Implemented by IndexedDB/OPFS on device, in memory in tests. */
export interface OutboxStore {
  get(id: string): Promise<OutboxItem | undefined>;
  put(item: OutboxItem): Promise<void>;
  delete(id: string): Promise<void>;
  /** All items, oldest first by createdAt. */
  list(): Promise<OutboxItem[]>;
}

export class MemoryOutboxStore implements OutboxStore {
  readonly #items = new Map<string, OutboxItem>();

  async get(id: string): Promise<OutboxItem | undefined> {
    return this.#items.get(id);
  }

  async put(item: OutboxItem): Promise<void> {
    this.#items.set(item.id, item);
  }

  async delete(id: string): Promise<void> {
    this.#items.delete(id);
  }

  async list(): Promise<OutboxItem[]> {
    return [...this.#items.values()].sort(
      (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
    );
  }
}

export interface EnqueueInput {
  readonly id: string;
  readonly kind: OutboxItemKind;
  readonly byteSize: number;
  readonly createdAt: number;
  readonly observationId?: string | null;
}

export interface ClaimOptions {
  /** Chunk ceiling. 64 KB by default: a 2G drop mid-chunk loses under a second. */
  readonly maxBytes?: number;
  readonly maxItems?: number;
  /**
   * Restrict to certain kinds.
   *
   * Used to defer MEDIA on a metered connection while still sending observations:
   * the attributes, position and timestamp are the irreplaceable part, and they are
   * small. A photo can wait for wifi; a visit cannot wait at all.
   */
  readonly kinds?: readonly OutboxItemKind[];
}

/** 64 KB — small enough that a dropped 2G connection wastes little, large enough
 * that per-request overhead stays around 5%. */
export const DEFAULT_CHUNK_BYTES = 64 * 1024;

export class Outbox {
  readonly #store: OutboxStore;

  constructor(store: OutboxStore) {
    this.#store = store;
  }

  /**
   * Add an item. Idempotent: re-enqueuing an existing id is a no-op that reports
   * success, exactly as a re-sent batch is server-side.
   */
  async enqueue(input: EnqueueInput): Promise<boolean> {
    if (!input.id) throw new TypeError('outbox items require a client-generated id');
    if (!Number.isFinite(input.byteSize) || input.byteSize < 0) {
      throw new RangeError('byteSize must be a non-negative finite number');
    }

    const existing = await this.#store.get(input.id);
    if (existing) return false;

    await this.#store.put({
      id: input.id,
      kind: input.kind,
      byteSize: input.byteSize,
      createdAt: input.createdAt,
      state: 'PENDING',
      attempts: 0,
      lastError: null,
      observationId: input.observationId ?? null,
    });
    return true;
  }

  /**
   * Take the next chunk of work, marking it IN_FLIGHT.
   *
   * Oldest first, so a day's collection syncs in the order it was walked and a
   * mapper watching the pending count sees their morning clear before their
   * afternoon.
   *
   * An item larger than `maxBytes` is still claimed, alone. Skipping it would strand
   * it forever — a photo slightly over the chunk size would never send, and the
   * count would stick at 1 with no explanation.
   */
  async claimBatch(options: ClaimOptions = {}): Promise<OutboxItem[]> {
    const maxBytes = options.maxBytes ?? DEFAULT_CHUNK_BYTES;
    const maxItems = options.maxItems ?? 100;

    const all = await this.#store.list();
    const kinds = options.kinds;
    const pending = all.filter(
      (i) => i.state === 'PENDING' && (kinds === undefined || kinds.includes(i.kind)),
    );

    const claimed: OutboxItem[] = [];
    let bytes = 0;

    for (const item of pending) {
      if (claimed.length >= maxItems) break;
      if (claimed.length > 0 && bytes + item.byteSize > maxBytes) break;

      claimed.push({ ...item, state: 'IN_FLIGHT' });
      bytes += item.byteSize;

      if (bytes >= maxBytes) break;
    }

    for (const item of claimed) await this.#store.put(item);
    return claimed;
  }

  /**
   * Remove items the server has explicitly acknowledged by id.
   *
   * Only ids actually named are removed. A server that acknowledges 9 of 10 leaves
   * the tenth queued, which is the correct and conservative reading of a partial
   * success.
   */
  async acknowledge(ids: readonly string[]): Promise<number> {
    let removed = 0;
    for (const id of ids) {
      const item = await this.#store.get(id);
      if (!item) continue;
      await this.#store.delete(id);
      removed += 1;
    }
    return removed;
  }

  /** Return failed items to PENDING, recording the attempt and the reason. */
  async release(ids: readonly string[], error: string): Promise<void> {
    for (const id of ids) {
      const item = await this.#store.get(id);
      if (!item) continue;
      await this.#store.put({
        ...item,
        state: 'PENDING',
        attempts: item.attempts + 1,
        lastError: error,
      });
    }
  }

  /**
   * Recover items stranded IN_FLIGHT by a crash or an OS kill.
   *
   * On a 2 GB device the app is killed routinely. Without this, every kill during a
   * sync would permanently strand whatever was in flight — the single most likely
   * way to lose a day's work in practice.
   */
  async recoverStranded(): Promise<number> {
    const all = await this.#store.list();
    const stranded = all.filter((i) => i.state === 'IN_FLIGHT');
    for (const item of stranded) {
      await this.#store.put({ ...item, state: 'PENDING' });
    }
    return stranded.length;
  }

  async stats(): Promise<{
    total: number;
    pending: number;
    inFlight: number;
    bytes: number;
    oldestCreatedAt: number | null;
    maxAttempts: number;
  }> {
    const all = await this.#store.list();
    return {
      total: all.length,
      pending: all.filter((i) => i.state === 'PENDING').length,
      inFlight: all.filter((i) => i.state === 'IN_FLIGHT').length,
      bytes: all.reduce((sum, i) => sum + i.byteSize, 0),
      oldestCreatedAt: all.length > 0 ? (all[0] as OutboxItem).createdAt : null,
      maxAttempts: all.reduce((max, i) => Math.max(max, i.attempts), 0),
    };
  }

  /**
   * Items that keep failing.
   *
   * Surfaced, never dropped. Repeated failure means a bug, a spec mismatch, or a
   * server rejecting something it should accept — all of which need a human, and
   * none of which are solved by deleting the evidence.
   */
  async stuckItems(minAttempts = 5): Promise<OutboxItem[]> {
    const all = await this.#store.list();
    return all.filter((i) => i.attempts >= minAttempts);
  }
}
