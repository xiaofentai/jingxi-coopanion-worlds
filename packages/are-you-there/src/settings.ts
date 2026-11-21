/**
 * 判定细节与雷达的那几项：存在 `config.json` 的 `worlds.are-you-there.settings` 段，
 * 由「设置」面板读写，和配置页那几个开关同住一份文件。
 *
 * 为什么设置项不进配置页的 schema：World 声明的配置组会被控制台**全部**渲染进「配置」页签，
 * 平台没有「声明了但不显示」这种开关；但写进同一份 config.json 的**未声明子段**不会被清理
 * （真机验证过），所以设置页自己画、数据落在自己的段里，配置页仍只显示那几个开关。
 *
 * 升级时读旧小本子 `<data>/are-you-there-settings.json`（及更老的 `are-you-there-radar.json`）
 * 作初值，真写进配置段后删掉旧文件；写入失败时保留旧文件，下次还能再迁。
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARE_YOU_THERE_ID, type AreYouThereConfigSection } from './config.ts';
import {
  DEFAULT_IDLE_MINUTES, DEFAULT_POLL_SECONDS,
  DEFAULT_RADAR_ABSENT_SECONDS, DEFAULT_RADAR_BACK_SECONDS, DEFAULT_RADAR_MAX_CM,
  DEFAULT_RADAR_MAX_DISTANCE, DEFAULT_RADAR_QUIET_SECONDS, MAX_IDLE_MINUTES, MAX_POLL_SECONDS,
  MAX_RADAR_ABSENT_SECONDS, MAX_RADAR_BACK_SECONDS, MAX_RADAR_MAX_CM, MAX_RADAR_MAX_DISTANCE,
  MAX_RADAR_QUIET_SECONDS, MIN_POLL_SECONDS, MIN_RADAR_MAX_CM, radarPortName,
} from './config.ts';
import { RADAR_PRESENT_MS, type RadarThresholds } from './radar.ts';

/** 旧的小本子，放在 `ctx.dataDir`；迁移成功后删掉。 */
export const SETTINGS_FILE = 'are-you-there-settings.json';

/** 更早的小本子（0.5.x）；读到它也搬过来，省得用户白改一遍。 */
export const LEGACY_SETTINGS_FILE = 'are-you-there-radar.json';

/** config.json 里放设置的键，和配置页那几个开关同住一段。 */
export const SETTINGS_KEY = 'settings';

export interface WorldSettings {
  /** 屏幕锁检查的轮询间隔，秒。 */
  pollSeconds: number;
  /** 鼠标键盘空闲多久算离开，分钟；0 表示不看。 */
  idleMinutes: number;
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
  /** 从最后一次看见近处的人到认定雷达说没人的总时长，秒；低于硬件延迟时按硬件算。 */
  radarAbsentSeconds: number;
  /** 回来观察窗口的一部分，秒；加上模块硬件延迟就是完整窗口。 */
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
    pollSeconds: clampInt(pick('pollSeconds'), fallback.pollSeconds, MIN_POLL_SECONDS, MAX_POLL_SECONDS),
    idleMinutes: clampInt(pick('idleMinutes'), fallback.idleMinutes, 0, MAX_IDLE_MINUTES),
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
    pollSeconds: num(cfg.pollSeconds, DEFAULT_POLL_SECONDS),
    idleMinutes: num(cfg.idleMinutes, DEFAULT_IDLE_MINUTES),
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

/**
 * 读设置：优先 config.json 里自己那段；没有就依次看两份旧小本子并迁过来；都没有才用配置槽初值。
 *
 * 迁移必须真写盘 + 删旧文件——否则界面显示"已保存"，但旧本子一直在，重启又被它盖回去。
 * 写盘失败时保留旧文件，下次还能再迁。
 */
export function readSettings(botDir: string, dataDir: string, cfg: AreYouThereConfigSection): WorldSettings {
  const seed = seedSettings(cfg);
  const configFile = join(botDir, 'config.json');
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
  } catch {
    // config.json 读不到：还能退到旧小本子或 seed，不让 World 起不来
  }
  const worlds = raw?.worlds as Record<string, unknown> | undefined;
  const section = worlds?.[ARE_YOU_THERE_ID] as Record<string, unknown> | undefined;
  const stored = section?.[SETTINGS_KEY];
  if (stored && typeof stored === 'object') {
    try {
      return clampSettings(stored as Partial<WorldSettings>, seed);
    } catch {
      // 坏段就当没配，继续往下找
    }
  }

  // 当前小本子 → 更老的雷达小本子：读到哪一份就迁哪一份
  for (const name of [SETTINGS_FILE, LEGACY_SETTINGS_FILE]) {
    const file = join(dataDir, name);
    if (!existsSync(file)) continue;
    const found = load(file, seed);
    if (found === null) continue;
    writeSettings(botDir, found);
    try {
      unlinkSync(file);
    } catch {
      // 删不掉也没关系：config.json 里已经有了，下次读会优先它
    }
    return found;
  }
  return seed;
}

/**
 * 整份读 config.json，只改 `worlds.are-you-there.settings`，其余键一个不动
 * （配置页那几个开关就在这段里，不能碰）。临时文件再改名，中途崩了不留半份配置。
 */
export function writeSettings(botDir: string, settings: WorldSettings): void {
  const file = join(botDir, 'config.json');
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    // 文件坏了也要写自己的段：保留能保住的部分
  }
  const worlds = (raw.worlds && typeof raw.worlds === 'object' ? raw.worlds : {}) as Record<string, unknown>;
  const section = (worlds[ARE_YOU_THERE_ID] && typeof worlds[ARE_YOU_THERE_ID] === 'object'
    ? worlds[ARE_YOU_THERE_ID] : {}) as Record<string, unknown>;
  worlds[ARE_YOU_THERE_ID] = { ...section, [SETTINGS_KEY]: settings };
  raw.worlds = worlds;
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, `${JSON.stringify(raw, null, 2)}\n`);
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

/** 模块目标消失延迟读不到时用出厂值兜底。 */
export const RADAR_GONE_FALLBACK_MS = 30_000;

/**
 * 雷达说没人的总时长：配置是下限，模块硬件延迟更长时按硬件算。
 *
 * 这样旧设置文件里 `radarAbsentSeconds=5` 也不会让判定比模块还快。
 */
export function settingsAbsentMs(settings: WorldSettings, goneMs: number | null): number {
  return Math.max(settings.radarAbsentSeconds * 1000, goneMs ?? RADAR_GONE_FALLBACK_MS);
}

/** 迟滞参数，毫秒。 */
export function settingsThresholds(settings: WorldSettings, goneMs: number | null): RadarThresholds {
  return {
    maxCm: settings.radarMaxCm,
    absentMs: settingsAbsentMs(settings, goneMs),
    presentMs: RADAR_PRESENT_MS,
  };
}

/** 雷达说没人时要求的键鼠安静时长，毫秒；0 表示不设这个门槛。 */
export function settingsQuietMs(settings: WorldSettings): number {
  return settings.radarQuietSeconds * 1000;
}

/**
 * 回来观察窗口：界面上那段时间 + 模块自己的目标消失延迟。
 *
 * 人短暂出现又走了，模块还要等这段硬件延迟才报 OFF；窗口必须盖住它，
 * 才能看见「跌落回没人」，否则路过会被当成回来。
 */
export function settingsBackWindowMs(settings: WorldSettings, goneMs: number | null): number {
  return settings.radarBackSeconds * 1000 + (goneMs ?? RADAR_GONE_FALLBACK_MS);
}
