/**
 * 状态机：把一次「判定过的读数」翻成「在桌前 / 不在」，并记下上一次离开的起止。
 *
 * 读数有三个来源：屏幕锁着、毫米波雷达稳定报「桌前没人」、键盘鼠标很久没动静。前两个是强证据，
 * 各自单独成立就够；键鼠空闲是弱证据，只在雷达没表态时才用。原因记下来，回执和环境提示要能
 * 说清是怎么判的。
 *
 * 纯函数，不读时钟、不碰文件；`now` 由调用方给，测试才好写。
 */
import type { RadarDecision } from './radar.ts';

/** 不在的原因：屏幕锁着、雷达没测到人，或键盘鼠标长时间没有输入。 */
export type AwayReason = 'lock' | 'idle' | 'radar';

export interface PresenceReading {
  away: boolean;
  /** `away` 为真时必有值。 */
  reason: AwayReason | null;
}

/** 一次离开：从哪里到哪里，都是 epoch ms。 */
export interface AwayRecord {
  from: number;
  to: number;
}

export interface PresenceState {
  /** 确认过的状态；`null` 表示启动后还没读到过。 */
  away: boolean | null;
  /** 当前状态从什么时候开始；`null` 表示未知。 */
  since: number | null;
  /** 当前「不在」的原因，在桌前时为 `null`。 */
  reason: AwayReason | null;
  /** 上一次「离开 → 回来」的区间；从没离开过就是 `null`。 */
  lastAway: AwayRecord | null;
}

export type PresenceChange =
  /** 第一次读到状态：只记下来，不推事件，免得每次启动都喊一句。 */
  | { kind: 'first'; at: number }
  /** 判成不在：`reason` 说明是锁屏、雷达还是空闲。 */
  | { kind: 'away'; at: number; reason: AwayReason }
  /** 回来了，`awayMs` 是这次离开了多久。 */
  | { kind: 'back'; at: number; awayMs: number };

export const emptyPresence = (): PresenceState => ({ away: null, since: null, reason: null, lastAway: null });

/**
 * 合并几个信号，顺序是有讲究的：
 *
 * 1. 锁着就是不在，后面一律不看——锁屏是最硬的证据。
 * 2. 雷达稳定报「桌前没人」就是不在。它比键鼠空闲硬：人走了但刚敲过键盘，键鼠要等十分钟。
 *    但雷达会漏检——人坐着没动、遮挡物挡了一下、微动门限偏高——所以键鼠刚动过时不采信它：
 *    手在键盘上就是人在，这条比雷达硬。`quietMs` 就是这个宽限期。
 * 3. 雷达稳定报「有人」就当作在桌前，键鼠空闲不再算数——这正是雷达要补的那个洞（读书、看纸质
 *    材料、用手柄）。但雷达「有人」只说明人在探测范围内，不说明在看屏幕。
 * 4. 雷达没表态（没开、没连上、刚连上还没见到人）才轮到键鼠空闲。
 *
 * `idleThresholdMs` 为 0 表示不看空闲；`idleMs` 为 `null` 表示读不到。`radar` 为 `null` 表示
 * 雷达不可用或还没到能下结论的程度，一律当作「没表态」。
 */
export function decidePresence(
  locked: boolean,
  idleMs: number | null,
  idleThresholdMs: number,
  radar: RadarDecision | null = null,
  radarQuietMs = 0,
): PresenceReading {
  if (locked) return { away: true, reason: 'lock' };
  if (radar !== null && radar.absent) {
    // 键鼠还热着，雷达说没人多半是漏检；读不到空闲时只能信雷达
    if (radarQuietMs > 0 && idleMs !== null && idleMs < radarQuietMs) return { away: false, reason: null };
    return { away: true, reason: 'radar' };
  }
  if (radar !== null && radar.present) return { away: false, reason: null };
  if (idleThresholdMs > 0 && idleMs !== null && idleMs >= idleThresholdMs) return { away: true, reason: 'idle' };
  return { away: false, reason: null };
}

/** 把一次确认过的读数并进状态；没有变化时原样返回。 */
export function applyReading(
  prev: PresenceState,
  reading: PresenceReading,
  now: number,
): { state: PresenceState; change: PresenceChange | null } {
  if (prev.away === reading.away) {
    // 还在不在状态没变，但离开的原因可能换了（空闲 → 锁屏），记下来让文案跟得上
    if (reading.away && reading.reason !== null && reading.reason !== prev.reason) {
      return { state: { ...prev, reason: reading.reason }, change: null };
    }
    return { state: prev, change: null };
  }
  if (prev.away === null) {
    return {
      state: { away: reading.away, since: now, reason: reading.reason, lastAway: prev.lastAway },
      change: { kind: 'first', at: now },
    };
  }
  if (reading.away) {
    return {
      state: { away: true, since: now, reason: reading.reason, lastAway: prev.lastAway },
      change: { kind: 'away', at: now, reason: reading.reason ?? 'lock' },
    };
  }
  // 时钟回拨或首次状态就在离开中：`from` 退化到 `now`，时长为 0，别报负数
  const from = prev.since !== null && prev.since <= now ? prev.since : now;
  return {
    state: { away: false, since: now, reason: null, lastAway: { from, to: now } },
    change: { kind: 'back', at: now, awayMs: now - from },
  };
}
