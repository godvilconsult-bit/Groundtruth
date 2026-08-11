// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openCollectorDb,
  IndexedDbOutboxStore,
  IndexedDbWardPackStore,
  IndexedDbSequenceStore,
  requestPersistentStorage,
  DB_NAME,
} from './indexeddb-store.js';
import {
  Outbox,
  CaptureSession,
  DailyByteBudget,
  Uuidv7Generator,
  type WardPack,
} from '@groundtruth/collector-core';

const NOW = new Date('2026-08-11T09:00:00Z');

let db: IDBDatabase;

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
  db = await openCollectorDb(indexedDB);
});

afterEach(() => {
  db?.close();
});

describe('schema', () => {
  it('creates the three stores the collector needs', () => {
    expect([...db.objectStoreNames].sort()).toEqual(['device-sequences', 'outbox', 'ward-packs']);
  });

  it('indexes createdAt, so oldest-first claiming is not a full scan', () => {
    const tx = db.transaction('outbox', 'readonly');
    expect([...tx.objectStore('outbox').indexNames]).toContain('createdAt');
  });

  it('is idempotent to reopen', async () => {
    db.close();
    const again = await openCollectorDb(indexedDB);
    expect(again.version).toBe(1);
    again.close();
  });
});

describe('outbox persistence', () => {
  it('round-trips an item', async () => {
    const outbox = new Outbox(new IndexedDbOutboxStore(db));
    await outbox.enqueue({ id: 'a', kind: 'OBSERVATION', byteSize: 1_200, createdAt: 1 });

    const stats = await outbox.stats();
    expect(stats.pending).toBe(1);
    expect(stats.bytes).toBe(1_200);
  });

  it('survives the app being killed and reopened', async () => {
    // The scenario that matters: the OS reclaims memory mid-shift on a 2 GB device.
    const first = new Outbox(new IndexedDbOutboxStore(db));
    for (let i = 0; i < 25; i += 1) {
      await first.enqueue({ id: `obs-${i}`, kind: 'OBSERVATION', byteSize: 900, createdAt: i });
    }
    db.close();

    const reopened = await openCollectorDb(indexedDB);
    const second = new Outbox(new IndexedDbOutboxStore(reopened));
    expect((await second.stats()).pending).toBe(25);
    reopened.close();
  });

  it('recovers items stranded IN_FLIGHT by a kill mid-sync', async () => {
    const first = new Outbox(new IndexedDbOutboxStore(db));
    await first.enqueue({ id: 'a', kind: 'OBSERVATION', byteSize: 10, createdAt: 1 });
    await first.claimBatch();
    expect((await first.stats()).inFlight).toBe(1);
    db.close();

    const reopened = await openCollectorDb(indexedDB);
    const second = new Outbox(new IndexedDbOutboxStore(reopened));
    expect(await second.recoverStranded()).toBe(1);
    expect((await second.stats()).pending).toBe(1);
    reopened.close();
  });

  it('preserves attempt counts and failure reasons across a restart', async () => {
    const first = new Outbox(new IndexedDbOutboxStore(db));
    await first.enqueue({ id: 'a', kind: 'OBSERVATION', byteSize: 10, createdAt: 1 });
    await first.release(['a'], 'HTTP 503');
    db.close();

    const reopened = await openCollectorDb(indexedDB);
    const item = await new IndexedDbOutboxStore(reopened).get('a');
    expect(item?.attempts).toBe(1);
    expect(item?.lastError).toBe('HTTP 503');
    reopened.close();
  });

  it('returns items oldest-first, so a day syncs in walked order', async () => {
    const outbox = new Outbox(new IndexedDbOutboxStore(db));
    await outbox.enqueue({ id: 'third', kind: 'OBSERVATION', byteSize: 1, createdAt: 300 });
    await outbox.enqueue({ id: 'first', kind: 'OBSERVATION', byteSize: 1, createdAt: 100 });
    await outbox.enqueue({ id: 'second', kind: 'OBSERVATION', byteSize: 1, createdAt: 200 });

    const claimed = await outbox.claimBatch({ maxItems: 10 });
    expect(claimed.map((i) => i.id)).toEqual(['first', 'second', 'third']);
  });

  it('removes acknowledged items permanently', async () => {
    const outbox = new Outbox(new IndexedDbOutboxStore(db));
    await outbox.enqueue({ id: 'a', kind: 'OBSERVATION', byteSize: 1, createdAt: 1 });
    await outbox.acknowledge(['a']);
    db.close();

    const reopened = await openCollectorDb(indexedDB);
    expect((await new Outbox(new IndexedDbOutboxStore(reopened)).stats()).total).toBe(0);
    reopened.close();
  });
});

describe('device sequence persistence', () => {
  it('never repeats a sequence across restarts', async () => {
    // (device_id, device_sequence) is unique server-side, and a repeat is rejected
    // as a replayed batch. Resetting on restart would make every observation after
    // a crash unsyncable.
    const first = new IndexedDbSequenceStore(db);
    expect(await first.next('device-a')).toBe(1);
    expect(await first.next('device-a')).toBe(2);
    db.close();

    const reopened = await openCollectorDb(indexedDB);
    const second = new IndexedDbSequenceStore(reopened);
    expect(await second.next('device-a')).toBe(3);
    reopened.close();
  });

  it('tracks devices independently', async () => {
    const sequences = new IndexedDbSequenceStore(db);
    expect(await sequences.next('device-a')).toBe(1);
    expect(await sequences.next('device-b')).toBe(1);
    expect(await sequences.next('device-a')).toBe(2);
  });

  it('issues no duplicates under concurrent captures', async () => {
    // Read and increment happen in one readwrite transaction precisely so two
    // simultaneous captures cannot both read the same value.
    const sequences = new IndexedDbSequenceStore(db);
    const issued = await Promise.all(
      Array.from({ length: 30 }, () => sequences.next('device-a')),
    );
    expect(new Set(issued).size).toBe(30);
    expect([...issued].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1),
    );
  });
});

describe('ward pack persistence', () => {
  const pack: WardPack = {
    wardId: 'ward-1',
    packVersion: 'v3',
    generatedAt: NOW.toISOString(),
    extent: { wardId: 'ward-1', nameSw: 'Chumbageni', nameEn: 'Chumbageni', outline: {} },
    specs: [],
    minAppVersion: '1.0.0',
    knownFeatures: [],
    sizeBytes: 1024,
  };

  it('keeps the pack across a restart, so a mapper starts offline with data', async () => {
    await new IndexedDbWardPackStore(db).save(pack);
    db.close();

    const reopened = await openCollectorDb(indexedDB);
    const loaded = await new IndexedDbWardPackStore(reopened).load('ward-1');
    expect(loaded?.packVersion).toBe('v3');
    expect(loaded?.extent.nameSw).toBe('Chumbageni');
    reopened.close();
  });

  it('returns null for a ward with no pack rather than inventing one', async () => {
    expect(await new IndexedDbWardPackStore(db).load('nowhere')).toBeNull();
  });

  it('replaces a pack on update rather than accumulating versions', async () => {
    const store = new IndexedDbWardPackStore(db);
    await store.save(pack);
    await store.save({ ...pack, packVersion: 'v4' });
    expect((await store.load('ward-1'))?.packVersion).toBe('v4');
  });
});

describe('capture through persistent storage', () => {
  it('queues a full day and survives a restart with sequences intact', async () => {
    let ms = NOW.getTime();
    const session = new CaptureSession({
      outbox: new Outbox(new IndexedDbOutboxStore(db)),
      budget: new DailyByteBudget(NOW),
      sequences: new IndexedDbSequenceStore(db),
      deviceId: 'device-a',
      appVersion: '1.0.0',
      clock: () => NOW,
      monotonic: () => (ms += 1),
      ids: new Uuidv7Generator({ now: () => (ms += 1), random: () => 0.5 }),
    });

    for (let i = 0; i < 40; i += 1) {
      await session.capture({
        featureClass: 'ACCESS_POINT',
        specVersion: 'access_point@1.0',
        position: { lon: 39.0951, lat: -5.0699, accuracyM: 5 },
        attributes: { access_type: 'gate', reachable_on_foot: true },
        wardId: 'ward-1',
      });
    }
    db.close();

    const reopened = await openCollectorDb(indexedDB);
    const outbox = new Outbox(new IndexedDbOutboxStore(reopened));
    expect((await outbox.stats()).pending).toBe(40);
    // The next sequence continues rather than restarting at 1.
    expect(await new IndexedDbSequenceStore(reopened).next('device-a')).toBe(41);
    reopened.close();
  });
});

describe('persistent storage request', () => {
  it('reports unavailability rather than assuming success', async () => {
    const result = await requestPersistentStorage(undefined);
    expect(result.persisted).toBe(false);
    expect(result.reason).toContain('unavailable');
  });

  it('reports a declined request, since eviction would lose an unsent day', async () => {
    const storage = {
      persisted: async () => false,
      persist: async () => false,
    } as unknown as StorageManager;
    const result = await requestPersistentStorage(storage);
    expect(result.persisted).toBe(false);
    expect(result.reason).toContain('declined');
  });

  it('skips the prompt when already persisted', async () => {
    let persistCalls = 0;
    const storage = {
      persisted: async () => true,
      persist: async () => {
        persistCalls += 1;
        return true;
      },
    } as unknown as StorageManager;
    const result = await requestPersistentStorage(storage);
    expect(result.persisted).toBe(true);
    expect(persistCalls).toBe(0);
  });

  it('reports a thrown error instead of propagating it into startup', async () => {
    // A real StorageManager exposes both methods; the throw comes from the call,
    // not from the API being absent.
    const storage = {
      persisted: async () => {
        throw new Error('SecurityError');
      },
      persist: async () => false,
    } as unknown as StorageManager;
    const result = await requestPersistentStorage(storage);
    expect(result.persisted).toBe(false);
    expect(result.reason).toContain('SecurityError');
  });
});
