import type { AdminClient } from './client.js';
import { ShopifyAdminApiError } from './errors.js';

/**
 * Winback discount creation (A4 / POST-EPIC-F §4.2).
 *
 * Creates a CUSTOMER-SCOPED, single-use Shopify discount code via
 * `discountCodeBasicCreate`, with deterministic idempotency on retry:
 *
 *   - Happy path → the mutation returns the new discount node id.
 *   - Duplicate code (`userError.code === 'TAKEN'`) → a PRIOR attempt for this
 *     same generation already created this exact code (codes are deterministic
 *     — see `discount-code.ts`). We treat this as SUCCESS and recover the
 *     existing node id via `codeDiscountNodeByCode` (needs `read_discounts`).
 *     This is the crash-window self-heal: mint succeeded, the completion tx
 *     didn't persist before a crash, the retry re-mints → TAKEN → we recover
 *     the id and the discount stays tracked.
 *   - Any OTHER userError → throw (fail loud; the worker lets it propagate to
 *     BullMQ's retry/failed-queue, matching the Q-A2 conservative posture).
 *
 * MUST be called OUTSIDE any `prisma.$transaction` (locked rule: no external
 * HTTP inside a Postgres tx).
 *
 * The discount is customer-scoped (`customerSelection.customers.add`) and
 * `appliesOncePerCustomer` — a single-use code for exactly the one lapsed
 * customer this winback targets. `endsAt` is supplied by the caller (the AI
 * Worker computes `now + MerchantSettings.attributionDirectWindowDays`) so the
 * code expires server-side at the edge of the direct-attribution window; the
 * deferred 4.3 cleanup cron is then housekeeping, not correctness.
 */

export const WINBACK_DISCOUNT_CREATE_MUTATION = `
  mutation WinbackDiscountCreate($input: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $input) {
      codeDiscountNode { id }
      userErrors { field code message }
    }
  }
`;

export const WINBACK_DISCOUNT_BY_CODE_QUERY = `
  query WinbackDiscountByCode($code: String!) {
    codeDiscountNodeByCode(code: $code) { id }
  }
`;

/** Shopify userError code for a duplicate discount code (probe-confirmed). */
const TAKEN_ERROR_CODE = 'TAKEN';

/** Pre-flight cost hints (Shopify points; mutations are ~10, the lookup ~5). */
const CREATE_ESTIMATED_COST = 20;
const LOOKUP_ESTIMATED_COST = 10;

export interface CreateWinbackDiscountArgs {
  readonly merchantId: string;
  /** Full Shopify Customer GID, e.g. `gid://shopify/Customer/12345`. */
  readonly customerGid: string;
  /** Deterministic code from `deriveWinbackDiscountCode`. */
  readonly code: string;
  /** Percentage off as an integer, e.g. `15` for 15% (sent as 0.15). */
  readonly valuePercent: number;
  /** Server-side expiry — caller passes `now + attributionDirectWindowDays`. */
  readonly endsAt: Date;
  /** When the code becomes redeemable. Defaults to `new Date()`. */
  readonly startsAt?: Date;
  /** Admin-facing title. Defaults to a recognizable winback label. */
  readonly title?: string;
}

export interface CreateWinbackDiscountResult {
  /** Echo of the input code — the value to substitute into the message. */
  readonly code: string;
  /** The Shopify discount-node GID (for tracking + deferred 4.3 cleanup). */
  readonly shopifyDiscountId: string;
  /**
   * `true` when Shopify returned `TAKEN` and we recovered the existing node
   * (idempotent replay) rather than creating fresh. Lets the caller log the
   * self-heal without changing the success outcome.
   */
  readonly alreadyExisted: boolean;
}

interface RawCreateResponse {
  discountCodeBasicCreate?: {
    codeDiscountNode?: { id?: string | null } | null;
    userErrors?: readonly {
      field?: readonly string[] | null;
      code?: string | null;
      message?: string | null;
    }[] | null;
  } | null;
}

interface RawLookupResponse {
  codeDiscountNodeByCode?: { id?: string | null } | null;
}

export async function createWinbackDiscountCode(
  client: AdminClient,
  args: CreateWinbackDiscountArgs,
): Promise<CreateWinbackDiscountResult> {
  const startsAt = args.startsAt ?? new Date();
  const input = {
    title: args.title ?? `Winback offer (${args.code})`,
    code: args.code,
    startsAt: startsAt.toISOString(),
    endsAt: args.endsAt.toISOString(),
    // CUSTOMER-SCOPED, single-use. Never a store-wide code.
    customerSelection: { customers: { add: [args.customerGid] } },
    customerGets: {
      value: { percentage: args.valuePercent / 100 },
      items: { all: true },
    },
    appliesOncePerCustomer: true,
  };

  const data = await client.graphql<RawCreateResponse>(args.merchantId, {
    query: WINBACK_DISCOUNT_CREATE_MUTATION,
    variables: { input },
    estimatedCost: CREATE_ESTIMATED_COST,
  });

  const payload = data.discountCodeBasicCreate;
  const createdId = payload?.codeDiscountNode?.id ?? null;
  const userErrors = payload?.userErrors ?? [];

  // Happy path — created fresh.
  if (createdId !== null && userErrors.length === 0) {
    return { code: args.code, shopifyDiscountId: createdId, alreadyExisted: false };
  }

  // Idempotent replay — our prior attempt already created this exact code.
  const taken = userErrors.some((e) => e.code === TAKEN_ERROR_CODE);
  if (taken) {
    const existingId = await lookupDiscountIdByCode(client, args.merchantId, args.code);
    if (existingId === null) {
      // TAKEN but no node found — Shopify state we don't understand. Fail loud.
      throw new ShopifyAdminApiError(
        'discountCodeBasicCreate returned TAKEN but codeDiscountNodeByCode found no node',
        { context: { code: args.code } },
      );
    }
    return { code: args.code, shopifyDiscountId: existingId, alreadyExisted: true };
  }

  // Any other userError → fail loud (retried by BullMQ, then failed-queue).
  throw new ShopifyAdminApiError('discountCodeBasicCreate returned userErrors', {
    context: {
      userErrors: userErrors.map((e) => ({
        field: e.field ?? null,
        code: e.code ?? null,
        message: e.message ?? null,
      })),
    },
  });
}

/**
 * Resolves an existing discount node id from its code. Used only on the TAKEN
 * idempotency path. Returns null when no node matches (caller decides).
 *
 * Requires the `read_discounts` access scope.
 */
async function lookupDiscountIdByCode(
  client: AdminClient,
  merchantId: string,
  code: string,
): Promise<string | null> {
  const data = await client.graphql<RawLookupResponse>(merchantId, {
    query: WINBACK_DISCOUNT_BY_CODE_QUERY,
    variables: { code },
    estimatedCost: LOOKUP_ESTIMATED_COST,
  });
  return data.codeDiscountNodeByCode?.id ?? null;
}
