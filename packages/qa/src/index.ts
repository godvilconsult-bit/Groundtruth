export {
  REASON,
  PASS,
  flag,
  reject,
  type StageVerdict,
  type ReasonCode,
  type StageOutcome,
  type QaObservation,
  type CollectorProfile,
  type WardEnvelope,
  type QaContext,
} from './types.js';

export {
  QaPipeline,
  stage,
  type QaStage,
  type StageRecord,
  type PipelineResult,
  type PipelineMetrics,
} from './pipeline.js';

export {
  geometricPlausibility,
  footprintOverlap,
  distanceMetres,
  ACCURACY_FLAG_M,
  ACCURACY_REJECT_M,
  ACCURACY_IMPLAUSIBLE_M,
  WARD_SLACK_DEGREES,
  WARD_FAR_DEGREES,
} from './stages/geometric.js';

export {
  temporalPlausibility,
  WALKING_FLAG_MPS,
  VEHICLE_FLAG_MPS,
  IMPOSSIBLE_MPS,
  CLOCK_SKEW_FLAG_MS,
  MIN_DWELL_MS,
} from './stages/temporal.js';

export {
  reputationRouting,
  resurveySelection,
  resurveyRateFor,
  RESURVEY_POLICY_V1,
  PROVEN_THRESHOLD,
  PROVEN_REVIEW_RATE,
  ANOMALOUS_ACCEPTANCE_RATE,
  MIN_SAMPLE_FOR_ANOMALY,
  type ResurveyPolicy,
} from './stages/reputation.js';
