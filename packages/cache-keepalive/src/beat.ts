/**
 * 补拍的判据：全是纯函数，不碰磁盘、不发事件，可以单独测。
 *
 * 为什么要有它：上游按「缓存命中」计价时，钱全花在两种调用上——
 * 缓存热着的时候只付新增的那几百 token，缓存过期之后要付整份前缀。
 * 一次过期 = 二十几万 token，抵得上一两千拍心跳。所以这里的每一行都在回答同一个问题：
 * **现在这一拍，值不值得推。**
 */

/** 距上次模型调用多少分钟内不补拍。上限放开到一天，但**超过 75 分钟就没有意义了**（见下）。 */
export const MIN_AFTER_MINUTES = 1;
export const MAX_AFTER_MINUTES = 1440;
export const DEFAULT_AFTER_MINUTES = 40;

/** 实测边界：73 分钟还命中、78 分钟整份重来。阈值贴着这个数走等于没有保温。 */
export const CACHE_TTL_MINUTES = 75;

/** 看表间隔，秒。只做一次 `statSync`，但没必要比这个更勤。 */
export const MIN_TICK_SECONDS = 5;
export const MAX_TICK_SECONDS = 300;
export const DEFAULT_TICK_SECONDS = 15;

/** 一天最多补几拍；0 表示不限。 */
export const DEFAULT_MAX_PER_DAY = 48;
export const MAX_MAX_PER_DAY = 240;

/** 心跳正文的默认模板；`{time}` 会换成当前时刻。 */
export const DEFAULT_TEMPLATE_ZH = '（静默心跳：现在是 {time}）';
export const DEFAULT_TEMPLATE_EN = '(Silent heartbeat: it is now {time})';

/** 夜间窗口，小时制，可以跨零点（`23-7`）。 */
export interface QuietWindow {
  from: number;
  to: number;
}

export interface BeatPolicy {
  /** 距上一次模型调用超过这么多分钟才补一拍。 */
  afterMinutes: number;
  /** 夜间不补拍的窗口；null 表示全天都补。 */
  quiet: QuietWindow | null;
  /** 一天最多补几拍；0 表示不限。 */
  maxPerDay: number;
}

export interface BeatFacts {
  /** 现在，毫秒。 */
  now: number;
  /** 上一次模型调用的时刻；null 表示读不到使用账（文件还不存在）。 */
  lastCallAt: number | null;
  /** 上一次由本插件推的时刻；null 表示还没推过。内存里的值，重启就忘。 */
  lastBeatAt: number | null;
  /** 今天已经补了几拍。 */
  pushedToday: number;
  /** 本地小时，0–23。 */
  hour: number;
}

export type BeatDecision =
  | { fire: true; gapMinutes: number }
  | { fire: false; note: string };

/** 分钟数取整；空档很长时也只报个整数，回执里够用。 */
export function minutesOf(ms: number): number {
  if (!Number.isFinite(ms)) return -1;
  return Math.max(0, Math.round(ms / 60_000));
}

/** 夹在范围内的阈值，分钟；写坏了就退回默认值。 */
export function clampAfterMinutes(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : DEFAULT_AFTER_MINUTES;
  return Math.min(MAX_AFTER_MINUTES, Math.max(MIN_AFTER_MINUTES, n));
}

/** 看表间隔，秒。 */
export function clampTickSeconds(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : DEFAULT_TICK_SECONDS;
  return Math.min(MAX_TICK_SECONDS, Math.max(MIN_TICK_SECONDS, n));
}

/** 日上限；0 表示不限。 */
export function clampMaxPerDay(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : DEFAULT_MAX_PER_DAY;
  return Math.min(MAX_MAX_PER_DAY, Math.max(0, n));
}

/**
 * 解析夜间窗口。空串 = 全天都补（**默认**，因为省的钱全在夜里那几个小时）；
 * `2-7` = 02:00 起 07:00 前不补。写坏了当空串，宁可多推一拍，也别因为手滑把整个功能关掉。
 */
export function parseQuietHours(raw: unknown): QuietWindow | null {
  if (typeof raw !== 'string') return null;
  const m = /^\s*(\d{1,2})\s*[-–~]\s*(\d{1,2})\s*$/.exec(raw);
  if (m === null) return null;
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  if (from < 0 || from > 23 || to < 0 || to > 23) return null;
  // 起止相同等于「没有窗口」，别解释成「一整天都不补」
  if (from === to) return null;
  return { from, to };
}

/** 当前小时在不在窗口里；窗口可跨零点。 */
export function inQuietWindow(hour: number, window: QuietWindow | null): boolean {
  if (window === null) return false;
  if (window.from < window.to) return hour >= window.from && hour < window.to;
  return hour >= window.from || hour < window.to;
}

/**
 * 这一拍推不推。顺序是有讲究的：先看上一拍刚推过（避免自己把自己催起来），
 * 再看空档够不够长，最后看名额——每一条都留一句话，设置页直接显示它，
 * 不然「没推」到底卡在哪一步只能猜。
 */
export function decideBeat(facts: BeatFacts, policy: BeatPolicy): BeatDecision {
  const afterMs = clampAfterMinutes(policy.afterMinutes) * 60_000;

  if (facts.lastBeatAt !== null && facts.now - facts.lastBeatAt < afterMs) {
    return { fire: false, note: `上一拍刚推过（${minutesOf(facts.now - facts.lastBeatAt)} 分钟前）` };
  }

  const gapMs = facts.lastCallAt === null ? Number.POSITIVE_INFINITY : facts.now - facts.lastCallAt;
  if (gapMs < afterMs) {
    return { fire: false, note: `距上次调用 ${minutesOf(gapMs)} 分钟，还没到 ${clampAfterMinutes(policy.afterMinutes)}` };
  }

  if (policy.quiet !== null && inQuietWindow(facts.hour, policy.quiet)) {
    return { fire: false, note: `夜里 ${policy.quiet.from}–${policy.quiet.to} 点不补拍` };
  }

  const cap = clampMaxPerDay(policy.maxPerDay);
  if (cap > 0 && facts.pushedToday >= cap) {
    return { fire: false, note: `今天已经补了 ${facts.pushedToday} 拍（上限 ${cap}）` };
  }

  return { fire: true, gapMinutes: minutesOf(gapMs) };
}

/**
 * 渲染心跳正文：把模板里的 `{time}` 换成当前时刻。
 *
 * 模板为空或全是空白时退回默认那一句——空正文会被宿主当成空消息，
 * 那一拍就白付了整份前缀，还什么都没送到。
 */
export function renderHeartbeat(template: unknown, clock: string, fallback: string): string {
  const text = typeof template === 'string' && template.trim() !== '' ? template : fallback;
  return text.replace(/\{time\}/g, clock);
}

/** 本地时刻 HH:MM；时区用部署里的那个。 */
export function formatClock(timeZone: string, at: number): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(at));
  } catch {
    const d = new Date(at);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
}

/** 本地小时 0–23；时区解析失败时退回进程本地时区。 */
export function localHour(timeZone: string, at: number): number {
  const clock = formatClock(timeZone, at);
  const hh = Number(clock.slice(0, 2));
  return Number.isInteger(hh) ? hh : new Date(at).getHours();
}

/** 本地日期 yyyy-mm-dd，用来给「今天补了几拍」翻页。 */
export function localDay(timeZone: string, at: number): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(at));
  } catch {
    const d = new Date(at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}
