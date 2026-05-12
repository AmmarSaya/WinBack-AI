import { ValidationError } from '@winback/errors';
import { describe, expect, it } from 'vitest';

import { applyWriteHooks } from '../src/extensions/hooks.js';
import { withTenantScope } from '../src/tenant-scope.js';

describe('AiTone validation in extension write hooks', () => {
  it('rejects invalid style value', async () => {
    await withTenantScope('m_1', async () => {
      expect(() =>
        applyWriteHooks(
          'MerchantSettings',
          { where: { merchantId: 'm_1' }, data: { aiTone: { style: 'NOT_A_STYLE' } } },
          'update',
        ),
      ).toThrow(ValidationError);
    });
  });

  it('rejects unknown keys (strict mode)', async () => {
    await withTenantScope('m_1', async () => {
      expect(() =>
        applyWriteHooks(
          'MerchantSettings',
          {
            where: { merchantId: 'm_1' },
            data: { aiTone: { style: 'casual', maliciousField: 'x' } },
          },
          'update',
        ),
      ).toThrow(ValidationError);
    });
  });

  it('accepts a valid aiTone and applies defaults', async () => {
    await withTenantScope('m_1', async () => {
      const result = applyWriteHooks(
        'MerchantSettings',
        {
          where: { merchantId: 'm_1' },
          data: { aiTone: { style: 'casual' } } as Record<string, unknown>,
        },
        'update',
      );
      // The validator mutates the result's data block — defaults applied
      // (avoid/emphasize=[], emojiPolicy='minimal'). The original input
      // reference is not affected because the data block was copied during
      // tenant-id injection.
      const resultData = result.data as Record<string, unknown>;
      expect(resultData['aiTone']).toMatchObject({
        style: 'casual',
        emojiPolicy: 'minimal',
        avoid: [],
        emphasize: [],
      });
    });
  });

  it('allows null to clear aiTone', async () => {
    await withTenantScope('m_1', async () => {
      expect(() =>
        applyWriteHooks(
          'MerchantSettings',
          { where: { merchantId: 'm_1' }, data: { aiTone: null } },
          'update',
        ),
      ).not.toThrow();
    });
  });

  it('skips validation if aiTone is absent from data', async () => {
    await withTenantScope('m_1', async () => {
      expect(() =>
        applyWriteHooks(
          'MerchantSettings',
          { where: { merchantId: 'm_1' }, data: { monthlySendsCap: 5000 } },
          'update',
        ),
      ).not.toThrow();
    });
  });

  it('validates aiTone inside upsert create/update blocks', async () => {
    await withTenantScope('m_1', async () => {
      expect(() =>
        applyWriteHooks(
          'MerchantSettings',
          {
            where: { merchantId: 'm_1' },
            create: { aiTone: { style: 'INVALID' } },
            update: {},
          },
          'upsert',
        ),
      ).toThrow(ValidationError);
    });
  });

  it('does NOT validate aiTone on non-MerchantSettings models', async () => {
    await withTenantScope('m_1', async () => {
      // Even if some other model had an `aiTone` field (it shouldn't), the
      // validator only fires on MerchantSettings.
      expect(() =>
        applyWriteHooks(
          'Customer',
          { data: { shopifyCustomerId: 'sc_1', aiTone: { bogus: true } } },
          'create',
        ),
      ).not.toThrow(ValidationError);
    });
  });
});
