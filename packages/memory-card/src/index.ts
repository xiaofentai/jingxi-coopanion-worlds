/** 包入口：加载器读默认导出。 */
import { MEMORY_CARD } from './definition.ts';

export default MEMORY_CARD;
export { MEMORY_CARD };
export { MEMORY_CARD_DEFAULTS, MEMORY_CARD_ID, RULE_SLOTS, memoryCardConfigGroup, rulesText, splitList } from './config.ts';
export type { MemoryCardConfigSection } from './config.ts';
export { MemoryCardWorld } from './world.ts';
export type { MemoryCardWorldOptions } from './world.ts';
export { buildCard, parseRules, splitBlocks } from './card.ts';
export type { CardInput, CardResult, LoadedFile, Rule, RuleMode } from './card.ts';
