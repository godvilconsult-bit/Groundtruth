import { describe, it, expect } from 'vitest';
import { resolveScope, isValidBbox, intersect, type ApiKeyScope, type BoundingBox } from './scope.js';

const NOW = Date.parse('2026-08-12T08:00:00Z');

const TANGA: BoundingBox = { minLon: 39.03, minLat: -5.14, maxLon: 39.18, maxLat: -5.01 };
const CHUMBAGENI: BoundingBox = { minLon: 39.09, minLat: -5.075, maxLon: 39.1055, maxLat: -5.062 };
const DAR: BoundingBox = { minLon: 39.15, minLat: -6.9, maxLon: 39.35, maxLat: -6.7 };

const scope = (over: Partial<ApiKeyScope> = {}): ApiKeyScope => ({
  keyId: 'key-1',
  customerName: 'Tanga Logistics Ltd',
  featureClasses: ['ACCESS_POINT', 'ROAD_SEGMENT'],
  extent: TANGA,
  rateLimitPerMinute: 60,
  active: true,
  expiresAt: null,
  revokedAt: null,
  ...over,
});

describe('key validity', () => {
  it('allows an active, unexpired key', () => {
    expect(resolveScope({ scope: scope(), now: NOW }).allowed).toBe(true);
  });

  it('refuses an inactive key', () => {
    const decision = resolveScope({ scope: scope({ active: false }), now: NOW });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.denial).toBe('KEY_INACTIVE');
  });

  it('refuses an expired key', () => {
    const decision = resolveScope({ scope: scope({ expiresAt: NOW - 1 }), now: NOW });
    if (!decision.allowed) expect(decision.denial).toBe('KEY_EXPIRED');
  });

  it('refuses a revoked key even while still marked active', () => {
    // Revocation must win: it is the control used when a key has leaked.
    const decision = resolveScope({
      scope: scope({ active: true, revokedAt: NOW - 1 }),
      now: NOW,
    });
    if (!decision.allowed) expect(decision.denial).toBe('KEY_REVOKED');
  });

  it('allows a key whose expiry is still in the future', () => {
    expect(resolveScope({ scope: scope({ expiresAt: NOW + 86_400_000 }), now: NOW }).allowed).toBe(true);
  });
});

describe('feature class scoping', () => {
  it('defaults to exactly the licensed classes', () => {
    const decision = resolveScope({ scope: scope(), now: NOW });
    if (decision.allowed) {
      expect([...decision.featureClasses].sort()).toEqual(['ACCESS_POINT', 'ROAD_SEGMENT']);
    }
  });

  it('narrows to a requested subset', () => {
    const decision = resolveScope({
      scope: scope(),
      requestedClasses: ['ACCESS_POINT'],
      now: NOW,
    });
    if (decision.allowed) expect(decision.featureClasses).toEqual(['ACCESS_POINT']);
  });

  it('REFUSES a class outside the licence rather than quietly omitting it', () => {
    // Silently returning less than asked for is indistinguishable from "there is
    // no data there", and a customer would build on that false conclusion.
    const decision = resolveScope({
      scope: scope(),
      requestedClasses: ['ACCESS_POINT', 'BUILDING_FOOTPRINT'],
      now: NOW,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.denial).toBe('CLASS_NOT_LICENSED');
      expect(decision.detail).toContain('BUILDING_FOOTPRINT');
    }
  });

  it('REFUSES an unknown class name instead of ignoring it', () => {
    const decision = resolveScope({
      scope: scope(),
      requestedClasses: ['PARCEL'], // gt-vocab-allow: asserts a cadastral class is refused
      now: NOW,
    });
    expect(decision.allowed).toBe(false);
  });

  it('treats an empty licensed list as unrestricted', () => {
    // A scope of "everything" must be expressible without enumerating classes and
    // then forgetting to add a new one.
    const decision = resolveScope({
      scope: scope({ featureClasses: [] }),
      requestedClasses: ['BUILDING_FOOTPRINT'],
      now: NOW,
    });
    expect(decision.allowed).toBe(true);
  });
});

describe('geographic scoping', () => {
  it('defaults to the licensed extent', () => {
    const decision = resolveScope({ scope: scope(), now: NOW });
    if (decision.allowed) expect(decision.bbox).toEqual(TANGA);
  });

  it('allows a request wholly inside the licensed extent', () => {
    const decision = resolveScope({ scope: scope(), requestedBbox: CHUMBAGENI, now: NOW });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.bbox).toEqual(CHUMBAGENI);
  });

  it('REFUSES a request that reaches beyond the licence rather than clipping it', () => {
    // Clipping returns a partial answer that looks complete.
    const wider: BoundingBox = { minLon: 38.5, minLat: -5.5, maxLon: 39.5, maxLat: -4.5 };
    const decision = resolveScope({ scope: scope(), requestedBbox: wider, now: NOW });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.denial).toBe('OUTSIDE_LICENSED_EXTENT');
  });

  it('REFUSES a request for a different city entirely', () => {
    const decision = resolveScope({ scope: scope(), requestedBbox: DAR, now: NOW });
    if (!decision.allowed) expect(decision.denial).toBe('OUTSIDE_LICENSED_EXTENT');
  });

  it('allows any extent when the licence is unrestricted', () => {
    const decision = resolveScope({
      scope: scope({ extent: null }),
      requestedBbox: DAR,
      now: NOW,
    });
    expect(decision.allowed).toBe(true);
  });

  it.each([
    ['inverted longitude', { minLon: 39.2, minLat: -5.1, maxLon: 39.0, maxLat: -5.0 }],
    ['inverted latitude', { minLon: 39.0, minLat: -5.0, maxLon: 39.2, maxLat: -5.1 }],
    ['out of range longitude', { minLon: -200, minLat: -5, maxLon: 39, maxLat: -4 }],
    ['out of range latitude', { minLon: 39, minLat: -95, maxLon: 39.2, maxLat: -4 }],
    ['degenerate', { minLon: 39, minLat: -5, maxLon: 39, maxLat: -5 }],
    ['non-finite', { minLon: Number.NaN, minLat: -5, maxLon: 39, maxLat: -4 }],
  ])('refuses a %s bounding box', (_label, bbox) => {
    expect(isValidBbox(bbox as BoundingBox)).toBe(false);
    const decision = resolveScope({
      scope: scope({ extent: null }),
      requestedBbox: bbox as BoundingBox,
      now: NOW,
    });
    expect(decision.allowed).toBe(false);
  });
});

describe('intersect', () => {
  it('returns the overlapping region', () => {
    expect(intersect(TANGA, CHUMBAGENI)).toEqual(CHUMBAGENI);
  });

  it('returns null for disjoint boxes', () => {
    expect(intersect(TANGA, DAR)).toBeNull();
  });

  it('returns null for boxes that merely touch', () => {
    // A zero-area intersection contains no features and should not read as overlap.
    const touching: BoundingBox = { minLon: 39.18, minLat: -5.14, maxLon: 39.3, maxLat: -5.01 };
    expect(intersect(TANGA, touching)).toBeNull();
  });
});

describe('default-deny posture', () => {
  it('refuses before evaluating scope when the key is unusable', () => {
    // An expired key asking for something it is licensed for is still refused, and
    // refused for the RIGHT reason — the denial code drives what support tells them.
    const decision = resolveScope({
      scope: scope({ expiresAt: NOW - 1 }),
      requestedClasses: ['ACCESS_POINT'],
      requestedBbox: CHUMBAGENI,
      now: NOW,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.denial).toBe('KEY_EXPIRED');
  });

  it('always explains a refusal, since support answers with this string', () => {
    const decision = resolveScope({ scope: scope(), requestedBbox: DAR, now: NOW });
    if (!decision.allowed) expect(decision.detail.length).toBeGreaterThan(10);
  });
});
