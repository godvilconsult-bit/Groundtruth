import { describe, it, expect, beforeEach } from 'vitest';
import {
  WardPackManager,
  MemoryWardPackStore,
  evaluatePack,
  compareAppVersions,
  type WardPack,
  type WardPackTransport,
  type PackFetchOutcome,
  type PackDecision,
} from './ward-pack.js';
import { V1_SPECS, type FeatureClassSpec } from '@groundtruth/spec';

const WARD = '00000000-0000-4000-8000-000000000003';

const pack = (over: Partial<WardPack> = {}): WardPack => ({
  wardId: WARD,
  packVersion: 'v1',
  generatedAt: '2026-08-11T06:00:00Z',
  extent: {
    wardId: WARD,
    nameSw: 'Chumbageni',
    nameEn: 'Chumbageni',
    outline: { type: 'Polygon', coordinates: [] },
  },
  specs: V1_SPECS,
  minAppVersion: '1.0.0',
  knownFeatures: [],
  sizeBytes: 240_000,
  ...over,
});

class StubTransport implements WardPackTransport {
  outcome: PackFetchOutcome = { kind: 'NOT_MODIFIED' };
  readonly seenEtags: (string | null)[] = [];
  readonly rejections: PackDecision[] = [];
  reportShouldThrow = false;

  async fetchPack(_wardId: string, etag: string | null): Promise<PackFetchOutcome> {
    this.seenEtags.push(etag);
    return this.outcome;
  }

  async reportRejection(_wardId: string, decision: PackDecision): Promise<void> {
    if (this.reportShouldThrow) throw new Error('telemetry endpoint down');
    this.rejections.push(decision);
  }
}

describe('compareAppVersions', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['1.0.1', '1.0.0', 1],
    ['1.0.0', '1.0.1', -1],
    ['2.0.0', '1.99.99', 1],
    ['1.10.0', '1.9.0', 1],
  ])('compares %s to %s', (a, b, expected) => {
    expect(Math.sign(compareAppVersions(a, b))).toBe(expected);
  });

  it('rejects a malformed version rather than treating it as 0.0.0', () => {
    // Treating an unparseable min_app_version as 0.0.0 would make it satisfiable by
    // every client — the exact opposite of a version floor.
    expect(() => compareAppVersions('1.0', '1.0.0')).toThrow(TypeError);
    expect(() => compareAppVersions('v1.0.0', '1.0.0')).toThrow(TypeError);
    expect(() => compareAppVersions('', '1.0.0')).toThrow(TypeError);
  });
});

describe('evaluatePack', () => {
  it('accepts the v1 bundle on a current app', () => {
    expect(evaluatePack(pack(), { appVersion: '1.0.0' })).toEqual({ accept: true });
  });

  it('REFUSES a pack requiring a newer app', () => {
    const future = pack({
      specs: V1_SPECS.map((s) => ({ ...s, minAppVersion: '2.0.0' })) as FeatureClassSpec[],
    });
    const decision = evaluatePack(future, { appVersion: '1.4.0' });
    expect(decision.accept).toBe(false);
    if (!decision.accept) {
      expect(decision.reason).toBe('APP_TOO_OLD');
      expect(decision.detail).toContain('2.0.0');
    }
  });

  it('uses the STRICTEST floor across the bundle, not the manifest claim', () => {
    // A manifest that under-reports its requirement must not slip a form past us.
    const mixed = pack({
      minAppVersion: '1.0.0',
      specs: V1_SPECS.map((s, i) =>
        i === 0 ? { ...s, minAppVersion: '3.0.0' } : s,
      ) as FeatureClassSpec[],
    });
    const decision = evaluatePack(mixed, { appVersion: '1.0.0' });
    expect(decision.accept).toBe(false);
    if (!decision.accept) expect(decision.detail).toContain('3.0.0');
  });

  it('REFUSES a pack containing a widget it cannot render', () => {
    const future = pack({
      specs: V1_SPECS.map((s, i) =>
        i === 0
          ? { ...s, uiHints: { fields: s.uiHints.fields.map((f) => ({ ...f, widget: 'signature_pad' as never })) } }
          : s,
      ) as FeatureClassSpec[],
    });
    const decision = evaluatePack(future, { appVersion: '9.9.9' });
    expect(decision.accept).toBe(false);
    if (!decision.accept) {
      expect(decision.reason).toBe('UNSUPPORTED_WIDGET');
      expect(decision.detail).toContain('signature_pad');
    }
  });

  it('REFUSES an empty bundle, which would leave a mapper with no forms', () => {
    const decision = evaluatePack(pack({ specs: [] }), { appVersion: '1.0.0' });
    expect(decision.accept).toBe(false);
    if (!decision.accept) expect(decision.reason).toBe('EMPTY_SPEC_BUNDLE');
  });

  it('REFUSES a pack for a different ward', () => {
    const decision = evaluatePack(pack({ wardId: 'other-ward' }), {
      appVersion: '1.0.0',
      expectedWardId: WARD,
    });
    expect(decision.accept).toBe(false);
    if (!decision.accept) expect(decision.reason).toBe('WARD_MISMATCH');
  });

  it('always names a reason, so a stalled update is explainable', () => {
    // "The app stopped updating" with no explanation is indistinguishable from a
    // broken device to the mapper, and from a broken server to whoever they call.
    const decision = evaluatePack(pack({ specs: [] }), { appVersion: '1.0.0' });
    if (!decision.accept) {
      expect(decision.detail.length).toBeGreaterThan(0);
    }
  });
});

describe('WardPackManager', () => {
  let store: MemoryWardPackStore;
  let transport: StubTransport;
  let manager: WardPackManager;

  beforeEach(() => {
    store = new MemoryWardPackStore();
    transport = new StubTransport();
    manager = new WardPackManager({ store, transport, appVersion: '1.0.0' });
  });

  it('adopts a valid pack when none is held', async () => {
    transport.outcome = { kind: 'PACK', pack: pack() };
    const result = await manager.update(WARD);
    expect(result.updated).toBe(true);
    expect(result.reason).toBe('ADOPTED');
    expect((await manager.current(WARD))?.packVersion).toBe('v1');
  });

  it('sends the current version as an ETag on the next check', async () => {
    transport.outcome = { kind: 'PACK', pack: pack() };
    await manager.update(WARD);
    transport.outcome = { kind: 'NOT_MODIFIED' };
    await manager.update(WARD);
    expect(transport.seenEtags).toEqual([null, 'v1']);
  });

  it('keeps the current pack on 304, at the cost of one conditional request', async () => {
    transport.outcome = { kind: 'PACK', pack: pack() };
    await manager.update(WARD);
    transport.outcome = { kind: 'NOT_MODIFIED' };

    const result = await manager.update(WARD);
    expect(result.updated).toBe(false);
    expect(result.reason).toBe('ALREADY_CURRENT');
    expect(result.pack?.packVersion).toBe('v1');
  });

  it('adopts a newer version when offered', async () => {
    transport.outcome = { kind: 'PACK', pack: pack() };
    await manager.update(WARD);
    transport.outcome = { kind: 'PACK', pack: pack({ packVersion: 'v2' }) };

    const result = await manager.update(WARD);
    expect(result.updated).toBe(true);
    expect((await manager.current(WARD))?.packVersion).toBe('v2');
  });

  describe('a refusal is never destructive', () => {
    it('keeps the previous pack when the new one needs a newer app', async () => {
      transport.outcome = { kind: 'PACK', pack: pack() };
      await manager.update(WARD);

      transport.outcome = {
        kind: 'PACK',
        pack: pack({
          packVersion: 'v2',
          specs: V1_SPECS.map((s) => ({ ...s, minAppVersion: '5.0.0' })) as FeatureClassSpec[],
        }),
      };
      const result = await manager.update(WARD);

      expect(result.updated).toBe(false);
      expect(result.reason).toBe('REJECTED');
      // The mapper keeps working. A bad publish costs a schema update, not a day.
      expect((await manager.current(WARD))?.packVersion).toBe('v1');
    });

    it('keeps the previous pack when the new one has an unrenderable widget', async () => {
      transport.outcome = { kind: 'PACK', pack: pack() };
      await manager.update(WARD);

      transport.outcome = {
        kind: 'PACK',
        pack: pack({
          packVersion: 'v2',
          specs: V1_SPECS.map((s) => ({
            ...s,
            uiHints: { fields: s.uiHints.fields.map((f) => ({ ...f, widget: 'hologram' as never })) },
          })) as FeatureClassSpec[],
        }),
      };
      await manager.update(WARD);

      expect((await manager.current(WARD))?.packVersion).toBe('v1');
      const live = await manager.specFor(WARD, 'BUILDING_FOOTPRINT');
      expect(live?.uiHints.fields[0]?.widget).not.toBe('hologram');
    });

    it('reports the refusal so a bad rollout is visible centrally', async () => {
      transport.outcome = {
        kind: 'PACK',
        pack: pack({ specs: V1_SPECS.map((s) => ({ ...s, minAppVersion: '9.0.0' })) as FeatureClassSpec[] }),
      };
      await manager.update(WARD);
      expect(transport.rejections).toHaveLength(1);
      expect(transport.rejections[0]?.accept).toBe(false);
    });

    it('still refuses safely when reporting the refusal itself fails', async () => {
      // Telemetry is never worth breaking collection over.
      transport.reportShouldThrow = true;
      transport.outcome = {
        kind: 'PACK',
        pack: pack({ specs: [] }),
      };
      await expect(manager.update(WARD)).resolves.toMatchObject({ updated: false });
    });

    it('reports NO_PACK_YET when the first pack is already unusable', async () => {
      // Distinct from REJECTED: there is nothing to fall back to, so the mapper
      // cannot collect at all and needs telling, not a silent empty screen.
      transport.outcome = { kind: 'PACK', pack: pack({ specs: [] }) };
      const result = await manager.update(WARD);
      expect(result.reason).toBe('NO_PACK_YET');
      expect(result.pack).toBeNull();
    });
  });

  describe('connectivity', () => {
    it('keeps working offline with the pack it already has', async () => {
      transport.outcome = { kind: 'PACK', pack: pack() };
      await manager.update(WARD);

      transport.outcome = { kind: 'OFFLINE' };
      const result = await manager.update(WARD);

      expect(result.reason).toBe('OFFLINE');
      expect(result.pack?.packVersion).toBe('v1');
      expect(await manager.specFor(WARD, 'POI')).not.toBeNull();
    });

    it('survives a failed fetch without losing the current pack', async () => {
      transport.outcome = { kind: 'PACK', pack: pack() };
      await manager.update(WARD);

      transport.outcome = { kind: 'FAILED', error: 'HTTP 500' };
      const result = await manager.update(WARD);

      expect(result.reason).toBe('FETCH_FAILED');
      expect((await manager.current(WARD))?.packVersion).toBe('v1');
    });
  });

  it('serves specs by feature class from the live pack', async () => {
    transport.outcome = { kind: 'PACK', pack: pack() };
    await manager.update(WARD);
    const spec = await manager.specFor(WARD, 'WATER_POINT');
    expect(spec?.featureClass).toBe('WATER_POINT');
    expect(await manager.specFor(WARD, 'NOT_A_CLASS')).toBeNull();
  });

  it('returns null for a ward with no pack rather than inventing one', async () => {
    expect(await manager.current('unknown-ward')).toBeNull();
    expect(await manager.specFor('unknown-ward', 'POI')).toBeNull();
  });
});
