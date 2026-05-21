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

/**
 * Convert an unknown JSON value (e.g. `MerchantSettings.aiTone` read from
 * Prisma's `Json?` column) into a validated `AiTone | null`.
 *
 * - `null` / `undefined` input → `null` (no tone configured).
 * - Valid object → `AiTone` with defaults applied (avoid/emphasize default
 *   to `[]`, emojiPolicy defaults to `'minimal'`).
 * - Invalid object → throws the underlying `ZodError`. Callers that need a
 *   non-throwing variant should use `aiToneSchema.safeParse(value)` directly.
 *
 * The DB CHECK constraint T5 (`jsonb_typeof = 'object'` OR NULL) is the
 * structural floor; this helper is the application-layer shape guard the
 * Epic F prompt builder consumes. Two-layer defence per the schema header.
 *
 * Epic F batch 2 ships this helper as the boundary the prompt builder
 * relies on — callers (the AI Worker in batch 4) are responsible for
 * invoking `parseAiTone` BEFORE handing the value to `buildWinbackPrompt`.
 *
 * Operator note: if `MerchantSettings.aiTone` somehow contains invalid
 * data (direct DB manipulation, pre-validator legacy data, or a future
 * Zod-schema change that retroactively narrows a field), the AI Worker's
 * call to `parseAiTone` throws and the generation fails with
 * `AiGeneration.lastError = 'invalid_ai_tone'`. Recovery: operator
 * updates the row to `null` or to a valid `AiTone` via
 * `MerchantSettingsRepository.update`. The DB CHECK constraint T5 only
 * rejects non-object JSON; it cannot enforce the inner shape.
 */
export function parseAiTone(value: unknown): AiTone | null {
  if (value === null || value === undefined) return null;
  return aiToneSchema.parse(value);
}
