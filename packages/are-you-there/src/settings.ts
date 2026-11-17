/**
 * 雷达的调参项：存在 `<data>/radar-settings.json`，由「雷达」面板那一页读写。
 *
 * 为什么不放 config.json：World 的配置组会被控制台**全部**渲染进「配置」页签，平台没有「声明了
 * 但不显示」这种开关。要让这几项离开配置页，只能退出配置体系自己存——`radarEnabled` 留在配置里，
 * 其余六项在面板里改。
 *
 * 首次运行时用配置里的同名键做初值（0.4.x 的用户把这些值写在 config.json 里），此后以本文件为准。
 * 整份写临时文件再改名，和 `state.ts` 一个路子。
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AreYouThereConfigSection } from './config.ts';
import {
  DEFAULT_RADAR_ABSENT_SECONDS, DEFAULT_RADAR_BACK_SECONDS, DEFAULT_RADAR_MAX_CM,
  DEFAULT_RADAR_MAX_DISTANCE, DEFAULT_RADAR_QUIET_SECONDS, MAX_RADAR_ABSENT_SECONDS,
  MAX_RADAR_BACK_SECONDS, MAX_RADAR_MAX_CM, MAX_RADAR_MAX_DISTANCE, MAX_RADAR_QUIET_SECONDS,
  MIN_RADAR_MAX_CM, radarPortName,
} from './config.ts';
import type { RadarThresholds } from './radar.ts';

/** 放在 `ctx.dataDir` 里，以 World id 开头，不会和别的 World 撞。 */
export const RADAR_SETTINGS_FILE = 'are-you-there-radar.json';

export interface RadarSettings {
  /** 串口号；`auto` 表示每次连接时自己枚举。 */
  port: string;
  /** 模块侧最大探测距离，0.1 m 单位；0 表示不动模块。 */
  maxDistance: number;
  /** 软件侧上限，cm。 */
  maxCm: number;
  /** 雷达连续多久没测到人算离开，秒。 */
  absentSeconds: number;
  /** 雷达连续测到人多久才算回来，秒。 */
  backSeconds: number;
  /** 短暂经过推不推事件。 */
  passByNotify: boolean;
  /** 雷达报没人时要求的键鼠安静时长，秒；0 表示不设这个门槛。 */
  quietSeconds: number;
}

const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, raw));
};

const clampPort = (value: unknown): string => {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw === '' ? 'auto' : raw.slice(0, 32);
};

/** 把任意一份读数收进合法范围；面板提交什么都按这个过一遍。 */
export function clampRadarSettings(value: Partial<RadarSettings> | null | undefined, fallback: RadarSettings): RadarSettings {
  const raw = value ?? {};
  return {
    port: raw.port === undefined ? fallback.port : clampPort(raw.port),
    maxDistance: clampInt(raw.maxDistance, fallback.maxDistance, 0, MAX_RADAR_MAX_DISTANCE),
    maxCm: clampInt(raw.maxCm, fallback.maxCm, MIN_RADAR_MAX_CM, MAX_RADAR_MAX_CM),
    absentSeconds: clampInt(raw.absentSeconds, fallback.absentSeconds, 1, MAX_RADAR_ABSENT_SECONDS),
    backSeconds: clampInt(raw.backSeconds, fallback.backSeconds, 0, MAX_RADAR_BACK_SECONDS),
    passByNotify: typeof raw.passByNotify === 'boolean' ? raw.passByNotify : fallback.passByNotify,
    quietSeconds: clampInt(raw.quietSeconds, fallback.quietSeconds, 0, MAX_RADAR_QUIET_SECONDS),
  };
}

/** 文件还不存在时的初值：配置里那几个同名键（0.4.x 写过的话就沿用）。 */
export function seedRadarSettings(cfg: AreYouThereConfigSection): RadarSettings {
  const pick = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
  return clampRadarSettings({
    port: radarPortName(cfg),
    maxDistance: pick(cfg.radarMaxDistance, DEFAULT_RADAR_MAX_DISTANCE),
    maxCm: pick(cfg.radarMaxCm, DEFAULT_RADAR_MAX_CM),
    absentSeconds: pick(cfg.radarAbsentSeconds, DEFAULT_RADAR_ABSENT_SECONDS),
    backSeconds: pick(cfg.radarBackSeconds, DEFAULT_RADAR_BACK_SECONDS),
    passByNotify: typeof cfg.radarPassByNotify === 'boolean' ? cfg.radarPassByNotify : true,
    quietSeconds: pick(cfg.radarQuietSeconds, DEFAULT_RADAR_QUIET_SECONDS),
  }, {
    port: 'auto',
    maxDistance: DEFAULT_RADAR_MAX_DISTANCE,
    maxCm: DEFAULT_RADAR_MAX_CM,
    absentSeconds: DEFAULT_RADAR_ABSENT_SECONDS,
    backSeconds: DEFAULT_RADAR_BACK_SECONDS,
    passByNotify: true,
    quietSeconds: DEFAULT_RADAR_QUIET_SECONDS,
  });
}

/** 读一份；文件坏了就用初值，不拦着 World 干活。 */
export function readRadarSettings(dir: string, cfg: AreYouThereConfigSection): RadarSettings {
  const seed = seedRadarSettings(cfg);
  const file = join(dir, RADAR_SETTINGS_FILE);
  if (!existsSync(file)) return seed;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<RadarSettings>;
    return clampRadarSettings(raw, seed);
  } catch (error) {
    console.warn('[are-you-there] unreadable radar settings, falling back to the config', error);
    return seed;
  }
}

export function writeRadarSettings(dir: string, settings: RadarSettings): void {
  const file = join(dir, RADAR_SETTINGS_FILE);
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, `${JSON.stringify(settings, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/** 迟滞参数，毫秒。 */
export function settingsThresholds(settings: RadarSettings): RadarThresholds {
  return {
    maxCm: settings.maxCm,
    absentMs: settings.absentSeconds * 1000,
    backMs: settings.backSeconds * 1000,
  };
}

/** 雷达说没人时要求的键鼠安静时长，毫秒；0 表示不设这个门槛。 */
export function settingsQuietMs(settings: RadarSettings): number {
  return settings.quietSeconds * 1000;
}
