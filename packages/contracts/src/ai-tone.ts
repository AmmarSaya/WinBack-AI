import { z } from 'zod';

/**
 * Canonical schema for `MerchantSettings.aiTone`.
 *
 * Enforced at three layers:
 *   1. DB CHECK constraint (T5)              — structural floor: `jsonb_typeof = 'object'`
 *   2. Prisma extension validator (B3)       — full shape validation on every write to MerchantSettings.aiTone
 *   3. MerchantSettingsRepository typed API   — convenience over the above two
 *
 * Adding/changing fields here is the source of truth. The DB doesn't need a
 * migration; the extension picks up the new validator on the next deploy.
 * Removing or renaming a field is a coordinated change: deprecate in code,
 * stop reading the old field, then remove from the schema after data is
 * normalized.
 */

export const AI_TONE_STYLES = ['formal', 'casual', 'playful', 'professional'] as const;
export const AI_TONE_EMOJI_POLICIES = ['none', 'minimal', 'liberal'] as const;

export const aiToneSchema = z
  .object({
    style: z.enum(AI_TONE_STYLES),
    avoid: z.array(z.string().min(1).max(100)).max(50).default([]),
    emphasize: z.array(z.string().min(1).max(100)).max(50).default([]),
    emojiPolicy: z.enum(AI_TONE_EMOJI_POLICIES).default('minimal'),
    brandVoiceSample: z.string().max(2000).optional(),
    customInstructions: z.string().max(2000).optional(),
  })
  .strict(); // reject unknown keys — typo protection

export type AiTone = z.infer<typeof aiToneSchema>;
export type AiToneInput = z.input<typeof aiToneSchema>;
