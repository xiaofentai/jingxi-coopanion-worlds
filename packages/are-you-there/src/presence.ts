/**
 * 状态机：把确认过的锁屏读数翻成「在桌前 / 不在」，并记下上一次离开的起止。
 *
 * 纯函数，不读时钟、不碰文件；`now` 由调用方给，测试才好写。
 */

/** 一次离开：从哪里到哪里，都是 epoch ms。 */
export interface AwayRecord {
  from: number;
  to: number;
}

export interface PresenceState {
  /** 确认过的锁屏状态；`null` 表示启动后还没读到过。 */
  locked: boolean | null;
  /** 当前状态从什么时候开始；`null` 表示未知。 */
  since: number | null;
  /** 上一次「锁屏 → 解锁」的区间；从没离开过就是 `null`。 */
  lastAway: AwayRecord | null;
}

export type PresenceChange =
  /** 第一次读到状态：只记下来，不推事件，免得每次启动都喊一句。 */
  | { kind: 'first'; at: number }
  /** 锁上了：ta 离开电脑。 */
  | { kind: 'away'; at: number }
  /** 解锁了：ta 回来了，`awayMs` 是这次离开了多久。 */
  | { kind: 'back'; at: number; awayMs: number };

export const emptyPresence = (): PresenceState => ({ locked: null, since: null, lastAway: null });

/** 把一次确认过的读数并进状态；没有变化时原样返回。 */
export function applyLocked(
  prev: PresenceState,
  locked: boolean,
  now: number,
): { state: PresenceState; change: PresenceChange | null } {
  if (prev.locked === locked) return { state: prev, change: null };
  if (prev.locked === null) {
    return { state: { locked, since: now, lastAway: prev.lastAway }, change: { kind: 'first', at: now } };
  }
  if (locked) {
    return { state: { locked: true, since: now, lastAway: prev.lastAway }, change: { kind: 'away', at: now } };
  }
  // 时钟回拨或首次状态就在锁定中：`from` 退化到 `now`，时长为 0，别报负数
  const from = prev.since !== null && prev.since <= now ? prev.since : now;
  return {
    state: { locked: false, since: now, lastAway: { from, to: now } },
    change: { kind: 'back', at: now, awayMs: now - from },
  };
}
