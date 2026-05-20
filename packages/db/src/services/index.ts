// =============================================================================
// @winback/db — service-layer surface.
//
// Services compose repositories + pure-math primitives into a single
// business operation.  They never open transactions; they always accept a
// `tx` argument and inherit the caller's tenant scope.
//
// First member: CustomerScoreService (Epic E session 2).
// =============================================================================

export {
  CustomerScoreService,
  type RecomputeArgs,
  type RecomputeAppliedResult,
  type RecomputeResult,
  type RecomputeSkippedResult,
} from './customer-score.service.js';

export {
  INSUFFICIENT_COHORT_THRESHOLD,
  STATE_BOUNDARIES_DAYS,
  assignFQuintile,
  assignMQuintile,
  assignRQuintile,
  computeChurnRiskScore,
  computeQuintileBoundaries,
  lurkerRDays,
  resolveLurker,
  resolveScorableCustomer,
  stateFromRecency,
  type CustomerStateValue,
  type QuintileBoundaries,
  type ResolvedCustomerScore,
} from './scoring-math.js';
