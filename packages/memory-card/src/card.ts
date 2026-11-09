/**
 * 记忆卡：把目录里的 Markdown 按规则裁成一段文本，供 World 在构建系统前缀时使用。
 *
 * 纯函数：只读文件，不联网、不调模型、不写盘。同一批文件每次都要得到逐字相同的结果，
 * 所以排序、分块和截断都不依赖遍历顺序，也不读时钟以外的环境。
 */
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** `whole` 整份；`marker` 取到某个标题之前；`newest` 取日期最新的几块；`newest+pin` 再固定带上某几块。 */
export type RuleMode = 'whole' | 'marker' | 'newest' | 'newest+pin';

/** 超过字数上限时切哪一头：`tail` 断尾（留开头，默认）；`head` 截头（留结尾）。 */
export type Cut = 'head' | 'tail';

export interface Rule {
  /** 相对目录，`/` 分隔。 */
  path: string;
  mode: RuleMode;
  /** `marker` 的标题；`newest` 的块数；`newest+pin` 的「块数,固定块标题」。 */
  arg: string;
  /** 这一份的字数上限；0 表示不单独限制，只受整张卡的上限约束。 */
  maxChars: number;
  /** 超限时切哪一头；默认 `tail`，写 `head` 则留结尾。 */
  cut: Cut;
}

export interface CardInput {
  /** 绝对路径。 */
  folder: string;
  /** 一行一份：`路径|模式|参数|字数上限`，分号或换行分隔。 */
  rules: string;
  /** 整张卡的字数上限；超了从最后一条规则开始丢。 */
  totalChars: number;
  listOthers: boolean;
  listMax: number;
  /** 目录名，大小写不敏感。 */
  exclude: string[];
  /** 卡片抬头的时间，`MM-DD HH:mm`。 */
  stamp: string;
  language: 'zh' | 'en';
}

export interface LoadedFile {
  path: string;
  mode: RuleMode;
  /** 实际载入的字数。 */
  kept: number;
  /** 文件本来的字数。 */
  source: number;
  /** 载入的块数，非分块模式为 0。 */
  blocks: number;
}

export interface CardResult {
  card: string;
  index: string;
  meta: string;
  loaded: LoadedFile[];
  missing: string[];
  others: string[];
}

interface Block {
  title: string;
  text: string;
  /** 标题里的日期，越大越新；没有日期为 0。 */
  key: number;
}

const MODES: readonly RuleMode[] = ['whole', 'marker', 'newest', 'newest+pin'];

const TEXT = {
  zh: {
    noFolder: '（记忆卡是空的：没有配置目录。）',
    badFolder: (dir: string) => `（记忆卡：目录读不到 ${dir}。）`,
    empty: '（记忆卡是空的：规则为空，或目录里没有匹配的文件。）',
    missing: (file: string) => `（${file} 不存在，跳过。）`,
    noMarker: (marker: string) => `（没找到「${marker}」，整份载入。）`,
    truncated: (n: number, file: string, at: Cut) =>
      at === 'head'
        ? `（已截断：前面还有 ${n} 字未载入，用 read_file 查看 ${file}。）`
        : `（已截断：还有 ${n} 字未载入，用 read_file 查看 ${file}。）`,
    headFrom: (title: string) => `（前面已截断；这一段从「${title}」中间开始。）`,
    badRule: (line: string) => `（规则写错了，跳过：${line}）`,
    omittedTitle: '### 未上卡的块',
    omittedLine: (file: string, title: string, chars: number) => `- ${file}：${title} ${chars} 字`,
    omittedOver: (n: number) => `- 另有 ${n} 块没有列出。`,
    omittedNote: '这些块没进卡。整理记忆、或问到相关的事时，先打开对应文件读一遍；卡是交接时生成的，未必是此刻的样子。',
    untitled: '（没有标题）',
    othersTitle: '### 未载入的文件',
    othersNote: '问到相关的事，先打开对应文件再答。',
    othersOver: (n: number) => `- 另有 ${n} 个文件没有列出。`,
    over: (n: number) => `（还有 ${n} 份因总上限没有载入。）`,
    error: (msg: string) => `（记忆卡生成失败：${msg}）`,
    meta: (files: number, chars: number, omitted: number, stamp: string) =>
      omitted > 0
        ? `读取 ${files} 份 / ${chars} 字 / ${omitted} 块未上卡 / ${stamp}`
        : `读取 ${files} 份 / ${chars} 字 / ${stamp}`,
    metaEmpty: (stamp: string) => `没有载入任何文件 / ${stamp}`,
  },
  en: {
    noFolder: '(The card is empty: no folder is configured.)',
    badFolder: (dir: string) => `(Memory card: the folder cannot be read: ${dir}.)`,
    empty: '(The card is empty: no rules, or nothing in the folder matches them.)',
    missing: (file: string) => `(${file} is missing; skipped.)`,
    noMarker: (marker: string) => `("${marker}" not found; the whole file is loaded.)`,
    truncated: (n: number, file: string, at: Cut) =>
      at === 'head'
        ? `(Truncated: the first ${n} characters are not here; use read_file for ${file}.)`
        : `(Truncated: ${n} characters are not here; use read_file for ${file}.)`,
    headFrom: (title: string) => `(The beginning is cut; this part starts in the middle of "${title}".)`,
    badRule: (line: string) => `(Bad rule, skipped: ${line})`,
    omittedTitle: '### Blocks not on the card',
    omittedLine: (file: string, title: string, chars: number) => `- ${file}: ${title} (${chars} characters)`,
    omittedOver: (n: number) => `- ${n} more blocks are not listed.`,
    omittedNote: 'These blocks are not on the card. Before tidying the memory, or when a question is about them, open the files: the card was built at the handoff and may be old.',
    untitled: '(untitled)',
    othersTitle: '### Files not loaded',
    othersNote: 'Open the file before answering anything about it.',
    othersOver: (n: number) => `- ${n} more files are not listed.`,
    over: (n: number) => `(${n} more files did not fit under the total limit.)`,
    error: (msg: string) => `(Building the card failed: ${msg})`,
    meta: (files: number, chars: number, omitted: number, stamp: string) =>
      omitted > 0
        ? `${files} files / ${chars} characters / ${omitted} blocks not on the card / ${stamp}`
        : `${files} files / ${chars} characters / ${stamp}`,
    metaEmpty: (stamp: string) => `nothing loaded / ${stamp}`,
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
    // 留空 = 不单独限制；填了就必须是纯数字，`600；xxx` 这种半截数字不能当成 600
    const maxChars = max === '' ? 0 : /^\d+$/.test(max) ? Number(max) : Number.NaN;
    // 第 5 列可省；省了就是断尾（留开头）
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

export function buildCard(input: CardInput): CardResult {
  const t = TEXT[input.language];
  try {
    const folder = resolveFolder(input.folder);
    if (!folder) return blank(t.noFolder);
    if (!existsSync(folder) || !statSync(folder).isDirectory()) return blank(t.badFolder(folder));

    const { rules, errors } = parseRules(input.rules);
    const notes = errors.map((line) => t.badRule(line));
    const loaded: LoadedFile[] = [];
    const missing: string[] = [];
    const sections: string[] = [];
    const omitted: Array<{ file: string; title: string; chars: number }> = [];
    let chars = 0;
    let dropped = 0;
    let full = false;

    for (const rule of rules) {
      if (full) {
        dropped += 1;
        continue;
      }
      const file = resolveIn(folder, rule.path);
      if (!file) {
        notes.push(t.badRule(rule.path));
        continue;
      }
      const text = readText(file);
      if (!text) {
        missing.push(rule.path);
        notes.push(t.missing(rule.path));
        continue;
      }
      const picked = pick(text.text, rule);
      const section = [
        `### ${rule.path}（${text.mtime}）`,
        '',
        ...(picked.from ? [t.headFrom(picked.from), ''] : []),
        picked.text,
        ...(picked.note === 'no-marker' ? ['', t.noMarker(rule.arg)] : []),
        ...(picked.truncated > 0 ? ['', t.truncated(picked.truncated, rule.path, picked.cut)] : []),
      ].join('\n');
      if (chars + section.length > input.totalChars) {
        full = true;
        dropped += 1;
        continue;
      }
      chars += section.length;
      sections.push(section);
      for (const block of picked.omitted ?? []) omitted.push({ file: rule.path, ...block });
      loaded.push({ path: rule.path, mode: rule.mode, kept: picked.text.length, source: text.text.length, blocks: picked.blocks });
    }

    if (!sections.length) notes.push(t.empty);
    if (dropped > 0) notes.push(t.over(dropped));

    const known = new Set(rules.map((r) => r.path));
    const listing = input.listOthers ? listOthers(folder, input.exclude, known, input.listMax, input.language) : { index: '', others: [] };

    const omittedSection = omittedBlockList(omitted, input.listMax, t);
    const card = [...sections, ...notes, ...(omittedSection ? [omittedSection] : [])].join('\n\n').trim();
    return {
      card,
      index: listing.index,
      meta: loaded.length ? t.meta(loaded.length, chars, omitted.length, input.stamp) : t.metaEmpty(input.stamp),
      loaded,
      missing,
      others: listing.others,
    };
  } catch (err) {
    return blank(t.error(err instanceof Error ? err.message : String(err)));
  }
}

function blank(card: string): CardResult {
  return { card, index: '', meta: '', loaded: [], missing: [], others: [] };
}

function resolveFolder(folder: string): string | null {
  const trimmed = folder.trim();
  return trimmed ? resolve(trimmed) : null;
}

/** 目录内的绝对路径，越界或绝对路径返回 null。 */
function resolveIn(folder: string, rel: string): string | null {
  if (!rel || isAbsolute(rel)) return null;
  const full = resolve(folder, rel);
  const prefix = folder.endsWith(sep) ? folder : `${folder}${sep}`;
  return full === folder || full.startsWith(prefix) ? full : null;
}

function readText(file: string): { text: string; mtime: string } | null {
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return null;
    let text = readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { text: text.replaceAll('\r\n', '\n'), mtime: mmddhhmm(stat.mtime) };
  } catch {
    return null;
  }
}

function mmddhhmm(date: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

interface Picked {
  text: string;
  truncated: number;
  cut: Cut;
  /** 截头时，这一段原本所属的块标题。 */
  from?: string;
  blocks: number;
  note?: 'no-marker';
  /** 分块模式下没进卡的块：没被选中的，以及为字数上限整块丢掉的。 */
  omitted?: Array<{ title: string; chars: number }>;
}

function pick(text: string, rule: Rule): Picked {
  if (rule.mode === 'whole') {
    return { ...cap(text, rule.maxChars, rule.cut), blocks: 0 };
  }
  if (rule.mode === 'marker') {
    const marker = rule.arg.trim();
    if (!marker) return { ...cap(text, rule.maxChars, rule.cut), blocks: 0 };
    const at = text.split('\n').findIndex((line) => line.trimStart().startsWith(marker));
    if (at < 0) return { ...cap(text, rule.maxChars, rule.cut), blocks: 0, note: 'no-marker' };
    return { ...cap(text.split('\n').slice(0, at).join('\n'), rule.maxChars, rule.cut), blocks: 0 };
  }

  const { pre, blocks } = splitBlocks(text);
  const chosen = chooseBlocks(blocks, rule);
  if (!chosen.length) return { ...cap(text, rule.maxChars, rule.cut), blocks: 0 };
  const kept = capBlocks(pre, chosen, rule.maxChars, rule.cut);
  const onCard = new Set(kept.kept);
  const omitted = blocks
    .filter((block) => !onCard.has(block))
    .map((block) => ({ title: block.title, chars: block.text.length }));
  return {
    text: kept.text,
    truncated: kept.truncated,
    cut: kept.cut,
    ...(kept.from ? { from: kept.from } : {}),
    blocks: kept.blocks,
    ...(omitted.length ? { omitted } : {}),
  };
}

function cap(text: string, max: number, cut: Cut): { text: string; truncated: number; cut: Cut; from?: string } {
  const trimmed = text.trim();
  if (max <= 0 || trimmed.length <= max) return { text: trimmed, truncated: 0, cut };
  if (cut === 'head') {
    const at = trimmed.length - max;
    const nl = trimmed.indexOf('\n', at);
    // 起点落在半行上就跳到下一行开头；整段没有换行时只能按字切
    const head = (nl >= 0 && nl + 1 < trimmed.length ? trimmed.slice(nl + 1) : '').trimStart();
    const start = head ? nl + 1 : at;
    const kept = head || trimmed.slice(at).trimStart();
    // 开头不是块标题时，说明从某块中间起头，补一行出处
    const from = kept.startsWith('## ') ? undefined : headingBefore(trimmed, start);
    return { text: kept, truncated: trimmed.length - kept.length, cut, ...(from ? { from } : {}) };
  }
  return { text: trimmed.slice(0, max).trimEnd(), truncated: trimmed.length - max, cut };
}

/** 截点之前最近的一个 `## ` 标题；没有就 undefined。 */
function headingBefore(text: string, at: number): string | undefined {
  let title: string | undefined;
  for (const match of text.matchAll(/^##\s+.*$/gm)) {
    const index = match.index ?? 0;
    if (index >= at) break;
    const value = match[0].replace(/^##\s+/, '').trim();
    if (value) title = value;
  }
  return title;
}

/** 截点落在哪一块里（`frontLength` 是块前引言的长度）；落在引言里返回 undefined。 */
function blockTitleBefore(blocks: Block[], frontLength: number, at: number): string | undefined {
  let offset = frontLength;
  let title: string | undefined;
  for (const block of blocks) {
    if (offset >= at) break;
    if (block.title) title = block.title;
    offset += block.text.length;
  }
  return title;
}

/** 按 `## ` 切块，保留块前的引言。日期只认标题里出现的 `YYYY-MM` / `MM-DD`。 */
export function splitBlocks(text: string): { pre: string; blocks: Block[] } {
  const starts: number[] = [];
  for (const match of text.matchAll(/^##\s+.*$/gm)) starts.push(match.index ?? 0);
  if (!starts.length) return { pre: text, blocks: [] };

  const raw = starts.map((at, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : text.length;
    const chunk = text.slice(at, end);
    const nl = chunk.indexOf('\n');
    const title = (nl < 0 ? chunk : chunk.slice(0, nl)).replace(/^##\s+/, '').trim();
    return { title, text: chunk };
  });
  // a file that names a year anywhere orders its undated siblings by that year
  const hint = raw.reduce((max, b) => Math.max(max, explicitYear(b.title) ?? 0), 0) || 2000;
  return { pre: text.slice(0, starts[0]), blocks: raw.map((b) => ({ ...b, key: blockKey(b.title, hint) })) };
}

function explicitYear(title: string): number | null {
  const m = /(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(title);
  return m ? Number(m[1]) : null;
}

function blockKey(title: string, hint: number): number {
  const full = /(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(title);
  if (full) return Number(full[1]) * 10000 + Number(full[2]) * 100 + Number(full[3] ?? '0');
  const short = /(\d{2})-(\d{2})/.exec(title);
  if (short) return hint * 10000 + Number(short[1]) * 100 + Number(short[2]);
  return 0;
}

/** 取最新的几块，保持文件里的原顺序；`newest+pin` 额外带上标题含固定词的块。 */
function chooseBlocks(blocks: Block[], rule: Rule): Block[] {
  const parts = rule.arg.split(',');
  const asked = Number.parseInt(parts[0]?.trim() ?? '', 10);
  const count = Number.isFinite(asked) && asked > 0 ? asked : 2;
  const ranked = blocks.filter((b) => b.key > 0).sort((a, b) => b.key - a.key);
  const picked = new Set<Block>(ranked.slice(0, count));
  const pin = (parts[1] ?? '').trim();
  if (rule.mode === 'newest+pin' && pin) {
    for (const block of blocks) if (block.title.includes(pin)) picked.add(block);
  }
  return blocks.filter((b) => picked.has(b));
}

/**
 * `tail` 超上限时先丢最旧的块，再从尾部硬截；`head` 不丢块，按换行截头、保留结尾。
 * `truncated` 是这次实际没载入的字数。
 */
function capBlocks(
  pre: string,
  blocks: Block[],
  max: number,
  cut: Cut,
): { text: string; truncated: number; blocks: number; kept: Block[]; cut: Cut; from?: string } {
  const front = pre.trim() ? `${pre.trimEnd()}\n\n` : '';
  const total = front.length + blocks.reduce((n, b) => n + b.text.length, 0);
  const joined = front + blocks.map((b) => b.text).join('');

  if (max <= 0 || joined.length <= max) {
    const all = joined.trim();
    return { text: all, truncated: 0, blocks: blocks.length, kept: blocks.slice(), cut };
  }

  if (cut === 'head') {
    const at = joined.length - max;
    const nl = joined.indexOf('\n', at);
    // 从整行开头起；找不到换行就按字切
    const cutAt = nl >= 0 && nl + 1 < joined.length ? nl + 1 : at;
    const head = joined.slice(cutAt).trimStart();
    const text = head || joined.slice(at).trimStart();
    const start = head ? cutAt : at;
    let offset = front.length;
    const kept: Block[] = [];
    for (const block of blocks) {
      const end = offset + block.text.length;
      if (end > start) kept.push(block);
      offset = end;
    }
    // 开头不是块标题时，说明从某块中间起头，补一行出处
    const from = text.startsWith('## ') ? undefined : blockTitleBefore(blocks, front.length, start);
    return { text, truncated: total - text.length, blocks: kept.length, kept, cut, ...(from ? { from } : {}) };
  }

  let keep = blocks.slice();
  while (keep.length > 1 && front.length + keep.reduce((n, b) => n + b.text.length, 0) > max) keep = keep.slice(1);
  const trimmed = (front + keep.map((b) => b.text).join('')).trim();
  if (trimmed.length <= max) return { text: trimmed, truncated: total - trimmed.length, blocks: keep.length, kept: keep, cut };
  return { text: trimmed.slice(0, max).trimEnd(), truncated: total - max, blocks: keep.length, kept: keep, cut };
}

/** 卡尾的「未上卡的块」：整理记忆时，至少知道还有哪几块没被看到。 */
function omittedBlockList(
  blocks: Array<{ file: string; title: string; chars: number }>,
  max: number,
  t: (typeof TEXT)[keyof typeof TEXT],
): string {
  if (!blocks.length) return '';
  const shown = max > 0 ? blocks.slice(0, max) : [];
  const lines = shown.map((block) => t.omittedLine(block.file, block.title || t.untitled, block.chars));
  const rest = blocks.length - shown.length;
  if (rest > 0) lines.push(t.omittedOver(rest));
  return [t.omittedTitle, ...lines, '', t.omittedNote].join('\n');
}

/** 其余 `.md`：只列路径和首行，不读正文。 */
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

/** 清单只读开头 4 KB，不把整份文件读进内存。 */
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
