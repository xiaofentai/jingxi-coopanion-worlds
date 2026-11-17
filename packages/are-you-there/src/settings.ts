/**
 * 判定细节与雷达的那几项：存在 `<data>/are-you-there-settings.json`，由「设置」面板读写。
 *
 * 为什么不放 config.json：World 声明的配置组会被控制台**全部**渲染进「配置」页签，平台没有
 * 「声明了但不显示」这种开关。要让这些项离开配置页，只能退出配置体系自己存——配置页只留
 * 几个一句话能说清的开关。
 *
 * 首次运行时用配置里的同名键做初值（0.4.x/0.5.x 的用户把这些值写在 config.json 里），此后以本
 * 文件为准。整份写临时文件再改名，和 `state.ts` 一个路子。
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
export const SETTINGS_FILE = 'are-you-there-settings.json';

/** 0.5.x 用的文件名；读到它就搬过来，省得用户白改一遍。 */
export const LEGACY_SETTINGS_FILE = 'are-you-there-radar.json';

export interface WorldSettings {
  /** 空闲到阈值时看一眼前台窗口。 */
  checkForeground: boolean;
  /** 前台判定用的关键词，逗号分隔。 */
  mediaKeywords: string;
  /** 空闲到阈值时比较两帧画面。 */
  checkScreen: boolean;
  /** 串口号；`auto` 表示每次连接时自己枚举。 */
  radarPort: string;
  /** 模块侧最大探测距离，0.1 m 单位；0 表示不动模块。 */
  radarMaxDistance: number;
  /** 软件侧上限，cm。 */
  radarMaxCm: number;
  /** 雷达连续多久没测到人算离开，秒。 */
  radarAbsentSeconds: number;
  /** 雷达连续测到人多久才算回来，秒。 */
  radarBackSeconds: number;
  /** 短暂经过推不推事件。 */
  radarPassByNotify: boolean;
  /** 雷达报没人时要求的键鼠安静时长，秒；0 表示不设这个门槛。 */
  radarQuietSeconds: number;
}

const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, raw));
};

const clampText = (value: unknown, fallback: string, max: number): string => {
  if (typeof value !== 'string') return fallback;
  const raw = value.trim();
  return raw === '' ? fallback : raw.slice(0, max);
};

/** 把任意一份读数收进合法范围；面板提交什么都按这个过一遍。 */
export function clampSettings(value: Partial<WorldSettings> | null | undefined, fallback: WorldSettings): WorldSettings {
  const raw = value ?? {};
  const pick = <K extends keyof WorldSettings>(key: K): unknown => raw[key];
  return {
    checkForeground: typeof pick('checkForeground') === 'boolean' ? raw.checkForeground! : fallback.checkForeground,
    mediaKeywords: clampText(pick('mediaKeywords'), fallback.mediaKeywords, 2000),
    checkScreen: typeof pick('checkScreen') === 'boolean' ? raw.checkScreen! : fallback.checkScreen,
    radarPort: raw.radarPort === undefined ? fallback.radarPort : clampText(raw.radarPort, fallback.radarPort, 32),
    radarMaxDistance: clampInt(pick('radarMaxDistance'), fallback.radarMaxDistance, 0, MAX_RADAR_MAX_DISTANCE),
    radarMaxCm: clampInt(pick('radarMaxCm'), fallback.radarMaxCm, MIN_RADAR_MAX_CM, MAX_RADAR_MAX_CM),
    radarAbsentSeconds: clampInt(pick('radarAbsentSeconds'), fallback.radarAbsentSeconds, 1, MAX_RADAR_ABSENT_SECONDS),
    radarBackSeconds: clampInt(pick('radarBackSeconds'), fallback.radarBackSeconds, 0, MAX_RADAR_BACK_SECONDS),
    radarPassByNotify: typeof pick('radarPassByNotify') === 'boolean' ? raw.radarPassByNotify! : fallback.radarPassByNotify,
    radarQuietSeconds: clampInt(pick('radarQuietSeconds'), fallback.radarQuietSeconds, 0, MAX_RADAR_QUIET_SECONDS),
  };
}

/** 文件还不存在时的初值：配置里那几个同名键。 */
export function seedSettings(cfg: AreYouThereConfigSection): WorldSettings {
  const num = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
  const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
  const base: WorldSettings = {
    checkForeground: bool(cfg.checkForeground, false),
    mediaKeywords: typeof cfg.mediaKeywords === 'string' && cfg.mediaKeywords !== '' ? cfg.mediaKeywords : '',
    checkScreen: bool(cfg.checkScreen, false),
    radarPort: radarPortName(cfg),
    radarMaxDistance: num(cfg.radarMaxDistance, DEFAULT_RADAR_MAX_DISTANCE),
    radarMaxCm: num(cfg.radarMaxCm, DEFAULT_RADAR_MAX_CM),
    radarAbsentSeconds: num(cfg.radarAbsentSeconds, DEFAULT_RADAR_ABSENT_SECONDS),
    radarBackSeconds: num(cfg.radarBackSeconds, DEFAULT_RADAR_BACK_SECONDS),
    radarPassByNotify: bool(cfg.radarPassByNotify, true),
    radarQuietSeconds: num(cfg.radarQuietSeconds, DEFAULT_RADAR_QUIET_SECONDS),
  };
  return clampSettings(base, base);
}

function load(file: string, seed: WorldSettings): WorldSettings | null {
  if (!existsSync(file)) return null;
  try {
    return clampSettings(JSON.parse(readFileSync(file, 'utf8')) as Partial<WorldSettings>, seed);
  } catch (error) {
    console.warn('[are-you-there] unreadable settings, falling back to the seed', error);
    return seed;
  }
}

/** 读一份；文件坏了就用初值，不拦着 World 干活。 */
export function readSettings(dir: string, cfg: AreYouThereConfigSection): WorldSettings {
  const seed = seedSettings(cfg);
  const own = load(join(dir, SETTINGS_FILE), seed);
  if (own !== null) return own;
  // 0.5.x 把雷达那几项写在另一个文件里，读一次搬过来
  const legacy = load(join(dir, LEGACY_SETTINGS_FILE), seed);
  return legacy ?? seed;
}

export function writeSettings(dir: string, settings: WorldSettings): void {
  const file = join(dir, SETTINGS_FILE);
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

/**
 * 交给 `RadarTracker` 的那三个值。
 *
 * 单独拎出来是因为踩过一次：把设置字段从 `maxCm` 改名成 `radarMaxCm` 时漏改了一处，`undefined`
 * 一路传进子进程——`-MaxDistance 0` 让配置步骤整个跳过（于是读不到硬件延迟），`maxCm` 变成 0
 * 让距离过滤失效。名字写错在这里是类型错误，不会悄悄变成 `undefined`。
 */
export function trackerSettings(settings: WorldSettings): { port: string; maxDistance: number; maxCm: number } {
  return {
    port: settings.radarPort,
    maxDistance: settings.radarMaxDistance,
    maxCm: settings.radarMaxCm,
  };
}

/** 迟滞参数，毫秒。 */
export function settingsThresholds(settings: WorldSettings): RadarThresholds {
  return {
    maxCm: settings.radarMaxCm,
    absentMs: settings.radarAbsentSeconds * 1000,
    backMs: settings.radarBackSeconds * 1000,
  };
}

/** 雷达说没人时要求的键鼠安静时长，毫秒；0 表示不设这个门槛。 */
export function settingsQuietMs(settings: WorldSettings): number {
  return settings.radarQuietSeconds * 1000;
}
