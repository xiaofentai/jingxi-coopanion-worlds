import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARE_YOU_THERE_DEFAULTS, areYouThereConfigGroup } from '../src/config.ts';
import { decidePresence } from '../src/presence.ts';
import {
  RADAR_FAR_LIMIT_MS, RADAR_STALE_MS, RADAR_TRUST_MS,
  decideRadar, emptyRadarReading, parseRadarLine, radarTrustExpired,
  type RadarReading,
} from '../src/radar.ts';
import {
  LEGACY_SETTINGS_FILE, SETTINGS_FILE, clampSettings, readSettings, seedSettings,
  settingsAbsentMs, settingsBackWindowMs, trackerSettings, writeSettings,
} from '../src/settings.ts';
import { areYouThereText } from '../src/text.ts';

const THRESHOLDS = { maxCm: 120, absentMs: 5_000, presentMs: 2_000 };

/** 一份「刚刚在 79 厘米处见到人」的读数，按需覆盖。 */
function reading(overrides: Partial<RadarReading> = {}): RadarReading {
  const now = overrides.at ?? 1_000_000;
  return {
    ...emptyRadarReading(),
    linked: true,
    port: 'COM5',
    at: now,
    connectedAt: now - 60_000,
    lastPresentAt: now,
    presentSince: now - 60_000,
    cm: 79,
    sawNear: true,
    ...overrides,
  };
}

describe('parseRadarLine', () => {
  it('reads the three lines the script emits', () => {
    expect(parseRadarLine('READY COM5')).toEqual({ kind: 'ready', port: 'COM5' });
    expect(parseRadarLine('PRESENT 79')).toEqual({ kind: 'present', cm: 79 });
    expect(parseRadarLine('ABSENT')).toEqual({ kind: 'absent' });
  });

  it('keeps the config and failure lines apart from the frames', () => {
    expect(parseRadarLine('CFG keep 14')).toEqual({ kind: 'cfg', text: 'keep 14' });
    expect(parseRadarLine('FAIL busy')).toEqual({ kind: 'fail', reason: 'busy' });
  });

  it('drops anything else, including a half-written last line', () => {
    expect(parseRadarLine('')).toBeNull();
    expect(parseRadarLine('distance:79')).toBeNull();
    expect(parseRadarLine('PRESENT')).toBeNull();
    expect(parseRadarLine('PRESENT 79abc')).toBeNull();
  });

  it('tolerates the trailing carriage return Windows adds', () => {
    expect(parseRadarLine('PRESENT 79\r')).toEqual({ kind: 'present', cm: 79 });
  });
});

describe('decideRadar', () => {
  it('says nothing until it has seen somebody in range on this connection', () => {
    const now = 1_000_000;
    const quiet = reading({ at: now, lastPresentAt: null, presentSince: null, cm: null, sawNear: false });
    expect(decideRadar(quiet, now, THRESHOLDS)).toBeNull();
  });

  it('reports present once somebody has been in range long enough', () => {
    const now = 1_000_000;
    const decision = decideRadar(reading({ at: now, presentSince: now - 2_500 }), now, THRESHOLDS);
    expect(decision).toEqual({ present: true, absent: false, absentMs: null, cm: 79, offFrame: true });
  });

  it('waits out the back delay so somebody walking past does not count', () => {
    const now = 1_000_000;
    expect(decideRadar(reading({ at: now, presentSince: now - 500 }), now, THRESHOLDS)).toBeNull();
  });

  it('trusts a module OFF immediately and reports the full span', () => {
    const now = 1_000_000;
    const gone = reading({ at: now, lastPresentAt: now - 9_000, presentSince: null });
    expect(decideRadar(gone, now, THRESHOLDS)).toEqual({
      present: false, absent: true, absentMs: 9_000, cm: 79, offFrame: true,
    });
  });

  it('drops a reading that stopped updating, rather than treating it as nobody there', () => {
    const now = 1_000_000;
    const frozen = reading({ at: now - RADAR_STALE_MS - 1, lastPresentAt: now - 600_000, presentSince: null });
    expect(decideRadar(frozen, now, THRESHOLDS)).toBeNull();
  });

  it('ignores a radio that is not connected', () => {
    const now = 1_000_000;
    expect(decideRadar(reading({ at: now, linked: false }), now, THRESHOLDS)).toBeNull();
  });

  it('gives up when everything it sees stayed outside maxCm for too long', () => {
    const now = 1_000_000;
    const far = reading({
      at: now,
      lastPresentAt: now - 600_000,
      presentSince: null,
      sawNear: false,
      farSince: now - RADAR_FAR_LIMIT_MS,
    });
    expect(decideRadar(far, now, THRESHOLDS)).toBeNull();
  });

  it('flags a sighting from hours ago without blocking a genuinely cold keyboard', () => {
    const now = 1_000_000;
    const old = reading({ at: now, lastPresentAt: now - RADAR_TRUST_MS - 1, presentSince: null });
    expect(radarTrustExpired(old, now)).toBe(true);
    expect(radarTrustExpired(reading({ at: now }), now)).toBe(false);
    // 纯函数只标出「旧」；要不要撤销信任由 World 结合键鼠决定
    expect(decideRadar(old, now, THRESHOLDS)?.absent).toBe(true);
  });

  it('uses the same total window for far readings, without counting the hardware delay twice', () => {
    const now = 1_000_000;
    const due = THRESHOLDS.absentMs;
    const far = reading({ at: now, lastPresentAt: now - due + 1, presentSince: null, farSince: now - due + 1 });
    expect(decideRadar(far, now, THRESHOLDS)).toBeNull();
    expect(decideRadar({ ...far, lastPresentAt: now - due, farSince: now - due }, now, THRESHOLDS)).toEqual({
      present: false, absent: true, absentMs: due, cm: 79, offFrame: false,
    });
  });
});

describe('decidePresence with the radar attached', () => {
  const absent = { present: false, absent: true, absentMs: 9_000, cm: 79, offFrame: true };
  const present = { present: true, absent: false, absentMs: null, cm: 79, offFrame: true };

  it('lets the lock win over everything else', () => {
    expect(decidePresence(true, 11 * 60_000, 10 * 60_000, present)).toEqual({ away: true, reason: 'lock' });
  });

  it('takes a radar absence as away even when the keyboard was just touched', () => {
    expect(decidePresence(false, 0, 10 * 60_000, absent)).toEqual({ away: true, reason: 'radar' });
  });

  it('lets a radar presence veto the idle signal', () => {
    expect(decidePresence(false, 40 * 60_000, 10 * 60_000, present)).toEqual({ away: false, reason: null });
  });

  it('falls back to the idle signal when the radar says nothing', () => {
    expect(decidePresence(false, 11 * 60_000, 10 * 60_000, null)).toEqual({ away: true, reason: 'idle' });
    expect(decidePresence(false, 60_000, 10 * 60_000, null)).toEqual({ away: false, reason: null });
  });

  it('does not believe a radar absence while the keyboard is still warm', () => {
    // 雷达漏检：人坐着没动，但两秒前刚敲过键
    expect(decidePresence(false, 2_000, 10 * 60_000, absent, 60_000)).toEqual({ away: false, reason: null });
    // 键鼠安静够久了，这时才信雷达
    expect(decidePresence(false, 90_000, 10 * 60_000, absent, 60_000)).toEqual({ away: true, reason: 'radar' });
  });

  it('trusts the radar alone when the quiet window is 0', () => {
    expect(decidePresence(false, 0, 10 * 60_000, absent, 0)).toEqual({ away: true, reason: 'radar' });
  });
});

describe('text and config wiring', () => {
  it('has every radar string in both languages', () => {
    for (const language of ['zh', 'en'] as const) {
      const text = areYouThereText(language);
      for (const key of [
        'radarEnabled', 'radarPort', 'radarMaxDistance', 'radarMaxCm',
        'radarAbsentSeconds', 'radarBackSeconds', 'radarPassByNotify', 'radarQuietSeconds',
      ] as const) {
        expect(text.config[key].title, `${language}.${key}.title`).toBeTruthy();
        expect(text.config[key].description, `${language}.${key}.description`).toBeTruthy();
      }
      expect(text.config.radarGroup.title).toBeTruthy();
      expect(text.config.radarGroup.description).toBeTruthy();
      expect(text.config.radarGroup.descriptionOff).toBeTruthy();
      expect(text.event.passBy('3 s', '')).toBeTruthy();
      expect(text.event.awayRadar('9 s', '')).toBeTruthy();
      expect(text.event.backRadar('12:00', '5 min')).toBeTruthy();
      expect(text.tool.radarFar('120')).toBeTruthy();
      expect(text.tool.radarCooling).toBeTruthy();
      expect(text.lines.radarCooling).toBeTruthy();
      expect(text.tool.radarStale).toBeTruthy();
      expect(text.tool.lampStarting).toBeTruthy();
      expect(text.tool.idleCross('35 秒')).toContain('35');
      expect(text.config.checkIdle.title).toBeTruthy();
      expect(text.config.checkIdle.description).toBeTruthy();
      expect(text.lamp.radar).toBeTruthy();
      for (const key of ['radar', 'state', 'reading', 'connected', 'disconnected', 'none'] as const) {
        expect(text.badge[key], `${language}.badge.${key}`).toBeTruthy();
      }
      expect(text.badge.centimetres('79')).toContain('79');
      for (const key of [
        'title', 'description', 'lockTitle', 'lockDescription', 'judgeTitle', 'judgeDescription', 'radarTitle', 'radarDescription',
        'radarOff', 'status', 'radarLatencyUnknown', 'present', 'absent', 'warming', 'cooling', 'stale', 'far', 'down', 'starting',
        'fieldPollSeconds', 'fieldIdleMinutes', 'fieldCheckForeground', 'fieldMediaKeywords', 'fieldCheckScreen',
        'fieldPort', 'fieldMaxDistance', 'fieldMaxCm', 'fieldAbsentSeconds', 'fieldBackSeconds',
        'fieldPassByNotify', 'fieldQuietSeconds', 'saved',
      ] as const) {
        expect(text.panel[key], `${language}.panel.${key}`).toBeTruthy();
      }
      expect(text.panel.saveFailed('x')).toContain('x');
      expect(text.panel.radarLatency('30 秒')).toContain('30');
      expect(text.panel.radarTotal('40 秒')).toContain('40');
      expect(text.panel.radarAbsentHint('30 秒', '35 秒', '5 秒', '30 秒')).toContain('30');
      expect(text.lines.awayRadar('11-17 15:10', '9 s')).toBeTruthy();
    }
  });

  it('leaves only five switches on the config page, in order', () => {
    for (const language of ['zh', 'en'] as const) {
      const group = areYouThereConfigGroup(language);
      expect(Object.keys(group.schema.properties)).toEqual([
        'worlds.are-you-there.checkLock',
        'worlds.are-you-there.checkIdle',
        'worlds.are-you-there.radarEnabled',
        'worlds.are-you-there.notifyAway',
        'worlds.are-you-there.notifyBack',
      ]);
      for (const prop of Object.values(group.schema.properties)) {
        expect(prop.type).toBe('boolean');
      }
    }
  });
});

describe('the settings file', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'ayt-settings-'));
    dirs.push(dir);
    return dir;
  };
  const cfg = ARE_YOU_THERE_DEFAULTS;

  it('clamps anything it is handed instead of trusting it', () => {
    const fallback = seedSettings(cfg);
    const clamped = clampSettings({
      radarPort: '  ',
      radarMaxDistance: 999,
      radarMaxCm: 0,
      radarAbsentSeconds: 999,
      radarBackSeconds: -5,
      radarQuietSeconds: -1,
    }, fallback);
    expect(clamped.radarPort).toBe('auto');
    expect(clamped.radarMaxDistance).toBe(100);
    expect(clamped.radarMaxCm).toBe(30);
    expect(clamped.radarAbsentSeconds).toBe(300);
    expect(clamped.radarBackSeconds).toBe(0);
    expect(clamped.radarQuietSeconds).toBe(0);
    expect(clamped.radarPassByNotify).toBe(fallback.radarPassByNotify);
  });

  it('floors the total absence window at the module delay', () => {
    const settings = seedSettings(cfg);
    expect(settingsAbsentMs(settings, 30_000)).toBe(35_000);
    expect(settingsAbsentMs({ ...settings, radarAbsentSeconds: 5 }, 30_000)).toBe(30_000);
    expect(settingsAbsentMs(settings, 5_000)).toBe(35_000);
  });

  it('uses the module delay to build the back observation window', () => {
    const settings = seedSettings(cfg);
    expect(settingsBackWindowMs(settings, 30_000)).toBe(40_000);
    expect(settingsBackWindowMs(settings, null)).toBe(40_000);
  });

  it('passes real numbers, not undefined, into the tracker', () => {
    // 回归：改名时漏改一处，undefined 会让子进程收到 -MaxDistance 0（不配置模块，读不到硬件延迟）
    // 与 maxCm 0（距离过滤失效）
    const settings = { ...seedSettings(cfg), radarPort: 'COM7', radarMaxDistance: 21, radarMaxCm: 90 };
    expect(trackerSettings(settings)).toEqual({ port: 'COM7', maxDistance: 21, maxCm: 90 });
  });

  it('seeds itself from the config while the file does not exist yet', () => {
    const dir = tempDir();
    const settings = readSettings(dir, { ...cfg, radarMaxCm: 150, checkForeground: true, mediaKeywords: 'vlc' });
    expect(settings.radarMaxCm).toBe(150);
    expect(settings.checkForeground).toBe(true);
    expect(settings.mediaKeywords).toBe('vlc');
    expect(existsSync(join(dir, SETTINGS_FILE))).toBe(false);
  });

  it('round-trips through the file and wins over the config afterwards', () => {
    const dir = tempDir();
    const saved = { ...seedSettings(cfg), radarMaxCm: 90, mediaKeywords: 'mpv' };
    writeSettings(dir, saved);
    expect(existsSync(join(dir, SETTINGS_FILE))).toBe(true);
    expect(readSettings(dir, { ...cfg, radarMaxCm: 150 })).toEqual(saved);
  });

  it('picks up the radar file 0.5.x wrote, once', () => {
    const dir = tempDir();
    writeFileSync(join(dir, LEGACY_SETTINGS_FILE), JSON.stringify({ radarMaxCm: 111 }), 'utf8');
    expect(readSettings(dir, cfg).radarMaxCm).toBe(111);
    // 新文件写下去之后就只认新的
    writeSettings(dir, { ...seedSettings(cfg), radarMaxCm: 77 });
    expect(readSettings(dir, cfg).radarMaxCm).toBe(77);
  });

  it('falls back to the config when the file is corrupt', () => {
    const dir = tempDir();
    writeFileSync(join(dir, SETTINGS_FILE), '{oops', 'utf8');
    expect(readSettings(dir, cfg)).toEqual(seedSettings(cfg));
  });
});
