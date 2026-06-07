import type { Prisma } from '@prisma/client';
import { ValidationError } from '@winback/errors';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { WinbackPrisma } from '../src/client.js';
import { CustomerRepository } from '../src/repositories/customer.repository.js';
import { withSystemScope } from '../src/tenant-scope.js';
import type { ShopifyCustomerWebhookBody } from '../src/webhook-bodies.js';

/**
 * Unit tests for CustomerRepository.upsertFromWebhook + softDelete
 * against a mocked Prisma transaction client. Real-DB coverage in the
 * batch 5 drainer integration harness.
 *
 * Tests wrap each operation in withSystemScope so assertScopeMatchesMerchant
 * passes (otherwise the repo throws before any DB call). The scope-
 * assertion behavior itself is covered in tenant-scope.test.ts; here we
 * exercise the business logic on top.
 */

const MERCHANT_ID = 'm_test';
const SHOP_CUSTOMER_ID = 'gid://shopify/Customer/12345';
const LOCAL_CUSTOMER_ID = 'cust_local_1';

interface MockTx {
  customer: {
    findUnique: Mock;
    upsert: Mock;
    updateMany: Mock;
  };
}

function makeTx(): MockTx {
  return {
    customer: {
      findUnique: vi.fn(),
      upsert: vi.fn().mockResolvedValue({ id: LOCAL_CUSTOMER_ID }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

function makeBody(overrides: Partial<ShopifyCustomerWebhookBody> = {}): ShopifyCustomerWebhookBody {
  return {
    id: 12345,
    email: 'jane@example.com',
    phone: '+15551234567',
    first_name: 'Jane',
    last_name: 'Doe',
    created_at: '2026-05-19T12:00:00Z',
    updated_at: '2026-05-19T12:00:00Z',
    orders_count: 3,
    tags: 'vip, repeat-buyer',
    email_marketing_consent: { state: 'subscribed' },
    sms_marketing_consent: { state: 'not_subscribed' },
    ...overrides,
  } as ShopifyCustomerWebhookBody;
}

describe('CustomerRepository.upsertFromWebhook', () => {
  let repo: CustomerRepository;
  let tx: MockTx;

  beforeEach(() => {
    repo = new CustomerRepository({} as WinbackPrisma);
    tx = makeTx();
  });

  it('new customer → isNewCustomer=true, customerId returned', async () => {
    tx.customer.findUnique.mockResolvedValue(null);
    const result = await withSystemScope('test.upsert_customer', async () =>
      repo.upsertFromWebhook({
        merchantId: MERCHANT_ID,
        body: makeBody(),
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    );
    expect(result.isNewCustomer).toBe(true);
    expect(result.customerId).toBe(LOCAL_CUSTOMER_ID);
  });

  it('existing customer → isNewCustomer=false', async () => {
    tx.customer.findUnique.mockResolvedValue({ id: LOCAL_CUSTOMER_ID });
    const result = await withSystemScope('test.upsert_customer', async () =>
      repo.upsertFromWebhook({
        merchantId: MERCHANT_ID,
        body: makeBody(),
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    );
    expect(result.isNewCustomer).toBe(false);
  });

  // -------- derived consent flags (C21, C22, C23) --------

  it('email_marketing_consent.state = "subscribed" → acceptsMarketing=true on upsert', async () => {
    tx.customer.findUnique.mockResolvedValue(null);
    await withSystemScope('test.upsert_customer', async () =>
      repo.upsertFromWebhook({
        merchantId: MERCHANT_ID,
        body: makeBody({ email_marketing_consent: { state: 'subscribed' } }),
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    );
    expect(tx.customer.upsert.mock.calls[0]![0].create.acceptsMarketing).toBe(true);
  });

  it('email_marketing_consent.state = "unsubscribed" → acceptsMarketing NOT written (preserves existing value on update)', async () => {
    tx.customer.findUnique.mockResolvedValue(null);
    await withSystemScope('test.upsert_customer', async () =>
      repo.upsertFromWebhook({
        merchantId: MERCHANT_ID,
        body: makeBody({ email_marketing_consent: { state: 'unsubscribed' } }),
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    );
    // Documented behavior: only override when state IS 'subscribed' (true).
    // For other states, don't override — schema default `false` applies on
    // create; existing value preserved on update. This prevents a "consent
    // pending" webhook from clobbering a previously-confirmed subscription.
    expect(tx.customer.upsert.mock.calls[0]![0].create.acceptsMarketing).toBeUndefined();
  });

  it('no email_marketing_consent object → acceptsMarketing NOT written', async () => {
    tx.customer.findUnique.mockResolvedValue(null);
    const body = makeBody();
    delete (body as Partial<ShopifyCustomerWebhookBody>).email_marketing_consent;
    await withSystemScope('test.upsert_customer', async () =>
      repo.upsertFromWebhook({
        merchantId: MERCHANT_ID,
        body,
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    );
    expect(tx.customer.upsert.mock.calls[0]![0].create.acceptsMarketing).toBeUndefined();
  });

  it('sms_marketing_consent.state = "subscribed" → acceptsSms=true', async () => {
    tx.customer.findUnique.mockResolvedValue(null);
    await withSystemScope('test.upsert_customer', async () =>
      repo.upsertFromWebhook({
        merchantId: MERCHANT_ID,
        body: makeBody({ sms_marketing_consent: { state: 'subscribed' } }),
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    );
    expect(tx.customer.upsert.mock.calls[0]![0].create.acceptsSms).toBe(true);
  });

  // -------- tags split (P-6) --------

  it('tags "vip, repeat-buyer, loyal" → ["vip","repeat-buyer","loyal"]', async () => {
    tx.customer.findUnique.mockResolvedValue(null);
    await withSystemScope('test.upsert_customer', async () =>
      repo.upsertFromWebhook({
        merchantId: MERCHANT_ID,
        body: makeBody({ tags: 'vip, repeat-buyer, loyal' }),
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    );
    expect(tx.customer.upsert.mock.calls[0]![0].create.tags).toEqual([
      'vip',
      'repeat-buyer',
      'loyal',
    ]);
  });

  it('empty tags string → []', async () => {
    tx.customer.findUnique.mockResolvedValue(null);
    await withSystemScope('test.upsert_customer', async () =>
      repo.upsertFromWebhook({
        merchantId: MERCHANT_ID,
        body: makeBody({ tags: '' }),
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    );
    expect(tx.customer.upsert.mock.calls[0]![0].create.tags).toEqual([]);
  });

  it('null tags → []', async () => {
    tx.customer.findUnique.mockResolvedValue(null);
    await withSystemScope('test.upsert_customer', async () =>
      repo.upsertFromWebhook({
        merchantId: MERCHANT_ID,
        body: makeBody({ tags: null }),
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    );
    expect(tx.customer.upsert.mock.calls[0]![0].create.tags).toEqual([]);
  });

  it('tags with whitespace + empty entries → trimmed + filtered', async () => {
    tx.customer.findUnique.mockResolvedValue(null);
    await withSystemScope('test.upsert_customer', async () =>
      repo.upsertFromWebhook({
        merchantId: MERCHANT_ID,
        body: makeBody({ tags: '  vip  ,  ,  loyal  ' }),
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    );
    expect(tx.customer.upsert.mock.calls[0]![0].create.tags).toEqual(['vip', 'loyal']);
  });

  // -------- Customer.state NOT written from Shopify (C9 lock) --------

  it('Shopify state field present → NOT written to Customer.state (C9 collision lock)', async () => {
    tx.customer.findUnique.mockResolvedValue(null);
    // Shopify's `state` (account-lifecycle) is structurally allowed by
    // passthrough but the repository must not pull it. Our Customer.state
    // is RFM-lifecycle, owned by session 2's scoring writer.
    const bodyWithState = {
      ...makeBody(),
      state: 'enabled', // Shopify's customer-account-state value
    };
    await withSystemScope('test.upsert_customer', async () =>
      repo.upsertFromWebhook({
        merchantId: MERCHANT_ID,
        body: bodyWithState as ShopifyCustomerWebhookBody,
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    );
    const upsertArgs = tx.customer.upsert.mock.calls[0]![0];
    expect(upsertArgs.create).not.toHaveProperty('state');
    expect(upsertArgs.update).not.toHaveProperty('state');
  });

  // -------- TX invariant lock --------

  it('uses args.tx (not this.prisma) for the pre-write findUnique read', async () => {
    tx.customer.findUnique.mockResolvedValue(null);
    await withSystemScope('test.upsert_customer', async () =>
      repo.upsertFromWebhook({
        merchantId: MERCHANT_ID,
        body: makeBody(),
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    );
    expect(tx.customer.findUnique).toHaveBeenCalledTimes(1);
  });

  // -------- GID validation --------

  it('body.id non-numeric → throws ValidationError', async () => {
    await expect(
      withSystemScope('test.upsert_customer', async () =>
        repo.upsertFromWebhook({
          merchantId: MERCHANT_ID,
          body: makeBody({ id: 'not-numeric' }),
          tx: tx as unknown as Prisma.TransactionClient,
        }),
      ),
    ).rejects.toThrow(ValidationError);
  });
});

describe('CustomerRepository.softDelete', () => {
  let repo: CustomerRepository;
  let tx: MockTx;

  beforeEach(() => {
    repo = new CustomerRepository({} as WinbackPrisma);
    tx = makeTx();
  });

  it('existing customer (not yet deleted) → existed=true, deletedAt set', async () => {
    tx.customer.updateMany.mockResolvedValue({ count: 1 });
    const result = await withSystemScope('test.soft_delete', async () =>
      repo.softDelete({
        merchantId: MERCHANT_ID,
        shopifyCustomerId: SHOP_CUSTOMER_ID,
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    );
    expect(result.existed).toBe(true);
    const updateCall = tx.customer.updateMany.mock.calls[0]![0];
    expect(updateCall.where.deletedAt).toBeNull();
    expect(updateCall.data.deletedAt).toBeInstanceOf(Date);
  });

  it('already-deleted or absent customer → existed=false (idempotent)', async () => {
    tx.customer.updateMany.mockResolvedValue({ count: 0 });
    const result = await withSystemScope('test.soft_delete', async () =>
      repo.softDelete({
        merchantId: MERCHANT_ID,
        shopifyCustomerId: SHOP_CUSTOMER_ID,
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    );
    expect(result.existed).toBe(false);
  });
});
