import { describe, it, expect, beforeEach } from 'vitest';
import { CaptureSession, MemorySequenceStore, type CaptureInput } from './capture.js';
import { Outbox, MemoryOutboxStore, type OutboxStore } from './outbox.js';
import { DailyByteBudget, DAILY_BYTE_BUDGET } from './byte-budget.js';
import { Uuidv7Generator, isUuidv7 } from './uuidv7.js';

const NOW = new Date('2026-08-11T09:15:00Z');

let store: OutboxStore;
let outbox: Outbox;
let budget: DailyByteBudget;
let session: CaptureSession;

beforeEach(() => {
  store = new MemoryOutboxStore();
  outbox = new Outbox(store);
  budget = new DailyByteBudget(NOW);
  let ms = NOW.getTime();
  session = new CaptureSession({
    outbox,
    budget,
    sequences: new MemorySequenceStore(),
    deviceId: 'device-a',
    appVersion: '1.0.0',
    clock: () => NOW,
    monotonic: () => (ms += 1_000),
    ids: new Uuidv7Generator({ now: () => (ms += 1), random: () => 0.5 }),
  });
});

const input = (over: Partial<CaptureInput> = {}): CaptureInput => ({
  featureClass: 'ACCESS_POINT',
  specVersion: 'access_point@1.0',
  position: { lon: 39.0951, lat: -5.0699, accuracyM: 6.5 },
  attributes: { access_type: 'gate', reachable_on_foot: true },
  wardId: '00000000-0000-4000-8000-000000000003',
  ...over,
});

describe('capture', () => {
  it('mints a time-ordered v7 id', () => {
    // v4 here would scatter inserts across the whole index (ADR-0002).
    return session.capture(input()).then((o) => {
      expect(isUuidv7(o.id)).toBe(true);
    });
  });

  it('queues the observation for sync', async () => {
    const observation = await session.capture(input());
    expect((await outbox.stats()).pending).toBe(1);
    expect(await store.get(observation.id)).toBeDefined();
  });

  it('assigns a monotonic per-device sequence', async () => {
    const a = await session.capture(input());
    const b = await session.capture(input());
    const c = await session.capture(input());
    expect([a.deviceSequence, b.deviceSequence, c.deviceSequence]).toEqual([1, 2, 3]);
  });

  it('records a monotonic clock alongside the untrusted wall clock', async () => {
    // The wall clock is user-settable; the monotonic value is not. This is what
    // makes per-device ordering recoverable when the clock lies.
    const a = await session.capture(input());
    const b = await session.capture(input());
    expect(b.monotonicMs).toBeGreaterThan(a.monotonicMs);
    expect(a.capturedAt).toBe(NOW.toISOString());
  });

  it('stamps the app and spec versions the observation was collected under', async () => {
    const observation = await session.capture(input());
    expect(observation.appVersion).toBe('1.0.0');
    expect(observation.specVersion).toBe('access_point@1.0');
  });

  it('carries a consent reference when one is supplied', async () => {
    const observation = await session.capture(input({ consentRef: 'consent-2026-08-11-001' }));
    expect(observation.consentRef).toBe('consent-2026-08-11-001');
  });

  it('defaults consent to null rather than omitting it', async () => {
    expect((await session.capture(input())).consentRef).toBeNull();
  });

  it('freezes the record, so nothing can edit an immutable fact after the event', async () => {
    const observation = await session.capture(input());
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.attributes)).toBe(true);
  });

  it('copies attributes rather than aliasing the caller object', async () => {
    const attributes: Record<string, unknown> = { access_type: 'gate', reachable_on_foot: true };
    const observation = await session.capture(input({ attributes }));
    attributes['access_type'] = 'doorway';
    expect(observation.attributes['access_type']).toBe('gate');
  });
});

describe('position validation', () => {
  it.each([
    ['longitude too high', { lon: 181, lat: 0, accuracyM: 5 }],
    ['longitude too low', { lon: -181, lat: 0, accuracyM: 5 }],
    ['latitude too high', { lon: 0, lat: 91, accuracyM: 5 }],
    ['latitude too low', { lon: 0, lat: -91, accuracyM: 5 }],
    ['non-finite longitude', { lon: Number.NaN, lat: 0, accuracyM: 5 }],
  ])('rejects %s', async (_label, position) => {
    await expect(session.capture(input({ position }))).rejects.toThrow(RangeError);
  });

  it('rejects a non-positive GPS accuracy', async () => {
    // A zero or negative accuracy means a fabricated fix or a broken sensor.
    // Recording it would let QA treat a bogus position as perfectly precise.
    for (const accuracyM of [0, -1]) {
      await expect(
        session.capture(input({ position: { lon: 39, lat: -5, accuracyM } })),
      ).rejects.toThrow(RangeError);
    }
  });

  it('does not queue anything when validation fails', async () => {
    await expect(
      session.capture(input({ position: { lon: 999, lat: 0, accuracyM: 5 } })),
    ).rejects.toThrow();
    expect((await outbox.stats()).total).toBe(0);
  });
});

describe('media', () => {
  const digest = 'a'.repeat(64);

  it('queues media separately from the observation', async () => {
    await session.capture(input({ mediaRefs: [digest] }));
    const stats = await outbox.stats();
    expect(stats.total).toBe(2);
  });

  it('content-addresses media, so an identical photo is queued once', async () => {
    // Two observations referencing the same image: one upload, not two.
    await session.capture(input({ mediaRefs: [digest] }));
    await session.capture(input({ mediaRefs: [digest] }));
    const stats = await outbox.stats();
    expect(stats.total).toBe(3);
  });

  it('links media back to its observation', async () => {
    const observation = await session.capture(input({ mediaRefs: [digest] }));
    const media = await store.get(`media:${digest}`);
    expect(media?.observationId).toBe(observation.id);
  });

  it('orders the observation ahead of its media', async () => {
    // The visit is the irreplaceable part; the photo can follow.
    await session.capture(input({ mediaRefs: [digest] }));
    const claimed = await outbox.claimBatch({ maxItems: 10 });
    expect(claimed[0]?.kind).toBe('OBSERVATION');
  });
});

describe('retraction — corrections never delete', () => {
  it('writes a NEW observation referencing the original', async () => {
    const original = await session.capture(input());
    const retraction = await session.retract({
      originalId: original.id,
      reason: 'wrong gate recorded',
    });

    expect(retraction.id).not.toBe(original.id);
    expect(retraction.retractsId).toBe(original.id);
    expect(retraction.retractionReason).toBe('wrong gate recorded');
  });

  it('leaves the original queued and untouched', async () => {
    // The original claim was still made. Deleting it would erase evidence and
    // break the audit trail the dataset's credibility rests on.
    const original = await session.capture(input());
    await session.retract({ originalId: original.id, reason: 'mistyped' });

    expect(await store.get(original.id)).toBeDefined();
    expect((await outbox.stats()).total).toBe(2);
  });

  it('queues the retraction as its own kind, so sync can prioritise it', async () => {
    const original = await session.capture(input());
    const retraction = await session.retract({ originalId: original.id, reason: 'mistyped' });
    expect((await store.get(retraction.id))?.kind).toBe('RETRACTION');
  });

  it('REFUSES an unexplained retraction', async () => {
    // Months later, an unexplained retraction is indistinguishable from data loss.
    const original = await session.capture(input());
    await expect(
      session.retract({ originalId: original.id, reason: '   ' }),
    ).rejects.toThrow(TypeError);
    expect((await outbox.stats()).total).toBe(1);
  });

  it('carries replacement attributes when correcting rather than withdrawing', async () => {
    const original = await session.capture(input());
    const retraction = await session.retract({
      originalId: original.id,
      reason: 'corrected access type',
      replacement: input({ attributes: { access_type: 'doorway', reachable_on_foot: true } }),
    });
    expect(retraction.attributes['access_type']).toBe('doorway');
    expect(retraction.retractsId).toBe(original.id);
  });

  it('keeps advancing the device sequence, so the correction has its place in the walk', async () => {
    const original = await session.capture(input());
    const retraction = await session.retract({ originalId: original.id, reason: 'x' });
    expect(retraction.deviceSequence).toBe(original.deviceSequence + 1);
  });

  it('validates a replacement position like any other capture', async () => {
    const original = await session.capture(input());
    await expect(
      session.retract({
        originalId: original.id,
        reason: 'moved',
        replacement: input({ position: { lon: 0, lat: 0, accuracyM: -3 } }),
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe('the budget delays bytes, never refuses a visit', () => {
  it('still captures when the daily budget is fully spent', async () => {
    // R-003: the budget governs when bytes leave the device, never whether a visit
    // is recorded. An observation that does not fit today waits for tomorrow.
    budget.record(DAILY_BYTE_BUDGET, NOW);
    const observation = await session.capture(input());
    expect(observation.id).toBeTruthy();
    expect((await outbox.stats()).pending).toBe(1);
  });

  it('reports an image ceiling that shrinks as the day is consumed', () => {
    const early = session.imageBudget(200);
    budget.record(DAILY_BYTE_BUDGET * 0.9, NOW);
    expect(session.imageBudget(200)).toBeLessThan(early);
  });

  it('returns a zero image ceiling rather than refusing the observation', async () => {
    budget.record(DAILY_BYTE_BUDGET - 500, NOW);
    expect(session.imageBudget(100)).toBe(0);
    await expect(session.capture(input())).resolves.toBeTruthy();
  });
});

describe('a full day of capture', () => {
  it('queues 200 observations with correct sequencing and ordering', async () => {
    const captured = [];
    for (let i = 0; i < 200; i += 1) captured.push(await session.capture(input()));

    expect(captured.map((o) => o.deviceSequence)).toEqual(
      Array.from({ length: 200 }, (_, i) => i + 1),
    );
    // Ids sort in capture order, which is what the server-side index depends on.
    const ids = captured.map((o) => o.id);
    expect([...ids].sort()).toEqual(ids);
    expect((await outbox.stats()).pending).toBe(200);
  });
});
