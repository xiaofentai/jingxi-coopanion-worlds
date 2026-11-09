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
}

export const DEFAULT_IDLE_MINUTES = 10;
export const MAX_IDLE_MINUTES = 1440;

/** 默认认作「在看东西」的窗口关键词，都是视频与直播。 */
export const DEFAULT_MEDIA_KEYWORDS =
  'bilibili,哔哩哔哩,youtube,netflix,twitch,vlc,mpv,potplayer,mpc-hc,mpc-be,'
  + '爱奇艺,腾讯视频,优酷,芒果tv,抖音,douyin,斗鱼,虎牙,plex,emby,jellyfin';

export const ARE_YOU_THERE_DEFAULTS: AreYouThereConfigSection = {
  enabled: false,
  pollSeconds: DEFAULT_POLL_SECONDS,
  idleMinutes: DEFAULT_IDLE_MINUTES,
  checkLock: true,
  checkForeground: true,
  checkScreen: true,
  mediaKeywords: DEFAULT_MEDIA_KEYWORDS,
  notifyAway: true,
  notifyBack: true,
};

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
        [`${K}.checkForeground`]: {
          type: 'boolean',
          title: c.checkForeground.title,
          description: c.checkForeground.description,
          'x-hot': true,
        },
        [`${K}.mediaKeywords`]: {
          type: 'string',
          title: c.mediaKeywords.title,
          description: c.mediaKeywords.description,
          'x-hot': true,
        },
        [`${K}.checkScreen`]: {
          type: 'boolean',
          title: c.checkScreen.title,
          description: c.checkScreen.description,
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
