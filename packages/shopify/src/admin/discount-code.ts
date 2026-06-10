import { computeHmacSha256, encodeCrockfordBase32 } from '@winback/crypto';

/**
 * Deterministic winback discount-code derivation (A4 / POST-EPIC-F §4.2).
 *
 * The code is a KEYED HMAC of `merchantId:aiGenerationId`, Crockford-base32
 * encoded and truncated. Three properties hold simultaneously:
 *
 *   - DETERMINISTIC — the same generation always derives the same code, so a
 *     BullMQ retry that re-mints produces the SAME string. Shopify rejects a
 *     duplicate code with userError `TAKEN` (empirically confirmed against the
 *     dev store), which the creation module treats as idempotent success —
 *     this is what lets a crash between mint and completion self-heal.
 *   - UNGUESSABLE — the HMAC is keyed on a server secret (SHOPIFY_API_SECRET
 *     reuse for v1; a dedicated DISCOUNT_CODE_HMAC_SECRET is future hardening).
 *     Without the secret an attacker cannot derive another customer's code, so
 *     codes can't be enumerated for free discounts.
 *   - COLLISION-RESISTANT — `aiGenerationId` is a cuid (already globally
 *     unique), so the HMAC INPUT is unique per generation; the only residual
 *     collision is the truncated-digest birthday bound (see length note).
 *
 * The message space (`merchantId:aiGenerationId`, both cuid-shaped) never
 * collides with the OTHER consumer of SHOPIFY_API_SECRET (Shopify webhook HMAC
 * over raw request bodies), so reusing the key across the two domains is safe.
 */

/** Customer-visible prefix. Keeps codes recognizable in the Shopify admin. */
const WINBACK_CODE_PREFIX = 'WB-';

/**
 * 16 Crockford symbols = 80 bits of the HMAC digest. Birthday-collision bound
 * ≈ 2^40 (~1 trillion) codes before a 50% chance of one collision —
 * astronomically beyond any realistic winback volume, and the unique digest
 * input makes a true collision require a truncated-hash coincidence.
 */
const WINBACK_CODE_BASE32_LENGTH = 16;

/**
 * Derives the deterministic, keyed, customer-typeable winback discount code
 * for one AI generation. Pure — no I/O. The caller (AI Worker) supplies the
 * secret from config so this function stays free of env coupling and trivially
 * testable.
 */
export function deriveWinbackDiscountCode(
  secret: string,
  merchantId: string,
  aiGenerationId: string,
): string {
  const digest = computeHmacSha256(secret, `${merchantId}:${aiGenerationId}`);
  const encoded = encodeCrockfordBase32(digest).slice(0, WINBACK_CODE_BASE32_LENGTH);
  return `${WINBACK_CODE_PREFIX}${encoded}`;
}
