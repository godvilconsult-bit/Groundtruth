/**
 * IndexedDB persistence for the outbox, ward packs, and the device sequence.
 *
 * This is the layer that makes "eight hours offline, nothing lost" survive the app
 * being killed — which on a 2 GB Android device is routine, not exceptional.
 *
 * Chosen over OPFS because the collector stores structured records and blobs in
 * roughly equal measure, and IndexedDB handles both with one API and one
 * transaction model. OPFS is better for large binaries alone; we do not have that
 * shape of problem.
 *
 * Everything here is an adapter behind a port. The queue's rules were proven against
 * an in-memory store; this only has to persist faithfully.
 */

import type {
  OutboxItem,
  OutboxStore,
  WardPack,
  WardPackStore,
  SequenceStore,
} from '@groundtruth/collector-core';

export const DB_NAME = 'groundtruth-collector';
export const DB_VERSION = 1;

const STORE_OUTBOX = 'outbox';
const STORE_PACKS = 'ward-packs';
const STORE_SEQUENCES = 'device-sequences';

/** Promisify an IDBRequest without losing the rejection reason. */
function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * Open the database, creating stores on first run or upgrade.
 *
 * `createdAt` is indexed because the outbox always claims oldest-first: a day syncs
 * in the order it was walked, and a mapper watching the pending count sees their
 * morning clear before their afternoon. Without the index that ordering is a full
 * scan on every claim.
 */
export function openCollectorDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        const outbox = db.createObjectStore(STORE_OUTBOX, { keyPath: 'id' });
        outbox.createIndex('createdAt', 'createdAt', { unique: false });
        outbox.createIndex('state', 'state', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_PACKS)) {
        db.createObjectStore(STORE_PACKS, { keyPath: 'wardId' });
      }
      if (!db.objectStoreNames.contains(STORE_SEQUENCES)) {
        db.createObjectStore(STORE_SEQUENCES, { keyPath: 'deviceId' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('failed to open IndexedDB'));
    request.onblocked = () =>
      reject(new Error('IndexedDB upgrade blocked by another open tab'));
  });
}

export class IndexedDbOutboxStore implements OutboxStore {
  readonly #db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.#db = db;
  }

  async get(id: string): Promise<OutboxItem | undefined> {
    const tx = this.#db.transaction(STORE_OUTBOX, 'readonly');
    return promisify<OutboxItem | undefined>(tx.objectStore(STORE_OUTBOX).get(id));
  }

  async put(item: OutboxItem): Promise<void> {
    const tx = this.#db.transaction(STORE_OUTBOX, 'readwrite');
    await promisify(tx.objectStore(STORE_OUTBOX).put(item));
  }

  async delete(id: string): Promise<void> {
    const tx = this.#db.transaction(STORE_OUTBOX, 'readwrite');
    await promisify(tx.objectStore(STORE_OUTBOX).delete(id));
  }

  /**
   * All items, oldest first.
   *
   * Read through the `createdAt` index so ordering comes from the database rather
   * than from sorting the whole queue in memory on every claim — which on a day
   * with 400 queued items and 2 GB of RAM is not free.
   */
  async list(): Promise<OutboxItem[]> {
    const tx = this.#db.transaction(STORE_OUTBOX, 'readonly');
    const index = tx.objectStore(STORE_OUTBOX).index('createdAt');
    const items = await promisify<OutboxItem[]>(index.getAll());
    // getAll on an index returns index order; ties fall back to id for determinism.
    return items.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}

export class IndexedDbWardPackStore implements WardPackStore {
  readonly #db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.#db = db;
  }

  async load(wardId: string): Promise<WardPack | null> {
    const tx = this.#db.transaction(STORE_PACKS, 'readonly');
    const pack = await promisify<WardPack | undefined>(tx.objectStore(STORE_PACKS).get(wardId));
    return pack ?? null;
  }

  async save(pack: WardPack): Promise<void> {
    const tx = this.#db.transaction(STORE_PACKS, 'readwrite');
    await promisify(tx.objectStore(STORE_PACKS).put(pack));
  }
}

/**
 * Per-device sequence numbers, persisted.
 *
 * The sequence must never repeat for a device: `(device_id, device_sequence)` is
 * unique server-side, and a repeat is rejected as a replayed batch. Resetting on
 * restart would therefore make every observation after a crash unsyncable.
 *
 * Read and increment happen in ONE readwrite transaction, so two concurrent
 * captures cannot both read the same value and issue duplicate sequences.
 */
export class IndexedDbSequenceStore implements SequenceStore {
  readonly #db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.#db = db;
  }

  next(deviceId: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(STORE_SEQUENCES, 'readwrite');
      const store = tx.objectStore(STORE_SEQUENCES);
      const read = store.get(deviceId);

      read.onsuccess = () => {
        const current = (read.result as { deviceId: string; value: number } | undefined)?.value ?? 0;
        const next = current + 1;
        const write = store.put({ deviceId, value: next });
        write.onsuccess = () => resolve(next);
        write.onerror = () => reject(write.error ?? new Error('sequence write failed'));
      };
      read.onerror = () => reject(read.error ?? new Error('sequence read failed'));
      tx.onabort = () => reject(tx.error ?? new Error('sequence transaction aborted'));
    });
  }
}

/**
 * Ask the browser to keep our data.
 *
 * Without persistent storage the browser may evict everything under disk pressure —
 * which is exactly the condition a cheap device spends its life in. Evicting a
 * mapper's unsent day is the single worst thing this app could do, so this is
 * requested at startup and its refusal is worth surfacing rather than ignoring.
 */
export async function requestPersistentStorage(
  storage: StorageManager | undefined,
): Promise<{ persisted: boolean; reason: string | null }> {
  if (!storage?.persist) {
    return { persisted: false, reason: 'storage persistence API unavailable' };
  }
  try {
    const already = storage.persisted ? await storage.persisted() : false;
    if (already) return { persisted: true, reason: null };
    const granted = await storage.persist();
    return {
      persisted: granted,
      reason: granted ? null : 'browser declined persistent storage',
    };
  } catch (error) {
    return {
      persisted: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
