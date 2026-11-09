/**
 * 时长与时刻的人话，中文、英文两张表。纯函数，测试可以直接跑。
 */
import type { TextLanguage } from './text.ts';

const pad = (n: number): string => String(n).padStart(2, '0');

/** `MM-DD HH:MM`，按时区；时区写错就退回本机时间。 */
export function formatClock(timezone: string, ms: number): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(ms));
    const get = (kind: string) => parts.find((part) => part.type === kind)?.value ?? '';
    return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  } catch {
    const now = new Date(ms);
    return `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }
}

/** 一段时长：「26 分钟」「1 小时 12 分钟」「2 天 3 小时」。负值按 0 算。 */
export function formatDuration(ms: number, language: TextLanguage): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return language === 'zh' ? '不到一分钟' : 'under a minute';
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return language === 'zh' ? `${minutes} 分钟` : plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) {
    if (language === 'zh') return restMinutes ? `${hours} 小时 ${restMinutes} 分钟` : `${hours} 小时`;
    return restMinutes ? `${plural(hours, 'hour')} ${plural(restMinutes, 'minute')}` : plural(hours, 'hour');
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  if (language === 'zh') return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`;
  return restHours ? `${plural(days, 'day')} ${plural(restHours, 'hour')}` : plural(days, 'day');
}

/** 「17 分钟前」；不到一分钟说「刚刚」。 */
export function formatAgo(ms: number, language: TextLanguage): string {
  if (ms < 60_000) return language === 'zh' ? '刚刚' : 'just now';
  return language === 'zh' ? `${formatDuration(ms, 'zh')}前` : `${formatDuration(ms, 'en')} ago`;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}
