/**
 * Spec versions: `{feature_class}@{major}.{minor}`, e.g. `road_segment@2.1`.
 *
 * Versioning is per class, not global, so changing the POI schema does not
 * invalidate building footprints or force a full re-download over 2G. See ADR-0003.
 */

import { type FeatureClass, isFeatureClass } from './feature-class.js';

export interface SpecVersion {
  readonly raw: string;
  readonly featureClass: FeatureClass;
  readonly major: number;
  readonly minor: number;
}

const PATTERN = /^([a-z_]+)@(\d+)\.(\d+)$/;

export class InvalidSpecVersionError extends Error {
  readonly code = 'INVALID_SPEC_VERSION';
  constructor(value: string, detail: string) {
    super(`Invalid spec version "${value}": ${detail}`);
    this.name = 'InvalidSpecVersionError';
  }
}

/** Parse a spec version, or throw. */
export function parseSpecVersion(value: string): SpecVersion {
  const match = PATTERN.exec(value);
  if (!match) {
    throw new InvalidSpecVersionError(value, 'expected {feature_class}@{major}.{minor}');
  }

  const [, classPart, majorPart, minorPart] = match as unknown as [
    string, string, string, string,
  ];

  const featureClass = classPart.toUpperCase();
  if (!isFeatureClass(featureClass)) {
    throw new InvalidSpecVersionError(value, `unknown feature class "${classPart}"`);
  }

  // Leading zeros would make two distinct strings denote the same version, and
  // spec_version is stored as text and compared as text in places.
  if (majorPart.length > 1 && majorPart.startsWith('0')) {
    throw new InvalidSpecVersionError(value, 'major version has a leading zero');
  }
  if (minorPart.length > 1 && minorPart.startsWith('0')) {
    throw new InvalidSpecVersionError(value, 'minor version has a leading zero');
  }

  return Object.freeze({
    raw: value,
    featureClass,
    major: Number(majorPart),
    minor: Number(minorPart),
  });
}

/** Parse, returning null instead of throwing. */
export function trySpecVersion(value: string): SpecVersion | null {
  try {
    return parseSpecVersion(value);
  } catch {
    return null;
  }
}

export function formatSpecVersion(
  featureClass: FeatureClass,
  major: number,
  minor: number,
): string {
  if (!Number.isInteger(major) || major < 0) throw new RangeError('major must be a non-negative integer');
  if (!Number.isInteger(minor) || minor < 0) throw new RangeError('minor must be a non-negative integer');
  return `${featureClass.toLowerCase()}@${major}.${minor}`;
}

/**
 * Order two versions of the SAME class. Throws when the classes differ — there is
 * no meaningful ordering between `poi@3.0` and `water_point@1.0`, and silently
 * returning a number would let a sort produce confident nonsense.
 */
export function compareSpecVersions(a: SpecVersion, b: SpecVersion): number {
  if (a.featureClass !== b.featureClass) {
    throw new TypeError(
      `Cannot order spec versions of different classes: ${a.raw} and ${b.raw}`,
    );
  }
  return a.major - b.major || a.minor - b.minor;
}

/**
 * Whether a client built against `clientVersion` can faithfully collect under
 * `bundleVersion`.
 *
 * Minor versions are backward compatible by contract: additive fields, widened
 * enums, relaxed constraints. Majors are not, and a client below a major floor must
 * refuse the bundle and keep its last valid one — a half-rendered form produces
 * confidently wrong data, which is worse than no data and far more expensive to
 * detect later.
 */
export function isCompatible(clientVersion: SpecVersion, bundleVersion: SpecVersion): boolean {
  if (clientVersion.featureClass !== bundleVersion.featureClass) return false;
  if (clientVersion.major !== bundleVersion.major) return false;
  // A newer client reading an older bundle is fine; the reverse is fine too, because
  // tolerant readers preserve unknown keys verbatim rather than dropping them.
  return true;
}
