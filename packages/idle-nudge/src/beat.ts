/**
 * 静默心跳的判据：纯函数，不碰磁盘、不碰宿主。
 *
 * 沿用 cache-keepalive 的判据（同一台机器上量过：LongCat-2.5 缓存约 75 分钟过期）。
 * 只有一处不同：这里没有夜间窗口——心跳全天生效，夜间不推的是小纸条（见 note.ts）。
 *
 * 这一拍推的是"不要求回应"的静默事件，目的是让前缀缓存续期。
 */
export const MIN_IDLE_MINUTES = 1;
export const MAX_IDLE_MINUTES = 1440;
export const DEFAULT_IDLE_MINUTES = 40;

/** LongCat-2.5 实测：73 分钟还命中、78 分钟整份重来。换模型别照抄。 */
export const LONGCAT_TTL_MINUTES = 75;

export const MIN_TICK_SECONDS = 5;
export const MAX_TICK_SECONDS = 300;
export const DEFAULT_TICK_SECONDS = 15;

export const DEFAULT_MAX_PER_DAY = 48;
export const MAX_MAX_PER_DAY = 240;

export const DEFAULT_TEMPLATE_ZH = '静默心跳{time}，无需回复。';
export const DEFAULT_TEMPLATE_EN = '(Silent heartbeat at {time}. No reply needed.)';

export interface BeatPolicy {
  /** 距上一次模型调用超过这么多分钟才补一拍。 */
  idleMinutes: number;
  /** 一天最多补几拍；0 = 不限。 */
  maxPerDay: number;
}

export interface BeatFacts {
  now: number;
  /** 上一次模型调用的时刻；null = 读不到 usage 账（当作很久没调用）。 */
  lastCallAt: number | null;
  /** 上一次由心跳推的时刻；null = 还没推过。内存值，重启就忘。 */
  lastBeatAt: number | null;
  pushedToday: number;
}

export type BeatDecision =
  | { fire: true; gapMinutes: number }
  | { fire: false; note: string };

export function minutesOf(ms: number): number {
  if (!Number.isFinite(ms)) return -1;
  return Math.max(0, Math.round(ms / 60_000));
}

export function clampIdleMinutes(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : DEFAULT_IDLE_MINUTES;
  return Math.min(MAX_IDLE_MINUTES, Math.max(MIN_IDLE_MINUTES, n));
}

export function clampTickSeconds(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : DEFAULT_TICK_SECONDS;
  return Math.min(MAX_TICK_SECONDS, Math.max(MIN_TICK_SECONDS, n));
}

export function clampMaxPerDay(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : DEFAULT_MAX_PER_DAY;
  return Math.min(MAX_MAX_PER_DAY, Math.max(0, n));
}

/**
 * 心跳推不推。顺序有讲究：先看上一拍刚推过（自己不能把自己催起来），
 * 再看空档够不够长，最后看名额。每条都留一句话给设置页显示。
 */
export function decideBeat(facts: BeatFacts, policy: BeatPolicy): BeatDecision {
  const afterMs = clampIdleMinutes(policy.idleMinutes) * 60_000;

  if (facts.lastBeatAt !== null && facts.now - facts.lastBeatAt < afterMs) {
    return { fire: false, note: `上一拍刚推过（${minutesOf(facts.now - facts.lastBeatAt)} 分钟前）` };
  }

  const gapMs = facts.lastCallAt === null ? Number.POSITIVE_INFINITY : facts.now - facts.lastCallAt;
  if (gapMs < afterMs) {
    return { fire: false, note: `距上次调用 ${minutesOf(gapMs)} 分钟，还没到 ${clampIdleMinutes(policy.idleMinutes)}` };
  }

  const cap = clampMaxPerDay(policy.maxPerDay);
  if (cap > 0 && facts.pushedToday >= cap) {
    return { fire: false, note: `今天已经补了 ${facts.pushedToday} 拍（上限 ${cap}）` };
  }

  return { fire: true, gapMinutes: minutesOf(gapMs) };
}

/** 正文模板：{time} 换成当前时刻。留空退回默认。 */
export function renderHeartbeat(template: unknown, clock: string, fallback: string): string {
  const text = typeof template === 'string' && template.trim() !== '' ? template : fallback;
  return text.replace(/\{time\}/g, clock);
}

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

export function localHour(timeZone: string, at: number): number {
  const clock = formatClock(timeZone, at);
  const hh = Number(clock.slice(0, 2));
  return Number.isInteger(hh) ? hh : new Date(at).getHours();
}

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

/**
 * 本地"当天第几分钟"，0–1439。纸条的时段窗口按这个判，和时区设置一致。
 */
export function localMinuteOfDay(timeZone: string, at: number): number {
  const clock = formatClock(timeZone, at);
  const hh = Number(clock.slice(0, 2));
  const mm = Number(clock.slice(3, 5));
  return (Number.isInteger(hh) ? hh : 0) * 60 + (Number.isInteger(mm) ? mm : 0);
}
