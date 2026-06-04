/**
 * Registry-as-source-of-truth shape tests (B1 / closes 7 of 9 audit findings).
 *
 * Closes the registry-drift class flagged by the pre-Epic-G audit:
 *   L2-M1  TENANT_SCOPED_MODELS missing BackfillJob
 *   L3-H2  SHOP_REDACT_TABLES_IN_ORDER missing 4 Epic E/F tables
 *   L4-H2  No registry-shape test for the 7 currently-drift-prone lists
 *   L6-H1  SOFT_DELETE_MODELS closed-set with no shape test
 *   L6-H2  PROVIDER_COST_RATES ↔ *_MODELS asymmetric drift catch
 *   L6-H3  customerStateValues ↔ Prisma CustomerState (also fixes false comment)
 *   L6-L1  TENANT_OPTIONAL_READ_MODELS completeness untested
 *   L6-M3  WEBHOOK_TOPIC_TO_EVENT silent-topic-skip drift class
 *
 * Approach:
 *   - Schema-derived structures (1, 2, 3, 4, 6) read truth from Prisma DMMF
 *     at runtime via `Prisma.dmmf.datamodel.{models,enums}`. Verified at
 *     Prisma 5.22 — `field.relationOnDelete` exposes Cascade/SetNull, and
 *     enum.values exposes the enum string list. No schema-text parsing.
 *   - Cross-structure pairings (5, 7) assert symmetric key-set equality
 *     between two hand-maintained registries.
 *
 * Failure-message discipline: every assertion is wrapped to surface the
 * SPECIFIC missing/extra entries, not just "set A != set B". A red test
 * must tell the contributor exactly what to add/remove.
 *
 * Sibling test for #8 (AiProviderErrorCode → audit-action mapping) lives in
 * `apps/drainer/tests/ai-error-mapping.test.ts` because the mapping site is
 * the worker file; the test must live where the mapping lives.
 */

import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { ALL_OUTBOX_EVENT_TYPES } from '@winback/contracts';

import {
  ANTHROPIC_MODELS,
  DEEPSEEK_MODELS,
  OPENAI_MODELS,
  PROVIDER_COST_RATES,
} from '@winback/ai';

import { WEBHOOK_TOPIC_TO_EVENT } from '@winback/shopify';

import { SHOP_REDACT_TABLES_IN_ORDER } from '../src/compliance/gdpr-processor.js';
import { customerStateValues } from '../src/events/customer-state-changed.js';
import {
  SOFT_DELETE_MODELS,
  TENANT_OPTIONAL_READ_MODELS,
  TENANT_SCOPED_MODELS,
} from '../src/tenant-scope.js';

// ===========================================================================
// Schema-derivation helpers (Prisma DMMF, runtime; no .prisma text parsing)
// ===========================================================================

/** Models with a `merchant Merchant @relation(onDelete: Cascade)` field. */
function getMerchantCascadeModels(): Set<string> {
  return new Set(
    Prisma.dmmf.datamodel.models
      .filter((model) =>
        model.fields.some(
          (f) =>
            f.kind === 'object' &&
            f.type === 'Merchant' &&
            f.relationOnDelete === 'Cascade',
        ),
      )
      .map((m) => m.name),
  );
}

/** Models with a `merchant Merchant? @relation(onDelete: SetNull)` field. */
function getMerchantSetNullModels(): Set<string> {
  return new Set(
    Prisma.dmmf.datamodel.models
      .filter((model) =>
        model.fields.some(
          (f) =>
            f.kind === 'object' &&
            f.type === 'Merchant' &&
            f.relationOnDelete === 'SetNull',
        ),
      )
      .map((m) => m.name),
  );
}

/** Models with a `deletedAt DateTime?` scalar field. */
function getSoftDeleteModels(): Set<string> {
  return new Set(
    Prisma.dmmf.datamodel.models
      .filter((model) =>
        model.fields.some(
          (f) =>
            f.name === 'deletedAt' &&
            f.kind === 'scalar' &&
            f.type === 'DateTime' &&
            !f.isRequired,
        ),
      )
      .map((m) => m.name),
  );
}

/** Prisma enum values for a given enum name; throws if missing. */
function getEnumValues(enumName: string): readonly string[] {
  const e = Prisma.dmmf.datamodel.enums.find((x) => x.name === enumName);
  if (e === undefined) {
    throw new Error(`Prisma DMMF: enum ${enumName} not found`);
  }
  return e.values.map((v) => v.name);
}

/**
 * Prisma model names are PascalCase ('BackfillJob'); SHOP_REDACT_TABLES_IN_ORDER
 * uses Prisma client method names which are camelCase ('backfillJob'). Convert
 * before comparing.
 */
function pascalToCamel(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** Symmetric set-diff helper with descriptive failure context. */
function diffSets(
  expected: ReadonlySet<string>,
  actual: ReadonlySet<string>,
): { missing: string[]; extra: string[] } {
  const missing = [...expected].filter((v) => !actual.has(v)).sort();
  const extra = [...actual].filter((v) => !expected.has(v)).sort();
  return { missing, extra };
}

// ===========================================================================
// 1. TENANT_SCOPED_MODELS — schema-derived (#1 of 9 closed by B1)
// ===========================================================================

describe('TENANT_SCOPED_MODELS shape (closes L2-M1, partial L4-H2)', () => {
  it('contains every model with a Merchant relation onDelete=Cascade', () => {
    const schemaSet = getMerchantCascadeModels();
    const { missing, extra } = diffSets(schemaSet, TENANT_SCOPED_MODELS);
    expect(
      missing,
      `TENANT_SCOPED_MODELS is missing these schema-CASCADE-on-Merchant models: ${missing.join(', ')}. ` +
        `Add them to packages/db/src/tenant-scope.ts:45 and verify they are not also forensic (SetNull) tables.`,
    ).toEqual([]);
    expect(
      extra,
      `TENANT_SCOPED_MODELS contains models that are NOT Merchant-CASCADE in the schema: ${extra.join(', ')}. ` +
        `Either remove them from the set or fix the schema if the CASCADE was intended.`,
    ).toEqual([]);
  });
});

// ===========================================================================
// 2. TENANT_OPTIONAL_READ_MODELS — schema-derived (#2; closes L6-L1)
// ===========================================================================

describe('TENANT_OPTIONAL_READ_MODELS shape (closes L6-L1, partial L4-H2)', () => {
  it('contains every model with a Merchant relation onDelete=SetNull', () => {
    const schemaSet = getMerchantSetNullModels();
    const { missing, extra } = diffSets(schemaSet, TENANT_OPTIONAL_READ_MODELS);
    expect(
      missing,
      `TENANT_OPTIONAL_READ_MODELS is missing these schema-SetNull-on-Merchant models: ${missing.join(', ')}. ` +
        `Add them to packages/db/src/tenant-scope.ts:81.`,
    ).toEqual([]);
    expect(
      extra,
      `TENANT_OPTIONAL_READ_MODELS contains models that are NOT Merchant-SetNull in the schema: ${extra.join(', ')}. ` +
        `Either remove them or fix the schema relation policy.`,
    ).toEqual([]);
  });
});

// ===========================================================================
// 3. SOFT_DELETE_MODELS — schema-derived (#3; closes L6-H1)
// ===========================================================================

describe('SOFT_DELETE_MODELS shape (closes L6-H1, partial L4-H2)', () => {
  it('contains every model with a nullable deletedAt DateTime field', () => {
    const schemaSet = getSoftDeleteModels();
    const { missing, extra } = diffSets(schemaSet, SOFT_DELETE_MODELS);
    expect(
      missing,
      `SOFT_DELETE_MODELS is missing these models with deletedAt: ${missing.join(', ')}. ` +
        `The extension's auto-filter on { deletedAt: null } will not be applied to reads of these models, ` +
        `silently leaking soft-deleted rows. Add them to packages/db/src/tenant-scope.ts:91.`,
    ).toEqual([]);
    expect(
      extra,
      `SOFT_DELETE_MODELS contains models without a deletedAt column: ${extra.join(', ')}. ` +
        `Either remove them or add deletedAt to the schema.`,
    ).toEqual([]);
  });
});

// ===========================================================================
// 4. SHOP_REDACT_TABLES_IN_ORDER — schema-derived SET completeness (#4)
//    Order is operational, NOT correctness, per gdpr-processor.ts:322-325
//    ("CASCADE FKs make any particular order safe"). Test asserts SET only.
// ===========================================================================

describe('SHOP_REDACT_TABLES_IN_ORDER shape (closes L3-H2, partial L4-H2)', () => {
  it('covers (as a SET, order irrelevant per source comment) every tenant CASCADE table', () => {
    const expectedCamelCase = new Set(
      [...getMerchantCascadeModels()].map(pascalToCamel),
    );
    const actualSet = new Set<string>(SHOP_REDACT_TABLES_IN_ORDER);
    const { missing, extra } = diffSets(expectedCamelCase, actualSet);
    expect(
      missing,
      `SHOP_REDACT_TABLES_IN_ORDER is missing these tenant-CASCADE tables (camelCase Prisma method names): ${missing.join(', ')}. ` +
        `Each missing table allows PII / business data to survive a GDPR shop-redact request — Shopify App Review reject-grade. ` +
        `Insert at FK-deeper-first positions per the file's source comment (gdpr-processor.ts:322-325): ` +
        `tables with FKs to Customer go BEFORE customer; tables with FKs only to Merchant go anywhere.`,
    ).toEqual([]);
    expect(
      extra,
      `SHOP_REDACT_TABLES_IN_ORDER contains tables that are NOT tenant-CASCADE in the schema: ${extra.join(', ')}. ` +
        `Either remove them or verify they cascade from Merchant.`,
    ).toEqual([]);
  });
});

// ===========================================================================
// 5. PROVIDER_COST_RATES ↔ *_MODELS symmetry (#5; closes L6-H2)
// ===========================================================================

describe('PROVIDER_COST_RATES <-> *_MODELS symmetry (closes L6-H2)', () => {
  it.each([
    ['openai', OPENAI_MODELS, PROVIDER_COST_RATES.openai],
    ['anthropic', ANTHROPIC_MODELS, PROVIDER_COST_RATES.anthropic],
    ['deepseek', DEEPSEEK_MODELS, PROVIDER_COST_RATES.deepseek],
  ] as const)(
    '%s: every *_MODELS entry has a cost rate, and every cost rate has an entry',
    (provider, models, rates) => {
      const modelsSet = new Set<string>(models);
      const ratesSet = new Set(Object.keys(rates));
      const { missing, extra } = diffSets(modelsSet, ratesSet);
      expect(
        missing,
        `PROVIDER_COST_RATES.${provider} is MISSING rates for these *_MODELS entries: ${missing.join(', ')}. ` +
          `estimateCostMicrocents will throw "Unknown provider/model" if any of these is selected via AI_MODEL.`,
      ).toEqual([]);
      expect(
        extra,
        `PROVIDER_COST_RATES.${provider} has rates for models NOT in *_MODELS: ${extra.join(', ')}. ` +
          `getAiConfig's Zod enum will reject these strings at boot — the rate is unreachable. ` +
          `Either add the model to *_MODELS to make it selectable or remove the rate.`,
      ).toEqual([]);
    },
  );
});

// ===========================================================================
// 6. customerStateValues ↔ Prisma CustomerState enum (#6; closes L6-H3)
//    AND retroactively justifies the comment at customer-state-changed.ts:40-41
//    (which currently claims this test exists — the false claim becomes true).
// ===========================================================================

describe('customerStateValues <-> Prisma CustomerState enum (closes L6-H3)', () => {
  it('Zod enum array matches the Prisma enum values (set equality)', () => {
    const schemaValues = new Set(getEnumValues('CustomerState'));
    const handValues = new Set<string>(customerStateValues);
    const { missing, extra } = diffSets(schemaValues, handValues);
    expect(
      missing,
      `customerStateValues is missing these Prisma enum values: ${missing.join(', ')}. ` +
        `The customer.state_changed payload Zod validator will reject these states at the producer ` +
        `(packages/db/src/events/customer-state-changed.ts) even though the schema accepts them.`,
    ).toEqual([]);
    expect(
      extra,
      `customerStateValues contains values NOT in the Prisma CustomerState enum: ${extra.join(', ')}. ` +
        `Either remove them from the hand-maintained array or add them to the Prisma enum.`,
    ).toEqual([]);
  });
});

// ===========================================================================
// 7. WEBHOOK_TOPIC_TO_EVENT -> ALL_OUTBOX_EVENT_TYPES coverage (#7; closes L6-M3)
//    Per-entry assertion: every mapped event MUST be a valid OutboxEventType,
//    otherwise the drainer dispatcher silently routes to "unknown event".
// ===========================================================================

describe('WEBHOOK_TOPIC_TO_EVENT shape (closes L6-M3)', () => {
  it('every mapped event is a valid OutboxEventType', () => {
    const bad: Array<{ topic: string; event: string }> = [];
    for (const [topic, event] of Object.entries(WEBHOOK_TOPIC_TO_EVENT)) {
      if (!ALL_OUTBOX_EVENT_TYPES.has(event as never)) {
        bad.push({ topic, event });
      }
    }
    expect(
      bad,
      `WEBHOOK_TOPIC_TO_EVENT has entries that resolve to events NOT in OUTBOX_EVENTS: ${JSON.stringify(bad)}. ` +
        `The drainer's dispatch table will silently fail to route these topics. ` +
        `Either remove the mapping or register the event in packages/contracts/src/events.ts.`,
    ).toEqual([]);
  });
});
