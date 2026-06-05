import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyShopifyWebhookHmac } from '../src/hmac.js';

// The pre-B4 `verifyShopifyOAuthHmac` + `canonicalizeQueryForHmac` tests
// were removed alongside the legacy code-grant deletion (M-8 Commit 4 /
// audit L2-H1 closure). Only the live webhook HMAC verification remains.

const SECRET = 'test_secret';

describe('verifyShopifyWebhookHmac', () => {
  const body = '{"order":{"id":12345,"total":"99.00"}}';
  const expected = createHmac('sha256', SECRET).update(body).digest('base64');

  it('accepts matching base64 header on raw body', () => {
    expect(verifyShopifyWebhookHmac(SECRET, body, expected)).toBe(true);
  });

  it('rejects empty header value', () => {
    expect(verifyShopifyWebhookHmac(SECRET, body, '')).toBe(false);
  });

  it('rejects body modified by one byte', () => {
    const modified = body.replace('99.00', '00.99');
    expect(verifyShopifyWebhookHmac(SECRET, modified, expected)).toBe(false);
  });

  it('accepts Buffer raw body', () => {
    expect(
      verifyShopifyWebhookHmac(SECRET, Buffer.from(body, 'utf8'), expected),
    ).toBe(true);
  });

  it('rejects garbage header without throwing', () => {
    expect(verifyShopifyWebhookHmac(SECRET, body, 'not_base64!!!')).toBe(false);
  });
});
