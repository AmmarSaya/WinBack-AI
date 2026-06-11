/**
 * The dispatch gate chain (Epic G batch 8.3). Runs the 6 gates over a loaded
 * `DispatchContext` and returns the outcome the worker applies. PURE
 * orchestration over the repo reads — no writes here (the worker owns the
 * outcome write).
 *
 * ORDER (G-Q10 — terminal before transient, each SHORT-CIRCUITS on hit):
 *   1. Suppression  (terminal)  — Suppression table
 *   2. Consent      (terminal)  — emailMarketingConsentState === 'subscribed'
 *   3. Freshness    (terminal)  — qualifying Order AFTER AiGeneration.createdAt
 *   4. Frequency    (terminal)  — sent within cooldown, or daily floor reached
 *   5. Quiet-hours  (transient) — merchant-local send window
 *   6. Quota        (transient) — pre-flight bucket read vs caps
 *
 * Why terminal-first: a target that would hit BOTH a terminal and a transient
 * gate must be SUPPRESSED, never deferred-then-suppressed — terminal wins and
 * the first matching gate's name is the forensic `suppressedByGate` label.
 *
 * 8.3 BOUNDARY: a `passed` outcome means "all gates clear" — the worker logs a
 * send-stub and leaves the target `pending`; 8.4 appends the real send + the
 * authoritative under-lock quota increment (gate 6 here is a pre-flight CHECK
 * only, per G-Q9).
 */

import type {
  CampaignRepository,
  DispatchContext,
  MessageRepository,
  OrderRepository,
} from '@winback/db';
import { getLogger } from '@winback/logger';

import { isWithinSendWindow } from './quiet-hours.js';

const log = getLogger('drainer.dispatch.gate-chain');

const MS_PER_HOUR = 60 * 60 * 1000;

export type TerminalGate = 'suppression' | 'consent' | 'freshness' | 'frequency';
export type TransientGate = 'quiet_hours' | 'quota';

export type GateOutcome =
  | { readonly kind: 'suppressed'; readonly gate: TerminalGate }
  | { readonly kind: 'deferred'; readonly gate: TransientGate }
  | { readonly kind: 'passed' };

export interface GateChainDeps {
  readonly campaignRepo: CampaignRepository;
  readonly orderRepo: OrderRepository;
  readonly messageRepo: MessageRepository;
  /** Pinned clock for the time-relative gates (cooldown window, quiet-hours, quota day). */
  readonly now: Date;
}

export async function runGateChain(
  deps: GateChainDeps,
  input: { merchantId: string; ctx: DispatchContext },
): Promise<GateOutcome> {
  const { merchantId } = input;
  const ctx = input.ctx;
  const customerId = ctx.customerId;

  // ── 1. Suppression (terminal) ───────────────────────────────────────────
  if (await deps.campaignRepo.isSuppressed({ merchantId, customerId, channel: 'email' })) {
    return { kind: 'suppressed', gate: 'suppression' };
  }

  // ── 2. Consent (terminal) ───────────────────────────────────────────────
  if (ctx.consentState !== 'subscribed') {
    return { kind: 'suppressed', gate: 'consent' };
  }

  // ── 3. Freshness / G-Q6 (terminal) ──────────────────────────────────────
  // Bought again AFTER we decided to winback → no longer lapsed → suppress.
  if (
    await deps.orderRepo.hasQualifyingOrderSince({
      merchantId,
      customerId,
      since: ctx.generationCreatedAt,
    })
  ) {
    return { kind: 'suppressed', gate: 'freshness' };
  }

  // ── 4. Frequency (terminal) ─────────────────────────────────────────────
  // Reuses the EXISTING send-policy fields (no new schema). Cooldown: any send
  // within defaultCooldownHours. Daily: today's (UTC) send count vs the floor.
  const cooldownSince = new Date(deps.now.getTime() - ctx.defaultCooldownHours * MS_PER_HOUR);
  if ((await deps.messageRepo.countSentSince({ merchantId, customerId, since: cooldownSince })) > 0) {
    return { kind: 'suppressed', gate: 'frequency' };
  }
  const dayStart = utcMidnight(deps.now);
  if (
    (await deps.messageRepo.countSentSince({ merchantId, customerId, since: dayStart })) >=
    ctx.maxDailySendsPerCustomer
  ) {
    return { kind: 'suppressed', gate: 'frequency' };
  }

  // ── 5. Quiet-hours (transient) ──────────────────────────────────────────
  const window = isWithinSendWindow({
    timezone: ctx.timezone,
    startHour: ctx.sendTimeStartHour,
    endHour: ctx.sendTimeEndHour,
    now: deps.now,
  });
  if (window.usedUtcFallback) {
    log.warn(
      { merchantId, customerId },
      'dispatch quiet-hours: merchant timezone missing/unparseable — UTC fallback (set timezone at onboarding)',
    );
  }
  if (!window.inWindow) {
    return { kind: 'deferred', gate: 'quiet_hours' };
  }

  // ── 6. Quota pre-flight (transient) ─────────────────────────────────────
  // Pre-flight CHECK only; 8.4's mark-sent tx owns the authoritative under-lock
  // increment (G-Q9), so a small over-admit here is corrected there.
  const usage = await deps.campaignRepo.getQuotaUsage({ merchantId, now: deps.now });
  if (usage.daySentCount >= ctx.dailySendCap || usage.monthSentCount >= ctx.monthlySendsCap) {
    return { kind: 'deferred', gate: 'quota' };
  }

  return { kind: 'passed' };
}

function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
