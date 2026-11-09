/**
 * 状态机：把一次「判定过的读数」翻成「在桌前 / 不在」，并记下上一次离开的起止。
 *
 * 读数有两个来源：屏幕锁着，或键盘鼠标很久没动静。两者都只给出「不在」，原因记下来，
 * 回执和环境提示要能说清是怎么判的。
 *
 * 纯函数，不读时钟、不碰文件；`now` 由调用方给，测试才好写。
 */

/** 不在的原因：屏幕锁着，或键盘鼠标长时间没有输入。 */
export type AwayReason = 'lock' | 'idle';

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
  /** 判成不在：`reason` 说明是锁屏还是空闲。 */
  | { kind: 'away'; at: number; reason: AwayReason }
  /** 回来了，`awayMs` 是这次离开了多久。 */
  | { kind: 'back'; at: number; awayMs: number };

export const emptyPresence = (): PresenceState => ({ away: null, since: null, reason: null, lastAway: null });

/**
 * 合并两个信号：锁着就是不在，不用看空闲；解锁着但鼠标键盘久没动，也算不在。
 *
 * `idleThresholdMs` 为 0 表示不看空闲；`idleMs` 为 `null` 表示读不到，这时只信锁屏。
 */
export function decidePresence(locked: boolean, idleMs: number | null, idleThresholdMs: number): PresenceReading {
  if (locked) return { away: true, reason: 'lock' };
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
