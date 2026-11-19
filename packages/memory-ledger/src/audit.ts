/**
 * 体检：只读，把几份记忆的结构说出来——每份几块、日期到哪、哪天重复、哪天缺。
 *
 * 这是「整理前先看一遍」的那一步。它不判断内容好坏，只报结构上的洞。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { archivedDates } from './archive.ts';
import { coverOf } from './board.ts';
import { parseRules, type Rule } from './board.ts';
import { overSoft, overdueAge, usageOf, windowOf } from './due.ts';
import { FIRST_LINE_MAX, bodyStartOf, dayDates, firstLine, parseDoc, shiftDate, type Block, type Doc } from './parse.ts';
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
  /**
   * 分区抽查：把条目按顺序分三段，每段取头尾各一条（共 6 条）。
   *
   * 给「要整理但不想读全文」用的——她看这 6 条就知道这份东西大概是哪些事，
   * 该搬哪几条拿日期去 `ml_move` 就行。
   */
  samples: Array<{ file: string; lines: string[] }>;
  /**
   * 到期没搬的块（结构化）。
   *
   * `tidy` 里也有它们，但那是给人看的句子；这个字段是给「阈值提醒」用的：
   * 到期数会随时间自己涨、也会因为她整理而回落——所以拿它当提醒的触发器就**自抑制**了。
   */
  overdue: Array<{ file: string; handle: string; days: number; window: number; block: Block }>;
}

/** 目录一行留多少字；首行超过它，目录里就会被截成半句。定义在 `parse.ts`，三处共用。 */
export { FIRST_LINE_MAX } from './parse.ts';

/* 天数差与窗口判定都在 `due.ts`：同一个概念只能有一处定义。 */

/**
 * 目录里的路径；绝对路径或越界返回 null。
 *
 * 两边都先 `resolve` 再比：`resolve` 会把 `/` 统一成平台分隔符，而配置里的目录
 * 可能是 `C:/a/b` 这种写法。以前前缀直接拿原字符串拼，`C:/a/b` 和 `C:\a\b\x.md`
 * 永远不比上，结果是**一份都读不到，整个板空着**——而且不报错。
 */
export function insideFolder(folder: string, rel: string): string | null {
  if (!rel || isAbsolute(rel)) return null;
  const base = resolve(folder);
  const full = resolve(base, rel);
  return full.startsWith(`${base}${sep}`) ? full : null;
}

export function readDoc(folder: string, rel: string, year: number, today?: string): Doc | null {
  const file = insideFolder(folder, rel);
  if (!file || !existsSync(file)) return null;
  try {
    if (!statSync(file).isFile()) return null;
    let text = readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return parseDoc(text, rel, year, today);
  } catch {
    return null;
  }
}

/** 规则里的文件，去重后逐个读。 */
export function readRuleDocs(folder: string, rules: string, year: number, today?: string): Array<{ rule: Rule; doc: Doc }> {
  const { rules: parsed } = parseRules(rules);
  const seen = new Set<string>();
  const out: Array<{ rule: Rule; doc: Doc }> = [];
  for (const rule of parsed) {
    if (seen.has(rule.path)) continue;
    seen.add(rule.path);
    const doc = readDoc(folder, rule.path, year, today);
    if (doc) out.push({ rule, doc });
  }
  return out;
}

export function audit(
  folder: string,
  rules: string,
  today: string,
  year = Number(today.slice(0, 4)),
  /** 归档文件的相对路径；给了就把归档里的日期算进覆盖（搬走的天不算缺口）。 */
  archiveFile = '',
): AuditReport {
  const docs = readRuleDocs(folder, rules, year, today);
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
      // 「特殊块」指的是 `还挂着` 这种并列块；清单文件（month 且没有月份）整份一块，
      // 不该在这里再念一遍文件名——它的名字和文件名一样，念了也没有信息。
      special: doc.blocks
        .filter((block) => block.kind !== 'day' && !(block.kind === 'month' && block.date === null))
        .map(handleOf),
    };
  });
  const archived = archiveFile ? archivedDates(folder, archiveFile, year) : [];
  const cover = coverOf(docs.map(({ doc }) => doc), today, 'zh', archived);
  // 只给「有条目上限」的 catalog 抽样：它们要按条数整理，才需要看分布
  const samples = docs
    .filter(({ rule }) => rule.maxChars > 0 && rule.mode === 'catalog')
    .map(({ rule, doc }) => ({ file: rule.path, lines: sampleEntries(doc) }))
    .filter((item) => item.lines.length > 0);
  const { tidy, overdue } = tidyOf(docs, today);
  return {
    files,
    missing: cover.missing,
    duplicates: cover.duplicates,
    tidy,
    samples,
    overdue,
  };
}

/**
 * 该整理什么：块的首行不合格、天在窗口外、用量到了上限的 80%。
 *
 * 只算账、不动手，也不进前缀——她要整理时调一次 `ml_check` 就够了。
 * 首行那两条是最要紧的：目录直接取首行，`13:00 生态箱报错` 这种抄流水的东西
 * 会原样变成目录里的一行，看着像有条目，其实什么都没说。
 *
 * 「用量到线」和「出了窗口」的判据全在 `due.ts`，这里只负责措辞和范围：
 * 首行 / 裸行只对 `catalog` 有意义（别的模式首行不上卡）。
 */
function tidyOf(
  docs: Array<{ rule: Rule; doc: Doc }>,
  today: string,
): { tidy: TidyItem[]; overdue: AuditReport['overdue'] } {
  const out: TidyItem[] = [];
  const overdue: AuditReport['overdue'] = [];
  for (const { rule, doc } of docs) {
    const usage = usageOf(rule, doc);
    if (usage && overSoft(usage)) {
      out.push({
        file: doc.path,
        handle: '（整份）',
        reason: `已到 ${usage.value}/${usage.cap} ${usage.unit}（${Math.round((usage.value / usage.cap) * 100)}%）：该压一压或替换掉一些`,
      });
    }

    // 只有 catalog 会把「块的首行」搬进目录；常驻 / 偏好 / 记忆 的首行没人看，不该报
    if (rule.mode !== 'catalog') continue;
    const window = windowOf(rule);

    for (const block of doc.blocks) {
      const handle = handleOf(block);
      // 月块没有「这个月的一句话」：目录里它只给件数，预激活按条走。所以不查首行。
      const month = block.kind === 'month';
      // 判据必须和目录取行、预激活匹配的地方一致：正文第一行非空行，去掉列表符号。
      // 以前这里用 `entries[0]`，于是「写成裸行的一句话」会被漏判成流水第一条。
      const text = month ? '' : firstLine(block);
      if (!month) {
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
      }
      // 裸行：不在任何条目的行里。目录认它（读的是正文第一行），但它不是条目——
      // `ml_delete` 删不掉，再 `ml_add(first=true)` 会叠在它上面。加个 `- ` 前缀就成条目。
      const covered = new Set(block.entries.flatMap((entry) => entry.lines));
      const bodyStart = bodyStartOf(block);
      const bare = block.body
        .split('\n')
        .map((line, index) => ({ text: line.trim(), no: bodyStart + index }))
        .filter((item) => item.text && !covered.has(item.no));
      if (bare.length) {
        const first = bare[0];
        const where = first.no === bodyStart ? '首行' : `块里第 ${first.no - bodyStart + 1} 行`;
        out.push({
          file: doc.path,
          handle,
          reason: `${where}是裸行（不成条目，ml_delete 删不掉）：${first.text.slice(0, 30)}——加个 \`- \` 前缀就成条目`,
        });
      }

      const day = overdueAge(block, window, today);
      if (day !== null) {
        // 「本该哪天搬」写出来，否则读着像又催了一次；其实它说的是「清理没做」。
        // 清理按 `age >= window` 走，所以那天就是块日期 + 窗口天数。
        const should = block.date ? shiftDate(block.date, window).slice(5) : '';
        out.push({
          file: doc.path,
          handle,
          reason: `已第 ${day} 天（窗口 ${window} 天）：该搬到下一份（本该 ${should} 就搬）`,
        });
        overdue.push({ file: doc.path, handle, days: day, window, block });
      }
    }
  }
  return { tidy: out, overdue };
}

/**
 * 一行一份，供工具回执与脚本共用。
 *
 * `file` 只看那一份的待整理项（文件的摘要行照旧全给，覆盖是全局的）；
 * `limit` 默认 12，`0` 表示全列——不然「首行不合格归零」这条指标会被截断挡住，
 * 她看见「另有 30 处」却没有任何块名，永远清不完。
 */
export function auditLines(
  report: AuditReport,
  today: string,
  opts: { file?: string; limit?: number } = {},
): string[] {
  const only = (opts.file ?? '').trim();
  const tidy = only ? report.tidy.filter((item) => item.file === only) : report.tidy;
  const max = opts.limit === undefined ? 12 : Math.max(0, opts.limit);

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
  // 分区抽查：要整理的那几份，先看 6 条就够判断，不用读全文
  const picks = only ? report.samples.filter((item) => item.file === only) : report.samples;
  const sampleLines: string[] = [];
  for (const item of picks) {
    sampleLines.push(`抽查 ${item.file}（3 区各 2 条）：`);
    for (const text of item.lines) sampleLines.push(`  · ${short(text, 34)}`);
  }

  if (!tidy.length) {
    lines.push(...sampleLines);
    lines.push(only ? `该整理：${only} 没有` : '该整理：没有');
    return lines;
  }
  const shown = max > 0 ? tidy.slice(0, max) : tidy;
  lines.push(`该整理 ${tidy.length} 处${only ? `（只看 ${only}）` : ''}：`);
  for (const item of shown) lines.push(`  - ${item.file}「${item.handle}」：${item.reason}`);
  if (tidy.length > shown.length) lines.push(`  - 另有 ${tidy.length - shown.length} 处`);
  lines.push(...sampleLines);
  return lines;
}

/** 回执里一行留多少字。 */
function short(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * 分区抽查：条目按文件里的顺序分成 `zones` 段，每段取头尾各一条。
 *
 * 为什么分区而不是取最早的几条：最早的几条只说明「开头是什么」，看不出整份有多长、
 * 中间和最近是什么。三段各取头尾，6 条就能把「起点、中段、现在」摆出来。
 */
export function sampleEntries(doc: Doc, zones = 3, perZone = 2): string[] {
  const entries = doc.blocks.flatMap((block) => block.entries.map((entry) => entry.text));
  if (!entries.length) return [];
  if (entries.length <= zones * perZone) return entries;
  const out: string[] = [];
  const size = entries.length / zones;
  for (let zone = 0; zone < zones; zone += 1) {
    // 区间必须首尾相接但不重叠：取 `ceil` 当上界会让两段共用一条，最后只出 4 条
    const from = Math.floor(zone * size);
    const to = Math.min(entries.length - 1, Math.floor((zone + 1) * size) - 1);
    if (to < from) continue;
    const middle = Math.floor((from + to) / 2);
    const picks = perZone >= 3 ? [from, middle, to] : [from, to];
    for (const at of picks) {
      const text = entries[at];
      if (text && !out.includes(text)) out.push(text);
    }
  }
  return out;
}

/** 部署目录下的记忆目录。 */
export function folderOf(botDir: string, folder: string): string {
  const raw = folder.trim() || 'workspace';
  return isAbsolute(raw) ? resolve(raw) : resolve(join(botDir, raw));
}
