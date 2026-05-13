/**
 * Unit tests for AuditLogRepository.
 *
 * Two surfaces:
 *   - `append(input, tx?)` — the typed-action chokepoint. After step 5,
 *     every AuditLog write in production code flows through this method.
 *     Direct `prisma.auditLog.create` outside this repository is a typo
 *     hazard (the model column is a free-form string at the DB layer).
 *   - `appendFromContext(extra?, tx?)` — convenience for callers already
 *     inside a `withAudit(ctx)` scope.
 *
 * The `tx?` parameter is load-bearing: compliance evidence must land in
 * the SAME transaction as the business action it records (Audit Write
 * Policy in ARCHITECTURE.md). These tests pin the dispatch — without tx
 * goes to `this.prisma`; with tx goes to the passed client. Divergence
 * would be a compliance bug.
 */

import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { WinbackPrisma } from '../src/client.js';
import { withAudit } from '../src/audit-scope.js';
import { AuditLogRepository } from '../src/repositories/audit-log.repository.js';

function makeMockClient() {
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => {
    return { id: 'audit_1', ...args.data };
  });
  return {
    client: { auditLog: { create } } as unknown as WinbackPrisma,
    create,
  };
}

// ===========================================================================
// append — basic dispatch
// ===========================================================================

describe('AuditLogRepository.append — dispatch', () => {
  it('without tx, writes via this.prisma', async () => {
    const own = makeMockClient();
    const repo = new AuditLogRepository(own.client);

    await repo.append({
      merchantId: 'm_1',
      shop: 'foo.myshopify.com',
      actorType: 'system',
      action: 'gdpr.customer_redact',
    });

    expect(own.create).toHaveBeenCalledTimes(1);
  });

  it('with tx, writes via the passed tx (NOT this.prisma)', async () => {
    const own = makeMockClient();
    const tx = makeMockClient();
    const repo = new AuditLogRepository(own.client);

    await repo.append(
      {
        merchantId: 'm_1',
        shop: 'foo.myshopify.com',
        actorType: 'system',
        action: 'gdpr.customer_redact',
      },
      tx.client as never,
    );

    expect(tx.create).toHaveBeenCalledTimes(1);
    expect(own.create).toHaveBeenCalledTimes(0);
  });
});

// ===========================================================================
// append — data shape contract
// ===========================================================================

describe('AuditLogRepository.append — data shape', () => {
  it('forwards core fields verbatim', async () => {
    const own = makeMockClient();
    const repo = new AuditLogRepository(own.client);

    await repo.append({
      merchantId: 'm_1',
      shop: 'foo.myshopify.com',
      actorType: 'system',
      actorId: 'gdpr.processor',
      action: 'gdpr.customer_redact',
      targetType: 'customer',
      targetId: 'c_42',
      context: { merged: true, count: 3 },
    });

    const args = own.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(args.data['merchantId']).toBe('m_1');
    expect(args.data['shop']).toBe('foo.myshopify.com');
    expect(args.data['actorType']).toBe('system');
    expect(args.data['actorId']).toBe('gdpr.processor');
    expect(args.data['action']).toBe('gdpr.customer_redact');
    expect(args.data['targetType']).toBe('customer');
    expect(args.data['targetId']).toBe('c_42');
    expect(args.data['context']).toEqual({ merged: true, count: 3 });
  });

  it('defaults absent actorId / targetType / targetId to null (Prisma nullable column shape)', async () => {
    const own = makeMockClient();
    const repo = new AuditLogRepository(own.client);

    await repo.append({
      merchantId: 'm_1',
      shop: 'foo.myshopify.com',
      actorType: 'system',
      action: 'gdpr.customer_redact_malformed',
    });

    const args = own.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(args.data['actorId']).toBeNull();
    expect(args.data['targetType']).toBeNull();
    expect(args.data['targetId']).toBeNull();
  });

  it('uses Prisma.JsonNull when context is omitted (NOT plain null, which Prisma rejects on Json columns)', async () => {
    const own = makeMockClient();
    const repo = new AuditLogRepository(own.client);

    await repo.append({
      merchantId: 'm_1',
      shop: 'foo.myshopify.com',
      actorType: 'system',
      action: 'gdpr.customer_redact_malformed',
    });

    const args = own.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(args.data['context']).toBe(Prisma.JsonNull);
  });

  it('preserves merchantId=null on tombstone rows (system-scope writes)', async () => {
    // The gdpr.shop_redact_idempotent flow writes merchantId=null with
    // shop denormalized. Extension allows this in system scope; the repo
    // must not coerce null to anything else.
    const own = makeMockClient();
    const repo = new AuditLogRepository(own.client);

    await repo.append({
      merchantId: null,
      shop: 'foo.myshopify.com',
      actorType: 'system',
      action: 'gdpr.shop_redact_idempotent',
      targetType: 'merchant',
    });

    const args = own.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(args.data['merchantId']).toBeNull();
    expect(args.data['shop']).toBe('foo.myshopify.com');
  });

  it('passes through an actor of type "operator"', async () => {
    const own = makeMockClient();
    const repo = new AuditLogRepository(own.client);

    await repo.append({
      merchantId: 'm_1',
      shop: 'foo.myshopify.com',
      actorType: 'operator',
      actorId: 'ops-engineer@example.com',
      action: 'gdpr.customer_redact',
    });

    const args = own.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(args.data['actorType']).toBe('operator');
    expect(args.data['actorId']).toBe('ops-engineer@example.com');
  });
});

// ===========================================================================
// append — error propagation (Audit Write Policy)
// ===========================================================================

describe('AuditLogRepository.append — error propagation', () => {
  it('propagates failures to the caller (does NOT silently swallow)', async () => {
    // Per the Audit Write Policy in ARCHITECTURE.md: a failed audit write
    // for a compliance action is exactly the failure mode an auditor cares
    // about. Callers wanting fire-and-forget must explicitly try/catch.
    const client = {
      auditLog: {
        create: vi.fn(async () => {
          throw new Error('DB connection lost');
        }),
      },
    } as unknown as WinbackPrisma;
    const repo = new AuditLogRepository(client);

    await expect(
      repo.append({
        merchantId: 'm_1',
        shop: 'foo.myshopify.com',
        actorType: 'system',
        action: 'gdpr.customer_redact',
      }),
    ).rejects.toThrow('DB connection lost');
  });
});

// ===========================================================================
// appendFromContext
// ===========================================================================

describe('AuditLogRepository.appendFromContext', () => {
  it('throws when no withAudit scope is active', async () => {
    const own = makeMockClient();
    const repo = new AuditLogRepository(own.client);

    await expect(repo.appendFromContext()).rejects.toThrow(
      /appendFromContext called outside withAudit scope/,
    );
  });

  it('reads actor + action from ALS context, applies provided extras', async () => {
    const own = makeMockClient();
    const repo = new AuditLogRepository(own.client);

    await withAudit(
      {
        action: 'gdpr.customer_redact',
        actorType: 'system',
        actorId: 'gdpr.processor',
        targetType: 'customer',
        targetId: 'c_42',
        context: { source: 'als' },
      },
      () => repo.appendFromContext({ merchantId: 'm_1', shop: 'foo.myshopify.com' }),
    );

    const args = own.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(args.data['merchantId']).toBe('m_1');
    expect(args.data['shop']).toBe('foo.myshopify.com');
    expect(args.data['actorType']).toBe('system');
    expect(args.data['actorId']).toBe('gdpr.processor');
    expect(args.data['action']).toBe('gdpr.customer_redact');
    expect(args.data['targetType']).toBe('customer');
    expect(args.data['targetId']).toBe('c_42');
    expect(args.data['context']).toEqual({ source: 'als' });
  });

  it('forwards tx to the underlying append call', async () => {
    const own = makeMockClient();
    const tx = makeMockClient();
    const repo = new AuditLogRepository(own.client);

    await withAudit(
      {
        action: 'gdpr.customer_redact',
        actorType: 'system',
      },
      () => repo.appendFromContext({ merchantId: 'm_1', shop: 'foo.myshopify.com' }, tx.client as never),
    );

    expect(tx.create).toHaveBeenCalledTimes(1);
    expect(own.create).toHaveBeenCalledTimes(0);
  });
});
