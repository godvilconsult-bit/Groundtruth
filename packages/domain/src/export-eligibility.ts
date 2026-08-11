import { isExportable } from './provenance.js';
import { ProvenanceContaminationError } from './errors.js';

/** The minimum a row must expose to be checked for export eligibility. */
export interface ExportCandidate {
  readonly id: string;
  readonly provenance: unknown;
}

/** Cap on ids carried in the error, to keep alert payloads and logs bounded. */
const MAX_REPORTED_IDS = 20;

/**
 * Gate every row entering a commercial export.
 *
 * Scans the whole batch before throwing so that the alert reports the true scale of
 * the contamination rather than the first row encountered. Knowing whether one row
 * or forty thousand rows are affected is the difference between a stray insert and a
 * broken pipeline, and that is the first question asked during the incident.
 *
 * Throws {@link ProvenanceContaminationError} if any row is not cleared. Returns
 * normally, and silently, otherwise — this is a guard, not a filter. It never
 * removes rows, because an export quietly missing rows is its own serious failure.
 *
 * See ADR-0001, layer 4.
 */
export function assertExportable(rows: Iterable<ExportCandidate>): void {
  const offendingIds: string[] = [];
  const offendingProvenance = new Set<string>();
  let offendingCount = 0;

  for (const row of rows) {
    if (isExportable(row.provenance)) continue;

    offendingCount += 1;
    if (offendingIds.length < MAX_REPORTED_IDS) offendingIds.push(row.id);
    offendingProvenance.add(
      typeof row.provenance === 'string' ? row.provenance : String(row.provenance),
    );
  }

  if (offendingCount > 0) {
    throw new ProvenanceContaminationError({
      offendingIds,
      offendingProvenance: [...offendingProvenance].sort(),
      offendingCount,
    });
  }
}
