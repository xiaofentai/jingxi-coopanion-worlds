/**
 * `<data>/serverchan.json`：上一次推送的结果与本地计数。
 *
 * 整份写进临时文件再改名，崩溃后要么是旧记录、要么是新记录。计数只报「本地成功发出去多少条」，
 * 不假装知道服务端还剩多少额度——那是 Server酱 后台的事。
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Channel } from './channel.ts';

/** 放在 `ctx.dataDir` 里，以 World id 开头，不会和别的 World 撞。 */
export const STATE_FILE = 'serverchan.json';

export interface LastSend {
  at: number;
  ok: boolean;
  channel: Channel;
  title: string;
  /** 正文的短哈希，用来认「60 秒内一模一样的一条」。 */
  hash: string;
  /** 失败原因（已经渲染成人话）；成功是 null。 */
  error: string | null;
}

export interface ServerChanState {
  last: LastSend | null;
  /** 本地日期 `YYYY-MM-DD`，换了日子就把 `today` 归零。 */
  day: string;
  /** 这一天成功发出多少条。 */
  today: number;
  /** 累计成功发出多少条。 */
  total: number;
}

export function emptyState(): ServerChanState {
  return { last: null, day: '', today: 0, total: 0 };
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isChannel = (value: unknown): value is Channel => value === 'turbo' || value === 'sc3';

function lastSend(value: unknown): LastSend | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (!isNumber(raw.at) || typeof raw.title !== 'string' || !isChannel(raw.channel)) return null;
  return {
    at: raw.at,
    ok: raw.ok === true,
    channel: raw.channel,
    title: raw.title,
    hash: typeof raw.hash === 'string' ? raw.hash : '',
    error: typeof raw.error === 'string' ? raw.error : null,
  };
}

export function readState(file: string): ServerChanState {
  if (!existsSync(file)) return emptyState();
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    console.warn('[serverchan] could not read the record', file, error);
    return emptyState();
  }
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    return {
      last: lastSend(raw.last),
      day: typeof raw.day === 'string' ? raw.day : '',
      today: isNumber(raw.today) ? Math.max(0, Math.round(raw.today)) : 0,
      total: isNumber(raw.total) ? Math.max(0, Math.round(raw.total)) : 0,
    };
  } catch (error) {
    console.warn('[serverchan] unreadable record, keeping it as .bad', file, error);
    try {
      renameSync(file, `${file}.bad`);
    } catch {
      // 下一次保存会写一份新的
    }
    return emptyState();
  }
}

export function writeState(file: string, state: ServerChanState): void {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/** 本地日期，按时区；时区写错就退回 UTC。 */
export function dayKey(timezone: string, at: number): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

/** 这一天已经成功发出几条；不是今天就当 0。 */
export function todayCount(state: ServerChanState, timezone: string, at: number): number {
  return state.day === dayKey(timezone, at) ? state.today : 0;
}

/** 记一笔；只有成功的那次才进计数。 */
export function recordSend(state: ServerChanState, entry: LastSend, timezone: string): ServerChanState {
  const day = dayKey(timezone, entry.at);
  const sameDay = state.day === day;
  const counted = entry.ok ? 1 : 0;
  return {
    last: { ...entry },
    day,
    today: (sameDay ? state.today : 0) + counted,
    total: state.total + counted,
  };
}

/** 正文的短哈希：只用来认重复，不存原文。 */
export function bodyHash(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 16);
}
