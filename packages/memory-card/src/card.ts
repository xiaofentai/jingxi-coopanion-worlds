/**
 * 记忆卡：把目录里的 Markdown 按规则裁成一段文本，供 World 在构建系统前缀时使用。
 *
 * 纯函数：只读文件，不联网、不调模型、不写盘。同一批文件每次都要得到逐字相同的结果，
 * 所以排序、分块和截断都不依赖遍历顺序，也不读时钟以外的环境。
 */
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * 记忆卡只做一件事：把整份文件按字数裁进前缀。
 *
 * 不按块索引、不识别游戏路由、不按标题挑选——那些是 memory-ledger 的活。
 * 一条规则只有四个字段：`路径|whole|（留空）|字数上限|切法`；切法写 `tail`（留开头，默认）
 * 或 `head`（留结尾）。超过上限时回执会写明「还有 N 字未载入」。
 */
export type RuleMode = 'whole';

/** 截断关键词：`tail` 断尾（留开头，默认）；`head` 截头（留结尾）。 */
export type Cut = 'head' | 'tail';

export interface Rule {
  /** 相对目录，`/` 分隔。 */
  path: string;
  mode: RuleMode;
  /** 保留字段，必须留空；card 不再按标题或块数挑选。 */
  arg: string;
  /** 这一份的字数上限；0 表示不单独限制，只受整张卡的上限约束。 */
  maxChars: number;
  /** 截断关键词：`tail` 留开头（默认），`head` 留结尾。 */
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

const MODES: readonly RuleMode[] = ['whole'];

const TEXT = {
  zh: {
    noFolder: '（记忆卡是空的：没有配置目录。）',
    badFolder: (dir: string) => `（记忆卡：目录读不到 ${dir}。）`,
    empty: '（记忆卡是空的：规则为空，或目录里没有匹配的文件。）',
    missing: (file: string) => `（${file} 不存在，跳过。）`,
    truncated: (n: number, file: string, at: Cut) =>
      at === 'head'
        ? `（已截断：前面还有 ${n} 字未载入，用 read_file 查看 ${file}。）`
        : `（已截断：还有 ${n} 字未载入，用 read_file 查看 ${file}。）`,
    headFrom: (title: string) => `（前面已截断；这一段从「${title}」中间开始。）`,
    badRule: (line: string) => `（规则写错了，跳过：${line}）`,
    othersTitle: '### 未载入的文件',
    othersNote: '问到相关的事，先打开对应文件再答。',
    othersOver: (n: number) => `- 另有 ${n} 个文件没有列出。`,
    over: (n: number) => `（还有 ${n} 份因总上限没有载入。）`,
    error: (msg: string) => `（记忆卡生成失败：${msg}）`,
    meta: (files: number, chars: number, stamp: string) =>
      `读取 ${files} 份 / ${chars} 字 / ${stamp}`,
    metaEmpty: (stamp: string) => `没有载入任何文件 / ${stamp}`,
  },
  en: {
    noFolder: '(The card is empty: no folder is configured.)',
    badFolder: (dir: string) => `(Memory card: the folder cannot be read: ${dir}.)`,
    empty: '(The card is empty: no rules, or nothing in the folder matches them.)',
    missing: (file: string) => `(${file} is missing; skipped.)`,
    truncated: (n: number, file: string, at: Cut) =>
      at === 'head'
        ? `(Truncated: the first ${n} characters are not here; use read_file for ${file}.)`
        : `(Truncated: ${n} characters are not here; use read_file for ${file}.)`,
    headFrom: (title: string) => `(The beginning is cut; this part starts in the middle of "${title}".)`,
    badRule: (line: string) => `(Bad rule, skipped: ${line})`,
    othersTitle: '### Files not loaded',
    othersNote: 'Open the file before answering anything about it.',
    othersOver: (n: number) => `- ${n} more files are not listed.`,
    over: (n: number) => `(${n} more files did not fit under the total limit.)`,
    error: (msg: string) => `(Building the card failed: ${msg})`,
    meta: (files: number, chars: number, stamp: string) =>
      `${files} files / ${chars} characters / ${stamp}`,
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
      parts.length < 4 || parts.length > 5 || !path || !MODES.includes(mode as RuleMode) || !!arg
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
        ...(picked.truncated > 0 ? ['', t.truncated(picked.truncated, rule.path, picked.cut)] : []),
      ].join('\n');
      if (chars + section.length > input.totalChars) {
        full = true;
        dropped += 1;
        continue;
      }
      chars += section.length;
      sections.push(section);
      loaded.push({ path: rule.path, mode: rule.mode, kept: picked.text.length, source: text.text.length, blocks: 0 });
    }

    if (!sections.length) notes.push(t.empty);
    if (dropped > 0) notes.push(t.over(dropped));

    const known = new Set(rules.map((r) => r.path));
    const listing = input.listOthers ? listOthers(folder, input.exclude, known, input.listMax, input.language) : { index: '', others: [] };

    const card = [...sections, ...notes].join('\n\n').trim();
    return {
      card,
      index: listing.index,
      meta: loaded.length ? t.meta(loaded.length, chars, input.stamp) : t.metaEmpty(input.stamp),
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
}

function pick(text: string, rule: Rule): Picked {
  return cap(text.trim(), rule.maxChars, rule.cut);
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
