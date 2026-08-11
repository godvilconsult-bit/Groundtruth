/**
 * Provenance — the origin of a geometry, and the licence obligations that travel
 * with it.
 *
 * Every geometry-bearing row in the system carries a non-null provenance. This is
 * the single most legally consequential field in the data model: it is what keeps
 * ODbL-licensed OpenStreetMap data out of the proprietary canonical dataset.
 *
 * See ADR-0001 for the full segregation strategy.
 */

export const PROVENANCE = {
  /** Walked and recorded by a Ground Truth field collector. */
  FIELD_COLLECTED: 'FIELD_COLLECTED',
  /** Derived from imagery captured by a Ground Truth or contracted drone flight. */
  DRONE_DERIVED: 'DRONE_DERIVED',
  /** Licensed from a third party under terms permitting commercial redistribution. */
  LICENSED_THIRD_PARTY: 'LICENSED_THIRD_PARTY',
  /**
   * OpenStreetMap, under the Open Database Licence.
   *
   * Share-alike. Permitted for basemap tiles and navigation reference only, and
   * only within the `osm_reference` schema. Must never enter the canonical dataset
   * and must never reach an export. Present in this enum so that reference rows can
   * be labelled honestly — not because it is ever a valid value in `gt`.
   */
  OSM_ODBL: 'OSM_ODBL',
  /** Public domain, with the source recorded in the row's attribution metadata. */
  PUBLIC_DOMAIN: 'PUBLIC_DOMAIN',
} as const;

export type Provenance = (typeof PROVENANCE)[keyof typeof PROVENANCE];

export const ALL_PROVENANCE: readonly Provenance[] = Object.freeze(
  Object.values(PROVENANCE),
);

/**
 * Provenance values permitted in a commercial export.
 *
 * This is an allow-list, not a deny-list, and that is deliberate. A deny-list
 * (`!== 'OSM_ODBL'`) silently admits any provenance value added to the enum in
 * future — the failure mode is a new share-alike source leaking into paid exports
 * because nobody remembered to update a negation. Default-deny means a new value is
 * non-exportable until someone states otherwise in code review.
 */
export const EXPORTABLE_PROVENANCE: ReadonlySet<Provenance> = Object.freeze(
  new Set<Provenance>([
    PROVENANCE.FIELD_COLLECTED,
    PROVENANCE.DRONE_DERIVED,
    PROVENANCE.LICENSED_THIRD_PARTY,
    PROVENANCE.PUBLIC_DOMAIN,
  ]),
);

export function isProvenance(value: unknown): value is Provenance {
  return typeof value === 'string' && (ALL_PROVENANCE as string[]).includes(value);
}

/**
 * True only for provenance values explicitly cleared for commercial export.
 * Unknown or malformed values are never exportable.
 */
export function isExportable(value: unknown): boolean {
  return isProvenance(value) && EXPORTABLE_PROVENANCE.has(value);
}
