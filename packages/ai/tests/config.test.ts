import { ConfigError } from '@winback/config';
import { describe, expect, it } from 'vitest';

import { getAiConfig } from '../src/config.js';

const baseEnv = {
  AI_MAX_TOKENS: '300',
  AI_TEMPERATURE: '0.7',
} as const;

describe('getAiConfig', () => {
  describe('happy paths per provider', () => {
    it('boots with AI_PROVIDER=deepseek + AI_MODEL=deepseek-v4-flash + DEEPSEEK_API_KEY', () => {
      const cfg = getAiConfig({
        reset: true,
        source: {
          ...baseEnv,
          AI_PROVIDER: 'deepseek',
          AI_MODEL: 'deepseek-v4-flash',
          DEEPSEEK_API_KEY: 'sk-deepseek-fake',
        },
      });
      expect(cfg.AI_PROVIDER).toBe('deepseek');
      if (cfg.AI_PROVIDER === 'deepseek') {
        expect(cfg.AI_MODEL).toBe('deepseek-v4-flash');
        expect(cfg.DEEPSEEK_API_KEY).toBe('sk-deepseek-fake');
      }
    });

    it('boots with AI_PROVIDER=openai + AI_MODEL=gpt-4.1-mini + OPENAI_API_KEY', () => {
      const cfg = getAiConfig({
        reset: true,
        source: {
          ...baseEnv,
          AI_PROVIDER: 'openai',
          AI_MODEL: 'gpt-4.1-mini',
          OPENAI_API_KEY: 'sk-openai-fake',
        },
      });
      expect(cfg.AI_PROVIDER).toBe('openai');
    });

    it('boots with AI_PROVIDER=anthropic + AI_MODEL=claude-haiku-4-5 + ANTHROPIC_API_KEY', () => {
      const cfg = getAiConfig({
        reset: true,
        source: {
          ...baseEnv,
          AI_PROVIDER: 'anthropic',
          AI_MODEL: 'claude-haiku-4-5',
          ANTHROPIC_API_KEY: 'sk-anthropic-fake',
        },
      });
      expect(cfg.AI_PROVIDER).toBe('anthropic');
    });

    it('AI_PROVIDER=deepseek with no OPENAI_API_KEY set boots fine (L6)', () => {
      // Lazy provider construction — the active provider is the only one
      // that needs a key. A merchant on DeepSeek must not be blocked by a
      // missing OpenAI key.
      expect(() =>
        getAiConfig({
          reset: true,
          source: {
            ...baseEnv,
            AI_PROVIDER: 'deepseek',
            AI_MODEL: 'deepseek-v4-flash',
            DEEPSEEK_API_KEY: 'sk-deepseek-fake',
            // OPENAI_API_KEY and ANTHROPIC_API_KEY intentionally absent
          },
        }),
      ).not.toThrow();
    });
  });

  describe('boot failures', () => {
    it('throws ConfigError when active provider key is missing', () => {
      expect(() =>
        getAiConfig({
          reset: true,
          source: {
            ...baseEnv,
            AI_PROVIDER: 'openai',
            AI_MODEL: 'gpt-4.1-mini',
            // OPENAI_API_KEY missing
          },
        }),
      ).toThrow(ConfigError);
    });

    it('throws ConfigError when active provider key is empty string', () => {
      expect(() =>
        getAiConfig({
          reset: true,
          source: {
            ...baseEnv,
            AI_PROVIDER: 'anthropic',
            AI_MODEL: 'claude-haiku-4-5',
            ANTHROPIC_API_KEY: '',
          },
        }),
      ).toThrow(ConfigError);
    });

    it('rejects AI_PROVIDER=openai + AI_MODEL=gpt-4o with deprecation guidance', () => {
      try {
        getAiConfig({
          reset: true,
          source: {
            ...baseEnv,
            AI_PROVIDER: 'openai',
            AI_MODEL: 'gpt-4o',
            OPENAI_API_KEY: 'sk-openai-fake',
          },
        });
        throw new Error('expected ConfigError');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).message).toMatch(/legacy|deprecated/i);
        expect((err as ConfigError).message).toMatch(/gpt-4\.1/);
      }
    });

    it('rejects AI_MODEL=deepseek-chat with the friendly deprecation message', () => {
      try {
        getAiConfig({
          reset: true,
          source: {
            ...baseEnv,
            AI_PROVIDER: 'deepseek',
            AI_MODEL: 'deepseek-chat',
            DEEPSEEK_API_KEY: 'sk-deepseek-fake',
          },
        });
        throw new Error('expected ConfigError');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).message).toMatch(/deepseek-chat is deprecated/);
        expect((err as ConfigError).message).toMatch(/deepseek-v4-flash/);
      }
    });

    it('AI_PROVIDER=anthropic + AI_MODEL=gpt-4o → generic Zod error, NOT deprecation message', () => {
      // Cross-provider mismatch: gpt-4o is deprecated under OpenAI, but the
      // active provider is Anthropic. The deprecation message would suggest
      // gpt-4.1-mini, which is also invalid for Anthropic. Let the
      // discriminated-union fire its generic "Invalid enum value" instead
      // so the operator sees the real problem (provider/model mismatch).
      try {
        getAiConfig({
          reset: true,
          source: {
            ...baseEnv,
            AI_PROVIDER: 'anthropic',
            AI_MODEL: 'gpt-4o',
            ANTHROPIC_API_KEY: 'sk-anthropic-fake',
          },
        });
        throw new Error('expected ConfigError');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        // Must NOT contain the deprecation guidance (which would point at
        // gpt-4.1-mini — wrong advice for an Anthropic merchant).
        expect((err as ConfigError).message).not.toMatch(/gpt-4\.1-mini/);
      }
    });

    it('rejects mismatched provider/model — AI_PROVIDER=anthropic + AI_MODEL=gpt-4.1', () => {
      expect(() =>
        getAiConfig({
          reset: true,
          source: {
            ...baseEnv,
            AI_PROVIDER: 'anthropic',
            AI_MODEL: 'gpt-4.1',
            ANTHROPIC_API_KEY: 'sk-anthropic-fake',
          },
        }),
      ).toThrow(ConfigError);
    });

    it('rejects unknown AI_PROVIDER value', () => {
      expect(() =>
        getAiConfig({
          reset: true,
          source: {
            ...baseEnv,
            AI_PROVIDER: 'groq',
            AI_MODEL: 'mixtral',
            // eslint-disable-next-line @typescript-eslint/naming-convention
            GROQ_API_KEY: 'sk-fake',
          },
        }),
      ).toThrow(ConfigError);
    });

    it('rejects AI_MAX_TOKENS above 4096', () => {
      expect(() =>
        getAiConfig({
          reset: true,
          source: {
            AI_PROVIDER: 'deepseek',
            AI_MODEL: 'deepseek-v4-flash',
            DEEPSEEK_API_KEY: 'sk-fake',
            AI_MAX_TOKENS: '999999',
            AI_TEMPERATURE: '0.7',
          },
        }),
      ).toThrow(ConfigError);
    });

    it('rejects AI_TEMPERATURE above 2.0', () => {
      expect(() =>
        getAiConfig({
          reset: true,
          source: {
            AI_PROVIDER: 'deepseek',
            AI_MODEL: 'deepseek-v4-flash',
            DEEPSEEK_API_KEY: 'sk-fake',
            AI_MAX_TOKENS: '300',
            AI_TEMPERATURE: '3.0',
          },
        }),
      ).toThrow(ConfigError);
    });
  });

  describe('defaults', () => {
    it('AI_MAX_TOKENS defaults to 300 when absent', () => {
      const cfg = getAiConfig({
        reset: true,
        source: {
          AI_PROVIDER: 'deepseek',
          AI_MODEL: 'deepseek-v4-flash',
          DEEPSEEK_API_KEY: 'sk-fake',
          AI_TEMPERATURE: '0.7',
        },
      });
      expect(cfg.AI_MAX_TOKENS).toBe(300);
    });

    it('AI_TEMPERATURE defaults to 0.7 when absent', () => {
      const cfg = getAiConfig({
        reset: true,
        source: {
          AI_PROVIDER: 'deepseek',
          AI_MODEL: 'deepseek-v4-flash',
          DEEPSEEK_API_KEY: 'sk-fake',
          AI_MAX_TOKENS: '300',
        },
      });
      expect(cfg.AI_TEMPERATURE).toBe(0.7);
    });
  });

  describe('memoisation', () => {
    it('returns the same object on repeated calls (cache)', () => {
      const first = getAiConfig({
        reset: true,
        source: {
          ...baseEnv,
          AI_PROVIDER: 'deepseek',
          AI_MODEL: 'deepseek-v4-flash',
          DEEPSEEK_API_KEY: 'sk-fake',
        },
      });
      const second = getAiConfig();
      expect(second).toBe(first);
    });

    it('reset: true returns a fresh object', () => {
      const first = getAiConfig({
        reset: true,
        source: {
          ...baseEnv,
          AI_PROVIDER: 'deepseek',
          AI_MODEL: 'deepseek-v4-flash',
          DEEPSEEK_API_KEY: 'sk-fake',
        },
      });
      const second = getAiConfig({
        reset: true,
        source: {
          ...baseEnv,
          AI_PROVIDER: 'deepseek',
          AI_MODEL: 'deepseek-v4-pro',
          DEEPSEEK_API_KEY: 'sk-fake',
        },
      });
      expect(second).not.toBe(first);
      if (second.AI_PROVIDER === 'deepseek') {
        expect(second.AI_MODEL).toBe('deepseek-v4-pro');
      }
    });
  });
});
