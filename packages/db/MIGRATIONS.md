# Database Migrations Policy

The rules in this file are load-bearing. A schema is a contract; migrations
are how the contract evolves without breaking the system that depends on it.
Violating these rules is how you turn a 5-minute change into a multi-day
production incident.

## Two kinds of migration

1. **Auto-generated baseline migrations** — produced by `pnpm db:migrate:dev`.
   Files live in `prisma/migrations/<timestamp>_<name>/migration.sql`.
   These reflect drift between `schema.prisma` and the database.
   **Never edit them by hand.**

2. **Hand-authored raw-SQL migrations** — for features Prisma's DSL cannot
   express: functional indexes, partial indexes, CHECK constraints, GIN
   indexes, triggers, partitions. Each lives in its own folder with
   `migration.sql` (UP) and `rollback.sql` (DOWN).

**Never mix.** A migration folder contains either auto-generated SQL OR
hand-authored SQL. Mixing produces files that `prisma migrate dev` cannot
reconcile.

## Hand-authored migration rules

- One concern per folder. Don't bundle functional indexes with check
  constraints; their failure modes and rollback paths differ.
- `migration.sql` (UP) is always paired with `rollback.sql` (DOWN).
- The file header names the task IDs it implements (`T1`, `T2`, ...) and
  references the relevant section in the `schema.prisma` header.
- DROPs in rollback use `IF EXISTS` so re-application is safe.
- Folder name format: `<UTC-timestamp>_<snake_case_description>`.

## Expand-then-contract pattern

For any column rename or type change on a table with data, the migration is
six independent deployable steps:

1. **EXPAND** — add the new column (nullable or with default).
2. **DUAL-WRITE** — app code writes to both old and new columns.
3. **BACKFILL** — chunked data migration copies old → new, throttled and
   monitored. Often runs as a background script, not a migration.
4. **CUT READERS** — app code reads from the new column only.
5. **STOP DUAL-WRITE** — app code writes to the new column only.
6. **CONTRACT** — drop the old column.

The schema is always backwards-compatible with the currently-deployed app
version. Any single step can fail and be rolled back without losing data.

This is the slowest correct path. Faster paths usually require downtime.

## Production deployment rules

### `CREATE INDEX CONCURRENTLY` on hot tables

`CREATE INDEX CONCURRENTLY` does not lock the table for writes but **cannot
run inside a transaction**. Prisma wraps every migration file in a transaction
by default. Mixing `CONCURRENTLY` with other DDL in one file causes
mid-migration failure.

**Hard rules:**

1. A migration containing `CREATE INDEX CONCURRENTLY` (or `DROP INDEX
   CONCURRENTLY`) MUST be the **only** statement in its `migration.sql`. No
   other DDL or DML in the same file. Mark the file with this header:

   ```sql
   -- @op-applied
   -- This migration uses CREATE INDEX CONCURRENTLY and cannot run inside a
   -- transaction. `prisma migrate deploy` will fail on this file. Operator
   -- applies via psql, then marks resolved.
   ```

2. The operator runbook for these migrations is:

   ```bash
   psql "$DATABASE_URL" -f packages/db/prisma/migrations/<ts>_<name>/migration.sql
   pnpm --filter @winback/db prisma migrate resolve --applied <ts>_<name>
   ```

3. CI lint check (M10): any `migration.sql` containing `CONCURRENTLY` MUST
   also contain the `@op-applied` marker AND must not contain any other
   statement-terminating semicolons except the single `CREATE/DROP INDEX
   CONCURRENTLY`. Until the lint check ships, reviewers enforce by hand.

### `NOT NULL` on new columns

Only safe if the column has `DEFAULT` or the table is empty. Otherwise, a
three-migration sequence:

1. Add nullable column.
2. Backfill in chunks (separate maintenance job, not a migration).
3. `ALTER COLUMN ... SET NOT NULL`.

Step 3 acquires a brief lock to verify the constraint. On large tables, use
the `ADD CONSTRAINT ... CHECK (col IS NOT NULL) NOT VALID` / `VALIDATE
CONSTRAINT` two-step described below, then convert to `SET NOT NULL` at a
maintenance window.

### Foreign keys on populated tables

Adding a FK to a populated table acquires a `ShareRowExclusiveLock` while
existing rows are validated — blocks writers, possibly for minutes on large
tables. The two-step pattern:

1. **Add NOT VALID** — creates the constraint without checking existing rows.
   Acquires only a brief metadata lock. **The constraint enforces NEW writes
   immediately** but existing rows may already violate it.

   ```sql
   ALTER TABLE "Child" ADD CONSTRAINT "Child_parentId_fkey"
     FOREIGN KEY ("parentId") REFERENCES "Parent"("id") NOT VALID;
   ```

2. **VALIDATE CONSTRAINT** — checks existing rows. Acquires only a
   `ShareUpdateExclusiveLock` (does not block writers).

   ```sql
   ALTER TABLE "Child" VALIDATE CONSTRAINT "Child_parentId_fkey";
   ```

**Timing rule — when VALIDATE must run:**

The `VALIDATE CONSTRAINT` step MUST run in the **same release cycle** as the
`ADD ... NOT VALID` step — defined as **within 24 hours of the NOT VALID
deploy**, and **always before the next code deploy** that depends on the
constraint being valid. Concretely:

- Deploy with `NOT VALID` Monday morning → `VALIDATE` Monday or Tuesday at
  the latest.
- Operator opens a tracking ticket at NOT VALID deploy time, owner assigned,
  due date is 24 hours later. Ticket auto-pages if unresolved.
- Monitoring: a `convalidated = false` row in `pg_constraint` past the
  24-hour window is a paging alert. The `convalidated` column is the
  authoritative check; never trust application logs.

A `NOT VALID` constraint that sits indefinitely gives **false confidence** —
the schema looks correct, the constraint exists by name, but historical data
may already violate it. Treat unvalidated constraints as production
incidents, not as paperwork.

### Column drops

Deprecate in code first; deploy that; soak for at least one release; only
then drop the column in a separate migration. A column dropped while a
deployed worker still writes to it is a deploy failure.

## Tenant-safety review for raw migrations (mandatory)

Any hand-authored migration touching a multi-tenant table requires the
reviewer to confirm in the PR description:

- [ ] DDL preserves `merchantId` constraints (or has documented exception
      with sign-off).
- [ ] DML qualifies by `merchantId` in `WHERE` clauses, OR processes data
      in batches keyed by `merchantId`.
- [ ] CHECK constraints reference `merchantId`-qualified data where
      applicable.
- [ ] No new index permits a cross-tenant scan — every composite index
      leads with `merchantId`.
- [ ] No `DELETE` without a `WHERE` clause. No `UPDATE` without a `WHERE`
      clause.

Lint rules cannot catch these. Code review is the enforcement.

## CI drift check

`prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --exit-code`
runs on every PR. Non-zero exit fails the PR. The check is **not** gated to
"only run on merge" — every PR that touches schema or migrations sees it.

This catches the most common bug: someone edits `schema.prisma` without
running `prisma migrate dev` to regenerate the corresponding migration.

## Rollback policy

- `rollback.sql` is operator-applied. Prisma does not invoke it.
- During a failed deploy, the operator chooses: roll forward (fix in the
  next deploy) or apply `rollback.sql` manually.
- Migrations that drop data (column drops, table drops) require a soak
  period in production with the code deprecated before the drop migration
  ships. If a bug is found post-drop, the data is gone.

## Local development workflow

```bash
# Create + apply a new migration locally (interactive)
pnpm db:migrate:dev --name <descriptive_name>

# See applied + pending migrations
pnpm db:migrate:status

# Detect drift between schema and migrations
pnpm db:migrate:diff

# Wipe + reapply (development/test only — three guards in db-reset.mjs)
pnpm db:reset
```

## Production / staging deployment

```bash
# Applies pending migrations. Never auto-generates new migrations.
pnpm db:migrate:deploy
```

`migrate deploy` runs each migration in its own transaction. If one fails,
later migrations don't run; the operator inspects, fixes, redeploys.

## Raw SQL access — repository convention

`$queryRaw` and `$executeRaw` bypass the Prisma extension entirely. Tenant
assertion, soft-delete auto-filtering, and AiTone validation all stop
working for raw paths. A raw query written without explicit tenant
assertion is a P1 tenant-safety bug.

**The convention (B3 enforced):** repositories that need raw SQL extend
`BaseRepository` and use its protected helpers:

- `queryRawScoped(merchantId, sql)` — read-side raw SQL.
- `executeRawScoped(merchantId, sql)` — write-side raw SQL.

Both assert that the active scope matches `merchantId` (or is system
scope) BEFORE the query executes. Raw SQL is responsible for its own
`merchantId = $n` and `deletedAt IS NULL` predicates — those are not
auto-applied.

```ts
class CustomerRepository extends BaseRepository {
  async findByEmail(merchantId: string, email: string) {
    return this.queryRawScoped<Customer>(merchantId, Prisma.sql`
      SELECT * FROM "Customer"
      WHERE "merchantId" = ${merchantId}
        AND lower(email) = lower(${email})
        AND "deletedAt" IS NULL
      LIMIT 1
    `);
  }
}
```

**Rules:**

- Direct `this.prisma.$queryRaw` / `$executeRaw` use outside
  `BaseRepository` is forbidden. Lint rule lands in M10; until then,
  code-review enforcement.
- A repository that extends `BaseRepository` is a signal to reviewers
  that it contains raw SQL — that itself is enough context for a careful
  review.
- Use `Prisma.sql` template literals (parameter binding). Never
  string-concatenate user-supplied values into SQL.

## Things this file does NOT cover

- Seeding: see `pnpm db:seed:test` (stub in B2; populated in later subsystems).
- Backup / PITR / disaster recovery: ops domain, not migration domain.
- Performance tuning of existing queries: `EXPLAIN ANALYZE`-driven, not
  schema-change-driven.
