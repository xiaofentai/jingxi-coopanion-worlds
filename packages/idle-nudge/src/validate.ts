/**
 * 设置页提交时的严格校验：写坏了就报错，这一份**一个字都不存**。
 *
 * 和 `settings.ts` 的 `clampSettings` 分工不同，别合并：
 * - `clampSettings` 是「磁盘上读到什么都要能起来」——软的，坏值退回默认，插件不能因为
 *   一份手改坏的 config.json 起不来；
 * - 这里是「人刚填进来的不许含糊」——硬的，`9-25` / `25:00` / `9-` / `tickSeconds: 1`
 *   一律拒绝。否则改完显示「已保存」，实际被悄悄改回旧值（0.2.6 之前就是这样）。
 *
 * 只校验**提交了的键**：`undefined` ＝ 这次没动它，用原来的值，不算错。
 * 返回第一条问题（带人能看懂的位置，如「时段 2」）；`null` 表示全都规范。
 */
import { parseClock } from './note.ts';
import type { NudgeSettings } from './settings.ts';

/** 正文模板的字数上限，和 `clampSettings` 的 `slice(0, 500)` 对齐。 */
export const MAX_TEMPLATE_CHARS = 500;

interface IntField {
  key: string;
  label: string;
  min: number;
  max: number;
  unit: string;
}

const INT_FIELDS: readonly IntField[] = [
  { key: 'idleMinutes', label: '空档阈值', min: 1, max: 1440, unit: '分钟' },
  { key: 'tickSeconds', label: '看表间隔', min: 5, max: 300, unit: '秒' },
  { key: 'maxPerDay', label: '每日上限', min: 0, max: 240, unit: '拍' },
  { key: 'noteGapMinutes', label: '两张纸条的间隔', min: 0, max: 1440, unit: '分钟' },
];

const TEXT_FIELDS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'heartbeatText', label: '心跳正文' },
  { key: 'noteText', label: '纸条正文' },
];

/** 一个整数输入：必须是整数、必须落在范围内。 */
function checkInt(raw: unknown, label: string, min: number, max: number, unit = ''): string | null {
  if (raw === undefined || raw === null) return null;
  const suffix = unit ? ` ${unit}` : '';
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return `${label}要填数字，现在填的是「${String(raw)}」`;
  if (!Number.isInteger(raw)) return `${label}要填整数（不带小数），现在填的是 ${raw}`;
  if (raw < min || raw > max) return `${label}要 ${min}–${max}${suffix}，现在填的是 ${raw}`;
  return null;
}

/** 一个时刻框：留空＝这一条不启用；填了就必须是 `7:30` / `23` 这种。 */
function checkClockText(raw: unknown, label: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return `${label}要填文字`;
  const text = raw.trim();
  if (!text) return null;
  if (parseClock(text) === null) {
    return `${label}写坏了「${text}」：时刻是 0–23 点，写成 7:30 / 23（留空＝不启用）`;
  }
  return null;
}

/** 一个时段框 `9-12`：留空＝不启用；半填、写坏、起止相同都不行。 */
function checkRangeText(raw: unknown, label: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return `${label}要填时段文字`;
  const text = raw.trim();
  if (!text) return null;
  const bounds = text.split(/\s*[-–~—]\s*/);
  if (bounds.length !== 2) {
    return `${label}写坏了「${text}」：写成 9-12 / 14:30-18 / 22-2（留空＝不启用）`;
  }
  const from = (bounds[0] ?? '').trim();
  const to = (bounds[1] ?? '').trim();
  if (!from && !to) return null; // 只留了一个 `-`：等同于清空
  if (!from || !to) {
    return `${label}只填了一半「${text}」：两端都要填，要不整行留空`;
  }
  if (parseClock(from) === null || parseClock(to) === null) {
    return `${label}写坏了「${text}」：时刻是 0–23 点，写成 9-12 / 14:30-18 / 22-2`;
  }
  if (parseClock(from) === parseClock(to)) {
    return `${label}起止相同「${text}」：那样一张都推不出来，换个区间或留空`;
  }
  return null;
}

/** 一条 `{ range, perDay }`：左边是时段/时刻，右边是张数/抖动幅度。 */
function checkPair(raw: unknown, label: string, count: string, countMin: number, countMax: number): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') return `${label}提交的格式不对`;
  const pair = raw as { range?: unknown; perDay?: unknown };
  return (
    checkRangeText(pair.range, label)
    ?? checkInt(pair.perDay, `${label}的「${count}」`, countMin, countMax)
  );
}

/** 面板提交的那一份；返回第一条问题，或 `null` 表示可以存。 */
export function checkIncoming(incoming: Record<string, unknown>, current: NudgeSettings): string | null {
  for (const field of INT_FIELDS) {
    const problem = checkInt(incoming[field.key], field.label, field.min, field.max, field.unit);
    if (problem) return problem;
  }

  for (const { key, label } of TEXT_FIELDS) {
    const raw = incoming[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') return `${label}要填文字`;
    if (raw.length > MAX_TEMPLATE_CHARS) {
      return `${label}最多 ${MAX_TEMPLATE_CHARS} 字，现在 ${raw.length} 字`;
    }
  }

  for (let index = 0; index < current.slots.length; index += 1) {
    const problem = checkPair(incoming[`slot${index}`], `时段 ${index + 1}`, '每天几张', 0, 24);
    if (problem) return problem;
  }

  for (let index = 0; index < current.greetings.length; index += 1) {
    const label = index === 0 ? '早安时刻' : '晚安时刻';
    const raw = incoming[`greeting${index}`];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'object') return `${label}提交的格式不对`;
    const pair = raw as { range?: unknown; perDay?: unknown };
    const problem = checkClockText(pair.range, label)
      ?? checkInt(pair.perDay, `${label}的「抖动幅度」`, 0, 240, '分钟');
    if (problem) return problem;
  }

  return null;
}
