import { describe, expect, it } from 'vitest';

import {
  DEPRECATED_MODELS,
  PROVIDER_COST_RATES,
  estimateCostMicrocents,
} from '../src/cost-rates.js';

describe('PROVIDER_COST_RATES table', () => {
  it('contains exactly the 8 launch-ready models — no legacy entries', () => {
    expect(Object.keys(PROVIDER_COST_RATES.openai).sort()).toEqual([
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4.1-nano',
    ]);
    expect(Object.keys(PROVIDER_COST_RATES.anthropic).sort()).toEqual([
      'claude-haiku-4-5',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
    ]);
    expect(Object.keys(PROVIDER_COST_RATES.deepseek).sort()).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ]);
  });

  it('output rate >= input rate for every model (provider pricing invariant)', () => {
    for (const [provider, models] of Object.entries(PROVIDER_COST_RATES)) {
      for (const [model, rates] of Object.entries(models)) {
        expect(
          rates.outputPer1M >= rates.inputPer1M,
          `${provider}/${model}: output (${rates.outputPer1M}) must be >= input (${rates.inputPer1M})`,
        ).toBe(true);
      }
    }
  });

  it('every rate is BigInt — no Number values smuggled in', () => {
    for (const provider of Object.values(PROVIDER_COST_RATES)) {
      for (const rates of Object.values(provider)) {
        expect(typeof rates.inputPer1M).toBe('bigint');
        expect(typeof rates.outputPer1M).toBe('bigint');
      }
    }
  });
});

describe('estimateCostMicrocents — anchored value tests', () => {
  // Each test pins a specific model's rate so a quiet refactor that changes
  // `inputPer1M` by an order of magnitude (e.g. 100_000_000 → 100_000) ships
  // with a failing test rather than silently mis-pricing.

  it('OpenAI gpt-4.1-mini: 1000 input + 500 output = 120_000 microcents ($0.0012)', () => {
    // 1000 * 40_000_000 / 1_000_000 + 500 * 160_000_000 / 1_000_000
    // = 40_000 + 80_000 = 120_000 microcents
    expect(estimateCostMicrocents('openai', 'gpt-4.1-mini', 1000, 500)).toBe(120_000n);
  });

  it('OpenAI gpt-4.1: 1000 input + 500 output = 1_250_000 microcents ($0.0125)', () => {
    // 1000 * 500_000_000 / 1_000_000 + 500 * 1_500_000_000 / 1_000_000
    // = 500_000 + 750_000 = 1_250_000
    expect(estimateCostMicrocents('openai', 'gpt-4.1', 1000, 500)).toBe(1_250_000n);
  });

  it('Anthropic claude-haiku-4-5: 1000 input + 500 output = 350_000 microcents ($0.0035)', () => {
    // 1000 * 100_000_000 / 1_000_000 + 500 * 500_000_000 / 1_000_000
    // = 100_000 + 250_000 = 350_000
    expect(estimateCostMicrocents('anthropic', 'claude-haiku-4-5', 1000, 500)).toBe(350_000n);
  });

  it('Anthropic claude-sonnet-4-6: 1000 input + 500 output = 1_050_000 microcents ($0.0105)', () => {
    expect(estimateCostMicrocents('anthropic', 'claude-sonnet-4-6', 1000, 500)).toBe(
      1_050_000n,
    );
  });

  it('Anthropic claude-opus-4-7: 1000 input + 500 output = 1_750_000 microcents ($0.0175)', () => {
    // 1000 * 500_000_000 / 1M + 500 * 2_500_000_000 / 1M = 500_000 + 1_250_000
    expect(estimateCostMicrocents('anthropic', 'claude-opus-4-7', 1000, 500)).toBe(
      1_750_000n,
    );
  });

  it('DeepSeek deepseek-v4-flash: 1000 input + 500 output = 28_000 microcents ($0.00028)', () => {
    // 1000 * 14_000_000 / 1M + 500 * 28_000_000 / 1M = 14_000 + 14_000
    expect(estimateCostMicrocents('deepseek', 'deepseek-v4-flash', 1000, 500)).toBe(
      28_000n,
    );
  });

  it('DeepSeek deepseek-v4-pro: 1000 input + 500 output = 348_000 microcents ($0.00348)', () => {
    // 1000 * 174_000_000 / 1M + 500 * 348_000_000 / 1M = 174_000 + 174_000
    expect(estimateCostMicrocents('deepseek', 'deepseek-v4-pro', 1000, 500)).toBe(
      348_000n,
    );
  });

  it('zero tokens → zero cost', () => {
    expect(estimateCostMicrocents('deepseek', 'deepseek-v4-flash', 0, 0)).toBe(0n);
  });

  it('throws on unknown model under a known provider', () => {
    expect(() =>
      estimateCostMicrocents('openai', 'gpt-4o', 100, 100),
    ).toThrow(/Unknown provider\/model: openai\/gpt-4o/);
  });

  it('throws on unknown provider', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      estimateCostMicrocents('groq' as any, 'mixtral', 100, 100),
    ).toThrow(/Unknown provider: groq/);
  });

  it('handles large token counts without float drift (BigInt invariant)', () => {
    // 100M input tokens at gpt-4.1 ($5/M = 500_000_000 microcents/M).
    // Expected: 100_000_000 * 500_000_000 / 1_000_000 = 50_000_000_000 microcents = $500.
    expect(
      estimateCostMicrocents('openai', 'gpt-4.1', 100_000_000, 0),
    ).toBe(50_000_000_000n);
  });
});

describe('DEPRECATED_MODELS', () => {
  it('rejects deepseek-chat with operator-friendly guidance', () => {
    expect(DEPRECATED_MODELS.get('deepseek-chat')).toMatch(/deprecated/i);
    expect(DEPRECATED_MODELS.get('deepseek-chat')).toMatch(/deepseek-v4-flash/);
  });

  it('rejects legacy OpenAI gpt-4o family', () => {
    expect(DEPRECATED_MODELS.has('gpt-4o')).toBe(true);
    expect(DEPRECATED_MODELS.has('gpt-4o-mini')).toBe(true);
  });

  it('current models are not flagged as deprecated', () => {
    for (const provider of Object.values(PROVIDER_COST_RATES)) {
      for (const model of Object.keys(provider)) {
        expect(DEPRECATED_MODELS.has(model)).toBe(false);
      }
    }
  });
});
