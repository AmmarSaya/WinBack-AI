-- P-1 (POINTS-TO-CONSIDER) — add DB-level DEFAULT CURRENT_TIMESTAMP to every
-- `@updatedAt` column. Closes the gap where Prisma's `@updatedAt` decorator
-- sets the column on every client write but emits NO `DEFAULT` clause, so a
-- raw SQL `INSERT` that omits the column fails with a NOT NULL violation.
--
-- Schema-driven match: each Prisma model's `updatedAt` field is declared
-- `updatedAt DateTime @default(now()) @updatedAt`. The `@updatedAt`
-- decorator still drives runtime writes (Prisma client wins on every
-- update); the `@default(now())` translates to the SQL DEFAULT below as a
-- raw-SQL backstop.
--
-- 11 affected models — exhaustively the set of Prisma models in this schema
-- with an `@updatedAt` field. Excluded by design (no such column):
--   Session         — Shopify-adapter-owned, no @updatedAt
--   OrderLineItem   — immutable rows, no @updatedAt
--   WebhookLog      — append-only, no @updatedAt
--   OutboxEvent     — state transitions via specific columns, no @updatedAt
--   IdempotencyKey  — append-only with TTL, no @updatedAt
--   AuditLog        — append-only forensic, no @updatedAt
--   AiGeneration    — append-only post-completion, no @updatedAt
--
-- Operation cost:
--   ALTER COLUMN ... SET DEFAULT is a Postgres metadata-only change. No
--   row scans, no table rewrites. ACCESS EXCLUSIVE lock held per ALTER
--   for microseconds. Existing rows are unaffected — DEFAULT only applies
--   to future INSERTs that omit the column. Idempotent — re-running this
--   migration is a no-op.
--
-- Rollback (if ever needed):
--   ALTER TABLE "<table>" ALTER COLUMN "updatedAt" DROP DEFAULT;
--   for each row below. Paired rollback.sql NOT created — the migration
--   is non-destructive and trivially reversible inline.
--
-- First production migration against live Neon. Applied via the standard
-- `pnpm --filter @winback/db exec prisma migrate deploy` flow after the PR
-- merges to main (see operator runbook in OPERATIONS.md / forthcoming).

ALTER TABLE "Merchant" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "MerchantSettings" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "BillingSubscription" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Customer" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "CustomerScore" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Product" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "ProductVariant" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Order" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "BackfillJob" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Message" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "AiSpendBucket" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
