/**
 * 写入：只对「块」做操作，不对行号做操作。
 *
 * 今天的 11-09 被劈开，是因为给 `move_file` 传了个行数，多算一两行就越过了下一个标题。
 * 这里所有函数都按块标题定位：`11-09`、`2026-11`、`还挂着`。行号只在函数内部算，不交给调用方。
 *
 * 纯函数：进来一段文本，出去一段文本。读盘、原子写、备份在 `tools.ts` 里。
 */
import { parseDoc, type Block, type Doc } from './parse.ts';

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

/** 块在文件里占的行：`[start, end)`，0 起。含标题行。 */
function spanOf(block: Block): [number, number] {
  const bodyLines = block.body.split('\n').length;
  const start = block.startLine - 1;
  return [start, start + 1 + bodyLines];
}

/** 块的原样文本，含标题行与块尾空行。 */
export function blockText(block: Block): string {
  return `${block.heading}\n${block.body}`;
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
  const incoming = parseDoc(raw, doc.path, Number(doc.blocks[0]?.date?.slice(0, 4) ?? new Date().getFullYear()));
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

/** `11-11` 补成 `2026-11-11`；已经是全日期就原样返回。 */
export function fullDate(date: string, year: number): string {
  const trimmed = date.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const short = /^(\d{2})-(\d{2})$/.exec(trimmed);
  return short ? `${year}-${short[1]}-${short[2]}` : trimmed;
}

/** 某天还没有块就建一个，标题带星期。`date` 可以是 `11-11`，`year` 补年份。 */
export function ensureDayBlock(doc: Doc, date: string, year: number): { text: string; created: boolean } {
  const full = fullDate(date, year);
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
  /** 这一块的字数。 */
  chars: number;
}

/** 把整块从一份文件搬到另一份；同一天在目标里已有则拒绝——这正是 11-09 那种错的来源。 */
export function moveBlock(source: Doc, handle: string, target: Doc): MoveResult | { error: string } {
  const found = findBlocks(source, handle);
  if (found.length !== 1) {
    return { error: found.length ? `「${handle}」匹配到 ${found.length} 块` : `${source.path} 里没找到「${handle}」` };
  }
  const block = found[0];
  if (block.kind === 'special') return { error: `「${handle}」是特殊块，不搬` };
  const raw = blockText(block);
  const inserted = withBlock(target, raw, block.key);
  if ('error' in inserted) return inserted;
  return { source: withoutBlock(source, block), target: inserted.text, handle, chars: raw.length };
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
  const hits = block.entries.filter((entry) => entry.text.includes(match));
  if (!hits.length) return { error: `「${handle}」里没有含「${match}」的条目`, hint: sampleHint(block) };
  if (hits.length > 1) return { error: `含「${match}」的条目有 ${hits.length} 条，说不清删哪一条`, hint: sampleHint(block) };

  const drop = new Set(hits[0].lines);
  const all = doc.text.split('\n');
  const kept = all.filter((_, index) => !drop.has(index + 1));
  // 原文按行留着：归档时整条搬走（含续行），不压成一行
  const raw = [...drop].sort((a, b) => a - b).map((n) => all[n - 1] ?? '').join('\n');
  return { text: tidy(kept.join('\n')), removed: hits[0].text, raw, date: block.date };
}
