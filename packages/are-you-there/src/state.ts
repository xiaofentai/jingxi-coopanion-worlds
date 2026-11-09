/**
 * `<data>/are-you-there.json`：确认到的状态、它从什么时候开始、为什么不在、上一次离开的区间。
 *
 * 整份写进临时文件再改名，所以崩溃后要么是旧记录、要么是新记录。读不出来的内容改名为 `.bad`
 * 留在旁边，World 从空状态开始——一次启动不知道状态，比拿一份坏记录当事实好。
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { AwayReason, AwayRecord, PresenceState } from './presence.ts';
import { emptyPresence } from './presence.ts';

/** 放在 `ctx.dataDir` 里，以 World id 开头，不会和别的 World 撞。 */
export const STATE_FILE = 'are-you-there.json';

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function awayReason(value: unknown): AwayReason | null {
  return value === 'lock' || value === 'idle' ? value : null;
}

function awayRecord(value: unknown): AwayRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  if (!isNumber(r.from) || !isNumber(r.to) || r.to < r.from) return null;
  return { from: r.from, to: r.to };
}

export function readState(file: string): PresenceState {
  if (!existsSync(file)) return emptyPresence();
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    console.warn('[are-you-there] could not read the record', file, error);
    return emptyPresence();
  }
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    // 0.1.0 写的是 `locked`；读到旧记录就按它迁移，别当成没有状态
    const away = typeof raw.away === 'boolean' ? raw.away : typeof raw.locked === 'boolean' ? raw.locked : null;
    return {
      away,
      since: isNumber(raw.since) ? raw.since : null,
      reason: away ? awayReason(raw.reason) ?? 'lock' : null,
      lastAway: awayRecord(raw.lastAway),
    };
  } catch (error) {
    console.warn('[are-you-there] unreadable record, keeping it as .bad', file, error);
    try {
      renameSync(file, `${file}.bad`);
    } catch {
      // 下一次保存会写一份新的
    }
    return emptyPresence();
  }
}

export function writeState(file: string, state: PresenceState): void {
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
