import { describe, expect, it } from 'vitest';
import { clampedPollSeconds, ARE_YOU_THERE_DEFAULTS } from '../src/config.ts';
import { formatAgo, formatDuration } from '../src/format.ts';
import { applyLocked, emptyPresence } from '../src/presence.ts';
import { confirmedReading, emptyDebounce, feedReading, parseTasklist } from '../src/probe.ts';

describe('tasklist output', () => {
  it('finds LogonUI.exe in the CSV line', () => {
    expect(parseTasklist('"LogonUI.exe","1234","Console","1","12,345 K"\r\n')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(parseTasklist('"logonui.EXE","99","Console","1","4 K"')).toBe(true);
  });

  it('treats the locale-dependent "no tasks" message as unlocked', () => {
    expect(parseTasklist('信息: 没有运行的任务匹配指定标准。\r\n')).toBe(false);
    expect(parseTasklist('INFO: No tasks are running which match the specified criteria.\r\n')).toBe(false);
  });

  it('treats empty output as unlocked', () => {
    expect(parseTasklist('')).toBe(false);
  });
});

describe('debounce', () => {
  it('needs two readings in a row before it decides', () => {
    let d = emptyDebounce();
    d = feedReading(d, true);
    expect(confirmedReading(d)).toBeNull();
    d = feedReading(d, true);
    expect(confirmedReading(d)).toBe(true);
  });

  it('drops a reading that disagrees with the candidate', () => {
    let d = emptyDebounce();
    d = feedReading(d, true);
    d = feedReading(d, false);
    d = feedReading(d, true);
    expect(confirmedReading(d)).toBeNull();
    expect(d).toEqual({ candidate: true, count: 1 });
  });

  it('lets a failed probe change nothing', () => {
    let d = feedReading(emptyDebounce(), true);
    d = feedReading(d, null);
    d = feedReading(d, null);
    expect(d).toEqual({ candidate: true, count: 1 });
  });

  it('decides unlocked the same way', () => {
    let d = feedReading(emptyDebounce(), false);
    d = feedReading(d, false);
    expect(confirmedReading(d)).toBe(false);
  });
});

describe('presence', () => {
  it('records the first reading without a change', () => {
    const { state, change } = applyLocked(emptyPresence(), false, 1_000);
    expect(state).toEqual({ locked: false, since: 1_000, lastAway: null });
    expect(change).toEqual({ kind: 'first', at: 1_000 });
  });

  it('turns a lock into away and an unlock into back with the duration', () => {
    const first = applyLocked(emptyPresence(), false, 1_000).state;
    const away = applyLocked(first, true, 60_000);
    expect(away.change).toEqual({ kind: 'away', at: 60_000 });
    expect(away.state.locked).toBe(true);

    const back = applyLocked(away.state, false, 3_660_000);
    expect(back.change).toEqual({ kind: 'back', at: 3_660_000, awayMs: 3_600_000 });
    expect(back.state.lastAway).toEqual({ from: 60_000, to: 3_660_000 });
  });

  it('returns the same state when the reading did not change', () => {
    const state = applyLocked(emptyPresence(), true, 1_000).state;
    const again = applyLocked(state, true, 2_000);
    expect(again.change).toBeNull();
    expect(again.state).toBe(state);
  });

  it('never reports a negative away time', () => {
    const locked = { locked: true, since: 10_000, lastAway: null };
    const back = applyLocked(locked, false, 5_000);
    expect(back.change).toEqual({ kind: 'back', at: 5_000, awayMs: 0 });
  });

  it('keeps the last away period across a new one', () => {
    const away = applyLocked(applyLocked(emptyPresence(), false, 0).state, true, 100).state;
    const back = applyLocked(away, false, 400).state;
    const awayAgain = applyLocked(back, true, 900).state;
    expect(awayAgain.lastAway).toEqual({ from: 100, to: 400 });
  });
});

describe('durations', () => {
  it('says a short gap in words', () => {
    expect(formatDuration(30_000, 'zh')).toBe('不到一分钟');
    expect(formatDuration(30_000, 'en')).toBe('under a minute');
  });

  it('uses minutes, then hours and minutes, then days', () => {
    expect(formatDuration(26 * 60_000, 'zh')).toBe('26 分钟');
    expect(formatDuration(72 * 60_000, 'zh')).toBe('1 小时 12 分钟');
    expect(formatDuration(2 * 24 * 3_600_000, 'zh')).toBe('2 天');
    expect(formatDuration(26 * 60_000, 'en')).toBe('26 minutes');
    expect(formatDuration(60 * 60_000, 'en')).toBe('1 hour');
    expect(formatDuration(72 * 60_000, 'en')).toBe('1 hour 12 minutes');
  });

  it('formats how long ago in both languages', () => {
    expect(formatAgo(20_000, 'zh')).toBe('刚刚');
    expect(formatAgo(17 * 60_000, 'zh')).toBe('17 分钟前');
    expect(formatAgo(20_000, 'en')).toBe('just now');
    expect(formatAgo(17 * 60_000, 'en')).toBe('17 minutes ago');
  });
});

describe('config', () => {
  it('clamps the poll interval and falls back on nonsense', () => {
    expect(clampedPollSeconds({ ...ARE_YOU_THERE_DEFAULTS, pollSeconds: 1 })).toBe(5);
    expect(clampedPollSeconds({ ...ARE_YOU_THERE_DEFAULTS, pollSeconds: 10_000 })).toBe(300);
    expect(clampedPollSeconds({ ...ARE_YOU_THERE_DEFAULTS, pollSeconds: Number.NaN })).toBe(15);
    expect(clampedPollSeconds({ ...ARE_YOU_THERE_DEFAULTS, pollSeconds: 30.4 })).toBe(30);
  });
});
