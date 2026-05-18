import { describe, expect, it } from 'vitest';

import { TenantScopeError } from '../src/errors.js';
import { applyReadHooks, applyWriteHooks } from '../src/extensions/hooks.js';
import { withSystemScope, withTenantScope } from '../src/tenant-scope.js';

describe('tenant scope — reads', () => {
  it('throws when no scope is active', () => {
    expect(() => applyReadHooks('Customer', { where: {} })).toThrow(TenantScopeError);
  });

  it('auto-injects merchantId in tenant scope', async () => {
    await withTenantScope('m_1', async () => {
      const result = applyReadHooks('Customer', { where: { state: 'active' } });
      expect(result.where).toMatchObject({ merchantId: 'm_1', state: 'active' });
    });
  });

  it('rejects cross-tenant where.merchantId', async () => {
    await withTenantScope('m_1', async () => {
      expect(() =>
        applyReadHooks('Customer', { where: { merchantId: 'm_2' } }),
      ).toThrow(TenantScopeError);
    });
  });

  it('allows matching where.merchantId', async () => {
    await withTenantScope('m_1', async () => {
      const result = applyReadHooks('Customer', { where: { merchantId: 'm_1' } });
      expect(result.where).toMatchObject({ merchantId: 'm_1' });
    });
  });

  it('system scope bypasses tenant assertion but soft-delete still applies', async () => {
    await withSystemScope('test.scenario', async () => {
      const result = applyReadHooks('Customer', { where: {} });
      // No merchantId injection (system scope), but soft-delete is
      // independent of scope and still filters on `deletedAt: null`.
      expect(result.where).toEqual({ deletedAt: null });
      expect(result.where).not.toHaveProperty('merchantId');
    });
  });

  it('Merchant reads must target the active id in tenant scope', async () => {
    await withTenantScope('m_1', async () => {
      expect(() => applyReadHooks('Merchant', { where: { id: 'm_2' } })).toThrow(
        TenantScopeError,
      );
    });
  });

  it('unscoped Merchant read throws in tenant scope', async () => {
    await withTenantScope('m_1', async () => {
      expect(() => applyReadHooks('Merchant', { where: {} })).toThrow(TenantScopeError);
    });
  });

  // ----- S-3 regression coverage -----
  // Pre-S-3, the Merchant branch skipped its id check when `isFindUnique`
  // was true — so `findUnique({where:{shop:X}})` in tenant scope silently
  // returned another tenant's Merchant row. The fix removed that exception;
  // now every Merchant read in tenant scope requires `where.id ===
  // scope.merchantId`. The three tests below lock that contract.

  it('S-3: Merchant findUnique-by-shop throws in tenant scope (was silent leak pre-fix)', async () => {
    await withTenantScope('m_1', async () => {
      expect(() =>
        applyReadHooks('Merchant', { where: { shop: 'other.myshopify.com' } }, { findUnique: true }),
      ).toThrow(TenantScopeError);
    });
  });

  it('S-3: Merchant findUnique with cross-tenant id throws in tenant scope', async () => {
    await withTenantScope('m_1', async () => {
      expect(() =>
        applyReadHooks('Merchant', { where: { id: 'm_2' } }, { findUnique: true }),
      ).toThrow(TenantScopeError);
    });
  });

  it('S-3: Merchant findUnique self-lookup (id === scope) still passes', async () => {
    await withTenantScope('m_1', async () => {
      const result = applyReadHooks(
        'Merchant',
        { where: { id: 'm_1' } },
        { findUnique: true },
      );
      expect(result.where).toMatchObject({ id: 'm_1' });
    });
  });

  it('UNSCOPED model (Session) passes through untouched', async () => {
    await withTenantScope('m_1', async () => {
      const result = applyReadHooks('Session', { where: { shop: 'foo.myshopify.com' } });
      expect(result).toEqual({ where: { shop: 'foo.myshopify.com' } });
    });
  });
});

describe('tenant scope — writes', () => {
  it('throws when no scope is active', () => {
    expect(() => applyWriteHooks('Customer', { data: { shopifyCustomerId: 'x' } }, 'create')).toThrow(
      TenantScopeError,
    );
  });

  it('auto-injects merchantId into data', async () => {
    await withTenantScope('m_1', async () => {
      const result = applyWriteHooks(
        'Customer',
        { data: { shopifyCustomerId: 'sc_1' } },
        'create',
      );
      expect(result.data).toMatchObject({ merchantId: 'm_1', shopifyCustomerId: 'sc_1' });
    });
  });

  it('throws on cross-tenant data.merchantId', async () => {
    await withTenantScope('m_1', async () => {
      expect(() =>
        applyWriteHooks(
          'Customer',
          { data: { merchantId: 'm_2', shopifyCustomerId: 'sc_1' } },
          'create',
        ),
      ).toThrow(TenantScopeError);
    });
  });

  it('createMany injects merchantId into every row', async () => {
    await withTenantScope('m_1', async () => {
      const result = applyWriteHooks(
        'Customer',
        { data: [{ shopifyCustomerId: 'sc_1' }, { shopifyCustomerId: 'sc_2' }] },
        'createMany',
      );
      expect(result.data).toEqual([
        { merchantId: 'm_1', shopifyCustomerId: 'sc_1' },
        { merchantId: 'm_1', shopifyCustomerId: 'sc_2' },
      ]);
    });
  });

  it('throws on cross-tenant createMany row', async () => {
    await withTenantScope('m_1', async () => {
      expect(() =>
        applyWriteHooks(
          'Customer',
          { data: [{ shopifyCustomerId: 'sc_1' }, { merchantId: 'm_2', shopifyCustomerId: 'sc_2' }] },
          'createMany',
        ),
      ).toThrow(TenantScopeError);
    });
  });
});

/**
 * AuditLog (and other TENANT_OPTIONAL_READ_MODELS) write enforcement.
 *
 * These tests pin the behavior described in the model-classification
 * comment at the top of tenant-scope.ts: the "READ" in the set name
 * refers to the cross-tenant ALLOWANCE on reads (system scope can span
 * tenants), not to the write side. Writes still go through
 * enforceTenantScopeOnWrite — merchantId is injected/asserted in tenant
 * scope, and only system scope can write `null` or cross-tenant rows.
 *
 * Without these tests the behavior is comment-asserted only, which is
 * exactly the failure mode the project is set up to eliminate.
 */
describe('AuditLog write enforcement (TENANT_OPTIONAL_READ_MODELS)', () => {
  it('throws when no scope is active', () => {
    expect(() =>
      applyWriteHooks('AuditLog', { data: { action: 'x.y' } }, 'create'),
    ).toThrow(TenantScopeError);
  });

  it('auto-injects merchantId in tenant scope when absent', async () => {
    await withTenantScope('m_1', async () => {
      const result = applyWriteHooks('AuditLog', { data: { action: 'x.y' } }, 'create');
      expect(result.data).toMatchObject({ merchantId: 'm_1', action: 'x.y' });
    });
  });

  it('passes matching merchantId through in tenant scope', async () => {
    await withTenantScope('m_1', async () => {
      const result = applyWriteHooks(
        'AuditLog',
        { data: { merchantId: 'm_1', action: 'x.y' } },
        'create',
      );
      expect(result.data).toMatchObject({ merchantId: 'm_1' });
    });
  });

  it('throws on cross-tenant data.merchantId in tenant scope', async () => {
    await withTenantScope('m_1', async () => {
      expect(() =>
        applyWriteHooks(
          'AuditLog',
          { data: { merchantId: 'm_2', action: 'x.y' } },
          'create',
        ),
      ).toThrow(TenantScopeError);
    });
  });

  it('throws on explicit merchantId=null in tenant scope (mismatch with active tenant)', async () => {
    // Important: tenant-scope code paths cannot write tombstone rows.
    // The only legal way to write merchantId=null is system scope.
    await withTenantScope('m_1', async () => {
      expect(() =>
        applyWriteHooks(
          'AuditLog',
          { data: { merchantId: null, action: 'x.y' } },
          'create',
        ),
      ).toThrow(TenantScopeError);
    });
  });

  it('passes through unmodified in system scope (including merchantId=null)', async () => {
    await withSystemScope('test.audit_passthrough', async () => {
      const a = applyWriteHooks('AuditLog', { data: { action: 'x.y' } }, 'create');
      const b = applyWriteHooks(
        'AuditLog',
        { data: { merchantId: null, action: 'x.y' } },
        'create',
      );
      const c = applyWriteHooks(
        'AuditLog',
        { data: { merchantId: 'm_42', action: 'x.y' } },
        'create',
      );
      expect(a.data).toEqual({ action: 'x.y' });
      expect(b.data).toEqual({ merchantId: null, action: 'x.y' });
      expect(c.data).toEqual({ merchantId: 'm_42', action: 'x.y' });
    });
  });
});
