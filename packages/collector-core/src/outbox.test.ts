import { describe, it, expect, beforeEach } from 'vitest';
import {
  Outbox,
  MemoryOutboxStore,
  DEFAULT_CHUNK_BYTES,
  type OutboxStore,
} from './outbox.js';

const T0 = 1_754_870_400_000;

let store: OutboxStore;
let outbox: Outbox;

beforeEach(() => {
  store = new MemoryOutboxStore();
  outbox = new Outbox(store);
});

const add = (id: string, over: Partial<{ byteSize: number; createdAt: number; kind: 'OBSERVATION' | 'MEDIA' | 'RETRACTION' }> = {}) =>
  outbox.enqueue({
    id,
    kind: over.kind ?? 'OBSERVATION',
    byteSize: over.byteSize ?? 1_000,
    createdAt: over.createdAt ?? T0,
  });

describe('enqueue', () => {
  it('accepts an item', async () => {
    expect(await add('a')).toBe(true);
    expect((await outbox.stats()).pending).toBe(1);
  });

  it('is idempotent by client-generated id', async () => {
    // A double-tap, a replayed capture, or a resumed session must not duplicate a
    // walk. Same rule as server-side ON CONFLICT DO NOTHING (ADR-0002).
    expect(await add('a')).toBe(true);
    expect(await add('a')).toBe(false);
    expect((await outbox.stats()).total).toBe(1);
  });

  it('does not overwrite an in-flight item on re-enqueue', async () => {
    await add('a');
    await outbox.claimBatch();
    await add('a');
    expect((await outbox.stats()).inFlight).toBe(1);
    expect((await outbox.stats()).pending).toBe(0);
  });

  it('rejects an item with no id', async () => {
    await expect(
      outbox.enqueue({ id: '', kind: 'OBSERVATION', byteSize: 1, createdAt: T0 }),
    ).rejects.toThrow(TypeError);
  });

  it('rejects a negative byte size', async () => {
    await expect(
      outbox.enqueue({ id: 'x', kind: 'OBSERVATION', byteSize: -1, createdAt: T0 }),
    ).rejects.toThrow(RangeError);
  });
});

describe('claimBatch', () => {
  it('claims oldest first, so a day syncs in the order it was walked', async () => {
    await add('third', { createdAt: T0 + 2000 });
    await add('first', { createdAt: T0 });
    await add('second', { createdAt: T0 + 1000 });

    const claimed = await outbox.claimBatch();
    expect(claimed.map((i) => i.id)).toEqual(['first', 'second', 'third']);
  });

  it('respects the chunk byte ceiling', async () => {
    for (let i = 0; i < 10; i += 1) await add(`i${i}`, { byteSize: 20_000, createdAt: T0 + i });
    const claimed = await outbox.claimBatch({ maxBytes: 50_000 });
    // Stops once adding another would exceed the ceiling.
    expect(claimed.length).toBeLessThanOrEqual(3);
    expect(claimed.reduce((s, i) => s + i.byteSize, 0)).toBeLessThanOrEqual(60_000);
  });

  it('respects the item-count ceiling', async () => {
    for (let i = 0; i < 20; i += 1) await add(`i${i}`, { byteSize: 10, createdAt: T0 + i });
    expect((await outbox.claimBatch({ maxItems: 5 })).length).toBe(5);
  });

  it('claims an oversized item alone rather than stranding it forever', async () => {
    // A photo slightly over the chunk size must still send. Skipping it would leave
    // the pending count stuck at 1 with no explanation the mapper could act on.
    await add('huge', { byteSize: DEFAULT_CHUNK_BYTES * 3, createdAt: T0 });
    await add('small', { byteSize: 100, createdAt: T0 + 1 });

    const claimed = await outbox.claimBatch();
    expect(claimed.map((i) => i.id)).toEqual(['huge']);
  });

  it('does not re-claim items already in flight', async () => {
    await add('a');
    await add('b', { createdAt: T0 + 1 });
    const first = await outbox.claimBatch({ maxItems: 1 });
    const second = await outbox.claimBatch({ maxItems: 10 });
    expect(first.map((i) => i.id)).toEqual(['a']);
    expect(second.map((i) => i.id)).toEqual(['b']);
  });

  it('returns nothing when the outbox is empty', async () => {
    expect(await outbox.claimBatch()).toEqual([]);
  });
});

describe('acknowledge — the only way an item leaves', () => {
  it('removes acknowledged items', async () => {
    await add('a');
    await add('b', { createdAt: T0 + 1 });
    const claimed = await outbox.claimBatch();
    expect(await outbox.acknowledge(claimed.map((i) => i.id))).toBe(2);
    expect((await outbox.stats()).total).toBe(0);
  });

  it('removes ONLY the ids the server named', async () => {
    // A server acknowledging 1 of 2 leaves the other queued. Treating a partial
    // success as total is how a day's work disappears silently.
    await add('a');
    await add('b', { createdAt: T0 + 1 });
    await outbox.claimBatch();

    expect(await outbox.acknowledge(['a'])).toBe(1);
    const stats = await outbox.stats();
    expect(stats.total).toBe(1);
    expect((await store.get('b'))?.id).toBe('b');
  });

  it('ignores unknown ids without disturbing the queue', async () => {
    await add('a');
    expect(await outbox.acknowledge(['not-a-real-id'])).toBe(0);
    expect((await outbox.stats()).total).toBe(1);
  });
});

describe('release — failure never destroys data', () => {
  it('returns failed items to PENDING and counts the attempt', async () => {
    await add('a');
    const claimed = await outbox.claimBatch();
    await outbox.release(claimed.map((i) => i.id), 'network timeout');

    const item = await store.get('a');
    expect(item?.state).toBe('PENDING');
    expect(item?.attempts).toBe(1);
    expect(item?.lastError).toBe('network timeout');
  });

  it('keeps an item through many consecutive failures', async () => {
    // A permanently failing item is a bug to surface, not data to discard.
    await add('a');
    for (let i = 0; i < 50; i += 1) {
      const claimed = await outbox.claimBatch();
      await outbox.release(claimed.map((x) => x.id), `failure ${i}`);
    }
    const item = await store.get('a');
    expect(item).toBeDefined();
    expect(item?.attempts).toBe(50);
    expect((await outbox.stats()).total).toBe(1);
  });

  it('surfaces repeatedly failing items rather than dropping them', async () => {
    await add('good');
    await add('bad', { createdAt: T0 + 1 });
    for (let i = 0; i < 6; i += 1) {
      await outbox.release(['bad'], 'rejected by server');
    }
    const stuck = await outbox.stuckItems(5);
    expect(stuck.map((i) => i.id)).toEqual(['bad']);
  });
});

describe('crash recovery', () => {
  it('recovers items stranded IN_FLIGHT by an OS kill', async () => {
    // On a 2 GB device the app is killed routinely. Without recovery, every kill
    // mid-sync permanently strands whatever was in flight.
    await add('a');
    await add('b', { createdAt: T0 + 1 });
    await outbox.claimBatch();
    expect((await outbox.stats()).inFlight).toBe(2);

    // Simulate restart: a fresh Outbox over the same persisted store.
    const afterRestart = new Outbox(store);
    expect(await afterRestart.recoverStranded()).toBe(2);

    const stats = await afterRestart.stats();
    expect(stats.pending).toBe(2);
    expect(stats.inFlight).toBe(0);
  });

  it('preserves attempt counts and payload sizes across restart', async () => {
    await add('a', { byteSize: 4_242 });
    await outbox.release(['a'], 'boom');

    const afterRestart = new Outbox(store);
    const item = await store.get('a');
    expect(item?.attempts).toBe(1);
    expect(item?.byteSize).toBe(4_242);
    expect((await afterRestart.stats()).total).toBe(1);
  });
});

describe('the eight-hour offline day', () => {
  it('holds 200 observations with photos and loses none across failures and a crash', async () => {
    // The Phase 2 deliverable, as a property test: airplane mode, a full day of
    // collection, repeated sync failures, an OS kill, then reconnection.
    const OBSERVATIONS = 200;
    for (let i = 0; i < OBSERVATIONS; i += 1) {
      await outbox.enqueue({
        id: `obs-${i}`, kind: 'OBSERVATION', byteSize: 1_200, createdAt: T0 + i * 25_000,
      });
      await outbox.enqueue({
        id: `media-${i}`, kind: 'MEDIA', byteSize: 55_000,
        createdAt: T0 + i * 25_000 + 1, observationId: `obs-${i}`,
      });
    }
    expect((await outbox.stats()).total).toBe(OBSERVATIONS * 2);

    // Six hours of failed sync attempts.
    for (let round = 0; round < 20; round += 1) {
      const claimed = await outbox.claimBatch();
      await outbox.release(claimed.map((i) => i.id), 'no network');
    }
    expect((await outbox.stats()).total).toBe(OBSERVATIONS * 2);

    // The OS kills the app mid-send.
    await outbox.claimBatch();
    const restarted = new Outbox(store);
    await restarted.recoverStranded();
    expect((await restarted.stats()).total).toBe(OBSERVATIONS * 2);

    // Signal returns; drain the queue.
    let drained = 0;
    let guard = 0;
    while ((await restarted.stats()).total > 0 && guard < 10_000) {
      const claimed = await restarted.claimBatch();
      drained += await restarted.acknowledge(claimed.map((i) => i.id));
      guard += 1;
    }

    expect(drained).toBe(OBSERVATIONS * 2);
    expect((await restarted.stats()).total).toBe(0);
  });
});
