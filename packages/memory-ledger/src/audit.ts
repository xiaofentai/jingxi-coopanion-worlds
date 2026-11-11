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

export interface AuditReport {
  files: FileReport[];
  /** 所有日块合起来的覆盖：缺哪天、哪天重。 */
  missing: string[];
  duplicates: Array<{ date: string; files: string[] }>;
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
  return { files, missing: cover.missing, duplicates: cover.duplicates };
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
  return lines;
}

/** 部署目录下的记忆目录。 */
export function folderOf(botDir: string, folder: string): string {
  const raw = folder.trim() || 'workspace';
  return isAbsolute(raw) ? resolve(raw) : resolve(join(botDir, raw));
}
