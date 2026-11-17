/** 配置段 `worlds.are-you-there`：多久查一次、状态变化要不要推事件。 */
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { Language } from 'cortico/core/language.ts';
import type { WorldSection } from 'cortico/world.ts';
import { areYouThereText } from './text.ts';

export const ARE_YOU_THERE_ID = 'are-you-there';

/** 查得再勤也没意义：`tasklist` 自己就要几毫秒，状态变化还要连续两次才认。 */
export const MIN_POLL_SECONDS = 5;
export const MAX_POLL_SECONDS = 300;
export const DEFAULT_POLL_SECONDS = 15;

export interface AreYouThereConfigSection extends WorldSection {
  /** 轮询间隔，秒。 */
  pollSeconds: number;
  /** 单独用键盘鼠标空闲判离开的开关；雷达打开时这一路停用，键鼠只当雷达的交叉证据。 */
  checkIdle: boolean;
  /** 键盘鼠标空闲多少分钟算离开；0 表示不看这个信号。 */
  idleMinutes: number;
  /** 用锁屏判定。关掉后完全忽略锁屏，只靠键鼠动静。 */
  checkLock: boolean;
  /** 空闲到阈值时看一眼前台窗口，命中名单就不判离开。 */
  checkForeground: boolean;
  /** 前台判定用的关键词，逗号分隔，匹配进程名或窗口标题。 */
  mediaKeywords: string;
  /** 空闲到阈值时拍两帧比较，屏幕在变就不判离开。 */
  checkScreen: boolean;
  /** 判为离开后推事件。 */
  notifyAway: boolean;
  /** 回到桌前之后推事件。 */
  notifyBack: boolean;
  /** 用毫米波雷达判定。装完要显式打开，没插硬件时打开只会一直报「没连上」。 */
  radarEnabled: boolean;
  /** 串口号；`auto` 表示每次连接时自己枚举 USB 串口。 */
  radarPort: string;
  /** 模块侧最大探测距离，0.1 m 单位；0 表示不动模块参数，只按下面那条过滤。 */
  radarMaxDistance: number;
  /** 软件侧上限：只有这么近的人才算「在桌前」，cm。同时用来发现模块参数被重置。 */
  radarMaxCm: number;
  /** 雷达连续多久没测到人算离开，秒。模块自己还有一段「目标消失延迟」。 */
  radarAbsentSeconds: number;
  /** 雷达连续测到人多久才撤销「离开」，秒；比这更短的当作路过。 */
  radarBackSeconds: number;
  /** 比上面那段时间还短的「有人」推一条路过事件。 */
  radarPassByNotify: boolean;
  /** 雷达报没人时，键鼠至少安静这么久才采信它，秒；0 表示完全听雷达的。 */
  radarQuietSeconds: number;
}

export const DEFAULT_IDLE_MINUTES = 10;
export const MAX_IDLE_MINUTES = 1440;

/** 默认认作「在看东西」的窗口关键词，都是视频与直播。 */
export const DEFAULT_MEDIA_KEYWORDS =
  'bilibili,哔哩哔哩,youtube,netflix,twitch,vlc,mpv,potplayer,mpc-hc,mpc-be,'
  + '爱奇艺,腾讯视频,优酷,芒果tv,抖音,douyin,斗鱼,虎牙,plex,emby,jellyfin';

/** 模块最大距离，0.1 m 单位：7 是 0.7 m，100 是 10 m。 */
export const MIN_RADAR_MAX_DISTANCE = 7;
export const MAX_RADAR_MAX_DISTANCE = 100;
export const DEFAULT_RADAR_MAX_DISTANCE = 14;

/** 软件侧上限，cm。默认 1.2 m，比模块那 1.4 m 再收一点，站着的人还在里面。 */
export const MIN_RADAR_MAX_CM = 30;
export const MAX_RADAR_MAX_CM = 1000;
export const DEFAULT_RADAR_MAX_CM = 120;

export const DEFAULT_RADAR_ABSENT_SECONDS = 5;
export const MAX_RADAR_ABSENT_SECONDS = 600;
/** 默认 10 秒：站一下、伸个手不算回来，只推一条「有人经过」。 */
export const DEFAULT_RADAR_BACK_SECONDS = 10;
export const MAX_RADAR_BACK_SECONDS = 120;
/**
 * 雷达说没人、但键鼠还热着时，多半是雷达漏检。
 *
 * 取 35 = 模块的目标消失延迟 30 + 上面的 radarAbsentSeconds 5：这样这条门槛正好相当于
 * 「最后一次输入晚于雷达最后一次看见你」，既不会给真实离开再加延迟，也不会把「刚敲完字就报没人」当真。
 * 比 35 短就形同虚设，比 35 长它自己就成了离开判定的瓶颈。
 */
export const DEFAULT_RADAR_QUIET_SECONDS = 35;
export const MAX_RADAR_QUIET_SECONDS = 3600;

export const ARE_YOU_THERE_DEFAULTS: AreYouThereConfigSection = {
  enabled: false,
  pollSeconds: DEFAULT_POLL_SECONDS,
  checkIdle: true,
  idleMinutes: DEFAULT_IDLE_MINUTES,
  checkLock: true,
  checkForeground: false,
  checkScreen: false,
  mediaKeywords: DEFAULT_MEDIA_KEYWORDS,
  notifyAway: true,
  notifyBack: true,
  radarEnabled: false,
  radarPort: 'auto',
  radarMaxDistance: DEFAULT_RADAR_MAX_DISTANCE,
  radarMaxCm: DEFAULT_RADAR_MAX_CM,
  radarAbsentSeconds: DEFAULT_RADAR_ABSENT_SECONDS,
  radarBackSeconds: DEFAULT_RADAR_BACK_SECONDS,
  radarPassByNotify: true,
  radarQuietSeconds: DEFAULT_RADAR_QUIET_SECONDS,
};

/** 串口号：空或 `auto` 都走自动枚举；写具体端口就照写。 */
export function radarPortName(cfg: AreYouThereConfigSection): string {
  const raw = typeof cfg.radarPort === 'string' ? cfg.radarPort.trim() : '';
  return raw === '' ? 'auto' : raw;
}

/** 夹在范围内的轮询间隔，秒；写坏了就退回默认值。 */
export function clampedPollSeconds(cfg: AreYouThereConfigSection): number {
  const raw = typeof cfg.pollSeconds === 'number' && Number.isFinite(cfg.pollSeconds)
    ? Math.round(cfg.pollSeconds)
    : DEFAULT_POLL_SECONDS;
  return Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, raw));
}

/** 空闲阈值，毫秒；0 表示不看空闲。 */
export function idleThresholdMs(cfg: AreYouThereConfigSection): number {
  const raw = typeof cfg.idleMinutes === 'number' && Number.isFinite(cfg.idleMinutes)
    ? Math.round(cfg.idleMinutes)
    : DEFAULT_IDLE_MINUTES;
  const minutes = Math.min(MAX_IDLE_MINUTES, Math.max(0, raw));
  return minutes * 60_000;
}

/** 设置页。每个键都在用的时候读，所以改完不用重启。 */
export function areYouThereConfigGroup(language: Language = 'zh'): ConfigGroup {
  const c = areYouThereText(language).config;
  const K = `worlds.${ARE_YOU_THERE_ID}`;
  return {
    id: `world:${ARE_YOU_THERE_ID}`,
    owner: `world:${ARE_YOU_THERE_ID}`,
    schema: {
      type: 'object',
      title: c.group,
      description: c.groupDescription,
      properties: {
        [`${K}.pollSeconds`]: {
          type: 'integer',
          title: c.pollSeconds.title,
          description: c.pollSeconds.description,
          minimum: MIN_POLL_SECONDS,
          maximum: MAX_POLL_SECONDS,
          'x-suffix': c.pollSeconds.suffix,
          'x-hot': true,
        },
        [`${K}.checkIdle`]: {
          type: 'boolean',
          title: c.checkIdle.title,
          description: c.checkIdle.description,
          'x-hot': true,
        },
        [`${K}.idleMinutes`]: {
          type: 'integer',
          title: c.idleMinutes.title,
          description: c.idleMinutes.description,
          minimum: 0,
          maximum: MAX_IDLE_MINUTES,
          'x-suffix': c.idleMinutes.suffix,
          'x-hot': true,
        },
        [`${K}.checkLock`]: {
          type: 'boolean',
          title: c.checkLock.title,
          description: c.checkLock.description,
          'x-hot': true,
        },
        [`${K}.radarEnabled`]: {
          type: 'boolean',
          title: c.radarEnabled.title,
          description: c.radarEnabled.description,
          'x-hot': true,
        },
        [`${K}.notifyAway`]: {
          type: 'boolean',
          title: c.notifyAway.title,
          description: c.notifyAway.description,
          'x-hot': true,
        },
        [`${K}.notifyBack`]: {
          type: 'boolean',
          title: c.notifyBack.title,
          description: c.notifyBack.description,
          'x-hot': true,
        },
      },
    },
  };
}

