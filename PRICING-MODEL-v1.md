# PRICING-MODEL-v1.md — pricing contract for first paying merchant

**Status:** DRAFT — awaiting founder review and approval. Approval lands BEFORE Section 10 (Billing API) opens.
**Scope:** v1 launch pricing model. Tier structure, performance bonus, trial policy, overage policy, billing-cycle policy, edge cases, and the unit-economics math behind the numbers.
**Companion docs:** [POST-EPIC-F-CONSCIOUS-DECISION.md](POST-EPIC-F-CONSCIOUS-DECISION.md) (Section 10, Lock V5), [CP2-ATTRIBUTION-CONTRACT.md](CP2-ATTRIBUTION-CONTRACT.md) (the source of the recovered-revenue number that drives the performance bonus), [EPIC-F-DESIGN.md](EPIC-F-DESIGN.md) (`MerchantSettings.monthlyAiSpendCapCents` — the platform-internal cost ceiling that protects gross margin).
**Schema reference:** `packages/db/prisma/schema.prisma` at `main` SHA `675b1fc`. Billing-related fields already present: `BillingSubscription.plan`, `MerchantSettings.monthlyAiSpendCapCents`, `MerchantSettings.monthlySendsCap`.

This document is a permanent contract. Any future change to tier structure, performance bonus percentage, trial length, overage rates, or billing cycle MUST update this file in the same commit.

---

## Locked decisions (read first)

| Q | Lock | Rationale |
|---|---|---|
| P1 — Model shape | **Hybrid: flat monthly tier (banded by Customer count) + performance bonus on recovered revenue + free trial.** NOT pure flat, NOT pure performance, NOT per-message. | Flat covers fixed costs (AI, SendGrid, Twilio bills land monthly regardless of recovery). Performance bonus aligns incentives. Pure flat undersells; pure performance bankrupts in a slow month. |
| P2 — Banding criterion | **Customer count.** NOT order volume, NOT send volume, NOT MRR. | Intuitive to merchants. Exposed by Shopify Admin API (`customer count` query). Stable input (doesn't churn week-to-week the way order volume does). |
| P3 — Trial | **14 days, full feature access, no credit card required.** NOT $X-of-recovery-free. NOT 7 days. NOT 30 days. | Fixed time window = predictable cohort behavior. 7 days is too short for win-back recovery cycles. 30 days is too long; merchants disengage. "$X of recovery free" has no upper bound on cost-to-acquire. |
| P4 — Performance bonus rate | **10% of recovered revenue, capped per tier.** NOT 15%. NOT 5%. | 15% triggers merchant accountant pushback; 5% is forgettable. 10% sits at the industry tipping point where merchants accept it as "fair commission." Cap protects merchants from viral-month sticker shock + protects you from disputes. |
| P5 — Performance bonus opt-out | **Merchants may toggle the performance bonus OFF and pay a higher flat fee instead (~+33% on the flat tier).** | Removes the "you take a cut of my revenue" objection. Most merchants keep the bonus because their math says it's cheaper. The option neutralizes the objection in the sales conversation. |
| P6 — Annual billing | **Annual pre-pay available with 16.67% discount (≈ 2 months free).** Monthly is the default; annual is offered at checkout + on the billing page. | Cash flow protection. Some segment of merchants will pre-pay for the discount. Industry-standard SaaS pattern. |
| P7 — Overage policy | **Sends above the included monthly quota cost $0.05 per send (email or SMS). Hard quota cap enforced via existing `MerchantSettings.monthlySendsCap`.** Overages bill on the next invoice. | Predictable for the merchant (they can see overage in real time). Cap prevents runaway cost. Same `SELECT FOR UPDATE` pattern as `AiSpendBucket`. |
| P8 — Recovered-revenue source of truth | **`MetricsDailyRollup.recoveredRevenueCents` (Epic H1) is the ONLY value the performance bonus reads from. NOT `AttributionEvent` directly. NOT a separate billing-time recompute.** | Single source of truth. Disputes resolve by pointing at the same number the merchant sees on their dashboard. No "billing math vs dashboard math" divergence. |
| P9 — Bonus calculation window | **Calendar month UTC. Bonus on month N invoiced at start of month N+1.** Refund-reversed attribution within the same calendar month reduces that month's bonus; reversals after month-close are NOT clawed back. | Aligns with Shopify's billing cycles. After-month-close clawback would be a billing-ops nightmare; absorb the variance as cost-of-doing-business. |
| P10 — Tier transition mid-cycle | **Mid-cycle upgrade: prorated additional charge on the next invoice. Mid-cycle downgrade: takes effect at the next billing cycle.** | Shopify Billing API supports proration on upgrades; downgrades are clean if deferred. Matches Shopify-native pricing UX. |
| P11 — Numbers are provisional | **Tier prices below are a STARTING POINT. Final numbers locked after 30 days of design partner usage data.** | Founder + design partner research, not architect guess. The SHAPE is locked; the dollar amounts are tunable. |

---

## Tier structure (provisional — final after design partner research)

| Tier | Customers | Flat /mo | Bonus | Cap /mo | Included sends | Overage |
|---|---|---|---|---|---|---|
| **Starter** | 0 – 5,000 | $49 | 10% | $200 | 500 | $0.05 / send |
| **Growth** | 5,001 – 25,000 | $149 | 10% | $750 | 2,500 | $0.05 / send |
| **Scale** | 25,001 – 100,000 | $399 | 10% | $2,500 | 10,000 | $0.05 / send |
| **Custom** | 100,001+ | "Talk to us" | negotiated | negotiated | negotiated | negotiated |

**Annual pricing:** the flat tier × 10 (i.e., 2 months free).
- Starter annual: $490/year
- Growth annual: $1,490/year
- Scale annual: $3,990/year

**Bonus-off opt-out pricing:** the flat tier × 1.33, no performance bonus charged.
- Starter no-bonus: $65/mo
- Growth no-bonus: $199/mo
- Scale no-bonus: $529/mo

Merchant chooses bonus-on or bonus-off at checkout. Default is bonus-on. Can switch at any monthly boundary.

---

## Unit-economics math (the reason the numbers are what they are)

Approximate cost-to-serve at each tier, assuming **DeepSeek as launch provider** (Lock V7 from POST-EPIC-F-CONSCIOUS-DECISION.md), Postmark for email, Twilio for SMS, and the typical "30% of customers transition to a winback state in a 30-day window" baseline.

### Starter merchant (Tony's Pizza, 500 customers, ~300 sends/mo)

| Cost component | Monthly cost |
|---|---|
| AI generation (300 calls × ~500 tokens avg @ DeepSeek v4-flash $0.14/$0.28 per M) | ~$0.03 |
| Postmark email (assume 70% of sends = 210 emails @ $0.0015/email avg) | ~$0.30 |
| Twilio SMS (assume 30% of sends = 90 SMS @ $0.0079/SMS US) | ~$0.71 |
| Shopify discount API calls (free) | $0 |
| **Total cost-to-serve** | **~$1.04** |
| Tony pays: $49 flat + ~$20 bonus (if he recovers ~$200) | **~$69** |
| **Gross margin per merchant** | **~$68** (~98% margin) |

### Growth merchant (Mario's Pizza, 10,000 customers, ~1,500 sends/mo)

| Cost component | Monthly cost |
|---|---|
| AI generation (1,500 calls @ DeepSeek v4-flash) | ~$0.16 |
| Postmark email (1,050 emails) | ~$1.58 |
| Twilio SMS (450 SMS) | ~$3.56 |
| **Total cost-to-serve** | **~$5.30** |
| Mario pays: $149 flat + ~$150 bonus (if he recovers ~$1,500) | **~$299** |
| **Gross margin per merchant** | **~$294** (~98% margin) |

### Scale merchant (Bruno's Pizza, 50,000 customers, ~7,000 sends/mo)

| Cost component | Monthly cost |
|---|---|
| AI generation (7,000 calls @ DeepSeek v4-flash) | ~$0.74 |
| Postmark email (4,900 emails) | ~$7.35 |
| Twilio SMS (2,100 SMS) | ~$16.59 |
| **Total cost-to-serve** | **~$24.68** |
| Bruno pays: $399 flat + ~$400 bonus (if he recovers ~$4,000) | **~$799** |
| **Gross margin per merchant** | **~$774** (~96% margin) |

### Worst-case scenario (merchant pays flat, recovers $0)

Even if a merchant subscribes to Starter, pays $49 flat, and recovers $0 (so $0 performance bonus), your cost-to-serve is ~$1.04. **You still profit ~$48.** This is the floor that pure-performance pricing would not give you.

### Why DeepSeek-as-launch matters

These numbers assume DeepSeek v4-flash at $0.14 input / $0.28 output per million tokens. If you switch to OpenAI gpt-4.1 ($5/$15 per M), AI cost jumps ~17× (60/40 input/output weighting). At Scale tier (7,000 calls/mo), DeepSeek's ~$0.74 becomes ~$13 on gpt-4.1, ~$1 on gpt-4.1-mini, or ~$30+ on the gpt-5 family — turning a 96% margin tier into ~83% on the cheapest mainstream upgrade and lower from there. **Locking the launch provider (Lock V7) protects the unit economics encoded in this doc.** Switching providers at scale requires a margin re-baseline.

**Rate-verification note.** The figures above were corrected against verified vendor pricing on 2026-05-21 (see `packages/ai/src/cost-rates.ts` header for the URL register and quarterly re-verification cadence). An earlier draft of this document used `deepseek-chat $0.14/$2.80` — a 10× over-statement of the output rate — that was caught during Epic F batch 2's WebFetch verification. The conclusion (98% / 96% margins, floor profit at worst-case) is unchanged; the inputs are now accurate.

---

## Pricing page copy (founder finalizes; this is the architectural intent)

The pricing page tells THREE stories simultaneously:

**The headline:** "Win back lapsed customers. Pay only when we work."
**The proof:** "10% bonus on recovered revenue we prove we generated."
**The safety:** "Flat monthly fee gives you full access. The bonus is on top, only when we actually recover revenue."

The three tiers are presented side-by-side with the middle tier visually emphasized (industry-standard "anchor the middle" tactic — most merchants pick the middle option).

A 14-day free trial banner runs across the top of all three tiers. No credit card. After 14 days, the merchant picks a tier or loses access.

---

## Edge cases

| Case | Handling |
|---|---|
| Merchant exceeds `monthlySendsCap` mid-month | Hard block on additional sends. In-app banner + email: "You've reached your monthly send limit. Upgrade tier for more capacity or wait until next billing cycle." NOT silent over-sending. |
| Merchant's recovered revenue would push performance bonus past the per-tier cap | Bonus charged up to the cap. The bonus-cap line on the invoice reads "Performance bonus (capped at $X for Tier Y)." Merchant feels protected. |
| Merchant's BillingSubscription.status moves to `past_due` | All campaign sends paused. AI generation paused. In-app banner: "Billing issue — update payment to resume." 7-day grace period before `cancelled`. |
| Merchant downgrades mid-cycle | Takes effect at next billing cycle. No refund of the current cycle's flat fee. |
| Merchant upgrades mid-cycle | Prorated additional charge for the remainder of the cycle. Higher quotas + cap apply immediately. |
| Merchant uninstalls mid-cycle | `BillingSubscription.status = 'cancelled'`. No refund of current cycle (Shopify standard). Performance bonus on revenue recovered up to uninstall date still owed; invoiced on cycle-end. |
| Refund of an attributed order within the same calendar month | `AttributionEvent.reversedAt` set. Daily rollup recomputes that day. Performance bonus that month is reduced accordingly. |
| Refund of an attributed order in a LATER month | NOT clawed back. The bonus from month N is final after month N closes. Treated as cost-of-doing-business; the variance is bounded by typical refund rates (<3% of revenue). |
| Merchant's Customer count grows past their tier's cap | Automatic warning at 90% of cap (in-app banner + email). At 100% of cap: soft-block (campaigns still send, banner intensifies). At 110% of cap: hard-block on new campaigns until upgrade. |
| Merchant on annual plan recovers far more than the annual flat covers | Performance bonus invoiced monthly even on annual plans. Annual = pre-pay the flat; bonus is always monthly. |
| Disputed attribution number | Merchant clicks "view attribution detail" on the dashboard → sees the customer + order + message that produced the bonus row. Same number the bill is computed from. Disputes get filed through Shopify Partners support; we resolve case-by-case. |
| Merchant requests a refund of the performance bonus | Per Shopify partner agreement, all charges are final after 60 days. Within 60 days, refund at founder discretion. Pattern: refund first time, second time investigate, third time something else is wrong. |

---

## What this model is NOT (and why)

**Not pure performance pricing.** Because: your costs (AI, SendGrid, Twilio) bill monthly regardless of merchant recovery. A pure performance model creates uncovered fixed costs in a slow month.

**Not pure flat pricing.** Because: the pitch loses its strongest hook ("only pay when we work"). And Klaviyo/Postscript/Recharge already do pure flat. Differentiation matters.

**Not per-send pricing.** Because: it creates merchant friction at every campaign decision ("should I send this? it'll cost me $X"). Merchants under per-send pricing use the product less. Less product use = more churn.

**Not per-message-opened or per-click pricing.** Because: those metrics are gamed easily, and attribution disputes would be even worse than recovered-revenue disputes.

**Not pay-as-you-go for AI credits.** Because: this is what your customer originally explored. Pushes the cost-management burden onto the merchant. Merchants don't want to think about AI costs. They want to think about results.

---

## Open questions for founder before Section 10 (Billing API) opens

| Q | Decision needed by |
|---|---|
| Final tier prices locked? (currently $49/$149/$399; market-tested during design partner phase) | Week 12 of v1 roadmap (before Section 10 batch 10.1) |
| Bonus percentage final? (currently 10%; could be 8% or 12% depending on design partner feedback) | Week 12 |
| Trial length final? (currently 14 days; could be 21) | Week 12 |
| Custom tier threshold? (currently 100,001 customers; could be 50,001) | Week 12 |
| Annual discount final? (currently 2 months free = 16.67%; could be 1 month = 8.33%) | Week 12 |
| Bonus-off opt-out multiplier final? (currently 1.33x; could be 1.5x) | Week 12 |
| Per-tier bonus caps final? (currently $200/$750/$2500) | Week 12 |

All of these are tunable. The SHAPE of the model is locked (P1–P11); the NUMBERS are inputs from design partner research.

---

## Implementation footprint (Section 10 batches will reference this doc)

The Billing API integration (Section 10 of POST-EPIC-F-CONSCIOUS-DECISION.md) reads this doc as the contract for:

- `BillingSubscription.plan` values: `'starter' | 'growth' | 'scale' | 'custom' | 'starter_annual' | 'growth_annual' | 'scale_annual' | 'starter_no_bonus' | 'growth_no_bonus' | 'scale_no_bonus'`
- Tier-cap reads at quota-enforcement time (existing `MerchantSettings.monthlySendsCap` populated from tier on subscription activation)
- Performance bonus invoice computation at end-of-month cron (reads `MetricsDailyRollup` for the month, applies 10% with per-tier cap)
- Trial expiry handling (`BillingSubscription.trialEndsAt` already in schema)
- Tier transition handling per P10

Section 10 batch 10.1 (subscription creation flow) will hardcode the tier definitions from this doc as the source of truth. Future tier changes update this doc + a follow-up commit in `packages/contracts` adding the new plan literal to `BillingSubscription.plan` typing.

---

## Resolution log

Mark each open question ✅ when locked. Use the SHA + date.

- P1–P11 ✅ approved by founder on 2026-05-21 (model shape locked)
- Final tier numbers: pending design partner research (target close: week 12 of v1 roadmap)

---

*Source of truth for v1 pricing. Update in the same commit as any work that changes the model shape, tier structure, or billing-related schema fields.*
