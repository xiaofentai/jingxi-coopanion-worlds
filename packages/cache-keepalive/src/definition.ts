import type { WorldDefinition } from 'cortico/world.ts';
import { CACHE_KEEPALIVE_DEFAULTS, CACHE_KEEPALIVE_ID, type CacheKeepaliveConfigSection } from './config.ts';
import { CacheKeepaliveWorld } from './world.ts';

export const CACHE_KEEPALIVE: WorldDefinition<CacheKeepaliveConfigSection> = {
  id: CACHE_KEEPALIVE_ID,
  label: 'Cache Keepalive',
  defaults: () => ({ ...CACHE_KEEPALIVE_DEFAULTS }),
  configOptions: () => [],
  // `ctx.cfg` 是活的配置段：阈值、夜间窗口、日上限都在每一拍时现读，改完下一拍生效
  create: (ctx) => new CacheKeepaliveWorld({
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
        type: `${CACHE_KEEPALIVE_ID}.beat`,
        description: {
          zh: '空档变长时补的一拍静默心跳。正文明确写了「不是ta说的、不用回、不要调用工具」，'
            + '目的只是让上游的前缀缓存续期。',
          en: 'A silent heartbeat pushed when the context has been quiet for a while. The text says plainly that it is '
            + 'not from them, needs no reply and calls for no tools; its only job is to keep the upstream prefix cache warm.',
        },
        trigger: 'flush',
      },
    ],
  },
};
