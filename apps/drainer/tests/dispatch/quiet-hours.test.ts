/**
 * Unit tests for the quiet-hours helper (Epic G batch 8.3, gate 5).
 * Deterministic: fixed `now` (UTC) + explicit timezones.
 */

import { describe, expect, it } from 'vitest';

import { isWithinSendWindow } from '../../src/dispatch/quiet-hours.js';

const WINDOW = { startHour: 9, endHour: 18 } as const;

describe('isWithinSendWindow', () => {
  it('in window (UTC noon, 9–18)', () => {
    expect(
      isWithinSendWindow({ timezone: 'UTC', ...WINDOW, now: new Date('2026-06-11T12:00:00Z') }),
    ).toEqual({ inWindow: true, usedUtcFallback: false });
  });

  it('before start → out (06:00 < 9)', () => {
    expect(
      isWithinSendWindow({ timezone: 'UTC', ...WINDOW, now: new Date('2026-06-11T06:00:00Z') }).inWindow,
    ).toBe(false);
  });

  it('endHour is EXCLUSIVE (18:00 → out)', () => {
    expect(
      isWithinSendWindow({ timezone: 'UTC', ...WINDOW, now: new Date('2026-06-11T18:00:00Z') }).inWindow,
    ).toBe(false);
  });

  it('startHour is INCLUSIVE (09:00 → in)', () => {
    expect(
      isWithinSendWindow({ timezone: 'UTC', ...WINDOW, now: new Date('2026-06-11T09:00:00Z') }).inWindow,
    ).toBe(true);
  });

  it('applies the IANA offset — 20:00Z is 13:00 in America/Los_Angeles (PDT) → in window', () => {
    expect(
      isWithinSendWindow({
        timezone: 'America/Los_Angeles',
        ...WINDOW,
        now: new Date('2026-06-11T20:00:00Z'),
      }).inWindow,
    ).toBe(true);
  });

  it('null timezone → UTC fallback + flag', () => {
    const r = isWithinSendWindow({ timezone: null, ...WINDOW, now: new Date('2026-06-11T12:00:00Z') });
    expect(r).toEqual({ inWindow: true, usedUtcFallback: true });
  });

  it('malformed timezone → UTC fallback + flag (no throw)', () => {
    const r = isWithinSendWindow({
      timezone: 'Mars/Phobos',
      ...WINDOW,
      now: new Date('2026-06-11T12:00:00Z'),
    });
    expect(r).toEqual({ inWindow: true, usedUtcFallback: true });
  });
});
