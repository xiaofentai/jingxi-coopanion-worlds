/** 配置段 `worlds.idle-nudge`。开关在 config.json 的这一层；其余参数在 settings 段（见 settings.ts）。 */
export const IDLE_NUDGE_ID = 'idle-nudge';

/**
 * 宿主传进来的只有开关；所有判据参数都从 settings 段现读。
 * 这里不 extends WorldSection：vendor/cortico 没 checkout 时那个类型不存在，
 * 而本包真正需要的只有 enabled 一个字段，写死反而让类型检查能跑。
 */
export interface IdleNudgeConfigSection {
  enabled: boolean;
  [key: string]: unknown;
}

export const IDLE_NUDGE_DEFAULTS: IdleNudgeConfigSection = {
  enabled: false,
};

/** 配置页的 schema 形状（宿主侧的 ConfigGroup 类型在 vendor 里，这里只写用到的字段）。 */
export interface ConfigGroupLike {
  id: string;
  owner: string;
  schema: Record<string, unknown>;
}

/** 配置页只留一个开关，别的一律去「设置」页。 */
export function idleNudgeConfigGroup(): ConfigGroupLike {
  return {
    id: `world:${IDLE_NUDGE_ID}`,
    owner: `world:${IDLE_NUDGE_ID}`,
    schema: {
      type: 'object',
      title: '小纸条',
      description: '闲下来时按节奏推一条事件：静默心跳续缓存，或小纸条递一句带动作的话。参数在「设置」页。',
      properties: {},
    },
  };
}
