import { describe, expect, it } from 'vitest';

import {
  getFlag,
  getPositional,
  getRequiredFlag,
  getRequiredPositional,
  hasFlag,
} from '../src/argv.js';

describe('getPositional', () => {
  it('returns the first non-flag token at index 0', () => {
    expect(getPositional(['eventId-123', '--reason', 'text'], 0)).toBe('eventId-123');
  });

  it('skips flag values when counting positionals', () => {
    // `--reason "text"` consumes two tokens; eventId is still positional 0.
    expect(getPositional(['--reason', 'text', 'eventId-123'], 0)).toBe('eventId-123');
  });

  it('returns null when the positional is missing', () => {
    expect(getPositional(['--reason', 'text'], 0)).toBeNull();
  });

  it('returns null for index beyond available positionals', () => {
    expect(getPositional(['eventId-123'], 1)).toBeNull();
  });
});

describe('getFlag', () => {
  it('returns the value following the flag', () => {
    expect(getFlag(['--reason', 'operator note'], 'reason')).toBe('operator note');
  });

  it('returns null when the flag is absent', () => {
    expect(getFlag(['eventId-123'], 'reason')).toBeNull();
  });

  it('returns null when the flag has no value following it', () => {
    expect(getFlag(['--reason'], 'reason')).toBeNull();
  });

  it('returns null when the next token is another flag', () => {
    expect(getFlag(['--reason', '--other-flag'], 'reason')).toBeNull();
  });
});

describe('hasFlag (A1b — first boolean flag)', () => {
  it('returns true when the flag is present', () => {
    expect(hasFlag(['--force'], 'force')).toBe(true);
  });

  it('returns true when the flag is present among other tokens', () => {
    expect(hasFlag(['--merchant', 'm1', '--force'], 'force')).toBe(true);
  });

  it('returns false when the flag is absent', () => {
    expect(hasFlag(['--merchant', 'm1'], 'force')).toBe(false);
  });

  it('does NOT consume a following value (presence-only)', () => {
    // `--force` here is a boolean; the next token 'm1' is unrelated.
    const args = ['--force', 'm1'];
    expect(hasFlag(args, 'force')).toBe(true);
    // A separate getFlag read of 'force' returns the next token (value-mode),
    // which is exactly why force MUST use hasFlag, not getFlag.
    expect(getFlag(args, 'force')).toBe('m1');
  });

  it('returns false on an empty arg list', () => {
    expect(hasFlag([], 'force')).toBe(false);
  });
});

describe('getRequiredFlag', () => {
  it('returns ok=true with the value when present', () => {
    const result = getRequiredFlag(['--reason', 'text'], 'reason');
    expect(result).toEqual({ ok: true, value: 'text' });
  });

  it('returns ok=false with a typed error message when absent', () => {
    const result = getRequiredFlag(['eventId-123'], 'reason');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('argv_error');
      expect(result.error.message).toBe('Missing required flag --reason');
    }
  });

  it('treats empty-string value as missing', () => {
    const result = getRequiredFlag(['--reason', ''], 'reason');
    expect(result.ok).toBe(false);
  });
});

describe('getRequiredPositional', () => {
  it('returns ok=true with the value when present', () => {
    const result = getRequiredPositional(['eventId-123'], 0, 'eventId');
    expect(result).toEqual({ ok: true, value: 'eventId-123' });
  });

  it('returns ok=false with a typed error message when absent', () => {
    const result = getRequiredPositional(['--reason', 'text'], 0, 'eventId');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('Missing required positional argument <eventId>');
    }
  });
});

describe('argv composition — replay-style invocation', () => {
  it('parses `<eventId> --reason "<text>"` cleanly', () => {
    const args = ['evt_abc', '--reason', 'stale token'];
    const eventId = getRequiredPositional(args, 0, 'eventId');
    const reason = getRequiredFlag(args, 'reason');
    expect(eventId.ok && eventId.value).toBe('evt_abc');
    expect(reason.ok && reason.value).toBe('stale token');
  });

  it('parses `--reason "<text>" <eventId>` cleanly (flag-first ordering)', () => {
    const args = ['--reason', 'stale token', 'evt_abc'];
    const eventId = getRequiredPositional(args, 0, 'eventId');
    const reason = getRequiredFlag(args, 'reason');
    expect(eventId.ok && eventId.value).toBe('evt_abc');
    expect(reason.ok && reason.value).toBe('stale token');
  });
});
