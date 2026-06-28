import { ConfigError } from '@winback/config';
import { describe, expect, it } from 'vitest';

import { getEmailConfig } from '../src/config.js';

const baseEnv = {
  // Shared base; satisfies the typings @types/node imposes on NodeJS.ProcessEnv.
  NODE_ENV: 'test',
} as const;

const validSesEnv = {
  ...baseEnv,
  EMAIL_PROVIDER: 'amazon-ses',
  AWS_REGION: 'us-east-1',
  AWS_SES_ACCESS_KEY_ID: 'AKIA-FAKE',
  AWS_SES_SECRET_ACCESS_KEY: 'fake-secret',
  AWS_SES_FROM_ADDRESS: 'winback@example.com',
  AWS_SES_CONFIGURATION_SET: 'winback-events',
  AWS_SES_SANDBOX: 'true',
} as const;

describe('getEmailConfig', () => {
  describe('happy path', () => {
    it('boots with EMAIL_PROVIDER=amazon-ses + complete env', () => {
      const cfg = getEmailConfig({ reset: true, source: validSesEnv });
      expect(cfg.EMAIL_PROVIDER).toBe('amazon-ses');
      expect(cfg.AWS_REGION).toBe('us-east-1');
      expect(cfg.AWS_SES_ACCESS_KEY_ID).toBe('AKIA-FAKE');
      expect(cfg.AWS_SES_SECRET_ACCESS_KEY).toBe('fake-secret');
      expect(cfg.AWS_SES_FROM_ADDRESS).toBe('winback@example.com');
      expect(cfg.AWS_SES_CONFIGURATION_SET).toBe('winback-events');
      expect(cfg.AWS_SES_SANDBOX).toBe(true);
    });

    it('AWS_SES_SANDBOX coerces string → boolean', () => {
      const sandboxFalse = getEmailConfig({
        reset: true,
        source: { ...validSesEnv, AWS_SES_SANDBOX: 'false' },
      });
      expect(sandboxFalse.AWS_SES_SANDBOX).toBe(false);
    });

    it('AWS_SES_CONFIGURATION_SET is optional (omission still boots)', () => {
      // Cannot use object-spread + delete cleanly under strict mode; destructure to drop the field.
      const { AWS_SES_CONFIGURATION_SET, ...envNoConfigSet } = validSesEnv;
      void AWS_SES_CONFIGURATION_SET;
      const cfg = getEmailConfig({ reset: true, source: envNoConfigSet });
      expect(cfg.AWS_SES_CONFIGURATION_SET).toBeUndefined();
    });
  });

  describe('boot failures', () => {
    it('throws ConfigError when AWS_SES_ACCESS_KEY_ID is missing', () => {
      expect(() =>
        getEmailConfig({
          reset: true,
          source: { ...validSesEnv, AWS_SES_ACCESS_KEY_ID: '' },
        }),
      ).toThrow(ConfigError);
    });

    it('throws ConfigError when AWS_SES_SECRET_ACCESS_KEY is missing', () => {
      expect(() =>
        getEmailConfig({
          reset: true,
          source: { ...validSesEnv, AWS_SES_SECRET_ACCESS_KEY: '' },
        }),
      ).toThrow(ConfigError);
    });

    it('throws ConfigError when AWS_REGION is missing', () => {
      expect(() =>
        getEmailConfig({
          reset: true,
          source: { ...validSesEnv, AWS_REGION: '' },
        }),
      ).toThrow(ConfigError);
    });

    it('throws ConfigError when AWS_SES_FROM_ADDRESS is not an email', () => {
      expect(() =>
        getEmailConfig({
          reset: true,
          source: { ...validSesEnv, AWS_SES_FROM_ADDRESS: 'not-an-email' },
        }),
      ).toThrow(ConfigError);
    });

    it('throws ConfigError when EMAIL_PROVIDER is missing entirely', () => {
      const { EMAIL_PROVIDER, ...envNoProvider } = validSesEnv;
      void EMAIL_PROVIDER;
      expect(() => getEmailConfig({ reset: true, source: envNoProvider })).toThrow(ConfigError);
    });

    it('throws ConfigError when EMAIL_PROVIDER is an unknown value', () => {
      expect(() =>
        getEmailConfig({
          reset: true,
          source: { ...validSesEnv, EMAIL_PROVIDER: 'sendgrid' },
        }),
      ).toThrow(ConfigError);
    });
  });
});
