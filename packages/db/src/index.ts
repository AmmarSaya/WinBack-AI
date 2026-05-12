// =============================================================================
// @winback/db — public surface
//
// The factory + extension are intentionally hidden from direct import.
// Consumers receive the typed extended client via createWinbackPrisma; they
// do NOT instantiate PrismaClient themselves and do NOT see the raw client.
//
// Tenant + audit scopes are exported as the single sanctioned way to set
// boundary context. Repositories are the typed write chokepoints.
// =============================================================================

// --- Client factory ---------------------------------------------------------
export { createWinbackPrisma, type WinbackPrisma, type CreateWinbackPrismaOptions } from './client.js';

// --- Tenant scoping ---------------------------------------------------------
export {
  withTenantScope,
  withSystemScope,
  getTenantScope,
  assertScopeMatchesMerchant,
  type TenantScope,
  TENANT_SCOPED_MODELS,
  TENANT_OPTIONAL_READ_MODELS,
  SOFT_DELETE_MODELS,
  UNSCOPED_MODELS,
} from './tenant-scope.js';

// --- Audit scoping ----------------------------------------------------------
export { withAudit, getAuditContext, type AuditContext } from './audit-scope.js';

// --- Unit of work + outbox event registry -----------------------------------
export {
  UnitOfWork,
  UnitOfWorkContext,
  UNIT_OF_WORK_DEFAULTS,
  type UnitOfWorkOptions,
  OUTBOX_EVENTS,
  type OutboxEventType,
} from './unit-of-work.js';

// --- Errors -----------------------------------------------------------------
export { TenantScopeError } from './errors.js';

// --- Repositories -----------------------------------------------------------
export * from './repositories/index.js';
