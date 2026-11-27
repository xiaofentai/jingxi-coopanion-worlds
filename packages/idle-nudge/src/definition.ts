import type { WorldDefinition } from 'cortico/world.ts';
import { IDLE_NUDGE_DEFAULTS, IDLE_NUDGE_ID, type IdleNudgeConfigSection } from './config.ts';
import { IdleNudgeWorld } from './world.ts';

export const IDLE_NUDGE: WorldDefinition<IdleNudgeConfigSection> = {
  id: IDLE_NUDGE_ID,
  label: 'Idle Nudge',
  defaults: () => ({ ...IDLE_NUDGE_DEFAULTS }),
  configOptions: () => [],
  create: (ctx: { cfg: IdleNudgeConfigSection; timezone: string; botDir: string; dataDir: string }) => new IdleNudgeWorld({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    botDir: ctx.botDir,
    dataDir: ctx.dataDir,
  }),
  describe: {
    // 一个工具都没有：它不该出现在候选里，也不该进工具表
    tools: [],
    events: [
      {
        type: `${IDLE_NUDGE_ID}.beat`,
        description: {
          zh: '空档变长时补的一拍静默心跳。正文写明了不是ta说的、不用回、不要调用工具；目的只是续上游缓存。',
          en: 'A silent heartbeat pushed after a quiet gap. The text says it is not from them, needs no reply and calls for no tools; it only keeps the prefix cache warm.',
        },
        trigger: 'flush',
      },
      {
        type: `${IDLE_NUDGE_ID}.note`,
        description: {
          zh: '小纸条：闲下来、落在设定时段时递的一句带动作的话。正文写明了不是ta说的、不用回；去不去做由她自己定。',
          en: 'A little note: a short actionable line pushed during a quiet, configured window. The text says it is not from them and needs no reply; whether to act is up to them.',
        },
        trigger: 'flush',
      },
      {
        type: `${IDLE_NUDGE_ID}.greeting`,
        description: {
          zh: '早晚安：到点后递一句「该道早安 / 晚安了」的由头。正文写明了不是ta说的、别回这条；措辞和走哪条通道由她自己定。',
          en: 'A greeting: a hint at a configured time that it is time to say good morning / night. The text says it is not from them and needs no reply; wording and channel are up to them.',
        },
        trigger: 'flush',
      },
    ],
  },
};

export { IDLE_NUDGE_ID, IDLE_NUDGE_DEFAULTS };
