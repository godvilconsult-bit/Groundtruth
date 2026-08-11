/** Base class for violations of a domain invariant. */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Raised when a row whose provenance is not cleared for commercial export reaches
 * the export pipeline.
 *
 * This is a terminal, non-recoverable condition. It must abort the export job, emit
 * a critical alert, and leave no partial output. It must never be caught and
 * downgraded to a filter — a caller that "handles" this by skipping the offending
 * row has converted a licence-contamination alarm into silent data loss, and has
 * hidden the fact that contaminated rows are reachable from the export path at all.
 *
 * See ADR-0001, layer 4.
 */
export class ProvenanceContaminationError extends DomainError {
  readonly code = 'PROVENANCE_CONTAMINATION';

  /** Ids of the offending rows, capped for log safety. */
  readonly offendingIds: readonly string[];
  /** The distinct disallowed provenance values encountered. */
  readonly offendingProvenance: readonly string[];
  /** Total number of offending rows, which may exceed `offendingIds.length`. */
  readonly offendingCount: number;

  constructor(args: {
    offendingIds: readonly string[];
    offendingProvenance: readonly string[];
    offendingCount: number;
  }) {
    super(
      `Export blocked: ${args.offendingCount} row(s) carry provenance not cleared ` +
        `for commercial export [${args.offendingProvenance.join(', ')}]. ` +
        `This is a licence-contamination guard (ADR-0001); do not suppress it.`,
    );
    this.offendingIds = Object.freeze([...args.offendingIds]);
    this.offendingProvenance = Object.freeze([...args.offendingProvenance]);
    this.offendingCount = args.offendingCount;
  }
}
