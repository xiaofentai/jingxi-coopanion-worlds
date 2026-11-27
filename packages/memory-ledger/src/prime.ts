/**
 * 预激活：对方说了话之后，替她把相关的旧事递到眼前。
 *
 * 和 `ml_recall` 的区别只有一句：**触发权在插件手里，不在她手里**。
 * 提示词管不住动作（见交接 §0.9），所以「她会不会想起来查」这件事不能靠提示词，
 * 只能靠别人在她耳边说一句「以前记过这个」。
 *
 * 三条自我约束，缺一条就会变成噪音：
 *  - 只递「对得上」（strong）的，沾边的一律不递；
 *  - 一次最多两条；
 *  - 同一块两小时内不重复。
 */
import type { RecallHit } from './recall.ts';

/** 一次最多推几条。多了就等于换了个前缀，不做。 */
export const PRIME_LIMIT = 2;

/** 同一块推过之后多久之内不再推。重复的东西会让她以为刚才发生过。 */
export const PRIME_COOLDOWN_MS = 2 * 3600_000;

/** 一天最多推几次（配置的默认值）。预算是最后一道闸，前面还有说话/强命中/冷却三道。 */
export const PRIME_PER_DAY = 20;

/**
 * 今天的名额还没用完吗。`cap <= 0` 表示不限。
 *
 * 为什么是预算不是概率：概率每轮独立，聊五十句期望五次，你没法预测今天被打扰几回；
 * 预算可数、可解释、可调。真要「补漏比例」，也该是自适应的（按她最近的查询率反向定），
 * 而不是摇骰子。
 */
export function withinDailyBudget(pushedToday: number, cap: number): boolean {
  return cap <= 0 || pushedToday < cap;
}

/** 每行留多少字。 */
const LINE_MAX = 60;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 只要「对得上」的，按分数取前几条。 */
export function primeHits(hits: readonly RecallHit[], limit = PRIME_LIMIT): RecallHit[] {
  const max = Math.max(0, limit);
  return hits.filter((hit) => hit.tier === 'strong').slice(0, max);
}

/** 一块的身份：文件和句柄。冷却按这个键算。 */
export function primeKey(hit: RecallHit): string {
  return `${hit.file}\u0000${hit.handle}`;
}

/** 去掉还在冷却里的那些。 */
export function coolEnough(
  lastAt: ReadonlyMap<string, number>,
  hits: readonly RecallHit[],
  now: number,
  cooldownMs = PRIME_COOLDOWN_MS,
): RecallHit[] {
  return hits.filter((hit) => {
    const at = lastAt.get(primeKey(hit));
    return at === undefined || now - at > cooldownMs;
  });
}

/**
 * 推出去的那段话。
 *
 * 第一行要交代三件事，缺一件就会出岔子：
 *  - **不是他刚说的**：否则她会把想起来的当成刚听到的（memory-core 也踩过这个）；
 *  - **不用回**：这条是系统递的，不是他发的消息，回了就变成自言自语；
 *  - **要说话就走原来的通道**：她看不到“从哪来”，会直接输出纯文本，而桌宠里打字他看不见。
 */
export function primeText(hits: readonly RecallHit[]): string {
  if (!hits.length) return '';
  const lines = hits.map((hit) => `· ${hit.handle}（${hit.file.replace(/\.md$/, '')}）${clip(hit.text, LINE_MAX)}`);
  return [
    '（系统递的旧记忆：不是他刚说的，也不是他在问你话。**不用回这条。**',
    ...lines,
    '想看那天记了什么就自己 `ml_recall`；要用就用平时那条通道开口（微信 / 气泡）。）',
  ].join('\n');
}
