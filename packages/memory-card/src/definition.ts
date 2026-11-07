import type { WorldDefinition } from 'cortico/world.ts';
import { MEMORY_CARD_DEFAULTS, MEMORY_CARD_ID, type MemoryCardConfigSection } from './config.ts';
import { MemoryCardWorld } from './world.ts';

export const MEMORY_CARD: WorldDefinition<MemoryCardConfigSection> = {
  id: MEMORY_CARD_ID,
  label: 'Memory card',
  defaults: () => ({ ...MEMORY_CARD_DEFAULTS }),
  configOptions: () => [],
  // `ctx.cfg` 是活的配置段，规则与目录每次构建前缀时现读
  create: (ctx) => new MemoryCardWorld({ cfg: ctx.cfg, botDir: ctx.botDir, timezone: ctx.timezone }),
};
