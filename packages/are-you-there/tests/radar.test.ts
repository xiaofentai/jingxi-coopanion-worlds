import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARE_YOU_THERE_DEFAULTS, areYouThereConfigGroup } from '../src/config.ts';
import { decidePresence } from '../src/presence.ts';
import {
  RADAR_FAR_LIMIT_MS, RADAR_STALE_MS, decideRadar, emptyRadarReading, parseRadarLine,
  type RadarReading,
} from '../src/radar.ts';
import {
  RADAR_SETTINGS_FILE, clampRadarSettings, readRadarSettings, seedRadarSettings, writeRadarSettings,
} from '../src/settings.ts';
import { areYouThereText } from '../src/text.ts';

const THRESHOLDS = { maxCm: 120, absentMs: 5_000, backMs: 2_000 };

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
    expect(decision).toEqual({ present: true, absent: false, absentMs: null, cm: 79 });
  });

  it('waits out the back delay so somebody walking past does not count', () => {
    const now = 1_000_000;
    expect(decideRadar(reading({ at: now, presentSince: now - 500 }), now, THRESHOLDS)).toBeNull();
  });

  it('reports absent after the absence threshold, and says how long it has been', () => {
    const now = 1_000_000;
    const gone = reading({ at: now, lastPresentAt: now - 9_000, presentSince: null });
    expect(decideRadar(gone, now, THRESHOLDS)).toEqual({
      present: false, absent: true, absentMs: 9_000, cm: 79,
    });
  });

  it('stays undecided while the absence is shorter than the threshold', () => {
    const now = 1_000_000;
    const gone = reading({ at: now, lastPresentAt: now - 1_000, presentSince: null });
    expect(decideRadar(gone, now, THRESHOLDS)).toBeNull();
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
});

describe('decidePresence with the radar attached', () => {
  const absent = { present: false, absent: true, absentMs: 9_000, cm: 79 };
  const present = { present: true, absent: false, absentMs: null, cm: 79 };

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
      expect(text.tool.radarStale).toBeTruthy();
      expect(text.tool.lampStarting).toBeTruthy();
      expect(text.lamp.radar).toBeTruthy();
      for (const key of ['radar', 'state', 'reading', 'connected', 'disconnected', 'none'] as const) {
        expect(text.badge[key], `${language}.badge.${key}`).toBeTruthy();
      }
      expect(text.badge.centimetres('79')).toContain('79');
      for (const key of [
        'radarTitle', 'radarDescription', 'present', 'absent', 'warming', 'stale', 'far', 'down', 'starting',
        'fieldPort', 'fieldMaxDistance', 'fieldMaxCm', 'fieldAbsentSeconds', 'fieldBackSeconds',
        'fieldPassByNotify', 'fieldQuietSeconds', 'save', 'saved',
      ] as const) {
        expect(text.panel[key], `${language}.panel.${key}`).toBeTruthy();
      }
      expect(text.panel.saveFailed('x')).toContain('x');
      expect(text.lines.awayRadar('11-17 15:10', '9 s')).toBeTruthy();
    }
  });

  it('leaves only the switch in the settings page', () => {
    for (const language of ['zh', 'en'] as const) {
      const group = areYouThereConfigGroup(language);
      const keys = Object.keys(group.schema.properties);
      // 这些项已经搬到「雷达」页签，配置页里只剩开关
      expect(keys.filter((key) => key.includes('.radar'))).toEqual(['worlds.are-you-there.radarEnabled']);
      expect(keys).toContain('worlds.are-you-there.pollSeconds');
    }
  });
});

describe('the radar settings file', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'ayt-radar-'));
    dirs.push(dir);
    return dir;
  };
  const cfg = ARE_YOU_THERE_DEFAULTS;

  it('clamps anything it is handed instead of trusting it', () => {
    const fallback = seedRadarSettings(cfg);
    const clamped = clampRadarSettings({
      port: '  ',
      maxDistance: 999,
      maxCm: 0,
      absentSeconds: 10_000,
      backSeconds: -5,
      quietSeconds: -1,
    }, fallback);
    expect(clamped.port).toBe('auto');
    expect(clamped.maxDistance).toBe(100);
    expect(clamped.maxCm).toBe(30);
    expect(clamped.absentSeconds).toBe(600);
    expect(clamped.backSeconds).toBe(0);
    expect(clamped.quietSeconds).toBe(0);
    expect(clamped.passByNotify).toBe(fallback.passByNotify);
  });

  it('seeds itself from the config while the file does not exist yet', () => {
    const dir = tempDir();
    const settings = readRadarSettings(dir, { ...cfg, radarMaxCm: 150, radarAbsentSeconds: 7 });
    expect(settings.maxCm).toBe(150);
    expect(settings.absentSeconds).toBe(7);
    expect(existsSync(join(dir, RADAR_SETTINGS_FILE))).toBe(false);
  });

  it('round-trips through the file and wins over the config afterwards', () => {
    const dir = tempDir();
    const saved = { ...seedRadarSettings(cfg), maxCm: 90, backSeconds: 4 };
    writeRadarSettings(dir, saved);
    expect(existsSync(join(dir, RADAR_SETTINGS_FILE))).toBe(true);
    expect(readRadarSettings(dir, { ...cfg, radarMaxCm: 150 })).toEqual(saved);
  });

  it('falls back to the config when the file is corrupt', () => {
    const dir = tempDir();
    writeFileSync(join(dir, RADAR_SETTINGS_FILE), '{oops', 'utf8');
    expect(readRadarSettings(dir, cfg)).toEqual(seedRadarSettings(cfg));
  });
});
