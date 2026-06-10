/**
 * Canonical registry of AuditLog.action values. Every writer of `AuditLog`
 * MUST reference a constant from this object — never a string literal.
 *
 * Naming convention (same as OUTBOX_EVENTS — `<domain>.<action>` lowercase,
 * underscores allowed, optional `@v<n>` suffix on payload changes):
 *
 *   gdpr.customer_redact
 *   gdpr.shop_redact_idempotent
 *
 * There is no DB CHECK constraint on AuditLog.action — this registry plus
 * the typed write chokepoint in `AuditLogRepository` are the enforcement.
 * Free-form strings at the DB layer would be a typo-into-production hazard.
 *
 * Why this is a separate registry from OUTBOX_EVENTS: per the Audit Write
 * Policy in ARCHITECTURE.md, AuditLog rows are written DIRECTLY in the
 * same DB transaction as the business action they record — never via the
 * outbox. The two registries describe two different write paths.
 *
 * Adding a new action:
 *   1. Add the constant here under the appropriate domain (or create a new
 *      domain if it's the first action of a category).
 *   2. Use the constant at the call site — `AuditLogRepository.append`
 *      accepts only `AuditAction`, not raw strings.
 *   3. The registry's exhaustive shape test (packages/contracts/tests/
 *      registries.test.ts) will pass automatically.
 */

export const AUDIT_ACTIONS = {
  gdpr: {
    /** Customer (or merchant) requested a copy of their data. */
    customer_data_request: 'gdpr.customer_data_request',
    /** Customer PII NULL-ed and Customer row soft-deleted. */
    customer_redact: 'gdpr.customer_redact',
    /** customers/redact webhook arrived with a malformed customer.id. */
    customer_redact_malformed: 'gdpr.customer_redact_malformed',
    /** customers/redact webhook for a customer we never ingested. */
    customer_redact_no_local_record: 'gdpr.customer_redact_no_local_record',
    /** Shop fully redacted (Merchant row + all tenant data deleted). */
    shop_redact: 'gdpr.shop_redact',
    /** shop/redact webhook for a merchant already gone (idempotent ack). */
    shop_redact_idempotent: 'gdpr.shop_redact_idempotent',
  },
  /**
   * Outbox operator CLI actions (D4). Written by `apps/cli` in the same
   * tx as the corresponding `OutboxRepository` mutation. `actorType` is
   * `operator` for both; `actorId` is captured from `process.env.USER`.
   */
  outbox: {
    /** Operator requeued a dead-lettered event (`pnpm cli:outbox:replay`). */
    replay: 'outbox.replay',
    /** Operator force-DLQ'd a stuck event (`pnpm cli:outbox:dead-letter`). */
    dead_letter_forced: 'outbox.dead_letter_forced',
  },
  /**
   * Customer lifecycle actions (Epic E session 2). Written by the scoring
   * service in the same tx as the `Customer.state` update + outbox event.
   * `actorType` is `system`; `actorId` is `'drainer'` (the only producer).
   * See EPIC-E-SESSION-2-DESIGN.md §AUDIT_ACTIONS-additions.
   */
  customer: {
    /** RFM scoring recompute moved the customer between state bands. */
    state_changed: 'customer.state_changed',
  },
  /**
   * Merchant lifecycle actions (A1a / POST-EPIC-F §1 / Lock V10). Written by
   * the bulk-rescore pass (A1b) in the SAME tx as the
   * `Merchant.scoringInitializedAt` flag-flip that completes the first
   * scoring pass. `actorType` is `system`; `actorId` is the operator/CLI
   * identity. See ARCHITECTURE.md "Customer State Single-Owner Policy".
   */
  merchant: {
    /**
     * First scoring pass complete — `scoringInitializedAt` set. From this
     * point on, `CustomerScoreService.recompute` emits state transitions
     * normally (the install-day suppression gate opens).
     */
    scoring_initialized: 'merchant.scoring_initialized',
  },
  /**
   * AI generation pipeline actions (Epic F batch 4). Written by the AI
   * Worker (`apps/drainer/src/workers/ai-generate.worker.ts`) and the
   * `handleCustomerStateChanged` drainer handler in the same tx as the
   * `AiGeneration` row mutation that records the outcome. `actorType` is
   * `system`; `actorId` is `'drainer'`.
   *
   * See EPIC-F-DESIGN.md §F-9 (handler) + §F-8 (worker).
   */
  ai: {
    /**
     * Non-retryable provider failure (after the worker classifies
     * `AiProviderError.retryable === false`). Covers `invalid_request`,
     * `auth`, and any provider-side bug that exhausts retries.
     * `content_blocked` and spend-cap rejections have their own actions
     * below for forensic clarity.
     */
    generation_failed: 'ai.generation_failed',
    /**
     * Pre-flight spend ceiling check (§F-6 / §F-9 step 5) rejected the
     * generation because `currentMonthSpend + estimatedCallCost >
     * monthlyAiSpendCapCents`. No `AiGeneration` row created; this audit
     * row IS the forensic record of the denial.
     */
    spend_cap_exceeded: 'ai.spend_cap_exceeded',
    /**
     * A2 / POST-EPIC-F §2 — per-merchant hourly generation cap exceeded.
     * Gated in `handleCustomerStateChanged` BEFORE the spend-cap check
     * (cheap Redis-INCR rejection before any DB write — mirrors the
     * `spend_cap_exceeded` pattern: NO `AiGeneration` row created on
     * denial; this audit row IS the forensic record).
     *
     * LOAD-BEARING observability: this audit is the only signal that a
     * merchant is losing winbacks to the hourly cap. Must remain
     * queryable by `merchantId` (top-level column, not just context).
     * Context payload carries `{ currentCount, hourlyGenerationCap,
     * hourBucket, eventId }` for forensic dedupe across drainer re-runs.
     */
    rate_limited: 'ai.rate_limited',
    /**
     * Provider returned a content-policy block (`AiProviderContentBlockedError`
     * — `finish_reason === 'content_filter'` for OpenAI, `stop_reason ===
     * 'refusal'` for Anthropic, empty content for DeepSeek). Non-retryable;
     * the same prompt will be blocked on every retry.
     */
    content_blocked: 'ai.content_blocked',
  },
  /**
   * Discount lifecycle actions (A4 / POST-EPIC-F §4 batch 4.2). Written by
   * the AI Worker (`apps/drainer/src/workers/ai-generate.worker.ts`) in the
   * SAME tx as the `AiGeneration` completion that records the minted Shopify
   * discount on a winback message (rule #14 — audit-in-same-tx as the state
   * transition it records). `actorType` is `system`; `actorId` is `'drainer'`.
   *
   * The `4.3` cleanup cron and its `discount.expired` action are DEFERRED —
   * Shopify-side `endsAt` (set to `attributionDirectWindowDays` at creation)
   * expires the code server-side, so cleanup is housekeeping, not correctness.
   */
  discount: {
    /**
     * A customer-scoped, single-use Shopify discount code was minted for a
     * winback message. The code is a deterministic keyed-HMAC value
     * (idempotent on retry — Shopify rejects duplicate codes with `TAKEN`,
     * which the worker treats as success). Context carries
     * `{ shopifyDiscountId, valuePercent }`; the code string itself is NOT
     * logged in the audit context (it ships to the customer, not the log).
     */
    created: 'discount.created',
  },
} as const;

/**
 * Flat union of every audit-action literal — the type used for
 * `AuditLog.action`, `AppendAuditLogInput.action`, and `AuditContext.action`.
 *
 * [CLEANUP] Asymmetry with `SYSTEM_SCOPE_REASONS` / `QUEUE_NAMES` /
 * `OUTBOX_EVENTS`: those registries use `Object.values(REGISTRY).flatMap(
 * Object.values)`-style runtime extraction so the type union derives
 * itself from the const without per-category spread lines. This file
 * still requires a hand-edited union spread per new category (added
 * `outbox` in D4 — manual edit). Refactor candidate: switch this to the
 * auto-extending pattern so adding a future `billing` or `operator`
 * category is a const-only change. Out of D4 scope; tracked as a
 * deferred cleanup item.
 */
export type AuditAction =
  | (typeof AUDIT_ACTIONS.gdpr)[keyof typeof AUDIT_ACTIONS.gdpr]
  | (typeof AUDIT_ACTIONS.outbox)[keyof typeof AUDIT_ACTIONS.outbox]
  | (typeof AUDIT_ACTIONS.customer)[keyof typeof AUDIT_ACTIONS.customer]
  | (typeof AUDIT_ACTIONS.merchant)[keyof typeof AUDIT_ACTIONS.merchant]
  | (typeof AUDIT_ACTIONS.ai)[keyof typeof AUDIT_ACTIONS.ai]
  | (typeof AUDIT_ACTIONS.discount)[keyof typeof AUDIT_ACTIONS.discount];

/** Runtime Set of every registered action, for shape tests + iteration. */
export const ALL_AUDIT_ACTIONS: ReadonlySet<AuditAction> = new Set([
  ...Object.values(AUDIT_ACTIONS.gdpr),
  ...Object.values(AUDIT_ACTIONS.outbox),
  ...Object.values(AUDIT_ACTIONS.customer),
  ...Object.values(AUDIT_ACTIONS.merchant),
  ...Object.values(AUDIT_ACTIONS.ai),
  ...Object.values(AUDIT_ACTIONS.discount),
] as AuditAction[]);

/**
 * Predicate. Useful for inputs that are typed `string` at a boundary
 * (e.g. CLI args, untrusted API params) before they cross into the
 * AuditAction-typed code path.
 */
export function isAuditAction(value: string): value is AuditAction {
  return ALL_AUDIT_ACTIONS.has(value as AuditAction);
}
