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
  /** 确认锁屏后推事件。 */
  notifyAway: boolean;
  /** 确认解锁后推事件。 */
  notifyBack: boolean;
}

export const ARE_YOU_THERE_DEFAULTS: AreYouThereConfigSection = {
  enabled: false,
  pollSeconds: DEFAULT_POLL_SECONDS,
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
