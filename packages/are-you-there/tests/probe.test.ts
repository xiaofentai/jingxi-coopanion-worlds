import { describe, expect, it } from 'vitest';
import { ARE_YOU_THERE_DEFAULTS, clampedPollSeconds, idleThresholdMs } from '../src/config.ts';
import { mediaMatch, parseForegroundLine, parseShotLine, splitKeywords } from '../src/confirm.ts';
import { formatAgo, formatDuration } from '../src/format.ts';
import { parseIdleLine } from '../src/idle.ts';
import { applyReading, decidePresence, emptyPresence } from '../src/presence.ts';
import { confirmedReading, emptyDebounce, feedReading, parseTasklist } from '../src/probe.ts';

const MINUTE = 60_000;

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

describe('idle output', () => {
  it('reads the idle milliseconds', () => {
    expect(parseIdleLine('IDLE 1234')).toBe(1234);
    expect(parseIdleLine('IDLE   42\r')).toBe(42);
    expect(parseIdleLine('IDLE 0\n')).toBe(0);
  });

  it('ignores anything else', () => {
    expect(parseIdleLine('FAIL')).toBeNull();
    expect(parseIdleLine('')).toBeNull();
    expect(parseIdleLine('IDLE abc')).toBeNull();
    expect(parseIdleLine('IDLE')).toBeNull();
  });
});

describe('foreground window', () => {
  it('reads the process name and the title', () => {
    expect(parseForegroundLine('FG 24068 WXWork | 企业微信')).toEqual({ process: 'wxwork', title: '企业微信' });
    expect(parseForegroundLine('FG 42 chrome | 哔哩哔哩 - Google Chrome')).toEqual({ process: 'chrome', title: '哔哩哔哩 - Google Chrome' });
  });

  it('keeps a missing title empty and rejects anything else', () => {
    expect(parseForegroundLine('FG 7 explorer | ')).toEqual({ process: 'explorer', title: '' });
    expect(parseForegroundLine('FG NONE')).toBeNull();
    expect(parseForegroundLine('')).toBeNull();
    expect(parseForegroundLine('junk')).toBeNull();
  });

  it('matches keywords against the process and the title, case-insensitively', () => {
    const keywords = splitKeywords('bilibili, YouTube');
    expect(mediaMatch({ process: 'chrome', title: '哔哩哔哩' }, keywords)).toBe(false);
    expect(mediaMatch({ process: 'chrome', title: 'BILIBILI 视频' }, keywords)).toBe(true);
    expect(mediaMatch({ process: 'chrome', title: 'youtube.com/watch' }, keywords)).toBe(true);
    expect(mediaMatch({ process: 'notepad', title: '笔记.txt' }, keywords)).toBe(false);
    expect(mediaMatch({ process: 'chrome', title: 'anything' }, [])).toBe(false);
  });

  it('splits keywords on commas, full-width commas, semicolons and newlines', () => {
    expect(splitKeywords(' a, B;c，d；e\nf ')).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});

describe('screen diff', () => {
  it('reads the changed percentage', () => {
    expect(parseShotLine('SHOT 48 1800')).toBe(48);
    expect(parseShotLine('SHOT 3.4 1800')).toBe(3.4);
  });

  it('treats a failure as no reading', () => {
    expect(parseShotLine('SHOT FAIL out of memory')).toBeNull();
    expect(parseShotLine('')).toBeNull();
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

  it('decides present the same way', () => {
    let d = feedReading(emptyDebounce(), false);
    d = feedReading(d, false);
    expect(confirmedReading(d)).toBe(false);
  });
});

describe('signals', () => {
  it('takes a locked screen as away without looking at idle', () => {
    expect(decidePresence(true, null, 10 * MINUTE)).toEqual({ away: true, reason: 'lock' });
    expect(decidePresence(true, 0, 10 * MINUTE)).toEqual({ away: true, reason: 'lock' });
  });

  it('takes a long idle stretch as away when the screen is unlocked', () => {
    expect(decidePresence(false, 11 * MINUTE, 10 * MINUTE)).toEqual({ away: true, reason: 'idle' });
    expect(decidePresence(false, 10 * MINUTE, 10 * MINUTE)).toEqual({ away: true, reason: 'idle' });
  });

  it('stays present below the idle threshold', () => {
    expect(decidePresence(false, 9 * MINUTE, 10 * MINUTE)).toEqual({ away: false, reason: null });
  });

  it('ignores idle entirely when the threshold is 0 or the reading is missing', () => {
    expect(decidePresence(false, 60 * MINUTE, 0)).toEqual({ away: false, reason: null });
    expect(decidePresence(false, null, 10 * MINUTE)).toEqual({ away: false, reason: null });
  });
});

describe('presence', () => {
  it('records the first reading without a change', () => {
    const { state, change } = applyReading(emptyPresence(), { away: false, reason: null }, 1_000);
    expect(state).toEqual({ away: false, since: 1_000, reason: null, lastAway: null });
    expect(change).toEqual({ kind: 'first', at: 1_000 });
  });

  it('turns away into a change carrying the reason, and back into a duration', () => {
    const first = applyReading(emptyPresence(), { away: false, reason: null }, 1_000).state;
    const away = applyReading(first, { away: true, reason: 'lock' }, 60_000);
    expect(away.change).toEqual({ kind: 'away', at: 60_000, reason: 'lock' });
    expect(away.state.reason).toBe('lock');

    const back = applyReading(away.state, { away: false, reason: null }, 3_660_000);
    expect(back.change).toEqual({ kind: 'back', at: 3_660_000, awayMs: 3_600_000 });
    expect(back.state.lastAway).toEqual({ from: 60_000, to: 3_660_000 });
    expect(back.state.reason).toBeNull();
  });

  it('keeps the away state when the reading did not change', () => {
    const state = applyReading(emptyPresence(), { away: true, reason: 'lock' }, 1_000).state;
    const again = applyReading(state, { away: true, reason: 'lock' }, 2_000);
    expect(again.change).toBeNull();
    expect(again.state).toBe(state);
  });

  it('follows a change of reason without raising a new event', () => {
    const idle = applyReading(emptyPresence(), { away: true, reason: 'idle' }, 1_000).state;
    const locked = applyReading(idle, { away: true, reason: 'lock' }, 2_000);
    expect(locked.change).toBeNull();
    expect(locked.state.reason).toBe('lock');
    expect(locked.state.since).toBe(1_000);
  });

  it('never reports a negative away time', () => {
    const away = { away: true, since: 10_000, reason: 'lock' as const, lastAway: null };
    const back = applyReading(away, { away: false, reason: null }, 5_000);
    expect(back.change).toEqual({ kind: 'back', at: 5_000, awayMs: 0 });
  });

  it('keeps the last away period across a new one', () => {
    const away = applyReading(applyReading(emptyPresence(), { away: false, reason: null }, 0).state, { away: true, reason: 'idle' }, 100).state;
    const back = applyReading(away, { away: false, reason: null }, 400).state;
    const again = applyReading(back, { away: true, reason: 'lock' }, 900).state;
    expect(again.lastAway).toEqual({ from: 100, to: 400 });
  });
});

describe('durations', () => {
  it('says a short gap in words', () => {
    expect(formatDuration(30_000, 'zh')).toBe('不到一分钟');
    expect(formatDuration(30_000, 'en')).toBe('under a minute');
  });

  it('uses minutes, then hours and minutes, then days', () => {
    expect(formatDuration(26 * MINUTE, 'zh')).toBe('26 分钟');
    expect(formatDuration(72 * MINUTE, 'zh')).toBe('1 小时 12 分钟');
    expect(formatDuration(2 * 24 * 60 * MINUTE, 'zh')).toBe('2 天');
    expect(formatDuration(26 * MINUTE, 'en')).toBe('26 minutes');
    expect(formatDuration(60 * MINUTE, 'en')).toBe('1 hour');
    expect(formatDuration(72 * MINUTE, 'en')).toBe('1 hour 12 minutes');
  });

  it('formats how long ago in both languages', () => {
    expect(formatAgo(20_000, 'zh')).toBe('刚刚');
    expect(formatAgo(17 * MINUTE, 'zh')).toBe('17 分钟前');
    expect(formatAgo(20_000, 'en')).toBe('just now');
    expect(formatAgo(17 * MINUTE, 'en')).toBe('17 minutes ago');
  });
});

describe('config', () => {
  it('clamps the poll interval and falls back on nonsense', () => {
    expect(clampedPollSeconds({ ...ARE_YOU_THERE_DEFAULTS, pollSeconds: 1 })).toBe(5);
    expect(clampedPollSeconds({ ...ARE_YOU_THERE_DEFAULTS, pollSeconds: 10_000 })).toBe(300);
    expect(clampedPollSeconds({ ...ARE_YOU_THERE_DEFAULTS, pollSeconds: Number.NaN })).toBe(15);
    expect(clampedPollSeconds({ ...ARE_YOU_THERE_DEFAULTS, pollSeconds: 30.4 })).toBe(30);
  });

  it('turns idle minutes into milliseconds, 0 meaning off', () => {
    expect(idleThresholdMs({ ...ARE_YOU_THERE_DEFAULTS, idleMinutes: 0 })).toBe(0);
    expect(idleThresholdMs({ ...ARE_YOU_THERE_DEFAULTS, idleMinutes: 10 })).toBe(10 * MINUTE);
    expect(idleThresholdMs({ ...ARE_YOU_THERE_DEFAULTS, idleMinutes: -5 })).toBe(0);
    expect(idleThresholdMs({ ...ARE_YOU_THERE_DEFAULTS, idleMinutes: 10_000 })).toBe(1440 * MINUTE);
    expect(idleThresholdMs({ ...ARE_YOU_THERE_DEFAULTS, idleMinutes: Number.NaN })).toBe(10 * MINUTE);
  });
});
