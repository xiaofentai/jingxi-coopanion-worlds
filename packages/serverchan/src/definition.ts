import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { SERVERCHAN_DEFAULTS, SERVERCHAN_ID, serverChanConfigOptions, type ServerChanConfigSection } from './config.ts';
import { serverChanText } from './text.ts';
import { SERVERCHAN_TOOL_DECLS, ServerChanWorld } from './world.ts';

export const SERVERCHAN: WorldDefinition<ServerChanConfigSection> = {
  id: SERVERCHAN_ID,
  label: 'Server Chan',
  defaults: () => ({ ...SERVERCHAN_DEFAULTS }),
  configOptions: (kind, language) => serverChanConfigOptions(kind, language),
  // `ctx.cfg` 是活的配置段，Key 与通道每次使用时现读
  create: (ctx) => new ServerChanWorld({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    botDir: ctx.botDir,
    dataDir: ctx.dataDir,
  }),
  describe: {
    tools: describeTools(SERVERCHAN_TOOL_DECLS, {
      sc_send: {
        zh: serverChanText('zh').tool.describeSend,
        en: serverChanText('en').tool.describeSend,
      },
      sc_status: {
        zh: serverChanText('zh').tool.describeStatus,
        en: serverChanText('en').tool.describeStatus,
      },
    }),
  },
};
