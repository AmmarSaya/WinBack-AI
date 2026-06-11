/**
 * Unit tests for the dispatch gate chain (Epic G batch 8.3).
 *
 * Mocks the repo reads; asserts the OUTCOME + the ORDER/short-circuit
 * invariants the user audits hardest:
 *   - gate order 1..6 with short-circuit (a terminal gate fires → LATER gate
 *     reads never run);
 *   - terminal-before-transient (a target that would hit both is suppressed,
 *     never deferred);
 *   - the correct forensic gate label per outcome.
 */

import type { CampaignRepository, DispatchContext, MessageRepository, OrderRepository } from '@winback/db';
import { describe, expect, it, vi } from 'vitest';

import { runGateChain } from '../../src/dispatch/gate-chain.js';

const MERCHANT_ID = 'm_1';

const BASE_CTX: DispatchContext = {
  targetStatus: 'pending',
  customerId: 'cust_1',
  consentState: 'subscribed',
  generationCreatedAt: new Date('2026-06-10T00:00:00Z'),
  timezone: 'UTC',
  sendTimeStartHour: 9,
  sendTimeEndHour: 18,
  defaultCooldownHours: 168,
  maxDailySendsPerCustomer: 1,
  dailySendCap: 2000,
  monthlySendsCap: 50000,
};

// Noon UTC → inside the 9–18 window, so quiet-hours passes by default.
const NOON = new Date('2026-06-11T12:00:00Z');

function makeDeps(now: Date = NOON) {
  const isSuppressed = vi.fn().mockResolvedValue(false);
  const getQuotaUsage = vi.fn().mockResolvedValue({ daySentCount: 0, monthSentCount: 0 });
  const hasQualifyingOrderSince = vi.fn().mockResolvedValue(false);
  const countSentSince = vi.fn().mockResolvedValue(0);

  const deps = {
    campaignRepo: { isSuppressed, getQuotaUsage } as unknown as CampaignRepository,
    orderRepo: { hasQualifyingOrderSince } as unknown as OrderRepository,
    messageRepo: { countSentSince } as unknown as MessageRepository,
    now,
  };
  return { deps, isSuppressed, getQuotaUsage, hasQualifyingOrderSince, countSentSince };
}

function run(deps: ReturnType<typeof makeDeps>['deps'], ctx: DispatchContext = BASE_CTX) {
  return runGateChain(deps, { merchantId: MERCHANT_ID, ctx });
}

describe('runGateChain — pass', () => {
  it('all gates clear → passed (every gate read ran)', async () => {
    const t = makeDeps();
    await expect(run(t.deps)).resolves.toEqual({ kind: 'passed' });
    expect(t.isSuppressed).toHaveBeenCalledTimes(1);
    expect(t.hasQualifyingOrderSince).toHaveBeenCalledTimes(1);
    expect(t.countSentSince).toHaveBeenCalledTimes(2); // cooldown + daily
    expect(t.getQuotaUsage).toHaveBeenCalledTimes(1);
  });
});

describe('runGateChain — terminal gates + short-circuit', () => {
  it('1 Suppression → suppressed(suppression); NO later gate reads', async () => {
    const t = makeDeps();
    t.isSuppressed.mockResolvedValue(true);
    await expect(run(t.deps)).resolves.toEqual({ kind: 'suppressed', gate: 'suppression' });
    expect(t.hasQualifyingOrderSince).not.toHaveBeenCalled();
    expect(t.countSentSince).not.toHaveBeenCalled();
    expect(t.getQuotaUsage).not.toHaveBeenCalled();
  });

  it('2 Consent (not subscribed) → suppressed(consent); freshness never read', async () => {
    const t = makeDeps();
    await expect(run(t.deps, { ...BASE_CTX, consentState: 'unsubscribed' })).resolves.toEqual({
      kind: 'suppressed',
      gate: 'consent',
    });
    expect(t.hasQualifyingOrderSince).not.toHaveBeenCalled();
  });

  it('3 Freshness (bought after decision) → suppressed(freshness); frequency never read', async () => {
    const t = makeDeps();
    t.hasQualifyingOrderSince.mockResolvedValue(true);
    await expect(run(t.deps)).resolves.toEqual({ kind: 'suppressed', gate: 'freshness' });
    expect(t.countSentSince).not.toHaveBeenCalled();
    // The freshness `since` is the generation decision time.
    expect(t.hasQualifyingOrderSince).toHaveBeenCalledWith({
      merchantId: MERCHANT_ID,
      customerId: 'cust_1',
      since: BASE_CTX.generationCreatedAt,
    });
  });

  it('4 Frequency cooldown (a send within cooldown) → suppressed(frequency); quota never read', async () => {
    const t = makeDeps();
    t.countSentSince.mockResolvedValueOnce(1); // cooldown window has a send
    await expect(run(t.deps)).resolves.toEqual({ kind: 'suppressed', gate: 'frequency' });
    expect(t.getQuotaUsage).not.toHaveBeenCalled();
  });

  it('4 Frequency daily floor (cooldown clear but today >= max) → suppressed(frequency)', async () => {
    const t = makeDeps();
    // cooldown call → 0 (clear); daily call → 1 (>= maxDailySendsPerCustomer=1)
    t.countSentSince.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    await expect(run(t.deps)).resolves.toEqual({ kind: 'suppressed', gate: 'frequency' });
  });
});

describe('runGateChain — transient gates', () => {
  it('5 Quiet-hours (out of window) → deferred(quiet_hours); quota never read', async () => {
    const t = makeDeps(new Date('2026-06-11T06:00:00Z')); // 06:00 UTC < 9
    await expect(run(t.deps)).resolves.toEqual({ kind: 'deferred', gate: 'quiet_hours' });
    expect(t.getQuotaUsage).not.toHaveBeenCalled();
  });

  it('6 Quota (day cap reached) → deferred(quota)', async () => {
    const t = makeDeps();
    t.getQuotaUsage.mockResolvedValue({ daySentCount: 2000, monthSentCount: 2000 });
    await expect(run(t.deps)).resolves.toEqual({ kind: 'deferred', gate: 'quota' });
  });

  it('6 Quota (month cap reached, day under) → deferred(quota)', async () => {
    const t = makeDeps();
    t.getQuotaUsage.mockResolvedValue({ daySentCount: 5, monthSentCount: 50000 });
    await expect(run(t.deps)).resolves.toEqual({ kind: 'deferred', gate: 'quota' });
  });
});

describe('runGateChain — terminal beats transient (G-Q10)', () => {
  it('a consent-suppressed target that is ALSO out of quiet-hours → suppressed(consent), NOT deferred', async () => {
    const t = makeDeps(new Date('2026-06-11T06:00:00Z')); // out of window
    await expect(run(t.deps, { ...BASE_CTX, consentState: 'pending' })).resolves.toEqual({
      kind: 'suppressed',
      gate: 'consent',
    });
    // Transient gates never evaluated.
    expect(t.getQuotaUsage).not.toHaveBeenCalled();
  });
});
