import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyShopifyOAuthHmac, verifyShopifyWebhookHmac } from '../src/hmac.js';

const SECRET = 'test_secret';

function shopifyOauthHmac(query: Record<string, string>): string {
  const message = Object.entries(query)
    .filter(([k]) => k !== 'hmac' && k !== 'signature')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return createHmac('sha256', SECRET).update(message).digest('hex');
}

describe('verifyShopifyOAuthHmac', () => {
  it('accepts a canonical valid OAuth query', () => {
    const query = {
      code: 'abc123',
      shop: 'foo.myshopify.com',
      state: 'csrf_nonce',
      timestamp: '1700000000',
    };
    const hmac = shopifyOauthHmac(query);
    expect(verifyShopifyOAuthHmac(SECRET, { ...query, hmac })).toBe(true);
  });

  it('rejects when hmac is missing', () => {
    expect(
      verifyShopifyOAuthHmac(SECRET, { shop: 'foo.myshopify.com', timestamp: '1' }),
    ).toBe(false);
  });

  it('rejects when hmac is empty string', () => {
    expect(
      verifyShopifyOAuthHmac(SECRET, {
        shop: 'foo.myshopify.com',
        timestamp: '1',
        hmac: '',
      }),
    ).toBe(false);
  });

  it('rejects a tampered query', () => {
    const query = { shop: 'foo.myshopify.com', timestamp: '1700000000' };
    const hmac = shopifyOauthHmac(query);
    // Change shop after computing HMAC
    expect(
      verifyShopifyOAuthHmac(SECRET, {
        shop: 'evil.myshopify.com',
        timestamp: '1700000000',
        hmac,
      }),
    ).toBe(false);
  });

  it('excludes hmac and signature from canonicalized message', () => {
    const query = { shop: 'foo.myshopify.com', timestamp: '1700000000' };
    const hmac = shopifyOauthHmac(query);
    // Including a `signature` param should NOT change the HMAC result.
    expect(
      verifyShopifyOAuthHmac(SECRET, {
        ...query,
        signature: 'ignored_value',
        hmac,
      }),
    ).toBe(true);
  });

  it('handles unsorted keys (verifier must sort internally)', () => {
    const query = { z_last: 'z', a_first: 'a', m_mid: 'm' };
    const hmac = shopifyOauthHmac(query);
    expect(
      verifyShopifyOAuthHmac(SECRET, {
        m_mid: 'm',
        z_last: 'z',
        a_first: 'a',
        hmac,
      }),
    ).toBe(true);
  });

  it('rejects on wrong secret', () => {
    const query = { shop: 'foo.myshopify.com', timestamp: '1' };
    const hmac = shopifyOauthHmac(query);
    expect(verifyShopifyOAuthHmac('different_secret', { ...query, hmac })).toBe(false);
  });
});

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
