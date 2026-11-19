/**
 * 写入：只对「块」做操作，不对行号做操作。
 *
 * 今天的 11-09 被劈开，是因为给 `move_file` 传了个行数，多算一两行就越过了下一个标题。
 * 这里所有函数都按块标题定位：`11-09`、`2026-11`、`还挂着`。行号只在函数内部算，不交给调用方。
 *
 * 纯函数：进来一段文本，出去一段文本。读盘、原子写、备份在 `tools.ts` 里。
 */
import { bodyStartOf, parseDoc, resolveShortYear, type Block, type Doc } from './parse.ts';

/** 块的句柄：日块与月块用日期，特殊块用标题。 */
export function handleOf(block: Block): string {
  return block.kind === 'special' ? block.title : (block.date ?? block.title);
}

/** 文件头不是块（不属于任何块），`ml_edit` 用这两个名字之一指第一个 `##` 之前那段。 */
const FRONT_HANDLES = ['文件头', 'front'];

/** `block` 是否在指文件头；真有同名块时以块为准。 */
export function isFrontHandle(doc: Doc, handle: string): boolean {
  const wanted = handle.trim().toLowerCase();
  if (!FRONT_HANDLES.includes(wanted)) return false;
  return !doc.blocks.some((block) => handleOf(block) === handle.trim() || block.title === handle.trim());
}

/** 改不成时连上下文一起给回去：她照着就能改，不用再查一遍。 */
export interface Miss {
  error: string;
  /** 这一块现有的条目，或这份文件里有哪些块。 */
  hint?: string;
}

/**
 * 按句柄找块。`11-09`、`2026-11-09`、`11-09（周一）`、`还挂着` 都能认；
 * 写全了就不用猜，写半截也认得出，省得调用方去拼格式。
 */
export function findBlocks(doc: Doc, handle: string): Block[] {
  const wanted = handle.trim();
  if (!wanted) return [];
  return doc.blocks.filter((block) => {
    const id = handleOf(block);
    return id === wanted || block.title === wanted || id.endsWith(`-${wanted}`) || block.title.startsWith(wanted);
  });
}

/** 块在文件里占的行：`[start, end)`，0 起。有标题时含标题行；清单块只有正文。 */
function spanOf(block: Block): [number, number] {
  const bodyLines = block.body.split('\n').length;
  const start = block.startLine - 1;
  // 有标题就多占一行；清单块没有标题，正文就是它自己
  return [start, start + bodyLines + (block.heading ? 1 : 0)];
}

/** 块的原样文本，含标题行与块尾空行。清单块没有标题，只有正文。 */
export function blockText(block: Block): string {
  return block.heading ? `${block.heading}\n${block.body}` : block.body;
}

/** 文件头那段原文：第一个 `##` 之前；一个块都没有时是全文。 */
export function frontText(doc: Doc): string {
  const lines = doc.text.split('\n');
  const end = doc.blocks[0]?.startLine;
  return (end ? lines.slice(0, end - 1) : lines).join('\n');
}

/** 句柄指向的那段原文：块含标题行，文件头是第一个 `##` 之前。核对时用。 */
export function regionsOf(doc: Doc, handle: string): string[] {
  if (isFrontHandle(doc, handle)) return [frontText(doc)];
  return findBlocks(doc, handle).map(blockText);
}

/** 收窄成一句，回执里不至于把整段贴出来。 */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 这份文件里有哪些块：块名写错时，先让她看见能写什么。 */
function handlesHint(doc: Doc, limit = 8): string {
  const ids = doc.blocks.map(handleOf);
  if (!ids.length) return '这份文件里还没有 `##` 块。';
  const shown = ids.slice(0, limit).join('、');
  return `这份文件里有：${shown}${ids.length > limit ? ` …（共 ${ids.length} 块）` : ''}`;
}

/** 这一块现有的前几条：`old` 抄错了时，让她看见现在是什么。 */
function sampleHint(block: Block, limit = 3): string {
  if (!block.entries.length) return '这一块里还没有条目。';
  const more = block.entries.length > limit ? `（共 ${block.entries.length} 条，只列前 ${limit} 条）` : '';
  const shown = block.entries.slice(0, limit).map((entry) => `- ${clip(entry.text, 80)}`).join('\n');
  return `它现在的条目${more}：\n${shown}`;
}

/** 文件头现有的前几行，作用同 `sampleHint`。 */
function frontHint(doc: Doc, limit = 3): string {
  const lines = frontText(doc).split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return '文件头是空的。';
  return `文件头现在是这样：\n${lines.slice(0, limit).map((line) => `- ${clip(line, 80)}`).join('\n')}`;
}

/** 去掉块；顺带把连续空行压成一个，别留出三个空行。 */
export function withoutBlock(doc: Doc, block: Block): string {
  const lines = doc.text.split('\n');
  const [start, end] = spanOf(block);
  const kept = [...lines.slice(0, start), ...lines.slice(end)];
  return tidy(kept.join('\n'));
}

/** 连续三个以上空行压成一个空行，结尾留且只留一个换行。 */
export function tidy(text: string): string {
  return `${text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trimEnd()}\n`;
}

/** 新块插到哪：排在最后一个更旧的日块之后，保证文件里始终按日期往上走。 */
function insertAt(doc: Doc, key: number): number {
  const dated = doc.blocks.filter((block) => block.key > 0);
  const older = dated.filter((block) => block.key < key).at(-1);
  if (older) return spanOf(older)[1];
  const newer = dated.find((block) => block.key > key);
  if (newer) return spanOf(newer)[0];
  const last = doc.blocks.at(-1);
  return last ? spanOf(last)[1] : doc.text.split('\n').length;
}

/** 把一段块文本插进文件；同日期已在文件里则拒绝。 */
export function withBlock(doc: Doc, raw: string, key: number): { text: string } | { error: string } {
  // 搬过来的块是哪一年，`key` 已经写着了（日块 20261109 / 月块 20261100），别再拿目标文件
  // 第一块的年份去猜——跨年那几天猜出来的年份会把「目标里已有同一天」这条护栏绕过去。
  const year = key >= 10_000_000
    ? Math.floor(key / 10000)
    : Number(doc.blocks[0]?.date?.slice(0, 4) ?? new Date().getFullYear());
  const incoming = parseDoc(raw, doc.path, year);
  const head = incoming.blocks[0];
  if (!head) return { error: '要插入的内容里没有 ## 标题' };
  const exists = findBlocks(doc, handleOf(head));
  if (exists.length) return { error: `${doc.path} 里已经有「${handleOf(head)}」，没有插入` };
  const lines = doc.text.split('\n');
  const at = insertAt(doc, key);
  const chunk = raw.replace(/\s+$/, '').split('\n');
  const merged = [...lines.slice(0, at), '', ...chunk, ...lines.slice(at)];
  return { text: tidy(merged.join('\n')) };
}

/**
 * 在块里插几行原文。
 * `first` 插到块首——「日期块首行 = 当天的一句话」靠这个落地；
 * 否则接到最后一条非空行之后，块尾的空行不算内容。
 */
function spliceInBlock(doc: Doc, block: Block, chunk: readonly string[], first: boolean): string {
  const lines = doc.text.split('\n');
  const [start, end] = spanOf(block);
  let at: number;
  if (first) {
    at = start + 1;
    while (at < end && !(lines[at] ?? '').trim()) at += 1;
    if (at >= end) at = start + 1;
  } else {
    at = end;
    while (at > start + 1 && !(lines[at - 1] ?? '').trim()) at -= 1;
  }
  const merged = [...lines.slice(0, at), ...chunk, ...lines.slice(at)];
  return tidy(merged.join('\n'));
}

/** 块必须正好一块，否则说不清往哪儿写。 */
function onlyBlock(doc: Doc, handle: string): Block | { error: string } {
  const found = findBlocks(doc, handle);
  if (found.length === 1) return found[0];
  return { error: found.length ? `「${handle}」匹配到 ${found.length} 块，说不清是哪一块` : `没找到「${handle}」` };
}

/** 条目开头的日期头：`**11-02**：` 或 `11-02：`。`11-02 起` 这种不算（那是区间，不是某天）。 */
const DATE_HEAD = /^\*{0,2}(\d{1,2})-(\d{1,2})\*{0,2}\s*[：:]/;

/**
 * 月块里该插在哪一行：找第一条比它晚的，插在它前面。
 * 不带日期头的条目（块首那句「这个月的一句话」）不参与比较，永远留在最前。
 */
function insertByDate(block: Block, month: number, day: number): number {
  const target = month * 100 + day;
  for (const entry of block.entries) {
    const hit = DATE_HEAD.exec(entry.text.trim());
    if (!hit) continue;
    if (Number(hit[1]) * 100 + Number(hit[2]) > target) return entry.lines[0] - 1;
  }
  return -1;
}

/**
 * 在一个块里追加条目（`first` 时插到块首）；块不存在就报错，不擅自新建。
 *
 * 往**月块**补写带日期的条目时按日期插，不追加到块尾——否则时间轴会断
 * （11-02 跑到 11-09 后面就是这条缺失造成的）。找不到更晚的就追加，和以前一样。
 */
export function appendBullets(doc: Doc, handle: string, bullets: readonly string[], first = false): { text: string } | { error: string } {
  const block = onlyBlock(doc, handle);
  if ('error' in block) return block;
  const chunk = bullets.map((line) => `- ${line.replace(/^[-*]\s+/, '').trim()}`);

  if (!first && block.kind === 'month' && chunk.length === 1) {
    const hit = DATE_HEAD.exec(chunk[0].replace(/^-\s+/, ''));
    if (hit) {
      const at = insertByDate(block, Number(hit[1]), Number(hit[2]));
      if (at >= 0) {
        const lines = doc.text.split('\n');
        return { text: tidy([...lines.slice(0, at), chunk[0], ...lines.slice(at)].join('\n')) };
      }
    }
  }

  return { text: spliceInBlock(doc, block, chunk, first) };
}

/** 把几行原文（含续行）插进块里；归档一条旧记忆时用它，不压平、不掉行。 */
export function appendRawLines(doc: Doc, handle: string, raw: readonly string[]): { text: string } | { error: string } {
  const block = onlyBlock(doc, handle);
  if ('error' in block) return block;
  const chunk = raw.map((line) => line.replace(/\s+$/, '')).filter((line) => line.trim());
  if (!chunk.length) return { error: '要插入的内容是空的' };
  return { text: spliceInBlock(doc, block, chunk, false) };
}

/**
 * `11-11` 补成 `2026-11-11`；已经是全日期就原样返回。
 *
 * 给了 `today` 就按「不晚于今天的最近一年」补：元旦那天写 `12-31` 补成刚刚过去的那个月，
 * 而不是十一个月以后——否则会新建出一块未来日期的块。
 */
export function fullDate(date: string, year: number, today?: string): string {
  const trimmed = date.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const short = /^(\d{2})-(\d{2})$/.exec(trimmed);
  if (!short) return trimmed;
  const at = resolveShortYear(short[1], short[2], year, today);
  return `${at}-${short[1]}-${short[2]}`;
}

/**
 * 开一块**标题随便是啥**的块（追加到文件末尾）。
 *
 * 为什么需要：`ensureDayBlock` / `ensureMonthBlock` 只认日期形状，而 `games/*` 的块是
 * 身份名（`## 当守卫`）。她第一次打一个新身份时，那块还不存在——没有这个，她连写的
 * 地方都没有（`ml_add` 会回「没找到」）。
 *
 * **只在不在规则里的文件上用它**：规则文件里的块必须能算出日期，否则覆盖、到期就全乱。
 */
export function ensureBlock(doc: Doc, title: string): { text: string; created: boolean } {
  const cleaned = title.trim().replace(/^#+\s*/, '');
  if (!cleaned) return { text: doc.text, created: false };
  if (findBlocks(doc, cleaned).length) return { text: doc.text, created: false };
  const body = doc.text.replace(/\s+$/, '');
  return { text: `${body}\n\n## ${cleaned}\n`, created: true };
}

/** 某天还没有块就建一个，标题带星期。`date` 可以是 `11-11`，`year` 补年份。 */
export function ensureDayBlock(doc: Doc, date: string, year: number, today?: string): { text: string; created: boolean } {
  const full = fullDate(date, year, today);
  const found = findBlocks(doc, full);
  if (found.length) return { text: doc.text, created: false };
  const [y, m, d] = full.split('-').map(Number);
  if (!y || !m || !d) return { text: doc.text, created: false };
  const heading = `## ${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}（${weekday(full)}）`;
  const lines = doc.text.split('\n');
  const at = insertAt(doc, y * 10000 + m * 100 + d);
  const merged = [...lines.slice(0, at), heading, '', ...lines.slice(at)];
  return { text: tidy(merged.join('\n')), created: true };
}

/**
 * 某个月还没有块就建一个 `## 2026-11`。归档文件用它：按条淘汰的东西聚到月份里，
 * 不按天分块——归档是按月看的，一天一块会碎成几千块。
 */
export function ensureMonthBlock(doc: Doc, month: string): { text: string; created: boolean } {
  const hit = /^(\d{4})-(\d{2})$/.exec(month.trim());
  if (!hit) return { text: doc.text, created: false };
  const [, y, m] = hit;
  const title = `${y}-${m}`;
  if (doc.blocks.some((block) => block.kind === 'month' && block.date === title)) {
    return { text: doc.text, created: false };
  }
  const lines = doc.text.split('\n');
  const at = insertAt(doc, Number(y) * 10000 + Number(m) * 100);
  const merged = [...lines.slice(0, at), `## ${title}`, '', ...lines.slice(at)];
  return { text: tidy(merged.join('\n')), created: true };
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** `2026-11-10` → `周二`，按 UTC 算，不受时区影响；半个日期返回空。 */
export function weekday(date: string): string {
  const parts = date.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return '';
  const [y, m, d] = parts;
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? '';
}

export interface MoveResult {
  source: string;
  target: string;
  /** 搬过去的块句柄。 */
  handle: string;
  /** 搬过去之后这一块的字数。 */
  chars: number;
  /** 搬之前这一块的字数：给了新正文时报压缩比用。 */
  beforeChars: number;
}

/**
 * 把整块从一份文件搬到另一份；同一天在目标里已有则拒绝——这正是 11-09 那种错的来源。
 *
 * `body` 给了就用它换掉块内正文（标题不动）：压进下一层时用，压是她的判断，
 * 工具只负责「换正文 + 按日期插好 + 从源里删」，一处失败就整件事不做。
 */
export function moveBlock(source: Doc, handle: string, target: Doc, body?: string): MoveResult | { error: string } {
  const found = findBlocks(source, handle);
  if (found.length !== 1) {
    return { error: found.length ? `「${handle}」匹配到 ${found.length} 块` : `${source.path} 里没找到「${handle}」` };
  }
  const block = found[0];
  if (block.kind === 'special') return { error: `「${handle}」是特殊块，不搬` };
  const original = blockText(block);
  const text = body === undefined ? block.body : `${body.trim()}\n`;
  // 空正文会让整块变成空壳：不是压缩，是丢
  if (!text.trim()) return { error: '新的正文是空的，没有搬' };
  const raw = `${block.heading}\n${text}`;
  const inserted = withBlock(target, raw, block.key);
  if ('error' in inserted) return inserted;
  return {
    source: withoutBlock(source, block),
    target: inserted.text,
    handle,
    chars: raw.length,
    beforeChars: original.length,
  };
}

export interface RewriteResult {
  text: string;
  beforeChars: number;
  afterChars: number;
}

/**
 * 整块正文换掉，标题不动。
 *
 * 和 `ml_add` 的区别：那个加一条，这个**重写整块**。压 `games/*` 时需要它——
 * 七局同身份的教训里有大量重复，逐条删压不下去，得归并成十来条重写一遍。
 * 和 `ml_move` 的区别：那个会把块搬去另一份文件，这个原地不动。
 */
export function rewriteBlock(doc: Doc, handle: string, body: string): RewriteResult | Miss {
  const block = oneBlock(doc, handle);
  if ('error' in block) return block;
  if (!body.trim()) {
    return { error: '新的正文是空的：那会把整块清空。真要清掉用 ml_block(action="delete")', hint: sampleHint(block) };
  }
  const lines = doc.text.split('\n');
  const [start, end] = spanOf(block);
  const merged = [...lines.slice(0, start + 1), body.trim(), '', ...lines.slice(end)];
  return { text: tidy(merged.join('\n')), beforeChars: block.body.length, afterChars: body.trim().length };
}

export interface DropResult {
  text: string;
  handle: string;
  /** 删掉的字数与条数，回执里报给她。 */
  chars: number;
  entries: number;
}

/**
 * 整块删掉，**什么都不留**。
 *
 * 和 `ml_delete(…, keep=true)` 的分工：那个删一条、还往归档里留一份；这个删一整块、什么都不留，
 * 只有 `save()` 的备份能捞回来。压缩完、确认旧块没用了，才用它。
 */
export function dropBlock(doc: Doc, handle: string): DropResult | { error: string } {
  const found = findBlocks(doc, handle);
  if (found.length !== 1) {
    return {
      error: found.length
        ? `「${handle}」匹配到 ${found.length} 块，写清楚一点`
        : `${doc.path} 里没找到「${handle}」`,
    };
  }
  const block = found[0];
  if (block.kind === 'special') return { error: `「${handle}」是特殊块，要删其中几条请用 ml_delete` };
  return {
    text: withoutBlock(doc, block),
    handle,
    chars: block.body.length,
    entries: block.entries.length,
  };
}

export interface MergeResult {
  text: string;
  /** 被合并掉的块标题，按文件里的先后顺序。 */
  titles: string[];
  /** 合并后的标题行，含 `## `。 */
  heading: string;
  /** 合并后这一块的字数。 */
  chars: number;
}

/**
 * 把同一份文件里的几块并成一块：按文件里的先后顺序拼正文，标题换成 `into`，其余块删掉。
 *
 * 为什么不让调用方自己拼：拼的时候要照抄原文，抄漏一个字符就白改——这正是 `ml_edit`
 * 那条规矩的来由。这里只做机械部分，条目一条不动（条目数由调用方核对），
 * 「同类型的教训留一条」是她的判断，不是工具的。
 *
 * 日期护栏：合并会改掉块的日期归属，而前缀里的文件靠日期算覆盖。所以默认只许
 * 「合并后仍然解析出同一个日期」；规则外的文件（`games/*`）由调用方放开。
 */
export function mergeBlocks(
  doc: Doc,
  handles: readonly string[],
  next: string,
  opts: { allowDateChange?: boolean } = {},
): MergeResult | Miss {
  if (!next.trim()) return { error: '要说清合并后的标题（into）' };
  if (next.includes('\n')) return { error: '标题只能一行' };
  if (isFrontHandle(doc, next)) return { error: '文件头不是块，不能合并' };

  const picked: Block[] = [];
  for (const handle of handles) {
    const found = findBlocks(doc, handle);
    if (found.length === 0) return { error: `没找到「${handle}」`, hint: handlesHint(doc) };
    if (found.length > 1) {
      return {
        error: `「${handle}」匹配到 ${found.length} 块，说不清是哪一块`,
        hint: `匹配到的是：${found.map((block) => block.title).join('、')}`,
      };
    }
    if (!picked.includes(found[0])) picked.push(found[0]);
  }
  if (picked.length < 2) return { error: '至少写两块，才谈得上合并' };
  picked.sort((a, b) => a.startLine - b.startLine);

  const heading = next.trim().replace(/^#+\s*/, '').trim();
  if (!heading) return { error: '新标题是空的' };
  const clash = doc.blocks.find((block) => !picked.includes(block) && block.title.trim() === heading);
  if (clash) return { error: `已经有块叫「${heading}」了，重名以后就分不清是哪一块` };

  const first = picked[0];
  const probeYear = Number((first.date ?? doc.blocks[0]?.date ?? '').slice(0, 4)) || new Date().getFullYear();
  const probe = parseDoc(`## ${heading}\n`, doc.path, probeYear).blocks[0];
  const sameDate = picked.every((block) => block.date === first.date && block.kind === first.kind);
  const keepsDate = probe !== undefined && probe.kind === first.kind && probe.date === first.date;
  if (!opts.allowDateChange && !(sameDate && keepsDate)) {
    return {
      error: `合并会改掉这一块的日期（${picked.map((block) => block.title).join('、')} → ${heading}），覆盖就数不准了；这份文件在规则里，不能这么合`,
    };
  }

  const body = picked
    .map((block) => block.body.trim())
    .filter(Boolean)
    .join('\n\n');
  const raw = body ? `## ${heading}\n${body}` : `## ${heading}`;

  const lines = doc.text.split('\n');
  const spans = picked.map(spanOf);
  const drop = new Set<number>();
  for (const [start, end] of spans) for (let i = start; i < end; i += 1) drop.add(i);
  const anchor = spans[0][0];
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (i === anchor) kept.push(...raw.split('\n'));
    if (!drop.has(i)) kept.push(lines[i]);
  }
  return {
    text: tidy(kept.join('\n')),
    titles: picked.map((block) => block.title),
    heading: `## ${heading}`,
    chars: raw.length,
  };
}

/** `needle` 在 `hay` 里出现几次。 */
function occurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let at = 0;
  for (;;) {
    const hit = hay.indexOf(needle, at);
    if (hit < 0) break;
    count += 1;
    at = hit + needle.length;
  }
  return count;
}

/** 块必须正好找到一块，否则说不清改哪一块；找不到时把这份文件有哪些块报给她。 */
function oneBlock(doc: Doc, handle: string): Block | Miss {
  const found = findBlocks(doc, handle);
  if (found.length === 1) return found[0];
  return found.length
    ? { error: `「${handle}」匹配到 ${found.length} 块，说不清是哪一块`, hint: `匹配到的是：${found.map((block) => block.title).join('、')}` }
    : { error: `没找到「${handle}」`, hint: handlesHint(doc) };
}

/**
 * 把块内的一处文字换掉。
 * `old` 必须在这一块里只出现一次——改错位置的代价比报错大。
 * `handle` 写 `文件头` 时改的是第一个 `##` 之前那段（文件头不属于任何块）。
 */
export function editInBlock(doc: Doc, handle: string, old: string, next: string): { text: string } | Miss {
  if (!old.trim()) return { error: '要说清改哪一段（old）' };
  if (!next.trim()) return { error: '新内容是空的；删一整条请用 ml_delete' };
  if (isFrontHandle(doc, handle)) return editInFront(doc, old, next);
  const block = oneBlock(doc, handle);
  if ('error' in block) return block;
  const hits = occurrences(block.body, old);
  if (hits === 0) return { error: `「${handle}」里没有「${old}」`, hint: sampleHint(block) };
  if (hits > 1) return { error: `「${old}」在「${handle}」里出现 ${hits} 次，说不清改哪一处`, hint: sampleHint(block) };

  const lines = doc.text.split('\n');
  const [start, end] = spanOf(block);
  const body = lines.slice(start + 1, end).join('\n').replace(old, next);
  const merged = [...lines.slice(0, start + 1), ...body.split('\n'), ...lines.slice(end)];
  return { text: tidy(merged.join('\n')) };
}

/**
 * 改块标题：只动标题那一行，块里的条目一条不动。
 *
 * 为什么要有它：`ml_edit` 的替换范围是 `block.body`，**标题行改不到**；而 `games/*` 的块
 * 标题就是将来的检索键（角色 / 人数 / 日期），每局新建时都该统一形状。没有这个工具，
 * 她只能退回 `edit_file`——那条路不核对，还可能把块劈开。
 *
 * 两条硬护栏：日块 / 月块的标题是**格式化**的（目录与覆盖自检都读它），只许换括号里的
 * 星期，不许换日期；标题同时是特殊块的句柄，**不许和别的块重名**，否则以后「匹配到 2 块」。
 */
export function renameInBlock(doc: Doc, handle: string, next: string): { text: string; before: string; after: string } | Miss {
  if (!next.trim()) return { error: '要说清新标题（new）' };
  if (next.includes('\n')) return { error: '标题只能一行' };
  if (isFrontHandle(doc, handle)) return { error: '文件头没有标题可改' };

  const heading = next.trim().replace(/^#+\s*/, '').trim();
  if (!heading) return { error: '新标题是空的' };

  const block = oneBlock(doc, handle);
  if ('error' in block) return block;

  const before = block.heading.trim();
  const after = `## ${heading}`;
  if (before === after) return { error: '新旧标题一样，没有动文件' };

  if (block.kind === 'day') {
    const dayPart = (block.date ?? '').slice(5);
    if (!heading.startsWith(dayPart)) {
      return { error: `日块的标题要以 ${dayPart} 开头（如 \`${dayPart}（周一）\`）；要换日期请用 ml_move` };
    }
  }
  if (block.kind === 'month' && heading !== block.date) {
    return { error: `月块的标题只能是 ${block.date}（目录和覆盖都靠它）` };
  }
  if (doc.blocks.some((other) => other !== block && other.title.trim() === heading)) {
    return { error: `已经有块叫「${heading}」了，重名以后就分不清是哪一块` };
  }

  const lines = doc.text.split('\n');
  const [start] = spanOf(block);
  lines[start] = after;
  return { text: tidy(lines.join('\n')), before, after };
}

/** 改文件头里的一处；唯一匹配的规矩与块内相同。 */
export function editInFront(doc: Doc, old: string, next: string): { text: string } | Miss {
  const front = frontText(doc);
  const hits = occurrences(front, old);
  if (hits === 0) return { error: `文件头里没有「${old}」`, hint: frontHint(doc) };
  if (hits > 1) return { error: `「${old}」在文件头里出现 ${hits} 次，说不清改哪一处`, hint: frontHint(doc) };
  const rest = doc.text.split('\n').slice(front.split('\n').length).join('\n');
  return { text: tidy(`${front.replace(old, next)}\n${rest}`) };
}

/**
 * 删掉块里的一条（含续行整条一起删）。
 * `match` 命中两条以上就报错，不猜。
 */
export function deleteInBlock(doc: Doc, handle: string, match: string): { text: string; removed: string; raw: string; date: string | null } | Miss {
  const block = oneBlock(doc, handle);
  if ('error' in block) return block;
  if (!match.trim()) return { error: '要说清删哪一条（old）' };
  // 她常常直接把文件里那一行抄过来（带 `- `），而条目正文是不带的。
  // 两种写法都认——「抄原文反而删不掉」是最没道理的一种失败。
  const needle = match.replace(/^\s*[-*]\s+/, '').trim();
  const hits = block.entries.filter((entry) => entry.text.includes(needle));
  if (!hits.length) return { error: `「${handle}」里没有含「${needle}」的条目`, hint: sampleHint(block) };
  if (hits.length > 1) return { error: `含「${needle}」的条目有 ${hits.length} 条，说不清删哪一条`, hint: sampleHint(block) };

  const drop = new Set(hits[0].lines);
  const all = doc.text.split('\n');
  const kept = all.filter((_, index) => !drop.has(index + 1));
  // 原文按行留着：归档时整条搬走（含续行），不压成一行
  const raw = [...drop].sort((a, b) => a - b).map((n) => all[n - 1] ?? '').join('\n');
  return { text: tidy(kept.join('\n')), removed: hits[0].text, raw, date: block.date };
}
