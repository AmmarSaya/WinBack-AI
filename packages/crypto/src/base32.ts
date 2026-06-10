/**
 * Crockford base32 encoder (https://www.crockford.com/base32.html).
 *
 * A reusable encoding primitive — lives here next to the HMAC helpers so it
 * can be shared. Its first consumer is the deterministic winback discount-code
 * derivation (`@winback/shopify` `discount-code.ts`, A4 §4.2): an HMAC digest
 * is Crockford-base32-encoded and truncated to produce a code that is
 * deterministic, keyed (unguessable), and **human-typeable** at checkout.
 *
 * Why Crockford (not RFC 4648): the alphabet excludes the visually ambiguous
 * letters `I L O U` (I/1, L/1, O/0, and U is dropped to avoid accidental
 * profanity). A customer typing the code off an email is far less likely to
 * mis-key it. The alphabet is the 10 digits followed by the 22 surviving
 * uppercase letters:
 *
 *   0 1 2 3 4 5 6 7 8 9 A B C D E F G H J K M N P Q R S T V W X Y Z
 *
 * This is ENCODE-only (no decode) — the discount code is opaque; we never
 * parse it back. No check symbol, no padding, no hyphenation: callers take a
 * fixed-length prefix of the output, so trailing structure is irrelevant.
 */

/**
 * Crockford base32 alphabet — 32 symbols, index 0..31. Excludes I, L, O, U.
 */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const BITS_PER_BYTE = 8;
const BITS_PER_SYMBOL = 5;
const SYMBOL_MASK = 0b11111;

/**
 * Encodes a byte buffer as a Crockford base32 string (no padding).
 *
 * Processes the input as a continuous big-endian bit stream, emitting one
 * symbol per 5 bits. A trailing partial group (1–4 bits) is left-aligned into
 * a final symbol — standard base32 behaviour. Output length is
 * `ceil(input.length * 8 / 5)`.
 *
 * The bit accumulator is masked to its meaningful low bits every byte, so it
 * never exceeds ~13 bits — well within JS's 32-bit bitwise-operator range,
 * regardless of input length.
 */
export function encodeCrockfordBase32(input: Uint8Array): string {
  let accumulator = 0;
  let bits = 0;
  let output = '';

  for (const byte of input) {
    accumulator = (accumulator << BITS_PER_BYTE) | byte;
    bits += BITS_PER_BYTE;
    while (bits >= BITS_PER_SYMBOL) {
      bits -= BITS_PER_SYMBOL;
      // `.charAt` (not `[index]`) returns `string`, never `string | undefined`
      // — the masked index is always in 0..31, so it is always a real symbol.
      output += CROCKFORD_ALPHABET.charAt((accumulator >>> bits) & SYMBOL_MASK);
      // Keep only the not-yet-emitted low bits so the accumulator stays small.
      accumulator &= (1 << bits) - 1;
    }
  }

  // Trailing partial group: left-align the remaining 1–4 bits into a symbol.
  if (bits > 0) {
    output += CROCKFORD_ALPHABET.charAt((accumulator << (BITS_PER_SYMBOL - bits)) & SYMBOL_MASK);
  }

  return output;
}
