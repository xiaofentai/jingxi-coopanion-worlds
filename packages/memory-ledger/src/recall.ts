/**
 * 召回：从一堆记忆文件里挑出「和这次问的最相关的几条」。
 *
 * 纯函数、零依赖、不写盘。它解决的是**跨文件**：她不知道去哪找的时候，一次给出几条候选，
 * 她再决定要不要 `read_file` 取全文。所以每条都必须带来源（哪个文件、哪一天）。
 *
 * 和上一版的区别：上一版拿 2~4 字滑窗当特征，「说今」这种跨词碎片越怪越稀有、分越高，
 * 于是几乎每次都能捞回几条不相干的东西（「空结果」永远不出现）。这一版按 memory-core
 * 的路子重写，三件事：
 *  - 切词：先按标点切断，中文只出二元组，英文数字整词——碎片不再跨短语；
 *  - 打分：BM25（词频与长度都归一），不再「命中即等权」；
 *  - 分档：靠「实词二元组命中数」，高频词（今天/回来/他说）先剔掉。
 *
 * 另外，**日期从文本里摘出来单独走**：`11-06`、`11 月 6 日`、`昨天` 不参与文本打分，
 * 而是给那一天的块加分。日期在记忆里每个只出现一两次，按「越少见越值钱」会被当成
 * 最值钱的线索，那是错的。
 */
import { dayDates, firstLine, resolveShortYear, shiftDate, type Block, type Doc } from './parse.ts';

export interface RecallHit {
  /** 相对路径。 */
  file: string;
  /** 块句柄：日块 `11-07`、月块 `2026-10`、特殊块原名。 */
  handle: string;
  /** 块的完整标题（不含 `## `）：调用方靠它把这条对回块里。 */
  title: string;
  /** 在块里的位置；-1 表示按块比，没有具体条目。 */
  index: number;
  /** `YYYY-MM-DD` / `YYYY-MM`；特殊块为 null。 */
  date: string | null;
  /** 条目原文（可能很长，调用方自己截）。 */
  text: string;
  score: number;
  /**
   * `strong` = 真的对上了（实词二元组命中，或 entity 精确命中，或正好是问的哪天）；
   * `weak` = 只靠高频词/权重浮上来的，别当准。
   */
  tier: 'strong' | 'weak';
  /** 命中了几个「实词二元组」——比分数更好解释「像不像」。 */
  bigrams: number;
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
  /**
   * 要不要认句子里的日期（默认认）。
   *
   * 预激活必须关掉：事件文本自带 `[11-13 周五 23:03] [typed] 主人主人:` 这种装饰，
   * 每一句前面都写着今天。开着的话，每一次预激活都会被「今天」带偏——那不是她在问哪一天，
   * 是系统在给每条消息盖时间戳。
   */
  useDates?: boolean;
  /**
   * 比到哪一层（默认 `entry`）。
   *
   * `block` 是给预激活的：日块只拿首行比（那是那一天的一句话），
   * 月块和特殊块按条目比（它们每条本来就是一行一件事）。
   * 拿整块首行去代表一个月的「大事记」，会把后面二十几件全丢掉。
   */
  level?: 'entry' | 'block';
  /** 排除掉某一条（`ml_add` 刚写完时别把自己递回去）。 */
  skip?: (hit: RecallHit) => boolean;
}

/** 一条候选的内部形态：带上它的块、以及这次拿来比对的那段文字。 */
interface Candidate {
  file: string;
  block: Block;
  /** 条目正文，或（按块比时）那一块的首行。 */
  text: string;
  /** 在 `block.entries` 里的位置；按块比时是 -1。用它取前后几条。 */
  index: number;
}

/** 单字虚词：出现在任何二元组里，这个二元组就不算「实词线索」。 */
const STOP = new Set(
  '的了是在我你他她它和就都也不吗呢啊吧有会要说过这个那个把被给对说着地得然后还又很太嘛哦呀'
    .split(''),
);

/**
 * 在对话里到处都是、却在记忆里只出现一两次的词——它们看着像线索，其实不是。
 * 日期词放这里是因为日期**另有通道**（见 `extractDates`），不该再当文本线索算一遍。
 */
const PRIME_STOP = new Set(
  ('今天 明天 昨天 后天 前天 大前天 晚上 中午 早上 上午 下午 夜里 现在 刚才 刚刚 回来 回去 出来 起来 一下 一点 一起 '
    + '时候 然后 真的 可以 什么 怎么 觉得 应该 已经 还是 就是 因为 所以 但是 如果 不过 而且 '
    + '你们 我们 他们 自己 东西 事情 一个 有点 不是 没有 知道 看到 说过 感觉 需要 之前 之后').split(' '),
);

/** BM25 参数：k1 控制词频饱和，b 控制长度归一。都是常用值。 */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** 出现在超过这个比例的条目里的二元组，当成噪音（动态算，不写死词）。 */
const NOISE_RATIO = 0.3;

/**
 * 切词：先按非字母数字切断（标点/空白就是短语边界），
 * 英文数字整词保留，中文只出二元组。
 *
 * 不跨边界切片，是为了不再造出「说今」这种不存在的词——越怪的碎片越稀有，
 * 越稀有分越高，这正是上一版「每次都捞回废话」的根。
 */
export function tokenize(text: string): string[] {
  const norm = String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  if (!norm) return [];
  const out: string[] = [];
  for (const word of norm.split(/\s+/)) {
    if (!word) continue;
    if (/^[a-z0-9]+$/.test(word)) {
      out.push(word);
      continue;
    }
    for (let i = 0; i + 1 < word.length; i += 1) out.push(word.slice(i, i + 2));
  }
  return out;
}

/** 是不是「实词二元组」：够长、不在日期/口水词表里、不含虚词、不是满库都是的、**不是纯数字**。 */
export function isContentToken(token: string, common?: ReadonlySet<string>): boolean {
  if (token.length < 2) return false;
  if (PRIME_STOP.has(token)) return false;
  if (common?.has(token)) return false;
  // 纯数字不算实词：`19`、`24`、`23` 这种在流水里到处都是（时刻、局数、版本号），
  // 一旦算进去，任何含数字的长条目都能和任何含数字的句子对上——这是预激活里最脏的一种命中。
  if (/^\d+$/.test(token)) return false;
  for (const ch of token) if (STOP.has(ch)) return false;
  return true;
}

interface Index {
  df: Map<string, number>;
  tf: Map<number, Map<string, number>>;
  len: Map<number, number>;
  avg: number;
  n: number;
}

/** 给整个候选池建一次倒排：每条的词频、长度、以及每个词出现在几条里。 */
function buildIndex(texts: readonly string[]): Index {
  const df = new Map<string, number>();
  const tf = new Map<number, Map<string, number>>();
  const len = new Map<number, number>();
  let total = 0;
  texts.forEach((text, id) => {
    const tokens = tokenize(text);
    const local = new Map<string, number>();
    for (const token of tokens) local.set(token, (local.get(token) ?? 0) + 1);
    tf.set(id, local);
    len.set(id, tokens.length);
    total += tokens.length;
    for (const token of local.keys()) df.set(token, (df.get(token) ?? 0) + 1);
  });
  return { df, tf, len, avg: texts.length ? total / texts.length || 1 : 1, n: texts.length };
}

/** 一条的 BM25 分：字面越贴、词越罕见、条目越短，分越高。 */
function bm25(index: Index, id: number, tokens: readonly string[]): number {
  const local = index.tf.get(id);
  if (!local) return 0;
  const dl = index.len.get(id) ?? 0;
  let sum = 0;
  for (const token of new Set(tokens)) {
    const f = local.get(token);
    if (!f) continue;
    const df = index.df.get(token) ?? 0;
    const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
    sum += (idf * (f * (BM25_K1 + 1))) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / index.avg));
  }
  return sum;
}

/** `2` → `02`。 */
const two = (n: number): string => String(n).padStart(2, '0');

/** 「今天 / 昨天 / 前天 / 大前天」当日期用；这些词在流水里几乎就是字面意思。 */
const RELATIVE: Record<string, number> = { 今天: 0, 昨天: 1, 前天: 2, 大前天: 3 };

/**
 * 把查询里的日期摘出来，并把它们从文本里去掉（`rest` 才是拿去做词法比对的）。
 *
 * 日期不该当文本线索：每个日期在记忆里只出现一两次，按「越少见越值钱」会被打最高分，
 * 于是「11-06」这种纯噪音把不相干的条目顶上来。它该走自己的通道——给那天加分。
 */
export function extractDates(text: string, today: string): { dates: string[]; rest: string } {
  const year = Number(today.slice(0, 4));
  const dates: string[] = [];
  const short = (month: string, day: string): string => {
    const m = Number(month);
    const d = Number(day);
    if (!m || !d || m > 12 || d > 31) return '';
    const mm = two(m);
    const dd = two(d);
    return `${resolveShortYear(mm, dd, year, today)}-${mm}-${dd}`;
  };

  let rest = String(text ?? '');

  // 先整年整月日：2026-11-06 / 2026/11/6
  rest = rest.replace(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})[日号]?/g, (_all, y: string, m: string, d: string) => {
    dates.push(`${y}-${two(Number(m))}-${two(Number(d))}`);
    return ' ';
  });
  // 月日写法：11 月 6 日
  rest = rest.replace(/(\d{1,2})月(\d{1,2})[日号]?/g, (all, m: string, d: string) => {
    const at = short(m, d);
    if (!at) return all;
    dates.push(at);
    return ' ';
  });
  // 短日期：11-06（前后不能还挨着数字，否则是 2026-11 的一段）
  rest = rest.replace(/(?<!\d)(\d{1,2})-(\d{1,2})(?!\d)/g, (all, m: string, d: string) => {
    const at = short(m, d);
    if (!at) return all;
    dates.push(at);
    return ' ';
  });
  // 时刻是纯噪音：13:00 从头到尾不该参与比对
  rest = rest.replace(/\d{1,2}:\d{2}/g, ' ');

  for (const [word, back] of Object.entries(RELATIVE)) {
    if (!rest.includes(word)) continue;
    dates.push(shiftDate(today, -back));
    rest = rest.split(word).join(' ');
  }

  return { dates: [...new Set(dates)], rest: rest.replace(/\s+/g, ' ').trim() };
}

/** 块在回执里的短名。 */
function handleOf(block: Block): string {
  if (block.kind === 'special') return block.title;
  return block.kind === 'day' ? (block.date ?? block.title).slice(5) : (block.date ?? block.title);
}

/**
 * 候选池。
 *
 * `entry` = 一条一条地比（`ml_recall` 用：她要的是那一句）。
 *
 * `block` = 拿「代表一行的那个东西」去比（预激活用）。但**不同块的代表不一样**：
 *  - 日块：代表是**首行**——那一天的一句话，条目是流水细节，不该拿细节当线索；
 *  - 月块（大事记）/ 特殊块（还挂着）：代表就是**每一条自己**——它们本来就是一行一件事，
 *    整块首行只是这个月的第一件，拿它代表整月会把后面二十几件全丢了。
 */
function candidatesOf(docs: readonly Doc[], level: 'entry' | 'block'): Candidate[] {
  const out: Candidate[] = [];
  for (const doc of docs) {
    for (const block of doc.blocks) {
      if (level === 'block' && block.kind === 'day') {
        const line = firstLine(block);
        // 没有首行的日块（空块 / 只有标题）不参选：它没有「一句话」可以当线索
        if (line) out.push({ file: doc.path, block, text: line, index: -1 });
        continue;
      }
      block.entries.forEach((entry, index) => {
        out.push({ file: doc.path, block, text: entry.text, index });
      });
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

/** 两个 `YYYY-MM-DD` 相差几天（`to` 减 `from`）。 */
function daysBetween(from: string, to: string): number {
  const at = Date.UTC(...(from.split('-').map(Number) as [number, number, number]));
  const bt = Date.UTC(...(to.split('-').map(Number) as [number, number, number]));
  return Math.round((bt - at) / 86_400_000);
}

/**
 * 挑出最相关的几条。
 *
 * 三档同时给的时候取并集：`entity` 命中的优先，其次时间窗，最后文本分。
 * 返回的每条都带 `tier`：`strong` 才是「真的对上了」，`weak` 只是沾边——
 * 调用方该分两段给，别把「有点像」当成「就是」。
 */
export function recall(docs: readonly Doc[], opts: RecallOptions): RecallHit[] {
  const limit = Math.max(1, opts.limit ?? 5);
  const level = opts.level ?? 'entry';
  const all = candidatesOf(docs, level);
  if (!all.length) return [];

  const entity = (opts.entity ?? '').trim();
  const rawQuery = (opts.query ?? '').trim();
  // 关掉日期通道时，原句整段拿来切词，一个字都不摘
  const { dates, rest } = opts.useDates === false
    ? { dates: [] as string[], rest: rawQuery }
    : extractDates(rawQuery, opts.today);
  const queryTokens = tokenize(rest);
  const textMode = queryTokens.length > 0 || dates.length > 0;

  // 没给 entity、也没给能用的查询：退化成「时间窗内全给」
  if (!entity && !textMode) {
    const days = opts.days ?? 3;
    return all
      .filter((candidate) => inWindow(candidate.block, opts.today, days))
      .slice(0, limit)
      .map((candidate) => hitOf(candidate, 0, 'strong', 0));
  }

  const index = buildIndex(all.map((candidate) => candidate.text));
  // 满库都是的二元组不算线索：动态算，不靠写死词表（「六人局」火起来之后也该自动降下来）
  const common = new Set<string>();
  {
    const cap = Math.max(3, Math.ceil(all.length * NOISE_RATIO));
    for (const token of new Set(queryTokens)) {
      if ((index.df.get(token) ?? 0) > cap) common.add(token);
    }
  }
  const unique = [...new Set(queryTokens)];

  const hits: RecallHit[] = [];
  all.forEach((candidate, id) => {
    const { block, text } = candidate;
    let score = 0;
    let matched = false;

    // 1) 精确子串：人名、局号、项目名。命中就是命中，可解释。
    if (entity && (text.includes(entity) || block.title.includes(entity) || candidate.file.includes(entity))) {
      score += 10;
      matched = true;
    }

    // 2) 词法：BM25，词频和长度都归一过了
    const lexical = textMode ? bm25(index, id, queryTokens) : 0;
    if (lexical > 0) matched = true;
    score += lexical * 0.25;

    // 3) 日期通道：正好是问的那天，直接给足分（但不筛掉别的，她可能只是顺口提了个日子）
    const onDate = block.date !== null && dates.includes(block.date);
    if (onDate) {
      score += 2;
      matched = true;
    }

    if (!matched) return;
    // 给了时间窗就再从结果里筛一遍；月块和特殊块不筛
    if (opts.days && opts.days > 0 && !inWindow(block, opts.today, opts.days)) return;

    const hay = text.toLowerCase();
    let bigrams = 0;
    for (const token of unique) {
      if (isContentToken(token, common) && hay.includes(token)) bigrams += 1;
    }

    // 两档的口径：两个实词对上，或一个实词且词面确实重合，或正好是问的那天。
    // 只看分数不行——高频词也能把分堆起来。
    const tier: 'strong' | 'weak' = entity && matched && score >= 10
      ? 'strong'
      : bigrams >= 2 || (bigrams >= 1 && lexical >= 2.2) || onDate
        ? 'strong'
        : 'weak';

    const hit = hitOf(candidate, score, tier, bigrams);
    if (opts.skip?.(hit)) return;
    hits.push(hit);
  });

  hits.sort((a, b) => b.score - a.score || (b.date ?? '').localeCompare(a.date ?? ''));
  return hits.slice(0, limit);
}

function hitOf(candidate: Candidate, score: number, tier: 'strong' | 'weak', bigrams: number): RecallHit {
  return {
    file: candidate.file,
    handle: handleOf(candidate.block),
    /** 块的完整标题：调用方靠它把这条对回块里，好取前后几条。 */
    title: candidate.block.title,
    /** 在块里的位置；-1 表示按块比（没有具体条目）。 */
    index: candidate.index,
    date: candidate.block.date,
    text: candidate.text,
    score,
    tier,
    bigrams,
  };
}

/** 这份文件里最近的一天、最早的一天，回执里提一句用。 */
export function spanOf(doc: Doc): { from: string | null; to: string | null } {
  const dates = dayDates(doc);
  return { from: dates[0] ?? null, to: dates.at(-1) ?? null };
}
