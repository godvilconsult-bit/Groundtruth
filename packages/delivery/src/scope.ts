/**
 * API key scope enforcement.
 *
 * A key licenses a slice of the dataset: certain feature classes, a geographic
 * extent, a rate. That is not merely access control — it is the product shape. A
 * logistics customer buys access points and roads for Tanga, not everything.
 *
 * Every decision here is default-deny. A scope that cannot be evaluated is a scope
 * that refuses, because the alternative is a bug that silently ships unlicensed data
 * and is discovered by the customer rather than by us.
 */

import { isFeatureClass, type FeatureClass } from '@groundtruth/domain';

export interface BoundingBox {
  readonly minLon: number;
  readonly minLat: number;
  readonly maxLon: number;
  readonly maxLat: number;
}

export interface ApiKeyScope {
  readonly keyId: string;
  readonly customerName: string;
  /** Empty means every class. */
  readonly featureClasses: readonly FeatureClass[];
  /** Null means unrestricted. */
  readonly extent: BoundingBox | null;
  readonly rateLimitPerMinute: number;
  readonly active: boolean;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
}

export type ScopeDenial =
  | 'KEY_INACTIVE'
  | 'KEY_EXPIRED'
  | 'KEY_REVOKED'
  | 'CLASS_NOT_LICENSED'
  | 'OUTSIDE_LICENSED_EXTENT'
  | 'INVALID_BBOX';

export type ScopeDecision =
  | { readonly allowed: true; readonly featureClasses: readonly FeatureClass[]; readonly bbox: BoundingBox }
  | { readonly allowed: false; readonly denial: ScopeDenial; readonly detail: string };

export function isKeyUsable(scope: ApiKeyScope, now: number): ScopeDecision | null {
  if (scope.revokedAt !== null && scope.revokedAt <= now) {
    return { allowed: false, denial: 'KEY_REVOKED', detail: 'this key has been revoked' };
  }
  if (!scope.active) {
    return { allowed: false, denial: 'KEY_INACTIVE', detail: 'this key is not active' };
  }
  if (scope.expiresAt !== null && scope.expiresAt <= now) {
    return { allowed: false, denial: 'KEY_EXPIRED', detail: 'this key has expired' };
  }
  return null;
}

export function isValidBbox(bbox: BoundingBox): boolean {
  const values = [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat];
  if (!values.every(Number.isFinite)) return false;
  if (bbox.minLon < -180 || bbox.maxLon > 180) return false;
  if (bbox.minLat < -90 || bbox.maxLat > 90) return false;
  return bbox.minLon < bbox.maxLon && bbox.minLat < bbox.maxLat;
}

/** Intersection of two boxes, or null when they do not overlap. */
export function intersect(a: BoundingBox, b: BoundingBox): BoundingBox | null {
  const box: BoundingBox = {
    minLon: Math.max(a.minLon, b.minLon),
    minLat: Math.max(a.minLat, b.minLat),
    maxLon: Math.min(a.maxLon, b.maxLon),
    maxLat: Math.min(a.maxLat, b.maxLat),
  };
  return box.minLon < box.maxLon && box.minLat < box.maxLat ? box : null;
}

/**
 * Resolve a request against a key's scope.
 *
 * The request narrows; it can never widen. A caller asking for classes or an area
 * beyond their licence is REFUSED rather than quietly clipped: silently returning
 * less than asked for looks identical to "there is no data there", and a customer
 * would build on that false conclusion.
 */
export function resolveScope(args: {
  scope: ApiKeyScope;
  requestedClasses?: readonly string[];
  requestedBbox?: BoundingBox;
  now: number;
}): ScopeDecision {
  const unusable = isKeyUsable(args.scope, args.now);
  if (unusable) return unusable;

  const licensed = args.scope.featureClasses;

  let classes: FeatureClass[];
  if (!args.requestedClasses || args.requestedClasses.length === 0) {
    classes = licensed.length === 0 ? [] : [...licensed];
  } else {
    const requested = args.requestedClasses.filter(isFeatureClass);
    const unknown = args.requestedClasses.filter((c) => !isFeatureClass(c));
    if (unknown.length > 0) {
      return {
        allowed: false,
        denial: 'CLASS_NOT_LICENSED',
        detail: `unknown feature class: ${unknown.join(', ')}`,
      };
    }
    if (licensed.length > 0) {
      const forbidden = requested.filter((c) => !licensed.includes(c));
      if (forbidden.length > 0) {
        return {
          allowed: false,
          denial: 'CLASS_NOT_LICENSED',
          detail: `not licensed for: ${forbidden.join(', ')}`,
        };
      }
    }
    classes = requested;
  }

  const world: BoundingBox = { minLon: -180, minLat: -90, maxLon: 180, maxLat: 90 };
  const requestedBbox = args.requestedBbox ?? args.scope.extent ?? world;

  if (!isValidBbox(requestedBbox)) {
    return { allowed: false, denial: 'INVALID_BBOX', detail: 'bounding box is malformed' };
  }

  if (args.scope.extent) {
    const overlap = intersect(args.scope.extent, requestedBbox);
    if (!overlap) {
      return {
        allowed: false,
        denial: 'OUTSIDE_LICENSED_EXTENT',
        detail: 'requested area does not overlap the licensed extent',
      };
    }
    // Refuse rather than clip when the request reaches beyond the licence, so a
    // partial answer is never mistaken for a complete one.
    const reachesOutside =
      requestedBbox.minLon < args.scope.extent.minLon ||
      requestedBbox.maxLon > args.scope.extent.maxLon ||
      requestedBbox.minLat < args.scope.extent.minLat ||
      requestedBbox.maxLat > args.scope.extent.maxLat;
    if (reachesOutside) {
      return {
        allowed: false,
        denial: 'OUTSIDE_LICENSED_EXTENT',
        detail: 'requested area extends beyond the licensed extent',
      };
    }
  }

  return { allowed: true, featureClasses: classes, bbox: requestedBbox };
}
