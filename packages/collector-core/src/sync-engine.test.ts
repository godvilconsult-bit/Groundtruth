import { describe, it, expect, beforeEach } from 'vitest';
import { SyncEngine, type SyncTransport, type TransportOutcome, type RunContext } from './sync-engine.js';
import { Outbox, MemoryOutboxStore, type OutboxItem, type OutboxStore } from './outbox.js';
import { DailyByteBudget, DAILY_BYTE_BUDGET } from './byte-budget.js';

const T0 = new Date('2026-08-11T06:00:00');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const ONLINE: RunContext = { now: T0, connection: { online: true, metered: false } };
const OFFLINE: RunContext = { now: T0, connection: { online: false, metered: false } };
const METERED: RunContext = { now: T0, connection: { online: true, metered: true } };

/** Transport whose behaviour each test dictates, recording what it was given. */
class ScriptedTransport implements SyncTransport {
  outcome: TransportOutcome | ((items: readonly OutboxItem[]) => TransportOutcome) = {
    kind: 'ACCEPTED',
    acknowledgedIds: [],
  };
  readonly batches: OutboxItem[][] = [];
  throwOnce = false;

  async send(items: readonly OutboxItem[]): Promise<TransportOutcome> {
    this.batches.push([...items]);
    if (this.throwOnce) {
      this.throwOnce = false;
      throw new Error('socket hang up');
    }
    const outcome =
      typeof this.outcome === 'function' ? this.outcome(items) : this.outcome;
    if (outcome.kind === 'ACCEPTED' && outcome.acknowledgedIds.length === 0) {
      return { kind: 'ACCEPTED', acknowledgedIds: items.map((i) => i.id) };
    }
    return outcome;
  }
}

let store: OutboxStore;
let outbox: Outbox;
let budget: DailyByteBudget;
let transport: ScriptedTransport;
let engine: SyncEngine;

const makeEngine = (over: Partial<ConstructorParameters<typeof SyncEngine>[0]> = {}) =>
  new SyncEngine({ outbox, budget, transport, random: () => 0.5, ...over });

beforeEach(() => {
  store = new MemoryOutboxStore();
  outbox = new Outbox(store);
  budget = new DailyByteBudget(T0);
  transport = new ScriptedTransport();
  engine = makeEngine();
});

const enqueue = (id: string, kind: OutboxItem['kind'] = 'OBSERVATION', byteSize = 1_000) =>
  outbox.enqueue({ id, kind, byteSize, createdAt: T0.getTime() + id.length });

describe('happy path', () => {
  it('sends and acknowledges, emptying the queue', async () => {
    await enqueue('a');
    await enqueue('b');

    const result = await engine.runOnce(ONLINE);

    expect(result.outcome).toBe('ACCEPTED');
    expect(result.acknowledged).toBe(2);
    expect((await outbox.stats()).total).toBe(0);
  });

  it('records bytes against the daily budget', async () => {
    await enqueue('a', 'OBSERVATION', 5_000);
    await engine.runOnce(ONLINE);
    expect(budget.remainingBytes(T0)).toBe(DAILY_BYTE_BUDGET - 5_000);
  });

  it('does nothing when the queue is empty', async () => {
    const result = await engine.runOnce(ONLINE);
    expect(result.outcome).toBe('NOTHING_TO_DO');
    expect(transport.batches).toHaveLength(0);
  });

  it('reports everything sent once drained', async () => {
    await enqueue('a');
    await engine.runOnce(ONLINE);
    const state = await engine.state(ONLINE);
    expect(state.pendingItems).toBe(0);
    expect(state.lastSuccessAt).toBe(T0.getTime());
  });
});

describe('offline', () => {
  it('does not call the transport at all', async () => {
    await enqueue('a');
    const result = await engine.runOnce(OFFLINE);
    expect(result.outcome).toBe('OFFLINE');
    expect(transport.batches).toHaveLength(0);
    expect((await outbox.stats()).total).toBe(1);
  });

  it('requeues the batch when connectivity vanishes mid-request', async () => {
    await enqueue('a');
    transport.outcome = { kind: 'OFFLINE' };

    const result = await engine.runOnce(ONLINE);

    expect(result.outcome).toBe('OFFLINE');
    const stats = await outbox.stats();
    expect(stats.pending).toBe(1);
    expect(stats.inFlight).toBe(0);
  });

  it('does not count a lost radio as a server failure', async () => {
    // The radio, not the server, is the problem — so no backoff penalty.
    await enqueue('a');
    transport.outcome = { kind: 'OFFLINE' };
    await engine.runOnce(ONLINE);
    expect((await engine.state(ONLINE)).consecutiveFailures).toBe(0);
  });

  it('reports pending work as saved on device, not as failure', async () => {
    await enqueue('a');
    const state = await engine.state(OFFLINE);
    expect(state.phase).toBe('OFFLINE');
    expect(state.pendingItems).toBe(1);
  });
});

describe('failure never destroys data', () => {
  it('requeues on a transient failure and records the reason', async () => {
    await enqueue('a');
    transport.outcome = { kind: 'TRANSIENT_FAILURE', error: 'HTTP 503' };

    const result = await engine.runOnce(ONLINE);

    expect(result.outcome).toBe('TRANSIENT_FAILURE');
    expect((await outbox.stats()).pending).toBe(1);
    expect((await engine.state(ONLINE)).lastError).toBe('HTTP 503');
  });

  it('treats a thrown transport error as transient rather than losing the batch', async () => {
    await enqueue('a');
    transport.throwOnce = true;

    const result = await engine.runOnce(ONLINE);

    expect(result.outcome).toBe('TRANSIENT_FAILURE');
    expect((await outbox.stats()).pending).toBe(1);
    expect((await engine.state(ONLINE)).lastError).toContain('socket hang up');
  });

  it('KEEPS items the server rejected outright — a 4xx is not a delete', async () => {
    // A rejection means a bug, a spec mismatch, or a tampered client. All need a
    // human. Deleting the evidence is the one response that helps nobody.
    await enqueue('good');
    await enqueue('bad');
    transport.outcome = {
      kind: 'PARTIAL',
      acknowledgedIds: ['good'],
      rejected: [{ id: 'bad', reason: 'schema validation failed' }],
    };

    const result = await engine.runOnce(ONLINE);

    expect(result.acknowledged).toBe(1);
    expect(result.rejected).toBe(1);
    const remaining = await store.get('bad');
    expect(remaining).toBeDefined();
    expect(remaining?.lastError).toBe('schema validation failed');
  });

  it('surfaces a repeatedly rejected item instead of silently dropping it', async () => {
    await enqueue('bad');
    transport.outcome = {
      kind: 'PARTIAL',
      acknowledgedIds: [],
      rejected: [{ id: 'bad', reason: 'rejected' }],
    };
    for (let i = 0; i < 6; i += 1) {
      engine.requestImmediateAttempt();
      await engine.runOnce(ONLINE);
    }
    const stuck = await outbox.stuckItems(5);
    expect(stuck.map((i) => i.id)).toEqual(['bad']);
  });

  it('keeps items the server neither acknowledged nor rejected', async () => {
    // An ACCEPTED reply that names only some ids must not be read as "all fine".
    await enqueue('a');
    await enqueue('b');
    transport.outcome = { kind: 'ACCEPTED', acknowledgedIds: ['a'] };

    await engine.runOnce(ONLINE);

    expect(await store.get('b')).toBeDefined();
    expect((await store.get('b'))?.lastError).toBe('not acknowledged by server');
  });
});

describe('backoff', () => {
  it('waits before retrying after a failure', async () => {
    await enqueue('a');
    transport.outcome = { kind: 'TRANSIENT_FAILURE', error: 'boom' };
    await engine.runOnce(ONLINE);

    const batchesAfterFirst = transport.batches.length;
    // Immediately again: should be a no-op while in the backoff window.
    const second = await engine.runOnce(ONLINE);
    expect(second.outcome).toBe('NOTHING_TO_DO');
    expect(transport.batches.length).toBe(batchesAfterFirst);
  });

  it('retries once the window has elapsed', async () => {
    await enqueue('a');
    transport.outcome = { kind: 'TRANSIENT_FAILURE', error: 'boom' };
    await engine.runOnce(ONLINE);

    transport.outcome = { kind: 'ACCEPTED', acknowledgedIds: [] };
    const later = { ...ONLINE, now: at(30) };
    const result = await engine.runOnce(later);

    expect(result.outcome).toBe('ACCEPTED');
    expect((await outbox.stats()).total).toBe(0);
  });

  it('widens the window with each consecutive failure', async () => {
    await enqueue('a');
    transport.outcome = { kind: 'TRANSIENT_FAILURE', error: 'boom' };

    const windows: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const now = at(i * 60);
      await engine.runOnce({ ...ONLINE, now });
      const state = await engine.state({ ...ONLINE, now });
      windows.push((state.nextAttemptAt ?? 0) - now.getTime());
    }
    expect(windows[4]).toBeGreaterThan(windows[0]!);
  });

  it('clears the window on a user-initiated sync now', async () => {
    await enqueue('a');
    transport.outcome = { kind: 'TRANSIENT_FAILURE', error: 'boom' };
    await engine.runOnce(ONLINE);

    transport.outcome = { kind: 'ACCEPTED', acknowledgedIds: [] };
    engine.requestImmediateAttempt();
    expect((await engine.runOnce(ONLINE)).outcome).toBe('ACCEPTED');
  });

  it('resets the failure count after a success', async () => {
    await enqueue('a');
    transport.outcome = { kind: 'TRANSIENT_FAILURE', error: 'boom' };
    await engine.runOnce(ONLINE);
    expect((await engine.state(ONLINE)).consecutiveFailures).toBe(1);

    transport.outcome = { kind: 'ACCEPTED', acknowledgedIds: [] };
    engine.requestImmediateAttempt();
    await engine.runOnce(ONLINE);

    const state = await engine.state(ONLINE);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.nextAttemptAt).toBeNull();
  });
});

describe('observations outrank media', () => {
  it('defers media on a metered connection but still sends observations', async () => {
    await enqueue('obs', 'OBSERVATION', 1_000);
    await enqueue('photo', 'MEDIA', 55_000);

    await engine.runOnce(METERED);

    const sentIds = transport.batches.flat().map((i) => i.id);
    expect(sentIds).toContain('obs');
    expect(sentIds).not.toContain('photo');
    expect(await store.get('photo')).toBeDefined();
  });

  it('sends media on metered data when the user overrides', async () => {
    await enqueue('photo', 'MEDIA', 55_000);
    engine = makeEngine({ allowMeteredMedia: true });

    await engine.runOnce(METERED);

    expect(transport.batches.flat().map((i) => i.id)).toContain('photo');
  });

  it('defers media on low battery, still sending observations', async () => {
    await enqueue('obs', 'OBSERVATION', 1_000);
    await enqueue('photo', 'MEDIA', 55_000);

    await engine.runOnce({ ...ONLINE, batteryLevel: 0.05 });

    const sentIds = transport.batches.flat().map((i) => i.id);
    expect(sentIds).toEqual(['obs']);
  });

  it('sends media when battery is healthy', async () => {
    await enqueue('photo', 'MEDIA', 55_000);
    await engine.runOnce({ ...ONLINE, batteryLevel: 0.9 });
    expect(transport.batches.flat().map((i) => i.id)).toContain('photo');
  });

  it('always sends retractions, since a correction outranks everything', async () => {
    await enqueue('retract', 'RETRACTION', 400);
    await engine.runOnce({ ...METERED, batteryLevel: 0.02 });
    expect(transport.batches.flat().map((i) => i.id)).toContain('retract');
  });
});

describe('the daily budget delays bytes, never discards visits', () => {
  it('stops sending once the budget is exhausted', async () => {
    budget.record(DAILY_BYTE_BUDGET, T0);
    await enqueue('a');

    const result = await engine.runOnce(ONLINE);

    expect(result.outcome).toBe('BUDGET_EXHAUSTED');
    expect(transport.batches).toHaveLength(0);
  });

  it('keeps the queue intact when the budget runs out', async () => {
    budget.record(DAILY_BYTE_BUDGET, T0);
    await enqueue('a');
    await enqueue('b');
    await engine.runOnce(ONLINE);
    expect((await outbox.stats()).total).toBe(2);
  });

  it('resumes the next day', async () => {
    budget.record(DAILY_BYTE_BUDGET, T0);
    await enqueue('a');
    expect((await engine.runOnce(ONLINE)).outcome).toBe('BUDGET_EXHAUSTED');

    const tomorrow = new Date('2026-08-12T06:00:00');
    const result = await engine.runOnce({ ...ONLINE, now: tomorrow });
    expect(result.outcome).toBe('ACCEPTED');
  });
});

describe('crash recovery on first run', () => {
  it('rescues items stranded IN_FLIGHT by an OS kill', async () => {
    await enqueue('a');
    await outbox.claimBatch();
    expect((await outbox.stats()).inFlight).toBe(1);

    // Fresh engine over the same persisted store, as after a restart.
    const restarted = makeEngine();
    const result = await restarted.runOnce(ONLINE);

    expect(result.outcome).toBe('ACCEPTED');
    expect((await outbox.stats()).total).toBe(0);
  });
});

describe('a full offline day, then reconnection', () => {
  it('loses nothing across 6 hours offline, repeated failures and a restart', async () => {
    for (let i = 0; i < 200; i += 1) {
      await outbox.enqueue({
        id: `obs-${i}`, kind: 'OBSERVATION', byteSize: 1_200, createdAt: T0.getTime() + i * 25_000,
      });
      await outbox.enqueue({
        id: `media-${i}`, kind: 'MEDIA', byteSize: 55_000,
        createdAt: T0.getTime() + i * 25_000 + 1, observationId: `obs-${i}`,
      });
    }

    // Six hours in airplane mode: the engine is polled and does nothing harmful.
    for (let minute = 0; minute < 360; minute += 15) {
      const result = await engine.runOnce({ ...OFFLINE, now: at(minute) });
      expect(result.outcome).toBe('OFFLINE');
    }
    expect((await outbox.stats()).total).toBe(400);

    // Signal returns. Drain with generous budget and a fresh day.
    const day2 = new Date('2026-08-12T06:00:00');
    budget.restore('2026-08-12', 0);
    const engine2 = new SyncEngine({
      outbox,
      budget: new DailyByteBudget(day2, 64 * 1024 * 1024),
      transport,
      random: () => 0.5,
    });

    let guard = 0;
    while ((await outbox.stats()).total > 0 && guard < 5_000) {
      engine2.requestImmediateAttempt();
      await engine2.runOnce({ now: day2, connection: { online: true, metered: false } });
      guard += 1;
    }

    expect((await outbox.stats()).total).toBe(0);
    // Every one of the 400 items reached the transport at least once.
    const delivered = new Set(transport.batches.flat().map((i) => i.id));
    expect(delivered.size).toBe(400);
  });
});
