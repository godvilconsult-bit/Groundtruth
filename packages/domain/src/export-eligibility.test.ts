import { describe, it, expect } from 'vitest';
import { assertExportable, type ExportCandidate } from './export-eligibility.js';
import { ProvenanceContaminationError } from './errors.js';
import { PROVENANCE } from './provenance.js';

const clean = (id: string): ExportCandidate => ({
  id,
  provenance: PROVENANCE.FIELD_COLLECTED,
});

const osm = (id: string): ExportCandidate => ({
  id,
  provenance: PROVENANCE.OSM_ODBL,
});

describe('assertExportable — the ODbL contamination guard (ADR-0001, layer 4)', () => {
  it('passes a batch of exclusively field-collected rows', () => {
    expect(() =>
      assertExportable([clean('a'), clean('b'), clean('c')]),
    ).not.toThrow();
  });

  it('passes an empty batch', () => {
    expect(() => assertExportable([])).not.toThrow();
  });

  it('passes a mix of all four cleared provenance values', () => {
    expect(() =>
      assertExportable([
        { id: 'a', provenance: PROVENANCE.FIELD_COLLECTED },
        { id: 'b', provenance: PROVENANCE.DRONE_DERIVED },
        { id: 'c', provenance: PROVENANCE.LICENSED_THIRD_PARTY },
        { id: 'd', provenance: PROVENANCE.PUBLIC_DOMAIN },
      ]),
    ).not.toThrow();
  });

  // This is the test the brief demands: an OSM_ODBL row must cause a hard failure.
  it('HARD FAILS when a single OSM_ODBL row is present among thousands', () => {
    const batch: ExportCandidate[] = [];
    for (let i = 0; i < 5_000; i += 1) batch.push(clean(`clean-${i}`));
    batch.splice(3_197, 0, osm('contaminated-row'));

    expect(() => assertExportable(batch)).toThrow(ProvenanceContaminationError);
  });

  it('HARD FAILS when the contaminated row is first', () => {
    expect(() => assertExportable([osm('x'), clean('y')])).toThrow(
      ProvenanceContaminationError,
    );
  });

  it('HARD FAILS when the contaminated row is last', () => {
    expect(() => assertExportable([clean('y'), osm('x')])).toThrow(
      ProvenanceContaminationError,
    );
  });

  it('names the offending provenance and row in the error', () => {
    try {
      assertExportable([clean('ok'), osm('bad-row')]);
      expect.unreachable('guard must throw');
    } catch (error) {
      const e = error as ProvenanceContaminationError;
      expect(e).toBeInstanceOf(ProvenanceContaminationError);
      expect(e.code).toBe('PROVENANCE_CONTAMINATION');
      expect(e.offendingIds).toEqual(['bad-row']);
      expect(e.offendingProvenance).toEqual(['OSM_ODBL']);
      expect(e.offendingCount).toBe(1);
      expect(e.message).toContain('Export blocked');
      expect(e.message).toContain('OSM_ODBL');
    }
  });

  it('reports the true scale of contamination, not just the first hit', () => {
    const batch = [clean('a'), osm('b'), osm('c'), clean('d'), osm('e')];
    try {
      assertExportable(batch);
      expect.unreachable('guard must throw');
    } catch (error) {
      const e = error as ProvenanceContaminationError;
      expect(e.offendingCount).toBe(3);
      expect(e.offendingIds).toEqual(['b', 'c', 'e']);
    }
  });

  it('caps reported ids at 20 while still counting all of them', () => {
    const batch = Array.from({ length: 100 }, (_, i) => osm(`bad-${i}`));
    try {
      assertExportable(batch);
      expect.unreachable('guard must throw');
    } catch (error) {
      const e = error as ProvenanceContaminationError;
      expect(e.offendingCount).toBe(100);
      expect(e.offendingIds).toHaveLength(20);
    }
  });

  it('HARD FAILS on a null or missing provenance rather than treating it as clean', () => {
    // A row that lost its provenance in a join is exactly as dangerous as one
    // labelled OSM_ODBL: we cannot prove it is licensable.
    expect(() => assertExportable([{ id: 'a', provenance: null }])).toThrow(
      ProvenanceContaminationError,
    );
    expect(() => assertExportable([{ id: 'b', provenance: undefined }])).toThrow(
      ProvenanceContaminationError,
    );
  });

  it('HARD FAILS on an unrecognised provenance value', () => {
    expect(() =>
      assertExportable([{ id: 'a', provenance: 'SCRAPED_FROM_A_COMPETITOR' }]),
    ).toThrow(ProvenanceContaminationError);
  });

  it('is case-sensitive — a lowercase value is not a cleared value', () => {
    expect(() =>
      assertExportable([{ id: 'a', provenance: 'field_collected' }]),
    ).toThrow(ProvenanceContaminationError);
  });

  it('does not filter: a passing batch is left entirely untouched', () => {
    // The guard must never silently drop rows. An export missing rows without
    // anyone noticing is its own serious failure.
    const batch = [clean('a'), clean('b')];
    const before = structuredClone(batch);
    assertExportable(batch);
    expect(batch).toEqual(before);
  });

  it('works over a generator, not just an array', () => {
    function* rows(): Generator<ExportCandidate> {
      yield clean('a');
      yield osm('b');
    }
    expect(() => assertExportable(rows())).toThrow(ProvenanceContaminationError);
  });
});
