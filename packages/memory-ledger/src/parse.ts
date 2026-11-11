/**
 * 解析：把一份记忆文件读成「文件头 + 日期块 + 条目」。
 *
 * 只认行首的 `## `，代码围栏里的不算——围栏里的 `## ` 会被正则当成块标题，`memory-card` 踩过这个坑。
 * 日期从标题里取，顺序是 `2026-11-08` → `2026-11`（月块）→ `11-08`（当年，年份由调用方给）。
 * 取不到日期的是「特殊块」，比如 `## 还挂着`。
 */

/** 代码围栏的开头与结尾：``` 或 ~~~。 */
const FENCE = /^\s*(?:```|~~~)/;
/** 二级标题。 */
const HEADING = /^##\s+/;

export type BlockKind = 'day' | 'month' | 'special';

export interface Entry {
  /** 续行已并进上一条；换行与缩进压成单个空格。 */
  text: string;
  /** 这一条在文件里占的行号，1 起。 */
  lines: number[];
}

export interface Block {
  /** 标题去掉 `## `。 */
  title: string;
  /** 标题原行，含 `## `。 */
  heading: string;
  kind: BlockKind;
  /** `2026-11-08`、`2026-11`；特殊块为 null。 */
  date: string | null;
  /** 排序用的整数：日块 20261108，月块 20261100，特殊块 0。 */
  key: number;
  /** 标题所在行号，1 起。 */
  startLine: number;
  /** 标题之后、下一个标题之前的原文（不含标题行）。 */
  body: string;
  entries: Entry[];
}

export interface Doc {
  /** 相对目录的路径，`/` 分隔。 */
  path: string;
  /** 第一个标题之前的原文：文件头的「本文件持有 / 不写」。 */
  front: string;
  blocks: Block[];
  /** 全文，换行已统一成 `\n`。 */
  text: string;
}

/**
 * 标题里的日期。日块优先于月块——`## 2026-11` 曾被当成 `11-26` 这样的日块，
 * 所以先整段匹配四位数年份。
 */
function dateOf(title: string, year: number): { kind: BlockKind; date: string | null; key: number } {
  const full = /(\d{4})-(\d{2})-(\d{2})/.exec(title);
  if (full) {
    const [, y, m, d] = full;
    return { kind: 'day', date: `${y}-${m}-${d}`, key: Number(y) * 10000 + Number(m) * 100 + Number(d) };
  }
  const month = /(\d{4})-(\d{2})(?!\d)/.exec(title);
  if (month) {
    const [, y, m] = month;
    return { kind: 'month', date: `${y}-${m}`, key: Number(y) * 10000 + Number(m) * 100 };
  }
  const short = /(?:^|[^\d])(\d{2})-(\d{2})(?!\d)/.exec(title);
  if (short) {
    const [, m, d] = short;
    return { kind: 'day', date: `${year}-${m}-${d}`, key: year * 10000 + Number(m) * 100 + Number(d) };
  }
  return { kind: 'special', date: null, key: 0 };
}

/** 块内条目：`- ` 或 `* ` 起头，紧随其后的非空行并进上一条。 */
function entriesOf(body: string, firstLine: number): Entry[] {
  const out: Entry[] = [];
  let cur: Entry | null = null;
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (cur) out.push(cur);
      cur = { text: bullet[1].trim(), lines: [firstLine + i] };
      continue;
    }
    if (!cur) continue;
    if (line.trim() && !HEADING.test(line)) {
      cur.text = `${cur.text} ${line.trim()}`;
      cur.lines.push(firstLine + i);
      continue;
    }
    out.push(cur);
    cur = null;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 一份文件的全文。
 * `year` 给没有年份的日期标题（`## 11-08（周日）`）用；用文件修改时间的年份。
 */
export function parseDoc(text: string, path: string, year: number): Doc {
  const normalized = text.replaceAll('\r\n', '\n');
  const lines = normalized.split('\n');
  const heads: number[] = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (FENCE.test(lines[i])) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && HEADING.test(lines[i])) heads.push(i);
  }

  const front = heads.length ? lines.slice(0, heads[0]).join('\n') : normalized;
  const blocks: Block[] = heads.map((at, k) => {
    const end = k + 1 < heads.length ? heads[k + 1] : lines.length;
    const heading = lines[at];
    const title = heading.replace(HEADING, '').trim();
    const body = lines.slice(at + 1, end).join('\n');
    return {
      title,
      heading,
      ...dateOf(title, year),
      startLine: at + 1,
      body,
      entries: entriesOf(body, at + 2),
    };
  });

  return { path, front, blocks, text: normalized };
}

/** 日块里出现过的日期，从旧到新，去重。月块与特殊块不算。 */
export function dayDates(doc: Doc): string[] {
  const seen = new Set<string>();
  for (const block of doc.blocks) if (block.kind === 'day' && block.date) seen.add(block.date);
  return [...seen].sort();
}

/** `YYYY-MM-DD` 加减天数，跨月靠 Date 的 UTC 运算，不受时区影响。 */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d + days));
  const two = (n: number) => String(n).padStart(2, '0');
  return `${at.getUTCFullYear()}-${two(at.getUTCMonth() + 1)}-${two(at.getUTCDate())}`;
}
