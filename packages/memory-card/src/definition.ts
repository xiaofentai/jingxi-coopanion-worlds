import type { WorldDefinition } from 'cortico/world.ts';
import { MEMORY_CARD_DEFAULTS, MEMORY_CARD_ID, type MemoryCardConfigSection } from './config.ts';
import { MemoryCardWorld } from './world.ts';

export const MEMORY_CARD: WorldDefinition<MemoryCardConfigSection> = {
  id: MEMORY_CARD_ID,
  label: 'Memory card',
  defaults: () => ({ ...MEMORY_CARD_DEFAULTS }),
  configOptions: () => [],
  // `ctx.cfg` 是活的配置段；规则在 config.json 的 worlds.memory-card.settings 里，每次构建前缀时现读
  create: (ctx) => new MemoryCardWorld({
    cfg: ctx.cfg,
    botDir: ctx.botDir,
    dataDir: ctx.dataDir,
    timezone: ctx.timezone,
  }),
};
