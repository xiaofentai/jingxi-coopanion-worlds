/**
 * 召回：从一堆记忆文件里挑出「和这次问的最相关的几条」。
 *
 * 纯函数、零依赖、不写盘。它解决的是**跨文件**：她不知道去哪找的时候，一次给出几条候选，
 * 她再决定要不要 `read_file` 取全文。所以每条都必须带来源（哪个文件、哪一天），否则她无法判断。
 *
 * 排序靠三档，可靠性从高到低：
 * 1. `entity` 精确命中（人名、局号、项目名）——命中就是命中，可解释；
 * 2. `days` 时间窗——不用她给任何关键词；
 * 3. `query` 文本重合——用「字的片段」算权重，高频词（今天、他说）自动降权。
 */
import { dayDates, type Block, type Doc, type Entry } from './parse.ts';

export interface RecallHit {
  /** 相对路径。 */
  file: string;
  /** 块句柄：日块 `11-07`、月块 `2026-10`、特殊块原名。 */
  handle: string;
  /** `YYYY-MM-DD` / `YYYY-MM`；特殊块为 null。 */
  date: string | null;
  /** 条目原文（可能很长，调用方自己截）。 */
  text: string;
  score: number;
}

export interface RecallOptions {
  /** 自由文本：拿它去和记忆比对。 */
  query?: string;
  /** 精确子串：人名、局号、项目名。 */
  entity?: string;
  /** 只要最近这么多天的（含今天）。0 或不给表示不限。 */
  days?: number;
  /** `YYYY-MM-DD`。 */
  today: string;
  /** 最多给几条，默认 5。 */
  limit?: number;
  /** 排除掉某一条（`ml_add` 刚写完时别把自己递回去）。 */
  skip?: (hit: RecallHit) => boolean;
}

/** 一条候选的内部形态：带上它的块与文档。 */
interface Candidate {
  file: string;
  block: Block;
  entry: Entry;
}

const MIN_PIECE = 2;
const MAX_PIECE = 4;
/** 出现在超过这个比例的条目里的片段，当成噪音（「今天」「他说」）。 */
const NOISE_RATIO = 0.35;

/** 两个 `YYYY-MM-DD` 相差几天（`to` 减 `from`）。 */
function daysBetween(from: string, to: string): number {
  const at = Date.UTC(...(from.split('-').map(Number) as [number, number, number]));
  const bt = Date.UTC(...(to.split('-').map(Number) as [number, number, number]));
  return Math.round((bt - at) / 86_400_000);
}

/** 把查询切成 2~4 字的片段；中文按字切，不去词。 */
export function pieces(text: string): string[] {
  const flat = text.replace(/\s+/g, ' ').trim();
  const out = new Set<string>();
  for (let size = MIN_PIECE; size <= MAX_PIECE; size += 1) {
    for (let i = 0; i + size <= flat.length; i += 1) {
      const piece = flat.slice(i, i + size);
      if (/^[\s\p{P}]+$/u.test(piece)) continue;
      out.add(piece);
    }
  }
  return [...out];
}

/** 块在回执里的短名。 */
function handleOf(block: Block): string {
  if (block.kind === 'special') return block.title;
  return block.kind === 'day' ? (block.date ?? block.title).slice(5) : (block.date ?? block.title);
}

function candidatesOf(docs: readonly Doc[]): Candidate[] {
  const out: Candidate[] = [];
  for (const doc of docs) {
    for (const block of doc.blocks) {
      for (const entry of block.entries) out.push({ file: doc.path, block, entry });
    }
  }
  return out;
}

/** 这一天在不在最近 `days` 天里；月块按「整月都算」，特殊块永远算。 */
function inWindow(block: Block, today: string, days: number): boolean {
  if (days <= 0) return true;
  if (block.kind === 'special' || !block.date) return true;
  if (block.kind === 'month') {
    const monthEnd = `${block.date}-01`;
    const age = daysBetween(monthEnd, today);
    // 当月和上个月都算在窗内，再早的不算
    return age <= days + 31;
  }
  const age = daysBetween(block.date, today);
  return age >= 0 && age < days;
}

/**
 * 挑出最相关的几条。
 * 三档同时给的时候取并集：`entity` 命中的优先，其次时间窗，最后文本分。
 */
export function recall(docs: readonly Doc[], opts: RecallOptions): RecallHit[] {
  const limit = Math.max(1, opts.limit ?? 5);
  const all = candidatesOf(docs);
  if (!all.length) return [];

  const entity = (opts.entity ?? '').trim();
  const query = (opts.query ?? '').trim();

  // 文本分：先算全量 df，给每个片段一个「越少见越值钱」的权重
  const weight = new Map<string, number>();
  if (query) {
    const total = all.length;
    for (const piece of pieces(query)) {
      let df = 0;
      for (const candidate of all) if (candidate.entry.text.includes(piece)) df += 1;
      if (df === 0) continue;
      if (df / total > NOISE_RATIO) continue;
      weight.set(piece, Math.log(1 + total / df) * piece.length);
    }
  }

  const hits: RecallHit[] = [];
  for (const candidate of all) {
    const { block, entry } = candidate;
    let score = 0;
    let matched = false;

    if (entity && (entry.text.includes(entity) || block.title.includes(entity) || candidate.file.includes(entity))) {
      score += 10;
      matched = true;
    }
    if (weight.size) {
      for (const [piece, w] of weight) if (entry.text.includes(piece)) score += w;
      if (score > 0) matched = true;
    }
    // 没给 entity 也没给 query 时，退化成「时间窗内全给」
    if (!entity && !query) {
      matched = inWindow(block, opts.today, opts.days ?? 3);
      if (!matched) continue;
    } else if (!matched) continue;

    // 给了时间窗就再从结果里筛一遍；月块和特殊块不筛
    if (opts.days && opts.days > 0 && !inWindow(block, opts.today, opts.days)) continue;

    const hit: RecallHit = {
      file: candidate.file,
      handle: handleOf(block),
      date: block.date,
      text: entry.text,
      score,
    };
    if (opts.skip?.(hit)) continue;
    hits.push(hit);
  }

  hits.sort((a, b) => b.score - a.score || (b.date ?? '').localeCompare(a.date ?? ''));
  return hits.slice(0, limit);
}

/** 这份文件里最近的一天、最早的一天，回执里提一句用。 */
export function spanOf(doc: Doc): { from: string | null; to: string | null } {
  const dates = dayDates(doc);
  return { from: dates[0] ?? null, to: dates.at(-1) ?? null };
}
