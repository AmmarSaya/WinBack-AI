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
