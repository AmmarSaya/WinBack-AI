/**
 * Quiet-hours helper (Epic G batch 8.3, gate 5). Pure — computes the merchant's
 * LOCAL hour-of-day from an IANA timezone via `Intl.DateTimeFormat` (no new
 * dependency) and tests it against the `[startHour, endHour)` send window.
 *
 * Fallback (ruling 2): a null OR malformed timezone falls back to UTC and sets
 * `usedUtcFallback` so the gate logs a WARN — a missing tz is then observable
 * (onboarding/Campaign-CRUD should require/Shopify-default it), not silently
 * mis-timed.
 *
 * Window semantics: `[startHour, endHour)` on a 24h local clock, assumed
 * non-crossing (the schema defaults are 9→18). A midnight-crossing window is
 * out of v1 scope.
 */

export interface SendWindowResult {
  readonly inWindow: boolean;
  /** True when timezone was null or unparseable and UTC was used (gate warns). */
  readonly usedUtcFallback: boolean;
}

export function isWithinSendWindow(args: {
  timezone: string | null;
  startHour: number;
  endHour: number;
  now: Date;
}): SendWindowResult {
  let usedUtcFallback = args.timezone === null;
  let localHour: number;

  if (args.timezone === null) {
    localHour = hourInTimezone(args.now, 'UTC');
  } else {
    try {
      localHour = hourInTimezone(args.now, args.timezone);
    } catch {
      // Malformed IANA string (Intl throws RangeError) — treat as missing.
      usedUtcFallback = true;
      localHour = hourInTimezone(args.now, 'UTC');
    }
  }

  return {
    inWindow: localHour >= args.startHour && localHour < args.endHour,
    usedUtcFallback,
  };
}

/** Hour-of-day (0–23) for `now` in the given IANA timezone. */
function hourInTimezone(now: Date, timeZone: string): number {
  const part = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone,
  })
    .formatToParts(now)
    .find((p) => p.type === 'hour')?.value;
  const hour = Number.parseInt(part ?? '0', 10);
  // `hour12:false` yields '24' for midnight in some ICU builds — normalize to 0.
  return hour === 24 ? 0 : hour;
}
