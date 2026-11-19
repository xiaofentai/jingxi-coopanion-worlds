/**
 * 出卡：按规则把目录里的记忆裁成一段文本，并在卡尾报出「覆盖」——
 * 哪几天缺、哪天同时出现在两份文件里。
 *
 * 纯函数：只读文件，不写盘、不联网、不调模型；同一批文件每次都要得到逐字相同的结果。
 * 与 `memory-card` 的区别只在最后那一段：卡不再只说「有 N 块没上卡」，还说「11-09 缺了 / 重复了」。
 */
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { archivedDates } from './archive.ts';
import { overSoft, overdueAge, usageOf, windowOf } from './due.ts';
// 本文件里另有一个 `firstLine(file)`（读文件的第一行，列清单用），所以这里起个别名
import { FIRST_LINE_MAX, dayDates, firstLine as firstLineOf, parseDoc, shiftDate, type Doc } from './parse.ts';

/** 软限比例从 `due.ts` 借出去：写入侧和体检都读同一个常量。 */
export { SOFT_RATIO } from './due.ts';

/**
 * ledger 只做索引：`catalog` 每个日期块一行（标题 + 首行），月块 / 清单只给件数。
 * 整份装入是 memory-card 的职责；那些模式不在这里实现，避免同一个概念有两套判据。
 */
export type RuleMode = 'catalog';
/** 超过字数上限时切哪一头：`tail` 断尾（留开头，默认）；`head` 截头（留结尾）。 */
export type Cut = 'head' | 'tail';

export interface Rule {
  path: string;
  mode: RuleMode;
  arg: string;
  maxChars: number;
  cut: Cut;
}

export interface BoardInput {
  /** 绝对路径。 */
  folder: string;
  /** 一行一份：`路径|模式|参数|字数上限|方向`，分号或换行分隔。 */
  rules: string;
  listOthers: boolean;
  listMax: number;
  exclude: string[];
  /** 卡抬头的时间，`MM-DD`。 */
  stamp: string;
  /** `YYYY-MM-DD`：判覆盖用。 */
  today: string;
  language: 'zh' | 'en';
  /** 归档文件的相对路径；给了就把归档里的日期算进覆盖（搬走的天不算缺口）。 */
  archiveFile?: string;
}

export interface Loaded {
  path: string;
  mode: RuleMode;
  /** 实际载入的字数。 */
  kept: number;
  /** 文件本来的字数。 */
  source: number;
  blocks: number;
}

export interface CoverReport {
  /** 最早一天。 */
  from: string | null;
  /** 最晚一天，或今天——文件停在昨天也报出来。 */
  to: string | null;
  /** 区间里没有的那几天。 */
  missing: string[];
  /** 同一天出现在两份以上文件里。 */
  duplicates: Array<{ date: string; files: string[] }>;
}

export interface BoardResult {
  card: string;
  index: string;
  meta: string;
  /** 从规则算出来的口径（几层、各留多少天 / 几条），随设置变。 */
  policy: string;
  loaded: Loaded[];
  missing: string[];
  cover: CoverReport;
}

const MODES: readonly RuleMode[] = ['catalog'];

/*
 * 目录一行留多少字：就是 `FIRST_LINE_MAX`（`parse.ts`）。
 * 不能比首行上限短——不然提示词让人写 50 字，目录却截在 40，等于让人写一句放不下的。
 */
/**
 * 兜底：目录超过这么多行就只显示最近的，并明说。
 * 正常是「窗口天数 + 月份数」约 31 行，200 天不整理也才 200 行——这条只在事故里触发。
 */
const CATALOG_MAX_ROWS = 100;

const TEXT = {
  zh: {
    noFolder: '（记忆树网是空的：没有配置目录。）',
    badFolder: (dir: string) => `（记忆树网：目录读不到 ${dir}。）`,
    empty: '（记忆树网是空的：规则为空，或目录里没有匹配的文件。）',
    missing: (file: string) => `（${file} 不存在，跳过。）`,
    noMarker: (marker: string) => `（没找到「${marker}」，整份载入。）`,
    overLong: (file: string, chars: number, limit: number) =>
      `（${file} 现在 ${chars} 字，超过提醒线 ${limit}。**不截断**，整份都在上面；只是该收一收了。）`,
    catalogDrop: (n: number) => `（异常：目录 ${n} 行没有显示，先整理再往里写。）`,
    headFrom: (title: string) => `（前面已截断；这一段从「${title}」中间开始。）`,
    badRule: (line: string) => `（规则写错了，跳过：${line}）`,
    omittedTitle: '### 未上卡的块',
    omittedLine: (file: string, title: string, chars: number) => `- ${file}：${title} ${chars} 字`,
    omittedOver: (n: number) => `- 另有 ${n} 块没有列出。`,
    dueTitle: '### 该整理的',
    dueLine: (file: string, text: string) => `- ${file}：${text}`,
    dueOver: (n: number) => `- 另有 ${n} 处没有列出。`,
    policyDays: (file: string, days: number) => `${file} 留 ${days} 天`,
    policyCap: (file: string, cap: number) => `${file} 最多 ${cap} 条`,
    policyLine: (parts: string[], empty: boolean) => (empty
      ? '记忆口径：还没有目录规则（整份 / 标记模式不受天数限制）。'
      : `记忆口径（随设置变）：${parts.join('｜')}｜目录一行一块全上卡，超窗口的进「该整理的」`),
    coverTitle: '### 覆盖',
    coverRange: (from: string, to: string) => `记忆覆盖 ${from} ~ ${to}`,
    coverOk: '，没有缺口。',
    coverMissing: (days: string[]) => `，缺 ${days.join('、')}。`,
    coverNone: '记忆树网里没有任何带日期的块。',
    coverDup: (date: string, files: string[]) => `- ${date} 同时出现在 ${files.join(' 与 ')}：该只留在一处。`,
    coverDupTitle: '同一天出现在两份文件里：',
    othersTitle: '### 未载入的文件',
    othersNote: '问到相关的事，先打开对应文件再答。',
    othersOver: (n: number) => `- 另有 ${n} 个文件没有列出。`,
    over: (n: number) => `（还有 ${n} 份因总上限没有载入。）`,
    error: (msg: string) => `（记忆树网生成失败：${msg}）`,
    meta: (files: number, chars: number, omitted: number, holes: number, due: number, long: number, stamp: string) => {
      const parts = [`读取 ${files} 份`, `${chars} 字`];
      if (omitted > 0) parts.push(`${omitted} 块未上卡`);
      if (due > 0) parts.push(`该整理 ${due} 处`);
      if (long > 0) parts.push(`${long} 份偏长`);
      if (holes > 0) parts.push(`缺 ${holes} 天`);
      parts.push(stamp);
      return parts.join(' / ');
    },
    metaEmpty: (stamp: string) => `没有载入任何文件 / ${stamp}`,
    untitled: '（没有标题）',
  },
  en: {
    noFolder: '(Memory Graph is empty: no folder is configured.)',
    badFolder: (dir: string) => `(Memory Graph: the folder cannot be read: ${dir}.)`,
    empty: '(Memory Graph is empty: no rules, or nothing in the folder matches them.)',
    missing: (file: string) => `(${file} is missing; skipped.)`,
    noMarker: (marker: string) => `("${marker}" not found; the whole file is loaded.)`,
    overLong: (file: string, chars: number, limit: number) =>
      `(${file} is now ${chars} characters, past the ${limit} reminder line. **Nothing is truncated** — it is all above; it is just time to trim it.)`,
    catalogDrop: (n: number) => `(The ${n} older days are not on the board; see "Blocks not on the board" at the end.)`,
    headFrom: (title: string) => `(The beginning is cut; this part starts in the middle of "${title}".)`,
    badRule: (line: string) => `(Bad rule, skipped: ${line})`,
    omittedTitle: '### Blocks not on the board',
    omittedLine: (file: string, title: string, chars: number) => `- ${file}: ${title} (${chars} characters)`,
    omittedOver: (n: number) => `- ${n} more blocks are not listed.`,
    dueTitle: '### Due for tidying',
    dueLine: (file: string, text: string) => `- ${file}: ${text}`,
    dueOver: (n: number) => `- ${n} more are not listed.`,
    policyDays: (file: string, days: number) => `${file}: ${days} days`,
    policyCap: (file: string, cap: number) => `${file}: ${cap} entries at most`,
    policyLine: (parts: string[], empty: boolean) => (empty
      ? 'Memory policy: no catalog rule yet (whole / marker modes are not limited by days).'
      : `Memory policy (follows the settings): ${parts.join(' | ')} | one line per block, nothing dropped; overdue items go to "Due for tidying"`),
    coverTitle: '### Coverage',
    coverRange: (from: string, to: string) => `Memory covers ${from} to ${to}`,
    coverOk: ', no gaps.',
    coverMissing: (days: string[]) => `, missing ${days.join(', ')}.`,
    coverNone: 'No dated block is on the graph.',
    coverDup: (date: string, files: string[]) => `- ${date} is in both ${files.join(' and ')}: it belongs in one place.`,
    coverDupTitle: 'The same day appears in two files:',
    othersTitle: '### Files not loaded',
    othersNote: 'Open the file before answering anything about it.',
    othersOver: (n: number) => `- ${n} more files are not listed.`,
    over: (n: number) => `(${n} more files did not fit under the total limit.)`,
    error: (msg: string) => `(Building the graph failed: ${msg})`,
    meta: (files: number, chars: number, omitted: number, holes: number, due: number, long: number, stamp: string) => {
      const parts = [`${files} files`, `${chars} characters`];
      if (omitted > 0) parts.push(`${omitted} blocks not on the board`);
      if (due > 0) parts.push(`${due} to tidy`);
      if (long > 0) parts.push(`${long} running long`);
      if (holes > 0) parts.push(`${holes} days missing`);
      parts.push(stamp);
      return parts.join(' / ');
    },
    metaEmpty: (stamp: string) => `nothing loaded / ${stamp}`,
    untitled: '(untitled)',
  },
} as const;

export function parseRules(text: string): { rules: Rule[]; errors: string[] } {
  const rules: Rule[] = [];
  const errors: string[] = [];
  for (const raw of text.split(/[;；\n]+/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('|').map((s) => s.trim());
    const [path = '', mode = '', arg = '', max = '', cut = ''] = parts;
    const maxChars = max === '' ? 0 : /^\d+$/.test(max) ? Number(max) : Number.NaN;
    const cutSide: Cut = cut === '' ? 'tail' : (cut as Cut);
    if (
      parts.length < 4 || parts.length > 5 || !path || !MODES.includes(mode as RuleMode)
      || !Number.isFinite(maxChars) || maxChars < 0 || (cutSide !== 'head' && cutSide !== 'tail')
    ) {
      errors.push(line);
      continue;
    }
    rules.push({ path: path.replaceAll('\\', '/'), mode: mode as RuleMode, arg, maxChars, cut: cutSide });
  }
  return { rules, errors };
}

interface Read {
  doc: Doc;
  mtime: string;
}

function readOne(file: string, rel: string, today: string): Read | null {
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return null;
    let text = readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const two = (n: number) => String(n).padStart(2, '0');
    const mtime = `${two(stat.mtime.getMonth() + 1)}-${two(stat.mtime.getDate())} ${two(stat.mtime.getHours())}:${two(stat.mtime.getMinutes())}`;
    return { doc: parseDoc(text, rel, Number(today.slice(0, 4)), today), mtime };
  } catch {
    return null;
  }
}

/** 覆盖：所有日块合起来，区间里缺哪天、哪天重复。 */
export function coverOf(
  docs: readonly Doc[],
  today: string,
  language: 'zh' | 'en' = 'zh',
  /** 已经搬进归档的日期：它们不在规则文件里了，但不算缺口。 */
  archived: readonly string[] = [],
): CoverReport {
  const t = TEXT[language];
  const archivedSet = new Set(archived);
  const files = new Map<string, string[]>();
  for (const doc of docs) {
    for (const date of dayDates(doc)) {
      const list = files.get(date) ?? [];
      if (!list.includes(doc.path)) list.push(doc.path);
      files.set(date, list);
    }
  }
  const dates = [...files.keys()].sort();
  const duplicates = dates
    .filter((date) => (files.get(date) ?? []).length > 1)
    .map((date) => ({ date, files: files.get(date) ?? [] }));
  if (!dates.length) return { from: null, to: null, missing: [], duplicates };

  const from = dates[0];
  const latest = dates[dates.length - 1];
  const to = latest > today ? latest : today;
  const missing: string[] = [];
  for (let at = from; at <= to; at = shiftDate(at, 1)) {
    // 规则文件里没有、但归档里有 → 那天是搬走了，不是丢了
    if (!files.has(at) && !archivedSet.has(at)) missing.push(at);
    // 区间超过一年说明日期解析有问题，别无限循环
    if (missing.length > 400) break;
  }
  void t;
  return { from, to, missing, duplicates };
}

function coverSection(cover: CoverReport, language: 'zh' | 'en'): string {
  const t = TEXT[language];
  if (!cover.from || !cover.to) return `${t.coverTitle}\n${t.coverNone}`;
  const short = (date: string) => date.slice(5);
  const head = `${t.coverRange(short(cover.from), short(cover.to))}${cover.missing.length ? t.coverMissing(cover.missing.map(short)) : t.coverOk}`;
  if (!cover.duplicates.length) return [t.coverTitle, head].join('\n');
  return [
    t.coverTitle,
    head,
    '',
    t.coverDupTitle,
    ...cover.duplicates.map((dup) => t.coverDup(short(dup.date), dup.files)),
  ].join('\n');
}

interface Picked {
  text: string;
  blocks: number;
  /** 极端情况下目录超过 100 行，丢掉的行数必须报出来，不能静默。 */
  dropped?: number;
}

/**
 * 目录的一行。
 *
 * 日块：`11-08 这一天的一句话`——首行本来就是为索引写的。
 * 特殊块：`还挂着 手上几件挂着的…`——它也有自己的首行。
 * **月块：`2026-11（26 件）`，不带首行。** 它没有「这个月的一句话」这个位置，
 * 取首行只会拿到最旧的那一条，既占字数又不代表这个月；件数才是它该给的量感。
 */
function catalogRows(doc: Doc): Array<{ block: Block; line: string; chars: number }> {
  return doc.blocks.map((block) => {
    // 目录行的前缀尽量短：日块 `11-08`、月块 `2026-10`、特殊块用原名
    const handle = block.kind === 'special'
      ? block.title
      : block.kind === 'day' ? (block.date ?? block.title).slice(5) : (block.date ?? block.title);
    const month = block.kind === 'month';
    const flat = month ? '' : firstLineOf(block).replace(/\s+/g, ' ');
    const clipped = flat.length > FIRST_LINE_MAX ? `${flat.slice(0, FIRST_LINE_MAX)}…` : flat;
    const count = month ? `（${block.entries.length} 件）` : '';
    return { block, line: clipped ? `${handle} ${clipped}${count}` : `${handle}${count}`, chars: block.heading.length + 1 + block.body.length };
  });
}

/**
 * 目录：每个块只出一行「标题 + 首行」，**全部出，不按预算丢**。
 *
 * 这是这一版的根本区别：`whole` 按**字数**切文本（切掉的不报），上一版 `catalog` 按预算丢最旧（会报，但仍是丢）。
 * 现在一个块也不丢——行数增长是「一天一行」，不整理一个月也才 30 行。
 * 「哪些该搬到下一份」由 `dueOf` 算成待办，进卡尾的「该整理的」，不靠从卡上抹掉来说话。
 */
function catalogOf(doc: Doc): Picked {
  const rows = catalogRows(doc);
  if (!rows.length) return { text: '', blocks: 0 };
  const kept = rows.slice(Math.max(0, rows.length - CATALOG_MAX_ROWS));
  return {
    text: kept.map((row) => row.line).join('\n'),
    blocks: kept.length,
    ...(rows.length > kept.length ? { dropped: rows.length - kept.length } : {}),
  };
}

/**
 * 该整理什么：窗口外的天、超额的条目。
 *
 * 只算账，不动卡——报出来比从卡上抹掉有效（抹掉就变成「她不知道自己不知道」）。
 * 「算不算到期」由 `due.ts` 定义，这里只负责措辞。
 */
function dueOf(rule: Rule, doc: Doc, today: string): string[] {
  const out: string[] = [];
  const window = windowOf(rule);
  for (const block of doc.blocks) {
    const day = overdueAge(block, window, today);
    if (day === null) continue;
    out.push(
      `${handleOfBlock(block)} 已第 ${day} 天（窗口 ${window} 天），${block.heading.length + 1 + block.body.length} 字`,
    );
  }
  const usage = usageOf(rule, doc);
  if (usage && overSoft(usage)) {
    out.push(`已到 ${usage.value}/${usage.cap} ${usage.unit}（${Math.round((usage.value / usage.cap) * 100)}%）：该压一压或替换掉一些`);
  }
  return out;
}

/** 块在目录/报账里的短名。 */
function handleOfBlock(block: Block): string {
  if (block.kind === 'special') return block.title;
  return block.kind === 'day' ? (block.date ?? block.title).slice(5) : (block.date ?? block.title);
}

function pick(doc: Doc, _rule: Rule): Picked {
  return catalogOf(doc);
}



function omittedSection(list: Array<{ file: string; title: string; chars: number }>, max: number, language: 'zh' | 'en'): string {
  const t = TEXT[language];
  if (!list.length) return '';
  const shown = max > 0 ? list.slice(0, max) : [];
  const lines = shown.map((block) => t.omittedLine(block.file, block.title || t.untitled, block.chars));
  const rest = list.length - shown.length;
  if (rest > 0) lines.push(t.omittedOver(rest));
  return [t.omittedTitle, ...lines].join('\n');
}

/** 「该整理的」：窗口外的天、超额的条目。只报账，不从卡上抹掉任何东西。 */
function dueSection(list: Array<{ file: string; text: string }>, max: number, language: 'zh' | 'en'): string {
  const t = TEXT[language];
  if (!list.length) return '';
  const shown = max > 0 ? list.slice(0, max) : [];
  const lines = shown.map((item) => t.dueLine(item.file, item.text));
  const rest = list.length - shown.length;
  if (rest > 0) lines.push(t.dueOver(rest));
  return [t.dueTitle, ...lines].join('\n');
}

function listOthers(
  folder: string,
  exclude: string[],
  known: Set<string>,
  max: number,
  language: 'zh' | 'en',
): { index: string; others: string[] } {
  const t = TEXT[language];
  const skip = new Set(exclude.map((name) => name.trim().toLowerCase()).filter(Boolean));
  const found: Array<{ rel: string; label: string }> = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 2) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.') || skip.has(name.toLowerCase())) continue;
      const full = join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!stat.isFile() || !name.toLowerCase().endsWith('.md') || stat.size > 200_000) continue;
      const rel = relative(folder, full).split(sep).join('/');
      if (known.has(rel)) continue;
      found.push({ rel, label: firstLine(full) });
    }
  };
  walk(folder, 0);

  const shown = found.slice(0, Math.max(0, max));
  const lines = shown.map(({ rel, label }) => (label ? `- ${rel}：${label}` : `- ${rel}`));
  const rest = found.length - shown.length;
  if (rest > 0) lines.push(t.othersOver(rest));
  if (!lines.length) return { index: '', others: [] };
  return { index: [t.othersTitle, ...lines, '', t.othersNote].join('\n'), others: shown.map((f) => f.rel) };
}

function firstLine(file: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(4096);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, read).toString('utf8').split('\n')) {
      const cleaned = line.replace(/^#+\s*/, '').trim();
      if (cleaned) return cleaned.length > 60 ? `${cleaned.slice(0, 60)}…` : cleaned;
    }
    return '';
  } catch {
    return '';
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function blank(text: string): BoardResult {
  return { card: text, index: '', meta: '', policy: '', loaded: [], missing: [], cover: { from: null, to: null, missing: [], duplicates: [] } };
}

/** 口径：从规则里直接读出来，不再让人手写天数。 */
function policyOf(rules: readonly Rule[], language: 'zh' | 'en'): string {
  const t = TEXT[language];
  const parts: string[] = [];
  for (const rule of rules) {
    const days = Number.parseInt(rule.arg.trim(), 10);
    if (Number.isFinite(days) && days > 0) parts.push(t.policyDays(rule.path, days));
    if (rule.maxChars > 0) parts.push(t.policyCap(rule.path, rule.maxChars));
  }
  return t.policyLine(parts, parts.length === 0);
}

function resolveFolder(folder: string): string | null {
  const trimmed = folder.trim();
  return trimmed ? resolve(trimmed) : null;
}

function resolveIn(folder: string, rel: string): string | null {
  if (!rel || isAbsolute(rel)) return null;
  // 两边都 resolve 再比：配置里可能写 `C:/a/b`，而 resolve 给出 `C:\a\b\...`，
  // 拿原字符串拼前缀会永远不比上——结果是整张板静默空着。
  const base = resolve(folder);
  const full = resolve(base, rel);
  return full.startsWith(`${base}${sep}`) ? full : null;
}

export function buildBoard(input: BoardInput): BoardResult {
  const t = TEXT[input.language];
  try {
    const folder = resolveFolder(input.folder);
    if (!folder) return blank(t.noFolder);
    if (!existsSync(folder) || !statSync(folder).isDirectory()) return blank(t.badFolder(folder));

    const { rules, errors } = parseRules(input.rules);
    const notes = errors.map((line) => t.badRule(line));
    const loaded: Loaded[] = [];
    const missing: string[] = [];
    const sections: string[] = [];
    const due: Array<{ file: string; text: string }> = [];
    const docs: Doc[] = [];
    let chars = 0;

    for (const rule of rules) {
      const file = resolveIn(folder, rule.path);
      if (!file) {
        notes.push(t.badRule(rule.path));
        continue;
      }
      const read = readOne(file, rule.path, input.today);
      if (!read) {
        missing.push(rule.path);
        notes.push(t.missing(rule.path));
        continue;
      }
      docs.push(read.doc);
      const picked = pick(read.doc, rule);
      const section = [
        `### ${rule.path}（${read.mtime}）`,
        '',
        picked.text,
        ...(picked.dropped ? ['', t.catalogDrop(picked.dropped)] : []),
      ].join('\n');
      chars += section.length;
      sections.push(section);
      for (const text of dueOf(rule, read.doc, input.today)) due.push({ file: rule.path, text });
      loaded.push({ path: rule.path, mode: rule.mode, kept: picked.text.length, source: read.doc.text.length, blocks: picked.blocks });
    }

    if (!sections.length) notes.push(t.empty);

    const archived = input.archiveFile
      ? archivedDates(folder, input.archiveFile, Number(input.today.slice(0, 4)))
      : [];
    const cover = coverOf(docs, input.today, input.language, archived);
    const known = new Set(rules.map((r) => r.path));
    const listing = input.listOthers ? listOthers(folder, input.exclude, known, input.listMax, input.language) : { index: '', others: [] };
    const dueText = dueSection(due, input.listMax, input.language);

    const card = [
      ...sections,
      ...notes,
      ...(dueText ? [dueText] : []),
      coverSection(cover, input.language),
    ].join('\n\n').trim();

    return {
      card,
      policy: policyOf(rules, input.language),
      index: listing.index,
      meta: loaded.length
        ? t.meta(loaded.length, chars, 0, cover.missing.length, due.length, 0, input.stamp)
        : t.metaEmpty(input.stamp),
      loaded,
      missing,
      cover,
    };
  } catch (err) {
    return blank(t.error(err instanceof Error ? err.message : String(err)));
  }
}
