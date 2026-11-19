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

/** `YYYY-MM-DD` 之间差几天（`to` 减 `from`，UTC，不受时区影响）。 */
function daysApart(from: string, to: string): number {
  const at = Date.UTC(...(from.split('-').map(Number) as [number, number, number]));
  const bt = Date.UTC(...(to.split('-').map(Number) as [number, number, number]));
  return Math.round((bt - at) / 86_400_000);
}

/** 超过半年才算「明显在未来」：隔一天写明天是正常写法（`ml_add(block="11-11")`），不该被改年。 */
const FAR_AHEAD_DAYS = 180;

/**
 * `MM-DD` 补年份：落在半年以内的未来就照今年；落到半年以外，说明它是去年的那一天。
 *
 * 为什么不能直接用今年：元旦那几天，文件里还躺着上个月的 `## 12-30`（没写年份）。
 * 按今年补会把它读成**明年** 12 月——覆盖会报几百天缺口；而「该整理的」是拿今天减
 * 块日期算的，未来日期算出负数，那些天就永远不会被点名搬走。补成去年才是它真正的年份。
 *
 * 为什么不能一律「最近的过去」：她确实会写明天的块（`ml_add` 指定 `11-11`），
 * 一律往回想会把明天读成去年。
 */
export function resolveShortYear(month: string, day: string, year: number, today?: string): number {
  if (!today) return year;
  const filled = `${year}-${month}-${day}`;
  if (filled <= today) return year;
  return daysApart(today, filled) > FAR_AHEAD_DAYS ? year - 1 : year;
}

/**
 * 标题里的日期。日块优先于月块——`## 2026-11` 曾被当成 `11-26` 这样的日块，
 * 所以先整段匹配四位数年份。
 *
 * `today`（`YYYY-MM-DD`）只用来给不带年份的 `MM-DD` 补年，见 `shortYear`。
 */
function dateOf(title: string, year: number, today?: string): { kind: BlockKind; date: string | null; key: number } {
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
    const at = resolveShortYear(m, d, year, today);
    return { kind: 'day', date: `${at}-${m}-${d}`, key: at * 10000 + Number(m) * 100 + Number(d) };
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
 * `year` 给没有年份的日期标题（`## 11-08（周日）`）用；
 * `today`（`YYYY-MM-DD`）给了就按「不晚于今天的最近一年」修正年份——
 * **出卡和工具必须用同一个 `today`**，否则同一个块在两边是两年。
 */
export function parseDoc(text: string, path: string, year: number, today?: string): Doc {
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

  // 没有任何 `## ` 的文件 = 一张清单：一条一件事、日期写在条目里（大事记的形态）。
  // 整份折成一个块，句柄用文件名，所以 `ml_add` / `ml_delete` 照样认得出它。
  // 这样年份不再靠「补」，而是条目自己写死的——同一份文件今天读和明年读结果一样。
  if (!heads.length) {
    const first = lines.findIndex((line) => /^\s*[-*]\s+/.test(line));
    if (first >= 0) {
      const body = lines.slice(first).join('\n');
      const name = (path.split(/[\\/]/).pop() ?? path).replace(/\.md$/i, '');
      return {
        path,
        front: lines.slice(0, first).join('\n'),
        blocks: [{
          title: name,
          heading: '',
          // 复用月块：它本来就「不给首行、按条目走」。没有月份，所以 date 是 null。
          kind: 'month',
          date: null,
          key: 0,
          startLine: first + 1,
          body,
          entries: entriesOf(body, first + 1),
        }],
        text: normalized,
      };
    }
  }

  const blocks: Block[] = heads.map((at, k) => {
    const end = k + 1 < heads.length ? heads[k + 1] : lines.length;
    const heading = lines[at];
    const title = heading.replace(HEADING, '').trim();
    const body = lines.slice(at + 1, end).join('\n');
    return {
      title,
      heading,
      ...dateOf(title, year, today),
      startLine: at + 1,
      body,
      entries: entriesOf(body, at + 2),
    };
  });

  return { path, front, blocks, text: normalized };
}

/**
 * 日块首行最多这么多字。
 *
 * 它有三个用处，所以只有一个值：体检按它判「超长」、目录按它截断、提示词里写的就是它。
 * 三处各写一个数就会打架——提示词说 50、目录却截在 40，等于让人写一句放不下的。
 */
export const FIRST_LINE_MAX = 50;

/**
 * 正文第一行的行号（1 起）。
 *
 * 有标题的块：标题的下一行。**清单块（没有 `## `）**：它的 `startLine` 本身就是正文第一行。
 * 这个区别必须收在一处——各自写 `startLine + 1` 的话，清单块会整体错一行，
 * 于是体检会把一条正常的条目报成「裸行」。
 */
export function bodyStartOf(block: Block): number {
  return block.heading ? block.startLine + 1 : block.startLine;
}

/**
 * 块的首行：正文里第一个非空行，去掉列表符号。
 *
 * 这是整块「一句话」的位置——目录一行取的就是它，预激活也拿它去匹配。
 * 判据只能有一份：`audit.ts` 判「首行不合格」、`board.ts` 取目录行时用的都是这个。
 */
export function firstLine(block: Block): string {
  const line = block.body.split('\n').map((item) => item.trim()).find(Boolean) ?? '';
  return line.replace(/^[-*]\s+/, '').trim();
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
