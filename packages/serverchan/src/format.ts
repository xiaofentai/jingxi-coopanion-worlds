/** 回执里的时刻：`MM-DD HH:MM`，按时区；时区写错就退回本机时间。纯函数。 */

const pad = (n: number): string => String(n).padStart(2, '0');

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
