import { aiToneSchema } from '@winback/contracts';
import { ValidationError } from '@winback/errors';
import { getLogger } from '@winback/logger';

import { TenantScopeError } from '../errors.js';
import {
  SOFT_DELETE_MODELS,
  TENANT_OPTIONAL_READ_MODELS,
  TENANT_SCOPED_MODELS,
  UNSCOPED_MODELS,
  getTenantScope,
} from '../tenant-scope.js';

/**
 * Pure logic functions extracted from `winback-extension.ts`.
 *
 * Extracting them here gives us:
 *   - Unit tests without a real Prisma client (see `packages/db/tests/`).
 *   - Single source of truth for behavior — the extension wiring just calls
 *     these.
 *   - Clear public surface for `tx.$extends(winbackExtension)` to consume.
 *
 * No Prisma client is imported here. The functions take loosely-typed args
 * and return modified args (or throw). The extension wiring casts in/out.
 */

const log = getLogger('db.extension');

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type WhereLike = Record<string, unknown> | undefined;
export type DataLike =
  | Record<string, unknown>
  | Record<string, unknown>[]
  | undefined;
export interface ReadArgs { where?: WhereLike }
export interface WriteArgs {
  where?: WhereLike;
  data?: DataLike;
  create?: DataLike;
  update?: DataLike;
}

// ---------------------------------------------------------------------------
// Top-level orchestrators (one each for reads and writes)
// ---------------------------------------------------------------------------

export function applyReadHooks(
  model: string,
  args: ReadArgs,
  options: { findUnique?: boolean } = {},
): ReadArgs {
  if (UNSCOPED_MODELS.has(model)) return args;
  let next = enforceTenantScopeOnRead(model, args, options.findUnique === true);
  next = applySoftDeleteFilter(model, next);
  return next;
}

export function applyWriteHooks(
  model: string,
  args: WriteArgs,
  operation: string,
): WriteArgs {
  if (UNSCOPED_MODELS.has(model)) return args;
  let next = enforceTenantScopeOnWrite(model, args, operation);
  next = validateModelSpecific(model, next);
  return next;
}

// ---------------------------------------------------------------------------
// Tenant scope
// ---------------------------------------------------------------------------

export function enforceTenantScopeOnRead(
  model: string,
  args: ReadArgs,
  isFindUnique: boolean,
): ReadArgs {
  const scope = getTenantScope();
  if (scope === undefined) {
    throw new TenantScopeError(
      `Read on ${model} attempted with no active scope. ` +
        'Wrap in withTenantScope(merchantId, fn) or withSystemScope(reason, fn).',
      { context: { model, operation: 'read' } },
    );
  }
  if (scope.kind === 'system') return args;

  if (model === 'Merchant') {
    // In tenant scope, every Merchant read MUST be keyed by id === active
    // merchant. Two failure modes are blocked here:
    //
    //   1. `where` has no `id` (findFirst/findMany OR findUnique-by-shop):
    //      pre-S-3, findUnique({where:{shop:X}}) silently passed through
    //      because the `!isFindUnique` exception below treated all
    //      findUnique calls as already-tenant-bound. That assumption only
    //      holds for unique tuples that include merchantId; Merchant's
    //      `shop` unique key does NOT include the tenant. Cross-tenant
    //      read by shop was the leak the exception enabled. Fixed by
    //      dropping the exception — `id === undefined` always throws here.
    //   2. `where.id` is some other merchant's id: cross-tenant read.
    //
    // Legitimate `merchant.findUnique({where:{id: scope.merchantId}})`
    // (self-lookup) still passes — id matches the active scope.
    //
    // Cross-tenant Merchant reads (operator dashboards, install lookup
    // by shop, GDPR processor) MUST open withSystemScope; the early
    // return at line 89 above handles that path.
    const id = args.where?.id;
    if (id === undefined) {
      throw new TenantScopeError(
        `Unscoped Merchant read in tenant scope (${scope.merchantId}). ` +
          'Use withSystemScope for cross-tenant Merchant reads.',
        { context: { model, scope: scope.merchantId } },
      );
    }
    if (id !== scope.merchantId) {
      throw new TenantScopeError(
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Forensic operator-debug message on `unknown ${id}`; `[object Object]` IS the signal that an unexpected shape arrived at the tenant-scope boundary. JSON.stringify could throw on circular/null-proto values; disable is the safer surface.
        `Cross-tenant Merchant read: scope=${scope.merchantId}, requested=${String(id)}`,
        { context: { model } },
      );
    }
    return args;
  }

  if (!TENANT_SCOPED_MODELS.has(model) && !TENANT_OPTIONAL_READ_MODELS.has(model)) {
    return args;
  }

  // findUnique on tenant-scoped models requires the unique tuple in `where`,
  // which already includes merchantId. Skip injection.
  if (isFindUnique) return args;

  const where = (args.where ?? {});
  const existing = where.merchantId;
  if (existing === undefined) {
    return { ...args, where: { ...where, merchantId: scope.merchantId } };
  }
  if (existing !== scope.merchantId) {
    throw new TenantScopeError(
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Forensic operator-debug message on `unknown ${existing}` at the tenant-scope-mismatch boundary; `[object Object]` IS the signal that an unexpected shape arrived. JSON.stringify could throw on circular/null-proto values.
      `Tenant scope mismatch on ${model}: scope=${scope.merchantId}, where.merchantId=${String(existing)}`,
      { context: { model } },
    );
  }
  return args;
}

export function enforceTenantScopeOnWrite(
  model: string,
  args: WriteArgs,
  operation: string,
): WriteArgs {
  const scope = getTenantScope();
  if (scope === undefined) {
    throw new TenantScopeError(
      `Write on ${model} (${operation}) attempted with no active scope.`,
      { context: { model, operation } },
    );
  }
  if (scope.kind === 'system') return args;

  if (model === 'Merchant') {
    const where = args.where;
    const data = args.data as Record<string, unknown> | undefined;
    const targetId = where?.id ?? data?.id;
    if (targetId !== undefined && targetId !== scope.merchantId) {
      throw new TenantScopeError(
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Forensic operator-debug message on `unknown ${targetId}` at the cross-tenant-write boundary; `[object Object]` IS the signal that an unexpected shape arrived. JSON.stringify could throw on circular/null-proto values.
        `Cross-tenant Merchant write: scope=${scope.merchantId}, target=${String(targetId)}`,
        { context: { model, operation } },
      );
    }
    return args;
  }

  if (!TENANT_SCOPED_MODELS.has(model) && !TENANT_OPTIONAL_READ_MODELS.has(model)) {
    return args;
  }

  let next: WriteArgs = args;

  if (args.data !== undefined) {
    next = { ...next, data: injectMerchantIdIntoData(model, args.data, scope.merchantId) };
  }
  if (args.create !== undefined) {
    next = {
      ...next,
      create: injectMerchantIdIntoData(model, args.create, scope.merchantId),
    };
  }
  if (args.update !== undefined) {
    const update = args.update as Record<string, unknown>;
    if (update.merchantId !== undefined && update.merchantId !== scope.merchantId) {
      throw new TenantScopeError(
        `Upsert update block carries cross-tenant merchantId on ${model}`,
        { context: { model, operation } },
      );
    }
  }
  if (args.where !== undefined) {
    const where = args.where;
    const existing = where.merchantId;
    if (existing === undefined) {
      next = { ...next, where: { ...where, merchantId: scope.merchantId } };
    } else if (existing !== scope.merchantId) {
      throw new TenantScopeError(
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Forensic operator-debug message on `unknown ${existing}` at the tenant-scope-write-mismatch boundary; `[object Object]` IS the signal that an unexpected shape arrived. JSON.stringify could throw on circular/null-proto values.
        `Tenant scope mismatch on ${model} (${operation}): scope=${scope.merchantId}, where.merchantId=${String(existing)}`,
        { context: { model, operation } },
      );
    }
  }
  return next;
}

function injectMerchantIdIntoData(
  model: string,
  data: DataLike,
  scopeMerchantId: string,
): DataLike {
  if (data === undefined) return data;
  if (Array.isArray(data)) {
    return data.map((row) => injectIntoRow(model, row, scopeMerchantId));
  }
  return injectIntoRow(model, data, scopeMerchantId);
}

function injectIntoRow(
  model: string,
  row: Record<string, unknown>,
  scopeMerchantId: string,
): Record<string, unknown> {
  const existing = row.merchantId;
  if (existing === undefined) {
    return { ...row, merchantId: scopeMerchantId };
  }
  if (existing !== scopeMerchantId) {
    throw new TenantScopeError(
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Forensic operator-debug message on `unknown ${existing}` at the write-data-tenant-mismatch boundary; `[object Object]` IS the signal that an unexpected shape arrived. JSON.stringify could throw on circular/null-proto values.
      `Write data on ${model} carries cross-tenant merchantId: scope=${scopeMerchantId}, data.merchantId=${String(existing)}`,
      { context: { model } },
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// Soft delete
// ---------------------------------------------------------------------------

export function applySoftDeleteFilter(model: string, args: ReadArgs): ReadArgs {
  if (!SOFT_DELETE_MODELS.has(model)) return args;
  const where = (args.where ?? {});
  if ('deletedAt' in where) return args;
  return { ...args, where: { ...where, deletedAt: null } };
}

// ---------------------------------------------------------------------------
// Model-specific validation (AiTone)
// ---------------------------------------------------------------------------

export function validateModelSpecific(model: string, args: WriteArgs): WriteArgs {
  if (model !== 'MerchantSettings') return args;
  validateAiToneInWriteBlock(args.data);
  validateAiToneInWriteBlock(args.create);
  validateAiToneInWriteBlock(args.update);
  return args;
}

function validateAiToneInWriteBlock(block: DataLike): void {
  if (block === undefined) return;
  if (Array.isArray(block)) {
    for (const row of block) validateAiToneInRow(row);
    return;
  }
  validateAiToneInRow(block);
}

export function validateAiToneInRow(row: Record<string, unknown>): void {
  if (!('aiTone' in row)) return;
  const value = row.aiTone;
  if (value === null) return;
  const result = aiToneSchema.safeParse(value);
  if (!result.success) {
    const fields: Record<string, string> = {};
    for (const issue of result.error.issues) {
      fields[issue.path.join('.')] = issue.message;
    }
    log.warn({ fields }, 'MerchantSettings.aiTone validation rejected write');
    throw new ValidationError('Invalid aiTone configuration', {
      code: 'merchant_settings.ai_tone_invalid',
      fields,
      cause: result.error,
    });
  }
  row.aiTone = result.data;
}
