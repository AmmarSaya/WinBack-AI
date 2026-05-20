import { describe, expect, it } from 'vitest';

import {
  buildCustomerStateChangedPayload,
  customerStateChangedPayloadSchema,
  customerStateValues,
} from '../src/events/customer-state-changed.js';

/**
 * Unit tests for the customer.state_changed outbox event payload helper +
 * Zod schema.  These guard the BigInt → string conversion (standing rule
 * #19) and the producer-side contract that consumers (Epic G) will rely
 * on at consume time.
 */

const VALID_INPUT = {
  merchantId: 'm_1',
  customerId: 'cust_1',
  shopifyCustomerId: 'gid://shopify/Customer/12345',
  oldState: 'active' as const,
  newState: 'warm' as const,
  computedAt: new Date('2026-05-20T12:00:00.000Z'),
  rfmScore: {
    rDays: 45,
    fCount: 3,
    mCents: 19995n,
    rQuintile: 3,
    fQuintile: 4,
    mQuintile: 4,
  },
};

describe('buildCustomerStateChangedPayload', () => {
  it('converts BigInt mCents to a decimal-digit string (rule #19)', () => {
    const payload = buildCustomerStateChangedPayload(VALID_INPUT);
    expect(payload.rfmScore.mCents).toBe('19995');
    expect(typeof payload.rfmScore.mCents).toBe('string');
  });

  it('converts computedAt Date to ISO 8601 string in UTC', () => {
    const payload = buildCustomerStateChangedPayload(VALID_INPUT);
    expect(payload.computedAt).toBe('2026-05-20T12:00:00.000Z');
  });

  it('mCents = 0n → "0" (lurker case, valid)', () => {
    const payload = buildCustomerStateChangedPayload({
      ...VALID_INPUT,
      rfmScore: { ...VALID_INPUT.rfmScore, mCents: 0n, fCount: 0 },
    });
    expect(payload.rfmScore.mCents).toBe('0');
  });

  it('large mCents (BigInt > Number.MAX_SAFE_INTEGER) preserves precision', () => {
    const big = 9_999_999_999_999_999n; // exceeds 2^53
    const payload = buildCustomerStateChangedPayload({
      ...VALID_INPUT,
      rfmScore: { ...VALID_INPUT.rfmScore, mCents: big },
    });
    expect(payload.rfmScore.mCents).toBe('9999999999999999');
  });

  it('null quintiles pass through (insufficient_data / lurker payload)', () => {
    const payload = buildCustomerStateChangedPayload({
      ...VALID_INPUT,
      newState: 'insufficient_data',
      rfmScore: {
        ...VALID_INPUT.rfmScore,
        rQuintile: null,
        fQuintile: null,
        mQuintile: null,
      },
    });
    expect(payload.rfmScore.rQuintile).toBeNull();
    expect(payload.rfmScore.fQuintile).toBeNull();
    expect(payload.rfmScore.mQuintile).toBeNull();
    expect(payload.newState).toBe('insufficient_data');
  });

  it('every CustomerState enum value is accepted by the schema', () => {
    // Locks the CustomerState enum surface against drift between
    // schema.prisma + the local duplicate in events/customer-state-changed.ts.
    expect(customerStateValues).toEqual([
      'active',
      'warm',
      'at_risk',
      'dormant',
      'lost',
      'insufficient_data',
    ]);
  });
});

describe('customerStateChangedPayloadSchema validation', () => {
  function validPayload() {
    return buildCustomerStateChangedPayload(VALID_INPUT);
  }

  it('valid payload parses cleanly', () => {
    expect(() => customerStateChangedPayloadSchema.parse(validPayload())).not.toThrow();
  });

  it('rejects non-numeric mCents string ("19.95" with decimal point)', () => {
    const payload = validPayload();
    expect(() =>
      customerStateChangedPayloadSchema.parse({
        ...payload,
        rfmScore: { ...payload.rfmScore, mCents: '19.95' },
      }),
    ).toThrow();
  });

  it('rejects negative mCents ("-100")', () => {
    const payload = validPayload();
    expect(() =>
      customerStateChangedPayloadSchema.parse({
        ...payload,
        rfmScore: { ...payload.rfmScore, mCents: '-100' },
      }),
    ).toThrow();
  });

  it('rejects shopifyCustomerId without gid:// prefix', () => {
    const payload = validPayload();
    expect(() =>
      customerStateChangedPayloadSchema.parse({
        ...payload,
        shopifyCustomerId: '12345',
      }),
    ).toThrow();
  });

  it('rejects shopifyCustomerId with wrong resource type (gid://shopify/Order/...)', () => {
    const payload = validPayload();
    expect(() =>
      customerStateChangedPayloadSchema.parse({
        ...payload,
        shopifyCustomerId: 'gid://shopify/Order/12345',
      }),
    ).toThrow();
  });

  it('rejects quintile = 0 (out of 1..5 range)', () => {
    const payload = validPayload();
    expect(() =>
      customerStateChangedPayloadSchema.parse({
        ...payload,
        rfmScore: { ...payload.rfmScore, rQuintile: 0 },
      }),
    ).toThrow();
  });

  it('rejects quintile = 6 (out of 1..5 range)', () => {
    const payload = validPayload();
    expect(() =>
      customerStateChangedPayloadSchema.parse({
        ...payload,
        rfmScore: { ...payload.rfmScore, mQuintile: 6 },
      }),
    ).toThrow();
  });

  it('rejects negative rDays', () => {
    const payload = validPayload();
    expect(() =>
      customerStateChangedPayloadSchema.parse({
        ...payload,
        rfmScore: { ...payload.rfmScore, rDays: -1 },
      }),
    ).toThrow();
  });

  it('rejects extra top-level keys (strict mode)', () => {
    const payload = validPayload();
    expect(() =>
      customerStateChangedPayloadSchema.parse({
        ...payload,
        unknownExtra: 'should-fail',
      } as unknown),
    ).toThrow();
  });

  it('rejects invalid CustomerState value', () => {
    const payload = validPayload();
    expect(() =>
      customerStateChangedPayloadSchema.parse({
        ...payload,
        newState: 'super_active',
      }),
    ).toThrow();
  });

  it('rejects unparseable computedAt string', () => {
    const payload = validPayload();
    expect(() =>
      customerStateChangedPayloadSchema.parse({
        ...payload,
        computedAt: 'not-a-date',
      }),
    ).toThrow();
  });
});
