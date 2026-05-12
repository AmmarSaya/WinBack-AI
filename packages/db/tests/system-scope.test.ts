import { describe, expect, it } from 'vitest';

import { TenantScopeError } from '../src/errors.js';
import { getTenantScope, withSystemScope, withTenantScope } from '../src/tenant-scope.js';

describe('withSystemScope reason validation', () => {
  it('rejects empty string', async () => {
    await expect(withSystemScope('', async () => undefined)).rejects.toThrow(TenantScopeError);
  });

  it('rejects whitespace-only', async () => {
    await expect(withSystemScope('   ', async () => undefined)).rejects.toThrow(
      TenantScopeError,
    );
  });

  it('rejects a single word with no dot', async () => {
    await expect(withSystemScope('system', async () => undefined)).rejects.toThrow(
      TenantScopeError,
    );
  });

  it('rejects uppercase or special chars', async () => {
    await expect(withSystemScope('Fix-bug', async () => undefined)).rejects.toThrow(
      TenantScopeError,
    );
    await expect(withSystemScope('outbox drain', async () => undefined)).rejects.toThrow(
      TenantScopeError,
    );
    await expect(withSystemScope('CRON.cleanup', async () => undefined)).rejects.toThrow(
      TenantScopeError,
    );
  });

  it('accepts proper category.action format', async () => {
    const observed: string[] = [];
    for (const reason of [
      'outbox.drain',
      'cron.idempotency_cleanup',
      'shopify.install',
      'operator.admin_query',
      'gdpr.shop_redact',
    ]) {
      await withSystemScope(reason, async () => {
        const scope = getTenantScope();
        if (scope?.kind === 'system') observed.push(scope.reason);
      });
    }
    expect(observed).toEqual([
      'outbox.drain',
      'cron.idempotency_cleanup',
      'shopify.install',
      'operator.admin_query',
      'gdpr.shop_redact',
    ]);
  });
});

describe('nested tenant scope rules', () => {
  it('allows nested tenant scope with the same merchantId', async () => {
    await withTenantScope('m_1', async () => {
      await withTenantScope('m_1', async () => {
        expect(getTenantScope()).toEqual({ kind: 'tenant', merchantId: 'm_1' });
      });
    });
  });

  it('rejects nested tenant scope with a different merchantId', async () => {
    await withTenantScope('m_1', async () => {
      await expect(
        withTenantScope('m_2', async () => undefined),
      ).rejects.toThrow(TenantScopeError);
    });
  });
});
