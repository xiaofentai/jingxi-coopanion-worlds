/**
 * 小纸条的判据：纯函数，不碰磁盘、不碰宿主。
 *
 * 它和心跳完全分开——不看 usage 的 mtime（后台推多少信息都挡不住它），只看：
 *  1. 现在落在哪个启用的时段里；
 *  2. 那段今天还有没有名额；
 *  3. 当天的抖动点到了没有（窗口内随机一个时刻，不是一开门就推）；
 *  4. 距上一张纸条够不够久（跨段共用这一条，防止挨着推）。
 *
 * 抖动点由「日期 + 段号 + 第几张」哈希出来：同一天重启也不漂，隔天自动换。
 * 这样既不是整点机械触发，也不用落盘记随机种子。
 */
import type { NoteSlot } from './settings.ts';

/** "9" → 540；"14:30" → 870。空串 / 写坏 → null（这段不启用）。 */
export function parseClock(raw: string): number | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (!Number.isInteger(h) || h < 0 || h > 23) return null;
  if (!Number.isInteger(min) || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** 一段窗口在不在生效：两端都能解析、起点不等于终点、perDay > 0。 */
export function slotEnabled(slot: NoteSlot): boolean {
  return slot.perDay > 0 && parseClock(slot.from) !== null && parseClock(slot.to) !== null;
}

/** 当前分钟落在窗口内吗。窗口可跨零点（如 22-2）。 */
export function inWindow(minuteOfDay: number, from: number, to: number): boolean {
  if (from === to) return false;
  if (from < to) return minuteOfDay >= from && minuteOfDay < to;
  return minuteOfDay >= from || minuteOfDay < to;
}

/** 窗口长度（分钟），跨零点绕一圈。 */
export function windowSpan(from: number, to: number): number {
  return from < to ? to - from : 1440 - from + to;
}

/** 现在在窗口里走了多少分钟。调用前保证 inWindow 为真。 */
function elapsedInWindow(now: number, from: number, to: number): number {
  if (from < to) return now - from;
  return now >= from ? now - from : now + 1440 - from;
}

/** FNV-1a，32 位；用来把「日期|段号|第几张」定成一个当天稳定、跨天变化的数。 */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 当天这一段的第 attempt 张，落在窗口起点之后第几分钟。
 * 窗口按 perDay 均分成几份，每份里哈希取一个点——perDay=1 就是整段随机一个时刻；
 * perDay=2 就是前半段一个、后半段一个，不会两张挤在一起。
 */
export function jitterOffset(day: string, slotIndex: number, attempt: number, perDay: number, span: number): number {
  if (span <= 0 || perDay <= 0) return 0;
  const bucket = Math.max(1, Math.floor(span / perDay));
  const h = hash32(`${day}|${slotIndex}|${attempt}`);
  const within = Math.min(bucket - 1, h % bucket);
  // 每一张落在自己的那一份里，不会两张挤在同一个半段
  return Math.min(span - 1, attempt * bucket + within);
}

/** 把窗口起点 + 偏移换回当天的分钟数（可能跨零点，所以对 1440 取模）。 */
export function jitterMinute(from: number, offset: number): number {
  return (from + offset) % 1440;
}

export interface NoteFacts {
  /** 现在，毫秒；只用来算距上一张纸条多久。 */
  now: number;
  /** 本地当天第几分钟，0–1439。 */
  minuteOfDay: number;
  /** 本地日期 yyyy-mm-dd；哈希抖动点用，同一天重启也不漂。 */
  day: string;
  /** 上一张纸条推的时刻；null = 还没推过。内存值，重启就忘。 */
  lastNoteAt: number | null;
  /** 每段今天各推了几张。长度与 slots 一致，跨天清零。 */
  slotPushedToday: number[];
}

export interface NotePolicy {
  slots: NoteSlot[];
  /** 两张纸条之间至少隔多少分钟（跨段共用）。 */
  gapMinutes: number;
}

export type NoteDecision =
  | { fire: true; slot: number }
  | { fire: false; note: string };

/**
 * 纸条的判定。落在多个窗口时取第一个命中的段——所以默认三段不重叠；
 * 真写成重叠了也不会推两张，只是后一段永远轮不到。
 */
export function decideNote(facts: NoteFacts, policy: NotePolicy): NoteDecision {
  const hit = policy.slots.findIndex((slot) =>
    slotEnabled(slot)
    && inWindow(facts.minuteOfDay, parseClock(slot.from)!, parseClock(slot.to)!));

  if (hit < 0) {
    return { fire: false, note: '现在不在任何启用的纸条时段里' };
  }

  const slot = policy.slots[hit]!;
  const pushed = facts.slotPushedToday[hit] ?? 0;
  if (pushed >= slot.perDay) {
    return { fire: false, note: '这一段的名额今天用完了' };
  }

  const from = parseClock(slot.from)!;
  const to = parseClock(slot.to)!;
  const span = windowSpan(from, to);
  const target = jitterOffset(facts.day, hit, pushed, slot.perDay, span);
  const elapsed = elapsedInWindow(facts.minuteOfDay, from, to);
  if (elapsed < target) {
    const clock = jitterMinute(from, target);
    const hh = String(Math.floor(clock / 60)).padStart(2, '0');
    const mm = String(clock % 60).padStart(2, '0');
    return { fire: false, note: `今天的纸条约在 ${hh}:${mm}（窗口内抖了一下），还没到` };
  }

  const gapMs = policy.gapMinutes * 60_000;
  if (facts.lastNoteAt !== null && facts.now - facts.lastNoteAt < gapMs) {
    const left = Math.max(0, Math.round((gapMs - (facts.now - facts.lastNoteAt)) / 60_000));
    return { fire: false, note: `距上一张纸条还差 ${left} 分钟（间隔 ${policy.gapMinutes}）` };
  }

  return { fire: true, slot: hit };
}

/** 纸条正文：{time} 换成当前时刻。留空退回默认。 */
export function renderNote(template: unknown, clock: string, fallback: string): string {
  const text = typeof template === 'string' && template.trim() !== '' ? template : fallback;
  return text.replace(/\{time\}/g, clock);
}
