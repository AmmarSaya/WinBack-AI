import { describe, expect, it } from 'vitest';

import { applyReadHooks } from '../src/extensions/hooks.js';
import { withTenantScope } from '../src/tenant-scope.js';

describe('soft-delete filter', () => {
  it('injects deletedAt: null on Customer reads', async () => {
    await withTenantScope('m_1', async () => {
      const result = applyReadHooks('Customer', { where: {} });
      expect(result.where).toMatchObject({ deletedAt: null });
    });
  });

  it('injects deletedAt: null on Product reads', async () => {
    await withTenantScope('m_1', async () => {
      const result = applyReadHooks('Product', { where: {} });
      expect(result.where).toMatchObject({ deletedAt: null });
    });
  });

  it('injects deletedAt: null on ProductVariant reads', async () => {
    await withTenantScope('m_1', async () => {
      const result = applyReadHooks('ProductVariant', { where: {} });
      expect(result.where).toMatchObject({ deletedAt: null });
    });
  });

  it('preserves explicit deletedAt: { not: null } (read deleted rows)', async () => {
    await withTenantScope('m_1', async () => {
      const result = applyReadHooks('Customer', { where: { deletedAt: { not: null } } });
      expect(result.where).toMatchObject({ deletedAt: { not: null } });
    });
  });

  it('preserves explicit deletedAt: null', async () => {
    await withTenantScope('m_1', async () => {
      const result = applyReadHooks('Customer', { where: { deletedAt: null, state: 'lost' } });
      expect(result.where).toMatchObject({ deletedAt: null, state: 'lost' });
    });
  });

  it('does NOT inject deletedAt on Order reads (not a soft-delete model)', async () => {
    await withTenantScope('m_1', async () => {
      const result = applyReadHooks('Order', { where: {} });
      expect(result.where).not.toHaveProperty('deletedAt');
    });
  });

  it('does NOT inject deletedAt on OutboxEvent reads', async () => {
    await withTenantScope('m_1', async () => {
      const result = applyReadHooks('OutboxEvent', { where: {} });
      expect(result.where).not.toHaveProperty('deletedAt');
    });
  });
});
