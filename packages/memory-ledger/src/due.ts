/**
 * 算账：一份文件现在多大、哪几天出了窗口、到没到提醒线。
 *
 * 以前这是两份实现——出卡的「该整理的」和体检的清单各算一遍，而且已经漂过一次：
 * 出卡对**任何模式**都拿第 3 段当天数窗口，体检只在 `catalog` 下认。于是规则写成
 * `full|30|80` 时，卡尾会报「已第 N 天」，`ml_check` 一个字不说。
 *
 * 现在只有一个判据，两个地方都从这里取；各自的措辞和范围可以不同，
 * 但「算不算到期」必须只有一处定义。
 */
import type { Rule } from './board.ts';
import type { Block, Doc } from './parse.ts';

/** 用量到上限的这个比例就提醒（软限）：不拦写入，只报账。 */
export const SOFT_RATIO = 0.8;

/** 两个 `YYYY-MM-DD` 相差几天（`to` 减 `from`，UTC，不受时区影响）。 */
export function daysBetween(from: string, to: string): number {
  const at = Date.UTC(...(from.split('-').map(Number) as [number, number, number]));
  const bt = Date.UTC(...(to.split('-').map(Number) as [number, number, number]));
  return Math.round((bt - at) / 86_400_000);
}

/** 这一份现在有多少条。 */
export function entriesOf(doc: Doc): number {
  return doc.blocks.reduce((n, block) => n + block.entries.length, 0);
}

export interface Usage {
  unit: '条';
  value: number;
  cap: number;
}

/**
 * 用量：ledger 只管目录，所以只有条目数；字数提醒线是 memory-card 的事。
 * 第 4 段留空就是没有上限。
 */
export function usageOf(rule: Rule, doc: Doc): Usage | null {
  if (!(rule.maxChars > 0)) return null;
  return { unit: '条', value: entriesOf(doc), cap: rule.maxChars };
}

/** 到软限了没有。 */
export function overSoft(usage: Usage): boolean {
  return usage.value >= usage.cap * SOFT_RATIO;
}

/** 保留天数的窗口：**只有 `catalog` 的第 3 段是天数**，别的模式第 3 段不是这个意思。 */
export function windowOf(rule: Rule): number {
  if (rule.mode !== 'catalog') return 0;
  const days = Number.parseInt(rule.arg.trim(), 10);
  return Number.isFinite(days) && days > 0 ? days : 0;
}

/**
 * 这一块出窗口了没有：出了返回「第几天」（1 起），没出或这条规则不管窗口返回 null。
 *
 * **口径和提醒差一档，这是故意的**：
 *
 * - 「保留 4 天」= 第 5 天该搬（`age >= window`），**定时清理按这个走**；
 * - 这里给的是**提醒**，要慢一整天（`age > window`，第 6 天才说）——否则它每天 0 点后
 *   她一写第一条就喊，而清理要等到当晚才跑，看起来永远是提醒在催、清理跟不上。
 *
 * 也不能改成按块数判：第 5 个块什么时候出现，取决于她当天几点写第一条，深夜写就深夜催。
 */
export function overdueAge(block: Block, window: number, today: string): number | null {
  if (window <= 0 || block.kind !== 'day' || !block.date) return null;
  const age = daysBetween(block.date, today);
  return age > window ? age + 1 : null;
}


