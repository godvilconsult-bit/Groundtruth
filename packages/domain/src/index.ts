export {
  PROVENANCE,
  ALL_PROVENANCE,
  EXPORTABLE_PROVENANCE,
  isProvenance,
  isExportable,
  type Provenance,
} from './provenance.js';

export { DomainError, ProvenanceContaminationError } from './errors.js';

export { assertExportable, type ExportCandidate } from './export-eligibility.js';

export {
  NON_CADASTRAL_DISCLAIMER,
  NON_CADASTRAL_DISCLAIMER_SW,
} from './disclaimer.js';

export {
  FEATURE_CLASS,
  ALL_FEATURE_CLASSES,
  AREAL_CLASSES,
  GEOMETRY_TYPE,
  isFeatureClass,
  requiredGeometryType,
  geometryMatchesClass,
  type FeatureClass,
  type GeometryType,
} from './feature-class.js';

export {
  parseSpecVersion,
  trySpecVersion,
  formatSpecVersion,
  compareSpecVersions,
  isCompatible,
  InvalidSpecVersionError,
  type SpecVersion,
} from './spec-version.js';

export {
  computeConfidence,
  CONFIDENCE_FORMULA_VERSION,
  type ConfidenceInputs,
  type ConfidenceBreakdown,
} from './confidence.js';

export {
  matchToleranceM,
  distanceMetres,
  isSameFeature,
  clusterObservations,
  type MatchCandidate,
} from './matching.js';
