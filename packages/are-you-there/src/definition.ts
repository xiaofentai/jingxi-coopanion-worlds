import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { ARE_YOU_THERE_DEFAULTS, ARE_YOU_THERE_ID, type AreYouThereConfigSection } from './config.ts';
import { areYouThereText } from './text.ts';
import { ARE_YOU_THERE_TOOL_DECLS, AreYouThereWorld } from './world.ts';

export const ARE_YOU_THERE: WorldDefinition<AreYouThereConfigSection> = {
  id: ARE_YOU_THERE_ID,
  label: 'Are you there',
  defaults: () => ({ ...ARE_YOU_THERE_DEFAULTS }),
  configOptions: () => [],
  // `ctx.cfg` 是活的配置段，间隔与开关每次使用时现读
  create: (ctx) => new AreYouThereWorld({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    botDir: ctx.botDir,
    dataDir: ctx.dataDir,
  }),
  describe: {
    tools: describeTools(ARE_YOU_THERE_TOOL_DECLS, {
      here_status: {
        zh: areYouThereText('zh').tool.description,
        en: areYouThereText('en').tool.description,
      },
    }),
    events: [
      {
        type: `${ARE_YOU_THERE_ID}.changed`,
        description: {
          zh: areYouThereText('zh').event.changed,
          en: areYouThereText('en').event.changed,
        },
        trigger: 'flush',
      },
    ],
  },
};
