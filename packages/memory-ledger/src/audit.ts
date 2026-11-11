/**
 * 体检：只读，把几份记忆的结构说出来——每份几块、日期到哪、哪天重复、哪天缺。
 *
 * 这是「整理前先看一遍」的那一步。它不判断内容好坏，只报结构上的洞。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { coverOf } from './board.ts';
import { parseRules, type Rule } from './board.ts';
import { dayDates, parseDoc, type Doc } from './parse.ts';
import { handleOf } from './write.ts';

export interface FileReport {
  path: string;
  /** 文件本来的字数。 */
  chars: number;
  /** 日块数量。 */
  days: number;
  /** 最早一天、最晚一天。 */
  from: string | null;
  to: string | null;
  /** 条目总数。 */
  entries: number;
  /** 同一天在这一份里出现两次以上。 */
  repeated: string[];
  /** 文件里没有日期的块（还挂着、月块等）。 */
  special: string[];
}

/** 一处待整理：哪一份、哪一块、为什么。 */
export interface TidyItem {
  file: string;
  handle: string;
  reason: string;
}

export interface AuditReport {
  files: FileReport[];
  /** 所有日块合起来的覆盖：缺哪天、哪天重。 */
  missing: string[];
  duplicates: Array<{ date: string; files: string[] }>;
  /** 待整理清单：首行不合格、超窗口、条目超额。**只进 `ml_check` 的回执，不进前缀。** */
  tidy: TidyItem[];
}

/** 目录一行留多少字；首行超过它，目录里就会被截成半句。 */
export const FIRST_LINE_MAX = 40;

/** 两个 `YYYY-MM-DD` 相差几天。 */
function daysBetween(from: string, to: string): number {
  const at = Date.UTC(...(from.split('-').map(Number) as [number, number, number]));
  const bt = Date.UTC(...(to.split('-').map(Number) as [number, number, number]));
  return Math.round((bt - at) / 86_400_000);
}

/** 目录里的路径；绝对路径或越界返回 null。 */
export function insideFolder(folder: string, rel: string): string | null {
  if (!rel || isAbsolute(rel)) return null;
  const full = resolve(folder, rel);
  const prefix = folder.endsWith('\\') || folder.endsWith('/') ? folder : `${folder}${process.platform === 'win32' ? '\\' : '/'}`;
  return full.startsWith(prefix) ? full : null;
}

export function readDoc(folder: string, rel: string, year: number): Doc | null {
  const file = insideFolder(folder, rel);
  if (!file || !existsSync(file)) return null;
  try {
    if (!statSync(file).isFile()) return null;
    let text = readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return parseDoc(text, rel, year);
  } catch {
    return null;
  }
}

/** 规则里的文件，去重后逐个读。 */
export function readRuleDocs(folder: string, rules: string, year: number): Array<{ rule: Rule; doc: Doc }> {
  const { rules: parsed } = parseRules(rules);
  const seen = new Set<string>();
  const out: Array<{ rule: Rule; doc: Doc }> = [];
  for (const rule of parsed) {
    if (seen.has(rule.path)) continue;
    seen.add(rule.path);
    const doc = readDoc(folder, rule.path, year);
    if (doc) out.push({ rule, doc });
  }
  return out;
}

export function audit(folder: string, rules: string, today: string, year = Number(today.slice(0, 4))): AuditReport {
  const docs = readRuleDocs(folder, rules, year);
  const files: FileReport[] = docs.map(({ doc }) => {
    const dates = dayDates(doc);
    const byDate = new Map<string, number>();
    for (const block of doc.blocks) {
      if (block.kind !== 'day' || !block.date) continue;
      byDate.set(block.date, (byDate.get(block.date) ?? 0) + 1);
    }
    return {
      path: doc.path,
      chars: doc.text.length,
      days: dates.length,
      from: dates[0] ?? null,
      to: dates.at(-1) ?? null,
      entries: doc.blocks.reduce((n, block) => n + block.entries.length, 0),
      repeated: [...byDate.entries()].filter(([, n]) => n > 1).map(([date]) => date),
      special: doc.blocks.filter((block) => block.kind !== 'day').map(handleOf),
    };
  });
  const cover = coverOf(docs.map(({ doc }) => doc), today);
  return { files, missing: cover.missing, duplicates: cover.duplicates, tidy: tidyOf(docs, today) };
}

/**
 * 该整理什么：块的首行不合格、天在窗口外、条目超了上限。
 *
 * 只算账、不动手，也不进前缀——她要整理时调一次 `ml_check` 就够了。
 * 首行那两条是最要紧的：目录直接取首行，`13:00 生态箱报错` 这种抄流水的东西
 * 会原样变成目录里的一行，看着像有条目，其实什么都没说。
 */
function tidyOf(docs: Array<{ rule: Rule; doc: Doc }>, today: string): TidyItem[] {
  const out: TidyItem[] = [];
  for (const { rule, doc } of docs) {
    const catalog = rule.mode === 'catalog';
    const window = catalog ? Number.parseInt(rule.arg.trim(), 10) : 0;
    const cap = catalog ? rule.maxChars : 0;

    if (cap > 0) {
      const total = doc.blocks.reduce((n, block) => n + block.entries.length, 0);
      if (total > cap) out.push({ file: doc.path, handle: '（整份）', reason: `共 ${total} 条，超过上限 ${cap}：挑最旧的几条 ml_forget 进归档` });
    }

    // 只有 catalog 会把「块的首行」搬进目录；常驻 / 偏好 / 记忆 的首行没人看，不该报
    if (!catalog) continue;

    for (const block of doc.blocks) {
      const handle = handleOf(block);
      // 判据必须和 `catalog` 取行的地方一致：正文第一行非空行，去掉列表符号。
      // 以前这里用 `entries[0]`，于是「写成裸行的一句话」会被漏判成流水第一条。
      const text = (block.body.split('\n').map((line) => line.trim()).find(Boolean) ?? '')
        .replace(/^[-*]\s+/, '')
        .trim();
      if (!text) {
        out.push({ file: doc.path, handle, reason: '块里一条都没有，目录里只有个日期' });
        continue;
      }
      const clock = /^\d{1,2}:\d{2}/.exec(text);
      if (clock) {
        out.push({ file: doc.path, handle, reason: `首行以 ${clock[0]} 开头——这是流水第一条，不是这一天的一句话` });
      } else if (text.length > FIRST_LINE_MAX) {
        out.push({ file: doc.path, handle, reason: `首行 ${text.length} 字，超过 ${FIRST_LINE_MAX}：目录里会被截成半句` });
      }
      // 裸行：不在任何条目的行里。目录认它（读的是正文第一行），但它不是条目——
      // `ml_delete` 删不掉，再 `ml_add(first=true)` 会叠在它上面。加个 `- ` 前缀就成条目。
      const covered = new Set(block.entries.flatMap((entry) => entry.lines));
      const bare = block.body
        .split('\n')
        .map((line, index) => ({ text: line.trim(), no: block.startLine + 1 + index }))
        .filter((item) => item.text && !covered.has(item.no));
      if (bare.length) {
        const first = bare[0];
        const where = first.no === block.startLine + 1 ? '首行' : `块里第 ${first.no - block.startLine} 行`;
        out.push({
          file: doc.path,
          handle,
          reason: `${where}是裸行（不成条目，ml_delete 删不掉）：${first.text.slice(0, 30)}——加个 \`- \` 前缀就成条目`,
        });
      }

      if (Number.isFinite(window) && window > 0 && block.kind === 'day' && block.date) {
        const age = daysBetween(block.date, today);
        if (age >= window) out.push({ file: doc.path, handle, reason: `已第 ${age + 1} 天（窗口 ${window} 天）：该搬到下一份` });
      }
    }
  }
  return out;
}

/** 一行一份，供工具回执与脚本共用。 */
export function auditLines(report: AuditReport, today: string): string[] {
  const lines = [`今天 ${today}`];
  for (const file of report.files) {
    const span = file.from ? `${file.from.slice(5)}~${file.to?.slice(5) ?? '?'}` : '无日块';
    const extra = file.special.length ? `；特殊块 ${file.special.join('、')}` : '';
    const repeat = file.repeated.length ? `；同日重复 ${file.repeated.map((d) => d.slice(5)).join('、')}` : '';
    lines.push(`· ${file.path}：${file.chars} 字／${file.days} 天（${span}）／${file.entries} 条${extra}${repeat}`);
  }
  lines.push(report.missing.length
    ? `覆盖：缺 ${report.missing.map((d) => d.slice(5)).join('、')}`
    : '覆盖：没有缺口');
  for (const dup of report.duplicates) {
    lines.push(`重复：${dup.date.slice(5)} 同时出现在 ${dup.files.join(' 与 ')}`);
  }
  if (!report.tidy.length) {
    lines.push('该整理：没有');
    return lines;
  }
  const shown = report.tidy.slice(0, 12);
  lines.push(`该整理 ${report.tidy.length} 处：`);
  for (const item of shown) lines.push(`  - ${item.file}「${item.handle}」：${item.reason}`);
  if (report.tidy.length > shown.length) lines.push(`  - 另有 ${report.tidy.length - shown.length} 处`);
  return lines;
}

/** 部署目录下的记忆目录。 */
export function folderOf(botDir: string, folder: string): string {
  const raw = folder.trim() || 'workspace';
  return isAbsolute(raw) ? resolve(raw) : resolve(join(botDir, raw));
}
