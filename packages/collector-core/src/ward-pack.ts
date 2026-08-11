/**
 * Ward packs: everything a collector needs to work offline in one assignment area.
 *
 * A pack carries the spec bundle in force for that ward, the accepted features
 * already known there, and the ward's own extent for orientation. It is fetched with
 * an ETag so an unchanged pack costs one conditional request rather than a download
 * over 2G.
 *
 * The rule that governs acceptance, from ADR-0003:
 *
 *   **A client that cannot faithfully render a bundle refuses it and continues on
 *   its last valid one.**
 *
 * Not "renders what it can". A partially-rendered form produces confidently wrong
 * data, which is worse than no data and far more expensive to detect — the mapper
 * answers what they are shown, the server accepts it, and the error surfaces months
 * later as an inexplicable disagreement rate.
 */

import type { FeatureClassSpec, WidgetType } from '@groundtruth/spec';
import { SUPPORTED_WIDGETS } from './form-model.js';

/** Ward extent for orientation. Operational geofence, never a land determination. */
export interface WardExtent {
  readonly wardId: string;
  readonly nameSw: string;
  readonly nameEn: string;
  /** GeoJSON geometry of the administrative area (DECISIONS D-004). */
  readonly outline: Readonly<Record<string, unknown>>;
}

export interface KnownFeature {
  readonly id: string;
  readonly featureClass: string;
  readonly lon: number;
  readonly lat: number;
  readonly confidenceScore: number | null;
  readonly lastVerifiedAt: string | null;
}

export interface WardPack {
  readonly wardId: string;
  /** Opaque server version; also the ETag value. */
  readonly packVersion: string;
  readonly generatedAt: string;
  readonly extent: WardExtent;
  readonly specs: readonly FeatureClassSpec[];
  /** Minimum app version required by the strictest spec in this bundle. */
  readonly minAppVersion: string;
  readonly knownFeatures: readonly KnownFeature[];
  readonly sizeBytes: number;
}

export type PackRejectionReason =
  | 'APP_TOO_OLD'
  | 'UNSUPPORTED_WIDGET'
  | 'EMPTY_SPEC_BUNDLE'
  | 'WARD_MISMATCH';

export type PackDecision =
  | { readonly accept: true }
  | {
      readonly accept: false;
      readonly reason: PackRejectionReason;
      /** Reported to the server so a bad rollout is visible centrally, not just locally. */
      readonly detail: string;
    };

/**
 * Compare `1.2.3`-style versions. Returns <0, 0, >0.
 *
 * Deliberately strict: a malformed version is not silently treated as 0.0.0, because
 * that would make an unparseable `min_app_version` look satisfiable by every client.
 */
export function compareAppVersions(a: string, b: string): number {
  const parse = (v: string): number[] => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    if (!match) throw new TypeError(`malformed app version "${v}"`);
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const [aMajor, aMinor, aPatch] = parse(a) as [number, number, number];
  const [bMajor, bMinor, bPatch] = parse(b) as [number, number, number];
  return aMajor - bMajor || aMinor - bMinor || aPatch - bPatch;
}

export interface EvaluateOptions {
  readonly appVersion: string;
  readonly expectedWardId?: string;
  readonly supportedWidgets?: ReadonlySet<WidgetType>;
}

/**
 * Decide whether this client may adopt a pack.
 *
 * Every rejection names a reason, because "the app stopped updating" with no
 * explanation is indistinguishable from a broken device to the person holding it,
 * and indistinguishable from a broken server to whoever they call.
 */
export function evaluatePack(pack: WardPack, options: EvaluateOptions): PackDecision {
  const widgets = options.supportedWidgets ?? SUPPORTED_WIDGETS;

  if (options.expectedWardId && pack.wardId !== options.expectedWardId) {
    return {
      accept: false,
      reason: 'WARD_MISMATCH',
      detail: `pack is for ward ${pack.wardId}, device is assigned ${options.expectedWardId}`,
    };
  }

  if (pack.specs.length === 0) {
    // Adopting this would leave a mapper with no forms at all, and would look like
    // the app breaking rather than a bad publish.
    return { accept: false, reason: 'EMPTY_SPEC_BUNDLE', detail: 'pack contains no specs' };
  }

  let required: string;
  try {
    // The strictest floor across the bundle governs, not the pack's own claim: a
    // manifest that under-reports its requirement must not slip a form past us.
    required = pack.specs
      .map((s) => s.minAppVersion)
      .reduce((strictest, candidate) =>
        compareAppVersions(candidate, strictest) > 0 ? candidate : strictest,
      );
    if (compareAppVersions(options.appVersion, required) < 0) {
      return {
        accept: false,
        reason: 'APP_TOO_OLD',
        detail: `pack needs app ${required}, device has ${options.appVersion}`,
      };
    }
  } catch (error) {
    return {
      accept: false,
      reason: 'APP_TOO_OLD',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const unsupported = new Set<string>();
  for (const spec of pack.specs) {
    for (const field of spec.uiHints.fields) {
      if (!widgets.has(field.widget)) unsupported.add(String(field.widget));
    }
  }
  if (unsupported.size > 0) {
    return {
      accept: false,
      reason: 'UNSUPPORTED_WIDGET',
      detail: `cannot render widgets: ${[...unsupported].sort().join(', ')}`,
    };
  }

  return { accept: true };
}

/** Persistence port. IndexedDB/OPFS on device, memory in tests. */
export interface WardPackStore {
  load(wardId: string): Promise<WardPack | null>;
  save(pack: WardPack): Promise<void>;
}

export class MemoryWardPackStore implements WardPackStore {
  readonly #packs = new Map<string, WardPack>();
  async load(wardId: string): Promise<WardPack | null> {
    return this.#packs.get(wardId) ?? null;
  }
  async save(pack: WardPack): Promise<void> {
    this.#packs.set(pack.wardId, pack);
  }
}

/** What a fetch attempt produced. `NOT_MODIFIED` is the common, cheap case. */
export type PackFetchOutcome =
  | { readonly kind: 'PACK'; readonly pack: WardPack }
  | { readonly kind: 'NOT_MODIFIED' }
  | { readonly kind: 'OFFLINE' }
  | { readonly kind: 'FAILED'; readonly error: string };

export interface WardPackTransport {
  /** Conditional GET. `etag` is the current pack version, or null when we have none. */
  fetchPack(wardId: string, etag: string | null): Promise<PackFetchOutcome>;
  /** Report a refusal so a bad rollout is visible centrally. Best-effort. */
  reportRejection?(wardId: string, decision: PackDecision): Promise<void>;
}

export interface PackUpdateResult {
  readonly updated: boolean;
  readonly reason:
    | 'ADOPTED'
    | 'ALREADY_CURRENT'
    | 'OFFLINE'
    | 'FETCH_FAILED'
    | 'REJECTED'
    | 'NO_PACK_YET';
  readonly decision?: PackDecision;
  readonly pack: WardPack | null;
}

export class WardPackManager {
  readonly #store: WardPackStore;
  readonly #transport: WardPackTransport;
  readonly #appVersion: string;

  constructor(args: { store: WardPackStore; transport: WardPackTransport; appVersion: string }) {
    this.#store = args.store;
    this.#transport = args.transport;
    this.#appVersion = args.appVersion;
  }

  current(wardId: string): Promise<WardPack | null> {
    return this.#store.load(wardId);
  }

  /**
   * Check for a newer pack and adopt it only if this client can render it.
   *
   * A refusal is never destructive: the existing pack stays in place and the mapper
   * keeps working. A ward with a bad publish loses a schema update, not a day.
   */
  async update(wardId: string): Promise<PackUpdateResult> {
    const existing = await this.#store.load(wardId);
    const outcome = await this.#transport.fetchPack(wardId, existing?.packVersion ?? null);

    switch (outcome.kind) {
      case 'NOT_MODIFIED':
        return { updated: false, reason: 'ALREADY_CURRENT', pack: existing };

      case 'OFFLINE':
        return { updated: false, reason: 'OFFLINE', pack: existing };

      case 'FAILED':
        return { updated: false, reason: 'FETCH_FAILED', pack: existing };

      case 'PACK': {
        const decision = evaluatePack(outcome.pack, {
          appVersion: this.#appVersion,
          expectedWardId: wardId,
        });

        if (!decision.accept) {
          // Report, then carry on with what we have. Reporting is best-effort: a
          // failure to tell the server must not also cost the mapper their pack.
          try {
            await this.#transport.reportRejection?.(wardId, decision);
          } catch {
            /* telemetry is never worth breaking collection over */
          }
          return {
            updated: false,
            reason: existing ? 'REJECTED' : 'NO_PACK_YET',
            decision,
            pack: existing,
          };
        }

        await this.#store.save(outcome.pack);
        return { updated: true, reason: 'ADOPTED', decision, pack: outcome.pack };
      }

      default:
        return { updated: false, reason: 'FETCH_FAILED', pack: existing };
    }
  }

  /** Spec for a class from the live pack, or null when the ward has no pack yet. */
  async specFor(wardId: string, featureClass: string): Promise<FeatureClassSpec | null> {
    const pack = await this.#store.load(wardId);
    return pack?.specs.find((s) => s.featureClass === featureClass) ?? null;
  }
}
