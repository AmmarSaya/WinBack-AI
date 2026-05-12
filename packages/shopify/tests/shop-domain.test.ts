import { describe, expect, it } from 'vitest';

import { isValidShopDomain, normalizeShopDomain } from '../src/shop-domain.js';

describe('isValidShopDomain', () => {
  it('accepts canonical shop domains', () => {
    expect(isValidShopDomain('foo.myshopify.com')).toBe(true);
    expect(isValidShopDomain('my-store-123.myshopify.com')).toBe(true);
    expect(isValidShopDomain('a1b.myshopify.com')).toBe(true);
  });

  it('accepts case-insensitive', () => {
    expect(isValidShopDomain('Foo.MyShopify.com')).toBe(true);
  });

  it('rejects non-myshopify.com hosts', () => {
    expect(isValidShopDomain('attacker.com')).toBe(false);
    expect(isValidShopDomain('foo.evilshopify.com')).toBe(false);
    expect(isValidShopDomain('foo.myshopify.com.attacker.com')).toBe(false);
    expect(isValidShopDomain('myshopify.com')).toBe(false);
    expect(isValidShopDomain('.myshopify.com')).toBe(false);
  });

  it('rejects empty and oversized', () => {
    expect(isValidShopDomain('')).toBe(false);
    expect(isValidShopDomain('a'.repeat(256))).toBe(false);
  });

  it('rejects shops with invalid characters', () => {
    expect(isValidShopDomain('foo_bar.myshopify.com')).toBe(false);
    expect(isValidShopDomain('foo.bar.myshopify.com')).toBe(false);
    expect(isValidShopDomain('foo bar.myshopify.com')).toBe(false);
  });

  it('rejects shops starting/ending with hyphen', () => {
    expect(isValidShopDomain('-foo.myshopify.com')).toBe(false);
    expect(isValidShopDomain('foo-.myshopify.com')).toBe(false);
  });

  it('rejects non-string input safely', () => {
    expect(isValidShopDomain(null as unknown as string)).toBe(false);
    expect(isValidShopDomain(undefined as unknown as string)).toBe(false);
    expect(isValidShopDomain(123 as unknown as string)).toBe(false);
  });
});

describe('normalizeShopDomain', () => {
  it('lowercases a valid domain', () => {
    expect(normalizeShopDomain('Foo-Bar.MyShopify.com')).toBe('foo-bar.myshopify.com');
  });

  it('returns null for invalid input', () => {
    expect(normalizeShopDomain('attacker.com')).toBeNull();
    expect(normalizeShopDomain('')).toBeNull();
  });
});
