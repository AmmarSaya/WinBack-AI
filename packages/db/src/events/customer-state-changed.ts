// =============================================================================
// `customer.state_changed` outbox event — producer-side payload schema.
//
// Emitted by the Epic E session 2 scoring service (`CustomerScoreService.
// recompute`) when an inline RFM recompute detects that the customer's
// `Customer.state` band has changed.  Written to `OutboxEvent` in the SAME
// transaction as:
//   - the `Customer.state` UPDATE
//   - the `CustomerScore` UPSERT
//   - an `AuditLog` row (`AUDIT_ACTIONS.customer.state_changed`)
//
// Consumer (Epic G winback campaign engine) is NOT in session 2's scope —
// the drainer's `customer.state_changed` dispatch entry stays routed to
// `handleNoop` post-session-2.  Session 2 ships the PRODUCER only.
//
// Payload shape locked in EPIC-E-SESSION-2-DESIGN.md Q6.  Denormalised
// so the consumer never needs a FK read at consume time — every value
// downstream cares about (state bands, RFM quintiles, raw R/F/M, the
// shopify customer GID) is frozen on the row.  This freezes the moment
// of the transition for forensic / replay purposes; later state changes
// land on later events.
//
// BIGINT SERIALISATION (standing rule #19).
// `mCents` is the BigInt sum of `Order.totalAmountCents`.  `JSON.stringify`
// throws on BigInt, so the payload carries `mCents` as a *string* of
// decimal digits (e.g. `"19995"` = 199.95 in shop currency).  Producers
// MUST call `.toString()` on the BigInt at the write site; consumers
// MUST convert back via `BigInt(value)` before using it as money.
// =============================================================================

import { z } from 'zod';

// ---------------------------------------------------------------------------
// CustomerState — duplicated from `@prisma/client` deliberately.
//
// The Zod schema cannot import the runtime enum from `@prisma/client` without
// pulling the entire client into consumers of this file (the drainer, the
// service in batch 3, any future Epic G/F consumer).  Listing the values
// here keeps the validator zero-dependency on Prisma at parse time.  The
// shape test in `packages/contracts/tests/registries.test.ts` validates
// that these values match the Prisma enum — drift caught by CI.
// ---------------------------------------------------------------------------

export const customerStateValues = [
  'active',
  'warm',
  'at_risk',
  'dormant',
  'lost',
  'insufficient_data',
] as const;

export const customerStateSchema = z.enum(customerStateValues);

export type CustomerStateValue = z.infer<typeof customerStateSchema>;

// ---------------------------------------------------------------------------
// RFM score snapshot
//
// `mCents` is a stringified BigInt (decimal digits, no leading sign for
// positive values, no `n` suffix).  `^[0-9]+$` covers it — RFM monetary
// can be zero (lurker case) but never negative (sums of paid orders).
// Quintiles are nullable: lurkers and insufficient_data cohorts have
// raw R/F/M but no rank.
// ---------------------------------------------------------------------------

export const rfmScoreSchema = z.object({
  rDays: z.number().int().nonnegative(),
  fCount: z.number().int().nonnegative(),
  mCents: z.string().regex(/^[0-9]+$/, 'mCents must be a non-negative BigInt encoded as decimal digits'),
  rQuintile: z.number().int().min(1).max(5).nullable(),
  fQuintile: z.number().int().min(1).max(5).nullable(),
  mQuintile: z.number().int().min(1).max(5).nullable(),
});

export type RfmScore = z.infer<typeof rfmScoreSchema>;

// ---------------------------------------------------------------------------
// Top-level event payload
// ---------------------------------------------------------------------------

export const customerStateChangedPayloadSchema = z
  .object({
    merchantId: z.string().min(1),
    customerId: z.string().min(1),
    /**
     * Full GID (e.g. `gid://shopify/Customer/12345`) per locked decision #4.
     * Prefix-only check; numeric-id validation happens upstream at write
     * time via `toShopifyCustomerGid` (which rejects non-numeric tails) —
     * the schema's job here is to catch the obvious wrong-resource-type
     * mistake (e.g. an Order GID landing where a Customer GID belongs).
     */
    shopifyCustomerId: z.string().startsWith('gid://shopify/Customer/'),
    oldState: customerStateSchema,
    newState: customerStateSchema,
    /** ISO 8601 UTC; `new Date().toISOString()` at the producer call site. */
    computedAt: z.string().datetime({ offset: false }),
    rfmScore: rfmScoreSchema,
  })
  .strict();

export type CustomerStateChangedPayload = z.infer<typeof customerStateChangedPayloadSchema>;

// ---------------------------------------------------------------------------
// Producer helper
//
// Centralises the BigInt-to-string conversion + ISO-string conversion so
// the service call site doesn't have to remember the rule-#19 dance.
// ---------------------------------------------------------------------------

export interface CustomerStateChangedInput {
  readonly merchantId: string;
  readonly customerId: string;
  readonly shopifyCustomerId: string;
  readonly oldState: CustomerStateValue;
  readonly newState: CustomerStateValue;
  readonly computedAt: Date;
  readonly rfmScore: {
    readonly rDays: number;
    readonly fCount: number;
    /** BigInt in JS — converted to string here. */
    readonly mCents: bigint;
    readonly rQuintile: number | null;
    readonly fQuintile: number | null;
    readonly mQuintile: number | null;
  };
}

/**
 * Convert a typed `CustomerStateChangedInput` (BigInt + Date) into the
 * JSON-safe payload shape that lands in `OutboxEvent.payload`.  Parse-
 * validates the result via the Zod schema — defense in depth against
 * a future producer drift.
 */
export function buildCustomerStateChangedPayload(
  input: CustomerStateChangedInput,
): CustomerStateChangedPayload {
  return customerStateChangedPayloadSchema.parse({
    merchantId: input.merchantId,
    customerId: input.customerId,
    shopifyCustomerId: input.shopifyCustomerId,
    oldState: input.oldState,
    newState: input.newState,
    computedAt: input.computedAt.toISOString(),
    rfmScore: {
      rDays: input.rfmScore.rDays,
      fCount: input.rfmScore.fCount,
      mCents: input.rfmScore.mCents.toString(),
      rQuintile: input.rfmScore.rQuintile,
      fQuintile: input.rfmScore.fQuintile,
      mQuintile: input.rfmScore.mQuintile,
    },
  });
}
