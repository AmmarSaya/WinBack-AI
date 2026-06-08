# Architecture Decisions — AI Customer Winback

Permanent reference for locked architectural decisions. Each section
describes a decision, the rationale, and the constraints it imposes on
future code. **These decisions are not provisional.** Reversing one is
a coordinated cross-package change that requires a written counter-proposal
documented here.

The detailed conventions live in subsystem file headers and in
`packages/db/MIGRATIONS.md`. This file is for the cross-cutting policies
that span multiple packages.

---

## Audit Write Policy

**Decision.** `AuditLog` rows are written **directly**, in the same DB
transaction as the business action they record. They are **not** routed
through the outbox.

**Why.** The primary use of `AuditLog` is GDPR / compliance evidence —
"prove that customer 12345's PII was redacted at 14:02:31Z on the same
transaction as the row mutation that removed it." Drainer latency (the
gap between the outbox write and the row materialization) is incompatible
with that posture. A compliance auditor reading two rows minutes apart in
two log streams cannot prove they describe the same atomic event; a
single row written in the same `prisma.$transaction` as the redact can.

**Constraints this imposes on code.**

1. Producers write `AuditLog` rows inside their own transaction (typically
   via `ctx.db.auditLog.create` inside a `UnitOfWork.run` callback, or via
   `AuditLogRepository.append` when the caller is already in scope).
2. `AuditLog.action` is typed `AuditAction` (from
   `@winback/contracts`/`AUDIT_ACTIONS`). Raw string literals are a
   compile error at every write site.
3. The outbox **does not** carry audit events. There is no `audit.entry`
   event type in `OUTBOX_EVENTS`. Adding one back is a policy reversal,
   not a routine schema change. See `packages/contracts/src/events.ts`
   header for the lock.
4. New auditable actions: add the constant to `AUDIT_ACTIONS.<domain>`,
   then call `AuditLogRepository.append({ action: AUDIT_ACTIONS.<...>, … })`.
   The exhaustive shape test in `packages/contracts/tests/registries.test.ts`
   covers the registry; the typed chokepoint covers every call site.

**What this policy does NOT prohibit.** Subsystems that have their own
outbox events for business-event reasons (e.g. `merchant.uninstalled` →
downstream consumers care) keep writing those. The policy is only about
*audit-trail* rows, not about the outbox in general.

---

## System Scope Discipline

**Decision.** `withSystemScope(reason, fn)` is the **only** way to perform
cross-tenant or pre-tenant DB operations. `reason` is typed
`SystemScopeReason` from `@winback/contracts`. Every entry into system
scope must reference a registered reason, full stop.

**Why.** System scope is the escape hatch that bypasses the Prisma
extension's tenant assertion. The reason string is the audit trail —
greppable, log-surfaced, registry-validated documentation of *why* a
particular call escaped tenancy. Free-form strings let typos and ad-hoc
reasons proliferate, defeating the auditability.

**Constraints this imposes on code.**

1. Adding a new system-scope use case: register the reason in
   `SYSTEM_SCOPE_REASONS.<category>` *first*, then use the constant at
   the call site.
2. Test-only escape: the function signature also accepts the template
   literal `\`test.${string}\`` for ad-hoc test scenarios. The runtime
   regex still rejects `test.` with an empty suffix and any other
   malformed input — typed gate and runtime gate diverge on that edge,
   which is by design (the runtime is the production safety net for
   callers that bypass TS).
3. Production code passing a string that is neither a registered
   `SystemScopeReason` nor `test.*` is a TS compile error. Production
   code that bypasses TS (e.g. `as never`) still hits the runtime regex.

---

## Repository Chokepoint Policy (clarification of standing rule R3)

**Decision.** Direct `prisma.<model>` / `tx.<model>` access is permitted
**inside `UnitOfWork.run` transaction callbacks** and at the **install /
session / webhook-ingest entrypoints** that run before tenant scope is
established. All other multi-step or business-domain writes go through
repositories that extend `BaseRepository`.

**Why.** The standing rule "Repositories are the typed write chokepoints"
was originally stated absolutely. In practice, transaction-scoped writes
inside `UnitOfWork.run` callbacks already have tenant safety enforced by
the Prisma extension; passing a `tx` client through a repository adds
indirection without safety benefit. The install + webhook-ingest
entrypoints similarly cannot use repositories that assume tenant scope.

The rule's intent — **tenant safety** — is enforced at the query layer by
the extension, regardless of whether the call site is a repository method
or an inline `tx.foo.create`. The rule's secondary goal — **typed
chokepoints for domain invariants** — applies wherever the operation has
domain semantics beyond CRUD.

**Constraints this imposes on code.**

1. Application code that performs a single domain operation (e.g.
   "redact a customer", "create an outbox event for a known type")
   uses a repository.
2. Application code that performs a multi-step write inside a single
   transaction may use `ctx.db.<model>` directly; the `UnitOfWork.run`
   wrapper provides the tenant scope.
3. Pre-tenant operations (install flow, webhook ingest, GDPR shop-redact's
   merchant lookup) use `withSystemScope` + direct `prisma.<model>`.

**Note.** This clarification is not blanket permission. Reviewers should
still ask "could this be a repository method?" at every direct-prisma
call site outside `@winback/db`. The answer is sometimes "yes, and it
should be" — see the open `MerchantRepository` task in the pre-CP-2 prep
register.

---

## Customer State Single-Owner Policy (lock #22 / C9 — amended A1a)

**Decision.** `Customer.state` is written **only** by `CustomerScoreService`.
The service has **two** authorized state-writing methods:

- `recompute` — steady-state, per-customer, inline in the drainer's order /
  customer webhook handlers. The **transition detector**.
- `bulkRescore` — the operator bulk-rescore pass (A1b). The **batch
  (re)assigner** that runs a merchant's initial scoring pass.

No other method, repository, handler, or webhook upsert may write
`Customer.state`.

**Why — two invariants this protects.**

1. **Provenance.** `Customer.state` is the RFM-computed lifecycle band
   (`active/warm/at_risk/dormant/lost/insufficient_data`). It collides *by
   name* with Shopify's customer `state` enum
   (`enabled/disabled/invited/declined`) — an unrelated account-lifecycle
   concept that arrives on every `customers/*` webhook. The single-owner rule
   is why `CustomerRepository.upsertFromWebhook` excludes `state` from its
   writable fields: a webhook upsert must never clobber the computed band with
   Shopify's colliding value. Both authorized methods write the band
   **exclusively** from the pure `scoring-math` functions — never from any
   Shopify-sourced field.

2. **Side-effect routing.** Emission of `customer.state_changed` (the winback
   send-driver OutboxEvent + its forensic AuditLog) flows through exactly one
   **transition detector**: `recompute`, gated on
   `Merchant.scoringInitializedAt` (suppressed while null — first-pass
   suppression, Lock V10). `bulkRescore` performs batch assignment and
   **NEVER emits** `customer.state_changed` — a batch pass is not a transition
   stream, so it correctly has no transition side-effect. This makes the
   install-day storm structurally impossible: there is no flag value, no
   force flag, and no code path by which a bulk pass fires winback events.
   Catching up genuinely-missed lapses with sends is the job of a separate,
   **rate-limited** periodic decay-rescore sweep (future), never of
   `bulkRescore`.

**Why this is a widening, not a loosening.** The lock moves from
single-*writer* (`recompute` only) to single-*owner* (the service, two
methods). Both invariants hold unchanged: provenance (RFM-only writes) and
side-effect routing (emission via exactly one gated transition detector).
`bulkRescore` writing state without emitting does not punch a hole — a batch
assignment is definitionally not a transition.

**Constraints this imposes on code.**

1. Any new `Customer.state` write goes through `CustomerScoreService`. Adding
   a third writer requires amending this section first.
2. `recompute` gates emission on `Merchant.scoringInitializedAt`; the
   `Customer.state` update + `CustomerScore` upsert are unconditional (the
   band must always be correct).
3. `bulkRescore` always suppresses `customer.state_changed` emission,
   regardless of flag state, and sets `scoringInitializedAt` in the same tx as
   its final batch (atomic — a partial pass leaves the flag null so a rerun
   re-attempts the whole pass under suppression). It refuses to run when the
   flag is already set (idempotency guard; `--force` re-baselines silently,
   never emitting).
4. A grep for `Customer.state` writes must return only the two
   `CustomerScoreService` methods. The `POST-EPIC-E-AUDIT.md` §1.6 / §5.1
   single-writer check is updated to a single-owner (two-method) check.
