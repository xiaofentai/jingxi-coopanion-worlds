/**
 * 早晚安的判据：纯函数，不碰磁盘、不碰宿主。
 *
 * 和小纸条共用一套哈希抖动（同一天同一条稳定、隔天换），只是窗口的形状不同：
 * 纸条是「一段区间里挑一个时刻」，问候是「一个点 ± 幅度里挑一个时刻」。
 *
 * 每条一天一次。时刻留空＝不启用；幅度是双向的（默认 ±20 分，可改）。
 */
import type { GreetingSlot } from './settings.ts';
import { hashOffset, jitterMinute, parseClock } from './note.ts';

export interface GreetingFacts {
  /** 现在，毫秒；用来算「目标过了多久」。 */
  now: number;
  /** 本地当天第几分钟，0–1439。 */
  minuteOfDay: number;
  /** 本地日期 yyyy-mm-dd；哈希种子。 */
  day: string;
  /** 两条今天各推过没有。 */
  sentToday: boolean[];
}

export interface GreetingPolicy {
  slots: GreetingSlot[];
}

export type GreetingDecision =
  | { fire: true; slot: number; label: '早安' | '晚安' }
  | { fire: false; note: string };

const LABELS = ['早安', '晚安'] as const;

/** 一条问候启不启用：时刻能解析就算启用（幅度 0 = 整点，也允许）。 */
export function greetingEnabled(slot: GreetingSlot): boolean {
  return parseClock(slot.time) !== null;
}

/**
 * 当天这一条的目标时刻（当天第几分钟）。
 * 把「点 ± 幅度」摊成一段 2*jitter+1 分钟的窗口，再在这段里哈希挑一个点。
 */
export function greetingTarget(day: string, index: number, slot: GreetingSlot): number {
  const center = parseClock(slot.time)!;
  const jitter = Math.max(0, Math.min(240, slot.jitter));
  const span = jitter * 2 + 1;
  const from = (center - jitter + 1440) % 1440;
  const offset = hashOffset(day, 200 + index, 0, 1, span);
  return jitterMinute(from, offset);
}

/** `455` → `07:35`，只给「现状」卡的文案用。 */
function clockOf(minute: number): string {
  const hh = String(Math.floor(minute / 60)).padStart(2, '0');
  const mm = String(minute % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 一条已算出目标和差值的候选。`delta` ＝ 目标 − 现在（同一天，正数＝还没到）。 */
interface Candidate {
  index: number;
  target: number;
  delta: number;
}

/**
 * 问候推不推。顺序：开关→启用→今天推过没→目标到了没。
 *
 * 「目标过了很久」不再补：窗口起点之后超过 60 分钟就当错过，等明天。
 * 否则半夜会被补一条昨晚的晚安。
 *
 * **两条都要过一遍**，不能只拿第一条「启用且没发过」的去判：早安没发出去（早上没开机、
 * 中午才打开问候、那次推送失败）时，晚安会被它一直挡着——22:30 报的是「早安还有 545 分钟」。
 * 所以这里逐条算：命中窗口的推一条（最先到点的那个），都没命中再挑「今天稍晚」的报时间。
 *
 * **差值用「同一天」的原始差，不做 ±720 归一化**：归一化会把「今天 23:45 的晚安」在 00:00
 * 看成「15 分钟前」，于是跨日第一拍又补一条（11-26 00:00:09 实测：23:12 推过一条，
 * 00:00:09 同一次运行里又推了一条）。目标本来就取模在 0–1439，原始差够用：
 * 正数＝今天还没到，0 到 -grace＝正落在窗口里，更早＝今天错过。
 * 代价：目标点落在 00:0x（把问候填到午夜前后、抖动跨了零点）的那天不补，等明天按新日期的
 * 目标走——只有把时刻填到 23:5x 附近才会碰到。
 */
export function decideGreeting(facts: GreetingFacts, policy: GreetingPolicy): GreetingDecision {
  const pending = policy.slots
    .map((slot, index) => ({ slot, index }))
    .filter(({ slot, index }) => greetingEnabled(slot) && !facts.sentToday[index]);
  if (pending.length === 0) {
    const enabled = policy.slots
      .map((slot, index) => ({ slot, index }))
      .filter(({ slot }) => greetingEnabled(slot));
    if (enabled.length === 0) return { fire: false, note: '没填问候时刻，不启用' };
    if (enabled.length === 1) {
      return { fire: false, note: `今天的${LABELS[enabled[0]!.index]}已经发过了，等明天` };
    }
    return { fire: false, note: '今天两条问候都发过了' };
  }

  let due: Candidate | null = null;
  let upcoming: Candidate | null = null;

  for (const { slot, index } of pending) {
    const target = greetingTarget(facts.day, index, slot);
    const delta = target - facts.minuteOfDay;
    const grace = Math.max(0, slot.jitter) + 60;
    if (delta <= 0 && delta >= -grace) {
      if (due === null || delta < due.delta) due = { index, target, delta };
      continue;
    }
    if (delta > 0 && (upcoming === null || delta < upcoming.delta)) {
      upcoming = { index, target, delta };
    }
  }

  if (due !== null) return { fire: true, slot: due.index, label: LABELS[due.index] ?? '早安' };
  if (upcoming !== null) {
    const jitter = policy.slots[upcoming.index]?.jitter ?? 0;
    return {
      fire: false,
      note: `今天的${LABELS[upcoming.index]}约在 ${clockOf(upcoming.target)}`
        + `（±${jitter} 分内抖了一下），还有 ${upcoming.delta} 分钟`,
    };
  }
  const missed = pending.length === 1
    ? `今天的${LABELS[pending[0]!.index]}窗口已过，等明天`
    : '今天的问候窗口都过了，等明天';
  return { fire: false, note: missed };
}

/**
 * 问候正文是固定由头，不给用户填、也不替她写话：把「该道早安/晚安了」这件事递到眼前，
 * 措辞由她自己想。不绑定任何具体通道 World——哪个 World 提供开口的通道就用哪个。
 */
export const GREETING_HINT =
  '（系统给的由头，不是 ta 刚说的话。）现在{time}，该道{who}了——用你自己的话跟 ta 说一句，走你平时开口的通道。别回这条、别解释。';

/** 正文：{time} 换时刻，{who} 换「早安 / 晚安」。 */
export function renderGreeting(clock: string, who: string): string {
  return GREETING_HINT.replace(/\{time\}/g, clock).replace(/\{who\}/g, who);
}
