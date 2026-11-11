/**
 * 出卡：按规则把目录里的记忆裁成一段文本，并在卡尾报出「覆盖」——
 * 哪几天缺、哪天同时出现在两份文件里。
 *
 * 纯函数：只读文件，不写盘、不联网、不调模型；同一批文件每次都要得到逐字相同的结果。
 * 与 `memory-card` 的区别只在最后那一段：卡不再只说「有 N 块没上卡」，还说「11-09 缺了 / 重复了」。
 */
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { dayDates, parseDoc, shiftDate, type Doc } from './parse.ts';

/**
 * `whole` 整份；`marker` 取到某个标题之前；`newest` 取日期最新的几块；
 * `newest+pin` 再固定带上某几块；`catalog` 每个日期块只出一行（标题 + 首行）。
 */
export type RuleMode = 'whole' | 'marker' | 'newest' | 'newest+pin' | 'catalog';
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

const MODES: readonly RuleMode[] = ['whole', 'marker', 'newest', 'newest+pin', 'catalog'];

/** `catalog` 每行留多少字：够写一句「这一天」，又不至于吃掉下一天。 */
const CATALOG_LINE = 40;
/**
 * 兜底：目录超过这么多行就只显示最近的，并明说。
 * 正常是「窗口天数 + 月份数」约 31 行，200 天不整理也才 200 行——这条只在事故里触发。
 */
const CATALOG_MAX_ROWS = 100;

const TEXT = {
  zh: {
    noFolder: '（记忆板是空的：没有配置目录。）',
    badFolder: (dir: string) => `（记忆板：目录读不到 ${dir}。）`,
    empty: '（记忆板是空的：规则为空，或目录里没有匹配的文件。）',
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
    coverNone: '记忆板里没有任何带日期的块。',
    coverDup: (date: string, files: string[]) => `- ${date} 同时出现在 ${files.join(' 与 ')}：该只留在一处。`,
    coverDupTitle: '同一天出现在两份文件里：',
    othersTitle: '### 未载入的文件',
    othersNote: '问到相关的事，先打开对应文件再答。',
    othersOver: (n: number) => `- 另有 ${n} 个文件没有列出。`,
    over: (n: number) => `（还有 ${n} 份因总上限没有载入。）`,
    error: (msg: string) => `（记忆板生成失败：${msg}）`,
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
    noFolder: '(The board is empty: no folder is configured.)',
    badFolder: (dir: string) => `(Memory board: the folder cannot be read: ${dir}.)`,
    empty: '(The board is empty: no rules, or nothing in the folder matches them.)',
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
    coverNone: 'No dated block is on the board.',
    coverDup: (date: string, files: string[]) => `- ${date} is in both ${files.join(' and ')}: it belongs in one place.`,
    coverDupTitle: 'The same day appears in two files:',
    othersTitle: '### Files not loaded',
    othersNote: 'Open the file before answering anything about it.',
    othersOver: (n: number) => `- ${n} more files are not listed.`,
    over: (n: number) => `(${n} more files did not fit under the total limit.)`,
    error: (msg: string) => `(Building the board failed: ${msg})`,
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

function readOne(file: string, rel: string): Read | null {
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return null;
    let text = readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const two = (n: number) => String(n).padStart(2, '0');
    const mtime = `${two(stat.mtime.getMonth() + 1)}-${two(stat.mtime.getDate())} ${two(stat.mtime.getHours())}:${two(stat.mtime.getMinutes())}`;
    return { doc: parseDoc(text, rel, stat.mtime.getFullYear()), mtime };
  } catch {
    return null;
  }
}

/** 覆盖：所有日块合起来，区间里缺哪天、哪天重复。 */
export function coverOf(docs: readonly Doc[], today: string, language: 'zh' | 'en' = 'zh'): CoverReport {
  const t = TEXT[language];
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
    if (!files.has(at)) missing.push(at);
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

/**
 * 整份交给卡：**不截断**。
 *
 * 以前 `路径|whole||1600` 会切到 1600 字，切掉的部分只在卡上说一句「已截断」——
 * 那也是一种静默丢内容。现在这个数字改成**提醒线**：照给全文，只在超了的时候提一句该收了。
 */
function whole(text: string): { text: string; truncated: number; cut: Cut } {
  return { text: text.trim(), truncated: 0, cut: 'tail' };
}

interface Picked {
  text: string;
  truncated: number;
  cut: Cut;
  from?: string;
  blocks: number;
  note?: 'no-marker';
  /** `catalog` 超预算时丢掉的天数：必须在卡上报出来，不能静默。 */
  dropped?: number;
  omitted?: Array<{ title: string; chars: number }>;
}

/** 目录的一行：短日期 + 那天的首行（超长就截断）。 */
function catalogRows(doc: Doc): Array<{ block: Block; line: string; chars: number }> {
  return doc.blocks.map((block) => {
    // 目录行的前缀尽量短：日块 `11-08`、月块 `2026-10`、特殊块用原名
    const handle = block.kind === 'special'
      ? block.title
      : block.kind === 'day' ? (block.date ?? block.title).slice(5) : (block.date ?? block.title);
    const first = block.body.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
    const flat = first.replace(/^[-*]\s+/, '').replace(/\s+/g, ' ').trim();
    const clipped = flat.length > CATALOG_LINE ? `${flat.slice(0, CATALOG_LINE)}…` : flat;
    return { block, line: clipped ? `${handle} ${clipped}` : handle, chars: block.heading.length + 1 + block.body.length };
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
  if (!rows.length) return { text: '', truncated: 0, cut: 'head', blocks: 0 };
  const kept = rows.slice(Math.max(0, rows.length - CATALOG_MAX_ROWS));
  return {
    text: kept.map((row) => row.line).join('\n'),
    truncated: 0,
    cut: 'head',
    blocks: kept.length,
    ...(rows.length > kept.length ? { dropped: rows.length - kept.length } : {}),
  };
}

/** 两个 `YYYY-MM-DD` 相差几天（`to` 减 `from`）。 */
function daysBetween(from: string, to: string): number {
  const at = Date.UTC(...(from.split('-').map(Number) as [number, number, number]));
  const bt = Date.UTC(...(to.split('-').map(Number) as [number, number, number]));
  return Math.round((bt - at) / 86_400_000);
}

/**
 * 该整理什么：目录窗口外的天、超额的条目。
 *
 * 只算账，不动卡——报出来比从卡上抹掉有效（抹掉就变成「她不知道自己不知道」）。
 */
function dueOf(rule: Rule, doc: Doc, today: string, entries: number): string[] {
  const out: string[] = [];
  const window = Number.parseInt(rule.arg.trim(), 10);
  if (Number.isFinite(window) && window > 0) {
    for (const block of doc.blocks) {
      if (block.kind !== 'day' || !block.date) continue;
      const age = daysBetween(block.date, today);
      if (age >= window) out.push(`${handleOfBlock(block)} 已第 ${age + 1} 天（窗口 ${window} 天），${block.heading.length + 1 + block.body.length} 字`);
    }
  }
  if (rule.maxChars > 0 && entries > rule.maxChars) out.push(`共 ${entries} 条（上限 ${rule.maxChars}）`);
  return out;
}

/** 块在目录/报账里的短名。 */
function handleOfBlock(block: Block): string {
  if (block.kind === 'special') return block.title;
  return block.kind === 'day' ? (block.date ?? block.title).slice(5) : (block.date ?? block.title);
}

function pick(doc: Doc, rule: Rule): Picked {
  if (rule.mode === 'whole') return { ...whole(doc.text), blocks: 0 };
  if (rule.mode === 'catalog') return catalogOf(doc);
  if (rule.mode === 'marker') {
    const marker = rule.arg.trim();
    if (!marker) return { ...whole(doc.text), blocks: 0 };
    const at = doc.text.split('\n').findIndex((line) => line.trimStart().startsWith(marker));
    if (at < 0) return { ...whole(doc.text), blocks: 0, note: 'no-marker' };
    return { ...whole(doc.text.split('\n').slice(0, at).join('\n')), blocks: 0 };
  }

  // 分块模式：按日期取最新的几块，保持文件里的原顺序
  const parts = rule.arg.split(',');
  const asked = Number.parseInt(parts[0]?.trim() ?? '', 10);
  const count = Number.isFinite(asked) && asked > 0 ? asked : 2;
  const ranked = doc.blocks.filter((b) => b.key > 0).sort((a, b) => b.key - a.key);
  const chosen = new Set(ranked.slice(0, count));
  const pin = (parts[1] ?? '').trim();
  if (rule.mode === 'newest+pin' && pin) {
    for (const block of doc.blocks) if (block.title.includes(pin)) chosen.add(block);
  }
  const picked = doc.blocks.filter((b) => chosen.has(b));

  const front = doc.front.trim() ? `${doc.front.trimEnd()}\n\n` : '';
  const joined = front + picked.map((b) => `${b.heading}\n${b.body}`).join('');
  const onCard = new Set(picked);
  const omitted = doc.blocks
    .filter((block) => !onCard.has(block) && block.key > 0)
    .map((block) => ({ title: block.title, chars: block.heading.length + 1 + block.body.length }));
  return {
    text: joined.trim(),
    truncated: 0,
    cut: 'tail',
    blocks: picked.length,
    ...(omitted.length ? { omitted } : {}),
  };
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
    if (rule.mode !== 'catalog') continue;
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
  const full = resolve(folder, rel);
  const prefix = folder.endsWith(sep) ? folder : `${folder}${sep}`;
  return full === folder || full.startsWith(prefix) ? full : null;
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
    const omitted: Array<{ file: string; title: string; chars: number }> = [];
    const due: Array<{ file: string; text: string }> = [];
    const docs: Doc[] = [];
    let chars = 0;
    let long = 0;

    for (const rule of rules) {
      const file = resolveIn(folder, rule.path);
      if (!file) {
        notes.push(t.badRule(rule.path));
        continue;
      }
      const read = readOne(file, rule.path);
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
        ...(picked.from ? [t.headFrom(picked.from), ''] : []),
        picked.text,
        ...(picked.note === 'no-marker' ? ['', t.noMarker(rule.arg)] : []),
        ...(picked.dropped ? ['', t.catalogDrop(picked.dropped)] : []),
        // 第四段现在是「提醒线」：超了照给全文，只提一句（catalog 的第四段是条目数，另算）
        ...(rule.mode !== 'catalog' && rule.maxChars > 0 && picked.text.length > rule.maxChars
          ? ['', t.overLong(rule.path, picked.text.length, rule.maxChars)]
          : []),
      ].join('\n');
      if (rule.mode !== 'catalog' && rule.maxChars > 0 && picked.text.length > rule.maxChars) long += 1;
      chars += section.length;
      sections.push(section);
      for (const block of picked.omitted ?? []) omitted.push({ file: rule.path, ...block });
      // 目录只算账、不剪卡：窗口外的天与超额条目进「该整理的」
      if (rule.mode === 'catalog') {
        const entries = read.doc.blocks.reduce((n, block) => n + block.entries.length, 0);
        for (const text of dueOf(rule, read.doc, input.today, entries)) due.push({ file: rule.path, text });
      }
      loaded.push({ path: rule.path, mode: rule.mode, kept: picked.text.length, source: read.doc.text.length, blocks: picked.blocks });
    }

    if (!sections.length) notes.push(t.empty);

    const cover = coverOf(docs, input.today, input.language);
    const known = new Set(rules.map((r) => r.path));
    const listing = input.listOthers ? listOthers(folder, input.exclude, known, input.listMax, input.language) : { index: '', others: [] };
    const omittedText = omittedSection(omitted, input.listMax, input.language);
    const dueText = dueSection(due, input.listMax, input.language);

    const card = [
      ...sections,
      ...notes,
      ...(omittedText ? [omittedText] : []),
      ...(dueText ? [dueText] : []),
      coverSection(cover, input.language),
    ].join('\n\n').trim();

    return {
      card,
      policy: policyOf(rules, input.language),
      index: listing.index,
      meta: loaded.length
        ? t.meta(loaded.length, chars, omitted.length, cover.missing.length, due.length, long, input.stamp)
        : t.metaEmpty(input.stamp),
      loaded,
      missing,
      cover,
    };
  } catch (err) {
    return blank(t.error(err instanceof Error ? err.message : String(err)));
  }
}
