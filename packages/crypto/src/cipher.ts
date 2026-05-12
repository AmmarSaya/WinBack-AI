import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { AppError, ValidationError } from '@winback/errors';

/**
 * AES-256-GCM authenticated cipher.
 *
 * Output format: `v1:<base64(iv || tag || ciphertext)>`.
 *
 * The `v1:` prefix is the rotation version marker — when keys rotate,
 * `v2:` (etc.) is added to the decryption path while `v1:` continues to
 * decrypt with the old key. Single-key support is shipped now; multi-key
 * decryption lands when a rotation event actually requires it. The format
 * is forward-compatible.
 *
 *   iv:  12 bytes (96-bit GCM standard)
 *   tag: 16 bytes
 *   key: 32 bytes (AES-256)
 *
 * IV is randomly generated per-encryption. Authenticity is verified at
 * decrypt time via the auth tag — tampering causes `decrypt` to throw
 * (Node's GCM implementation rejects invalid tags).
 */

const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

export class CipherError extends AppError {
  override readonly name = 'CipherError';
  constructor(message: string, options: { cause?: unknown } = {}) {
    super({
      code: 'crypto.cipher_failed',
      message,
      statusCode: 500,
      retryable: false,
      exposeMessage: false,
      cause: options.cause,
    });
  }
}

export class Cipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_LEN) {
      throw new ValidationError(
        `Cipher key must be exactly ${KEY_LEN} bytes; got ${key.length}.`,
        { code: 'crypto.invalid_key_length' },
      );
    }
  }

  /**
   * Encrypts a UTF-8 string. Output is always prefixed with the format
   * version so future decoders can pick the right key set.
   */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([iv, tag, ciphertext]);
    return `${VERSION}:${payload.toString('base64')}`;
  }

  /**
   * Decrypts a value produced by `encrypt`. Throws on:
   *   - unknown format version
   *   - malformed payload
   *   - tampered ciphertext (GCM tag mismatch)
   *
   * Failure is a hard error — never return partial/garbage plaintext on
   * tampered input.
   */
  decrypt(value: string): string {
    const sepIdx = value.indexOf(':');
    if (sepIdx < 0) {
      throw new CipherError('Ciphertext missing version prefix');
    }
    const version = value.slice(0, sepIdx);
    if (version !== VERSION) {
      throw new CipherError(`Unsupported ciphertext version: ${version}`);
    }
    const payloadB64 = value.slice(sepIdx + 1);
    let payload: Buffer;
    try {
      payload = Buffer.from(payloadB64, 'base64');
    } catch (e) {
      throw new CipherError('Ciphertext is not valid base64', { cause: e });
    }
    if (payload.length < IV_LEN + TAG_LEN) {
      // Empty plaintext is legitimate (ciphertext is 0 bytes in GCM stream
      // mode; the IV + tag still take IV_LEN + TAG_LEN = 28 bytes).
      throw new CipherError('Ciphertext payload too short');
    }
    const iv = payload.subarray(0, IV_LEN);
    const tag = payload.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ciphertext = payload.subarray(IV_LEN + TAG_LEN);
    try {
      const decipher = createDecipheriv(ALGO, this.key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plaintext.toString('utf8');
    } catch (e) {
      throw new CipherError('Decryption failed (tampered or wrong key)', { cause: e });
    }
  }
}

/**
 * Decodes a base64-encoded 32-byte key from a config string. Throws if
 * decoding fails or length is wrong. Use this at boot when reading
 * `ENCRYPTION_KEY` from env.
 */
export function decodeKey(base64: string): Buffer {
  let buf: Buffer;
  try {
    buf = Buffer.from(base64, 'base64');
  } catch (e) {
    throw new ValidationError('ENCRYPTION_KEY is not valid base64', {
      code: 'crypto.invalid_key_format',
      cause: e,
    });
  }
  if (buf.length !== KEY_LEN) {
    throw new ValidationError(
      `ENCRYPTION_KEY must decode to ${KEY_LEN} bytes; got ${buf.length}.`,
      { code: 'crypto.invalid_key_length' },
    );
  }
  return buf;
}
