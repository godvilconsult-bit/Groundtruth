/**
 * The QA pipeline runner.
 *
 * Stages are composable and ordered, each producing a verdict and reason codes. The
 * runner records per-stage metrics because the pipeline's own behaviour is
 * operational data: a stage that starts rejecting 40% of a ward's submissions is
 * either catching a real collection problem or is itself broken, and you cannot tell
 * which without the numbers.
 *
 * Deliberately free of BullMQ, Redis and PostgreSQL. Phase 3's workers wrap this;
 * the decisions live here so they can be tested exhaustively in milliseconds rather
 * than against a queue.
 */

import { isExportable } from '@groundtruth/domain';
import {
  REASON,
  type QaObservation,
  type QaContext,
  type StageOutcome,
  type StageVerdict,
  type ReasonCode,
} from './types.js';

export interface QaStage {
  readonly name: string;
  run(observation: QaObservation, context: QaContext): StageOutcome;
}

export interface StageRecord {
  readonly stage: string;
  readonly verdict: StageVerdict;
  readonly reasons: readonly { code: ReasonCode; detail: string }[];
}

export interface PipelineResult {
  readonly observationId: string;
  /** ACCEPTED only when every stage passed and nothing flagged. */
  readonly verdict: StageVerdict;
  readonly stages: readonly StageRecord[];
  readonly reasonCodes: readonly ReasonCode[];
  /** True when a human must adjudicate before this can become canonical. */
  readonly needsReview: boolean;
  /** True when re-survey sampling selected this feature. */
  readonly selectedForResurvey: boolean;
}

export interface PipelineMetrics {
  readonly processed: number;
  readonly accepted: number;
  readonly flagged: number;
  readonly rejected: number;
  /** Per stage: how often it passed, flagged, rejected. */
  readonly byStage: Readonly<Record<string, { pass: number; flag: number; reject: number }>>;
  /** Reason code frequencies — the distribution R-007 needs to detect gaming. */
  readonly byReason: Readonly<Record<string, number>>;
}

export class QaPipeline {
  readonly #stages: readonly QaStage[];

  #processed = 0;
  #accepted = 0;
  #flagged = 0;
  #rejected = 0;
  readonly #byStage = new Map<string, { pass: number; flag: number; reject: number }>();
  readonly #byReason = new Map<string, number>();

  constructor(stages: readonly QaStage[]) {
    if (stages.length === 0) {
      // A pipeline with no stages would accept everything while looking like it
      // was checking. Better to refuse to exist.
      throw new TypeError('a QA pipeline needs at least one stage');
    }
    this.#stages = stages;
  }

  /**
   * Run every stage in order.
   *
   * A REJECT stops the pipeline: later stages cannot make a definitionally invalid
   * observation valid, and running them would only add noise to the reason-code
   * distribution.
   *
   * A FLAG does NOT stop it. Every flag is collected, because a reviewer opening an
   * observation should see all of what is wrong with it, not the first thing.
   */
  run(observation: QaObservation, context: QaContext): PipelineResult {
    const records: StageRecord[] = [];
    const reasonCodes: ReasonCode[] = [];
    let verdict: StageVerdict = 'PASS';

    // The provenance guard runs first and unconditionally. It should never fire —
    // the database CHECK constraint makes OSM_ODBL unwritable in gt — but a guard
    // that only runs where it is expected to be needed is not a guard (ADR-0001).
    if (!isExportable(observation.provenance)) {
      const record: StageRecord = {
        stage: 'provenance-guard',
        verdict: 'REJECT',
        reasons: [
          {
            code: REASON.PROVENANCE_NOT_EXPORTABLE,
            detail: `provenance ${String(observation.provenance)} is not cleared for the canonical dataset`,
          },
        ],
      };
      this.#record(record);
      this.#processed += 1;
      this.#rejected += 1;
      return {
        observationId: observation.id,
        verdict: 'REJECT',
        stages: [record],
        reasonCodes: [REASON.PROVENANCE_NOT_EXPORTABLE],
        needsReview: false,
        selectedForResurvey: false,
      };
    }

    for (const stage of this.#stages) {
      const outcome = stage.run(observation, context);
      const record: StageRecord = {
        stage: stage.name,
        verdict: outcome.verdict,
        reasons: outcome.reasons,
      };
      records.push(record);
      this.#record(record);

      for (const reason of outcome.reasons) reasonCodes.push(reason.code);

      if (outcome.verdict === 'REJECT') {
        verdict = 'REJECT';
        break;
      }
      if (outcome.verdict === 'FLAG') verdict = 'FLAG';
    }

    this.#processed += 1;
    if (verdict === 'REJECT') this.#rejected += 1;
    else if (verdict === 'FLAG') this.#flagged += 1;
    else this.#accepted += 1;

    return {
      observationId: observation.id,
      verdict,
      stages: records,
      reasonCodes,
      needsReview: verdict === 'FLAG',
      selectedForResurvey: reasonCodes.includes(REASON.RESURVEY_SELECTED),
    };
  }

  #record(record: StageRecord): void {
    const counts = this.#byStage.get(record.stage) ?? { pass: 0, flag: 0, reject: 0 };
    if (record.verdict === 'PASS') counts.pass += 1;
    else if (record.verdict === 'FLAG') counts.flag += 1;
    else counts.reject += 1;
    this.#byStage.set(record.stage, counts);

    for (const reason of record.reasons) {
      this.#byReason.set(reason.code, (this.#byReason.get(reason.code) ?? 0) + 1);
    }
  }

  metrics(): PipelineMetrics {
    return Object.freeze({
      processed: this.#processed,
      accepted: this.#accepted,
      flagged: this.#flagged,
      rejected: this.#rejected,
      byStage: Object.freeze(Object.fromEntries(this.#byStage)),
      byReason: Object.freeze(Object.fromEntries(this.#byReason)),
    });
  }
}

/** Wrap a plain function as a named stage. */
export function stage(
  name: string,
  run: (observation: QaObservation, context: QaContext) => StageOutcome,
): QaStage {
  return { name, run };
}
