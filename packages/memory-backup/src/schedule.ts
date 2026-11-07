/**
 * Wall-clock arithmetic for the reminder and the snapshot names: a daily time keeps its local clock
 * time across daylight-saving changes, and a clock time skipped by the change moves forward by the gap.
 */

export interface Clock {
  hour: number;
  minute: number;
}

/** `HH:MM` as a clock time; null when the text is not one. */
export function parseClock(value: string): Clock | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

function parts(timezone: string, ms: number, options: Intl.DateTimeFormatOptions): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', ...options })
    .formatToParts(new Date(ms))
    .map((p) => [p.type, p.value]));
}

/** UTC minus local, in minutes, for `timezone` at `ms`. */
function offsetMinutes(timezone: string, ms: number): number {
  const p = parts(timezone, ms, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return (ms - (ms % 1000) - local) / 60_000;
}

/** Epoch ms of a wall-clock time in `timezone`; a skipped time moves forward by the gap. */
export function localToEpoch(timezone: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess + offsetMinutes(timezone, guess) * 60_000;
  const second = guess + offsetMinutes(timezone, first) * 60_000;
  const wall = second - offsetMinutes(timezone, second) * 60_000;
  return wall === guess ? second : Math.max(first, second);
}

function localDate(timezone: string, ms: number): { year: number; month: number; day: number } {
  const p = parts(timezone, ms, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day) };
}

/** The next `hour:minute` in `timezone` after `now`. */
export function nextDaily(now: number, timezone: string, hour: number, minute: number): number {
  const { year, month, day } = localDate(timezone, now);
  const today = localToEpoch(timezone, year, month, day, hour, minute);
  return today > now ? today : localToEpoch(timezone, year, month, day + 1, hour, minute);
}

/** `MM-DD HH:MM` in `timezone`, as the receipts say a time. */
export function localLabel(timezone: string, ms: number): string {
  const p = parts(timezone, ms, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** `YYYY-MM-DD_HH-MM-SS` in `timezone`, the name of a snapshot. */
export function localStamp(timezone: string, ms: number): string {
  const p = parts(timezone, ms, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${p.year}-${p.month}-${p.day}_${p.hour}-${p.minute}-${p.second}`;
}
