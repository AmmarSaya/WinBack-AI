import { type AiTone, aiToneSchema } from '@winback/contracts';
import { ValidationError } from '@winback/errors';
import { Prisma } from '@prisma/client';

import type { WinbackPrisma } from '../client.js';
import { assertScopeMatchesMerchant } from '../tenant-scope.js';

export interface MerchantSettingsUpdate {
  readonly attributionDirectWindowDays?: number;
  readonly attributionAssistedWindowDays?: number;
  readonly sendTimeStartHour?: number;
  readonly sendTimeEndHour?: number;
  readonly defaultCooldownHours?: number;
  readonly maxDailySendsPerCustomer?: number;
  readonly monthlyAiSpendCapCents?: bigint;
  readonly monthlySendsCap?: number;
  /**
   * Pass `null` to clear; pass a value to set/replace.
   * Validated against `aiToneSchema` here AND by the extension's write hook
   * (defense in depth — repository is the typed convenience, extension is
   * the runtime gate).
   */
  readonly aiTone?: AiTone | null;
}

/**
 * The typed chokepoint for MerchantSettings writes.
 *
 * The aiTone validation runs at TWO layers:
 *   1. Here (so callers get a clean ValidationError with field paths).
 *   2. In the Prisma extension (so direct prisma.merchantSettings.update
 *      calls outside this repository ALSO go through validation — no
 *      bypass).
 *
 * The repository is convenience over the runtime gate, not the gate itself.
 */
export class MerchantSettingsRepository {
  constructor(private readonly prisma: WinbackPrisma) {}

  async ensureDefaults(merchantId: string): Promise<void> {
    assertScopeMatchesMerchant(merchantId);
    await this.prisma.merchantSettings.upsert({
      where: { merchantId },
      create: { merchantId },
      update: {},
    });
  }

  async findByMerchantId(merchantId: string) {
    assertScopeMatchesMerchant(merchantId);
    return this.prisma.merchantSettings.findUnique({ where: { merchantId } });
  }

  async update(merchantId: string, patch: MerchantSettingsUpdate): Promise<void> {
    assertScopeMatchesMerchant(merchantId);

    // Repository-layer validation. Mirrors what the extension does at the
    // write boundary — surfacing a typed ValidationError here gives callers
    // a clean error path before the query is built.
    let validatedAiTone: AiTone | null | undefined;
    if (patch.aiTone === undefined) {
      validatedAiTone = undefined; // not touching the field
    } else if (patch.aiTone === null) {
      validatedAiTone = null; // explicit clear
    } else {
      const result = aiToneSchema.safeParse(patch.aiTone);
      if (!result.success) {
        const fields: Record<string, string> = {};
        for (const issue of result.error.issues) {
          fields[issue.path.join('.')] = issue.message;
        }
        throw new ValidationError('Invalid aiTone configuration', {
          code: 'merchant_settings.ai_tone_invalid',
          fields,
          cause: result.error,
        });
      }
      validatedAiTone = result.data;
    }

    // Prisma's nullable Json field uses `JsonNull` for explicit-null writes;
    // a bare `null` is not part of `InputJsonValue`.
    const aiToneForPrisma =
      validatedAiTone === undefined
        ? undefined
        : validatedAiTone === null
          ? Prisma.JsonNull
          : (validatedAiTone as unknown as Prisma.InputJsonValue);

    await this.prisma.merchantSettings.update({
      where: { merchantId },
      data: {
        ...(patch.attributionDirectWindowDays !== undefined && {
          attributionDirectWindowDays: patch.attributionDirectWindowDays,
        }),
        ...(patch.attributionAssistedWindowDays !== undefined && {
          attributionAssistedWindowDays: patch.attributionAssistedWindowDays,
        }),
        ...(patch.sendTimeStartHour !== undefined && {
          sendTimeStartHour: patch.sendTimeStartHour,
        }),
        ...(patch.sendTimeEndHour !== undefined && {
          sendTimeEndHour: patch.sendTimeEndHour,
        }),
        ...(patch.defaultCooldownHours !== undefined && {
          defaultCooldownHours: patch.defaultCooldownHours,
        }),
        ...(patch.maxDailySendsPerCustomer !== undefined && {
          maxDailySendsPerCustomer: patch.maxDailySendsPerCustomer,
        }),
        ...(patch.monthlyAiSpendCapCents !== undefined && {
          monthlyAiSpendCapCents: patch.monthlyAiSpendCapCents,
        }),
        ...(patch.monthlySendsCap !== undefined && {
          monthlySendsCap: patch.monthlySendsCap,
        }),
        ...(aiToneForPrisma !== undefined && { aiTone: aiToneForPrisma }),
      },
    });
  }
}
