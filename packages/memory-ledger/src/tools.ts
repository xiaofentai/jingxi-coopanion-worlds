/**
 * 工具：记忆的写入与搬家都从这里过，不再由文件工具直接改。
 *
 * 三条规矩：
 * - 只对块操作，调用方给的是块句柄，不是行号；
 * - 写之前先备份、写之后重新解析核对，数目对不上就不落盘；
 * - 搬家先写目标再改源——中途出事最多是多出一份（能被体检发现），不会少一份。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ToolDef } from 'cortico/core/types.ts';
import { audit, auditLines, folderOf, readDoc, readRuleDocs } from './audit.ts';
import { parseRules } from './board.ts';
import { DEFAULT_ARCHIVE_FILE, DEFAULT_TODAY_FILE } from './config.ts';
import { recall, type RecallHit } from './recall.ts';
import { parseDoc, type Doc } from './parse.ts';
import { appendBullets, appendRawLines, deleteInBlock, editInBlock, ensureDayBlock, ensureMonthBlock, findBlocks, handleOf, moveBlock, regionsOf, renameInBlock } from './write.ts';

/** 一条记忆最多这么长；超了说明该拆成两条，而不是让它继续长。 */
const TEXT_MAX = 600;
/** 备份留这么多份。 */
const BACKUP_KEEP = 30;
/** `again` 写成 `11-05,11-08` 或 `2026-11-05`。 */
const DATE_PIECE = /^\d{2}-\d{2}$|^\d{4}-\d{2}-\d{2}$/;
/**
 * `ml_*` 的写入不进工作区 git：Persona 只给 `write_file` / `edit_file` 那几个文件工具挂提交。
 * 回执里说一句，免得她以为这次改动有版本可退。
 */
const NO_COMMIT = '（这次改动没进工作区版本历史。）';

export interface LedgerToolOptions {
  /** 记忆目录，绝对路径。 */
  folder: () => string;
  /** 规则文本，用来知道有哪些文件。 */
  rules: () => string;
  /** 备份落在这里。 */
  backupDir: () => string;
  /** `YYYY-MM-DD`。 */
  today: () => string;
  /** 三个写入工具不写 `file` 时的那一份；空表示 `DEFAULT_TODAY_FILE`。 */
  todayFile: () => string;
  /** `ml_forget` 不写 `to` 时归档到哪一份；空表示 `DEFAULT_ARCHIVE_FILE`。 */
  archiveFile: () => string;
}

type Args = Record<string, unknown>;

const str = (args: Args, key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');

/** 记忆目录下的相对路径；绝对路径或带 `..` 的返回空。 */
function relOf(rel: string): string | null {
  const wanted = rel.replaceAll('\\', '/').trim();
  if (!wanted || wanted.startsWith('/') || /^[a-zA-Z]:/.test(wanted)) return null;
  if (wanted.split('/').includes('..')) return null;
  return wanted;
}

function fileOf(folder: string, rel: string): string | null {
  const clean = relOf(rel);
  if (!clean) return null;
  const full = join(folder, clean);
  const prefix = folder.endsWith('\\') || folder.endsWith('/') ? folder : `${folder}${process.platform === 'win32' ? '\\' : '/'}`;
  return full === folder || full.startsWith(prefix) ? full : null;
}

function readText(file: string): string {
  const text = readFileSync(file, 'utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 先备份，再写临时文件，最后 rename——失败时原文件还在。 */
function save(file: string, text: string, backupDir: string): void {
  // 归档文件第一次写时父目录还不存在
  mkdirSync(dirname(file), { recursive: true });
  try {
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    copyFileSync(file, join(backupDir, `${stamp}-${basename(file)}`));
    const old = readdirSync(backupDir).sort();
    for (const name of old.slice(0, Math.max(0, old.length - BACKUP_KEEP))) {
      try {
        unlinkSync(join(backupDir, name));
      } catch {
        // 旧备份删不掉不影响这一次写入
      }
    }
  } catch {
    // 备份失败不阻止写入：文件本身还有 git 历史
  }
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

function docOf(folder: string, rel: string, year: number): Doc | null {
  return readDoc(folder, rel, year);
}

/** 不写 `file` 时写进哪一份：配置优先，空则用默认值。 */
function todayFileOf(opts: LedgerToolOptions): string {
  return opts.todayFile().trim() || DEFAULT_TODAY_FILE;
}

/** 这份文件的条目上限：来自它自己的规则（`catalog` / `full` 的第 4 段），没有就是 0（不管）。 */
function entryCapOf(rules: string, rel: string): number {
  for (const rule of parseRules(rules).rules) {
    if (rule.path === rel && (rule.mode === 'catalog' || rule.mode === 'full') && rule.maxChars > 0) return rule.maxChars;
  }
  return 0;
}

/** 收窄成一行，回执里不贴长条目。 */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 一条候选写成回执里的一行：带来源，否则她判断不了相关性。 */
function hitLine(hit: RecallHit): string {
  return `- ${hit.handle}（${hit.file.replace(/\.md$/, '')}）${clip(hit.text, 50)}`;
}

/** 规则里的文件当成召回范围；归档不在规则里，也就不在召回范围里。 */
function recallDocs(opts: LedgerToolOptions) {
  const year = Number(opts.today().slice(0, 4));
  return readRuleDocs(opts.folder(), opts.rules(), year).map(({ doc }) => doc);
}

/**
 * 召回：跨文件挑出最相关的几条。
 *
 * 它比 `read_file` 多的只有两件——**跨文件**和**排序**。所以每条都带来源，
 * 她照着来源去 `read_file` 取全文；找不到相关的就明说「大概是新的」，别硬凑。
 */
function recallTool(args: Args, opts: LedgerToolOptions): string {
  const docs = recallDocs(opts);
  const daysRaw = args.days;
  const days = typeof daysRaw === 'number' && Number.isFinite(daysRaw) ? Math.max(0, Math.trunc(daysRaw)) : 0;
  const hits = recall(docs, {
    query: str(args, 'query'),
    entity: str(args, 'entity'),
    days,
    today: opts.today(),
    limit: 5,
  });
  if (!hits.length) return '（没有找到相关的旧条目——这件事大概是新的。）';
  return [
    `${hits.length} 条（最多 5）：`,
    ...hits.map(hitLine),
    '（要细节就 read_file 看对应文件里那一块；这里只是给候选。）',
  ].join('\n');
}

/** 体检：每份几块、日期到哪、缺哪天。 */
function check(opts: LedgerToolOptions): string {
  const today = opts.today();
  const report = audit(opts.folder(), opts.rules(), today);
  return auditLines(report, today).join('\n');
}

/** 追加一条到某一天；默认今天、配置里的「今天那份」。 */
function add(args: Args, opts: LedgerToolOptions): string {
  const folder = opts.folder();
  const today = opts.today();
  const year = Number(today.slice(0, 4));
  const text = str(args, 'text');
  if (!text) return '（没写内容，没有动文件。）';
  if (text.length > TEXT_MAX) return `（${text.length} 字，超过 ${TEXT_MAX} 的限度；拆成两条再记。）`;

  const rel = str(args, 'file') || todayFileOf(opts);
  const file = fileOf(folder, rel);
  if (!file) return `（路径不对：${rel}）`;
  // 归档文件允许第一次就被写出来；别的文件打错名字仍然拒绝，免得多出一份
  const archiveRel = opts.archiveFile().trim() || DEFAULT_ARCHIVE_FILE;
  const fresh = !existsSync(file) || !statSync(file).isFile();
  if (fresh && rel !== archiveRel) return `（${rel} 不存在，没有动文件。）`;

  const block = str(args, 'block') || today;
  const again = str(args, 'again')
    .split(/[,，、;；\s]+/)
    .map((piece) => piece.trim())
    .filter(Boolean);
  const badDates = again.filter((piece) => !DATE_PIECE.test(piece));
  if (badDates.length) return `（again 只能写 11-05 或 2026-11-05 这样的日期：${badDates.join('、')}）`;

  let line = text;
  if (again.length && !/again/i.test(text)) line = `${text}（again: ${again.join('、')}）`;

  const before = parseDoc(fresh ? '# 归档\n' : readText(file), rel, year);

  // 条目闸门：上限来自这份文件自己的规则（catalog / full 的第 4 段）。
  // 到上限就拒绝——它是真上限，不是建议值；被拒时还有「写进归档」那条路，不会丢信息。
  const entryCap = entryCapOf(opts.rules(), rel);
  const entriesBefore = entriesCount(before);
  if (entryCap > 0 && entriesBefore >= entryCap) {
    const archive = archiveRel;
    const brief = before.blocks.slice(0, 6).map((item) => `${handleOf(item)}（${item.entries.length} 条）`).join('、');
    const oldest = before.blocks.find((item) => item.kind !== 'special');
    const sample = oldest && oldest.entries.length
      ? `最早的块 ${handleOf(oldest)} 现有 ${oldest.entries.length} 条，前 ${Math.min(3, oldest.entries.length)} 条：\n`
        + oldest.entries.slice(0, 3).map((entry) => `- ${entry.text.slice(0, 60)}`).join('\n')
      : '';
    return [
      `（${rel} 已经 ${entriesBefore} 条，到 ${entryCap} 的上限了，这一条没有写进去——先整理。）`,
      '两条路：',
      `① 换掉一条 → ml_forget(file="${rel}", block=…, old=…) 再 ml_add`,
      `② 这条不如旧的 → ml_add(file="${archive}", …)：同样记下来，只进归档、不进前缀，${rel} 一个字不动`,
      brief ? `现在有：${brief}` : '',
      sample,
    ].filter(Boolean).join('\n');
  }

  // `2026-11` 是月块（归档用得最多），`11-10` 是日块
  const created = /^\d{4}-\d{2}$/.test(block)
    ? ensureMonthBlock(before, block)
    : ensureDayBlock(before, block, year);
  const staged = parseDoc(created.text, rel, year);
  const first = args.first === true;
  const added = appendBullets(staged, block, [line], first);
  if ('error' in added) return `（${added.error}）`;

  // 核对：只多一条，块数最多多一个
  const after = parseDoc(added.text, rel, year);
  const entriesAfter = entriesCount(after);
  if (entriesAfter !== entriesBefore + 1) {
    return `（核对不通过：条目 ${entriesBefore} → ${entriesAfter}，没有写盘。）`;
  }
  if (after.blocks.length !== before.blocks.length && after.blocks.length !== before.blocks.length + 1) {
    return '（核对不通过：块数不对，没有写盘。）';
  }

  save(file, added.text, opts.backupDir());

  const lines = [`已记进 ${rel}「${block}」，第 ${after.blocks.length} 块`];
  if (created.created) lines.push(`（新建了「${block}」这一块）`);
  if (first) lines.push('（写在块首——这一行就是这一天的「一句话」）');
  if (fresh) lines.push(`（${rel} 原来没有，这次建起来了）`);
  // 到上限的 80% 就提醒（软限），不拦写入
  if (entryCap > 0 && entriesAfter >= entryCap * 0.8 && entriesAfter <= entryCap) {
    lines.push(`（${rel} 现在 ${entriesAfter}/${entryCap} 条，到 ${Math.round((entriesAfter / entryCap) * 100)}% 了：整理时挑最旧的几条 ml_forget 到归档。没空就 alarm_set 30 分钟后提醒自己。）`);
  }
  if (again.length) {
    const known = new Set(readRuleDocs(folder, opts.rules(), year).flatMap(({ doc }) => doc.blocks.map(handleOf)));
    const unknown = again.filter((piece) => ![...known].some((id) => id.endsWith(piece)));
    if (unknown.length) lines.push(`（注意：${unknown.join('、')} 在现有文件里找不到对应的块）`);
  }

  // 写入时算关联：她本来就在做事，插件只把候选递到眼前，她做选择题
  const related = recall(recallDocs(opts), {
    query: text,
    today,
    limit: 3,
    skip: (hit) => hit.text.trim() === line.trim(),
  });
  if (related.length) {
    lines.push('可能相关（不一定要接上，只是提醒）：');
    for (const hit of related) lines.push(hitLine(hit));
  }
  lines.push(NO_COMMIT);
  return lines.join('\n');
}

/** 归档目录名（默认 `archive`），用来判断一段路径是不是归档里的。 */
function archiveDirOf(opts: LedgerToolOptions): string {
  const rel = (opts.archiveFile().trim() || DEFAULT_ARCHIVE_FILE).replace(/\\/g, '/');
  const cut = rel.lastIndexOf('/');
  return cut > 0 ? rel.slice(0, cut) : '';
}

/** 这段路径在不在归档目录里。 */
function inArchive(rel: string, archiveDir: string): boolean {
  if (!archiveDir) return false;
  const path = rel.replace(/\\/g, '/');
  return path === archiveDir || path.startsWith(`${archiveDir}/`);
}

/**
 * 整块搬家；同一天在目标里已有就拒绝。
 *
 * **归档是单向的**：搬进去可以，搬出来不行。否则「折叠」随时能被撤销，那一层的上限就成了摆设。
 * 目标是归档里的新文件时自动建（第一次折叠到 `archive/近期-流水.md` 就会遇到）。
 */
function move(args: Args, opts: LedgerToolOptions): string {
  const folder = opts.folder();
  const today = opts.today();
  const year = Number(today.slice(0, 4));
  const from = str(args, 'from');
  const to = str(args, 'to');
  const handle = str(args, 'block');
  if (!from || !to || !handle) return '（要写清 from、block、to：从哪份、搬哪一块、搬到哪份。）';
  if (from === to) return '（源和目标是同一份文件。）';

  const archiveDir = archiveDirOf(opts);
  if (inArchive(from, archiveDir) && !inArchive(to, archiveDir)) {
    return `（${from} 在归档里，不再搬出来——归档是单向的：可以搬进去，不搬出来。要恢复请人工从备份捞。）`;
  }

  const source = docOf(folder, from, year);
  if (!source) return `（读不到 ${from}）`;
  // 目标是归档里的新文件时先建：折叠第一次落盘必然是新建
  const target = docOf(folder, to, year)
    ?? (inArchive(to, archiveDir) ? parseDoc('# 归档\n', to, year) : null);
  if (!target) return `（读不到 ${to}）`;

  const result = moveBlock(source, handle, target);
  if ('error' in result) return `（${result.error}）`;

  const sourceFile = fileOf(folder, from);
  const targetFile = fileOf(folder, to);
  if (!sourceFile || !targetFile) return '（路径不对，没有动文件。）';

  // 先写目标：这一步之后即使出错，最坏是多一份，体检能看出来，不会少
  const targetAfter = parseDoc(result.target, to, year);
  if (targetAfter.blocks.length !== target.blocks.length + 1) {
    return '（核对不通过：目标没有多出一块，没有写盘。）';
  }
  save(targetFile, result.target, opts.backupDir());

  const sourceAfter = parseDoc(result.source, from, year);
  if (sourceAfter.blocks.length !== source.blocks.length - 1) {
    return `（目标已写入，但源核对不通过：块数 ${source.blocks.length} → ${sourceAfter.blocks.length}。请用 ml_check 看一遍。）`;
  }
  save(sourceFile, result.source, opts.backupDir());

  return `已把「${result.handle}」（${result.chars} 字）从 ${from} 搬到 ${to}\n${NO_COMMIT}`;
}

/** 条目总数，用来核对「只改了一处」「只删了一条」。 */
function entriesCount(doc: Doc): number {
  return doc.blocks.reduce((n, block) => n + block.entries.length, 0);
}

/** 失败回执：原因之后跟上该块现有的样子，省得她再查一遍。 */
function miss(failure: { error: string; hint?: string }): string {
  return [`（${failure.error}）`, failure.hint ?? ''].filter(Boolean).join('\n');
}

/** 改块里的一处文字；`block` 写 `文件头` 时改第一个 `##` 之前那段。 */
function edit(args: Args, opts: LedgerToolOptions): string {
  const folder = opts.folder();
  const year = Number(opts.today().slice(0, 4));
  const rel = str(args, 'file') || todayFileOf(opts);
  const file = fileOf(folder, rel);
  if (!file || !existsSync(file) || !statSync(file).isFile()) return `（${rel} 不存在，没有动文件。）`;
  const block = str(args, 'block');
  const old = str(args, 'old');
  const next = str(args, 'new');
  if (!block || !old || !next) return '（要写清 block、old、new：哪一块、改哪段、改成什么。）';

  const before = parseDoc(readText(file), rel, year);
  const result = editInBlock(before, block, old, next);
  if ('error' in result) return miss(result);

  const after = parseDoc(result.text, rel, year);
  if (after.blocks.length !== before.blocks.length) return '（核对不通过：块数变了，没有写盘。）';
  // 不数条目：一条改成两条（new 里带换行）是正常写法，只核对改没改到
  const regions = regionsOf(after, block);
  if (!regions.some((text) => text.includes(next))) return '（核对不通过：改完在那块里找不到新内容，没有写盘。）';
  if (!next.includes(old) && regions.some((text) => text.includes(old))) {
    return '（核对不通过：旧内容还在，没有写盘。）';
  }
  save(file, result.text, opts.backupDir());
  return `已改 ${rel}「${block}」1 处，现在 ${after.text.length} 字\n${NO_COMMIT}`;
}

/** 改一个块的标题：只动标题那一行，条目一条不动。 */
function rename(args: Args, opts: LedgerToolOptions): string {
  const folder = opts.folder();
  const year = Number(opts.today().slice(0, 4));
  const rel = str(args, 'file') || todayFileOf(opts);
  const file = fileOf(folder, rel);
  if (!file) return `（路径不对：${rel}）`;
  if (!existsSync(file) || !statSync(file).isFile()) return `（${rel} 不存在，没有动文件。）`;

  const block = str(args, 'block');
  if (!block) return '（要写清改哪一块（block）。）';

  const before = parseDoc(readText(file), rel, year);
  const hit = renameInBlock(before, block, str(args, 'new'));
  if ('error' in hit) return miss(hit);

  const after = parseDoc(hit.text, rel, year);
  if (after.blocks.length !== before.blocks.length) return '（核对不通过：块数变了，没有写盘。）';
  if (entriesCount(after) !== entriesCount(before)) return '（核对不通过：条目数变了，没有写盘。）';
  const landed = after.blocks.find((item) => item.heading.trim() === hit.after);
  if (!landed) return '（核对不通过：新标题没落盘，没有写盘。）';

  save(file, hit.text, opts.backupDir());

  return [
    `已改标题：${hit.before}  →  ${hit.after}`,
    `（以后用「${handleOf(landed)}」找它；块里 ${landed.entries.length} 条一条没动）`,
    NO_COMMIT,
  ].join('\n');
}

/** 删块里的一条。 */
function remove(args: Args, opts: LedgerToolOptions): string {
  const folder = opts.folder();
  const year = Number(opts.today().slice(0, 4));
  const rel = str(args, 'file') || todayFileOf(opts);
  const file = fileOf(folder, rel);
  if (!file || !existsSync(file) || !statSync(file).isFile()) return `（${rel} 不存在，没有动文件。）`;
  const block = str(args, 'block');
  const old = str(args, 'old');
  if (!block || !old) return '（要写清 block 和 old：哪一块、删哪一条。）';

  const before = parseDoc(readText(file), rel, year);
  const result = deleteInBlock(before, block, old);
  if ('error' in result) return miss(result);

  const after = parseDoc(result.text, rel, year);
  if (after.blocks.length !== before.blocks.length) return '（核对不通过：块数变了，没有写盘。）';
  if (entriesCount(after) !== entriesCount(before) - 1) return '（核对不通过：不是正好少一条，没有写盘。）';
  save(file, result.text, opts.backupDir());
  return `已从 ${rel}「${block}」删掉一条「${result.removed.slice(0, 30)}」，现在 ${after.text.length} 字\n${NO_COMMIT}`;
}

/**
 * 淘汰一条：从这份文件移出，整条（含续行）归档进另一份。
 *
 * 和 `ml_delete` 的区别：删是真没了，这条是**移走**。和 `ml_move` 的区别：
 * `ml_move` 搬整块，这条只搬一条，且目标是归档——归档不进前缀，也不再回来。
 */
function forget(args: Args, opts: LedgerToolOptions): string {
  const folder = opts.folder();
  const today = opts.today();
  const year = Number(today.slice(0, 4));
  const rel = str(args, 'file') || todayFileOf(opts);
  const toRel = str(args, 'to') || opts.archiveFile().trim() || DEFAULT_ARCHIVE_FILE;
  const block = str(args, 'block');
  const old = str(args, 'old');
  if (!block || !old) return '（要写清 block 和 old：哪一块、淘汰哪一条。）';
  if (rel === toRel) return '（源和归档是同一份文件。）';

  const sourceFile = fileOf(folder, rel);
  const targetFile = fileOf(folder, toRel);
  if (!sourceFile || !targetFile) return '（路径不对，没有动文件。）';
  if (!existsSync(sourceFile) || !statSync(sourceFile).isFile()) return `（${rel} 不存在，没有动文件。）`;

  const source = parseDoc(readText(sourceFile), rel, year);
  const hit = deleteInBlock(source, block, old);
  if ('error' in hit) return miss(hit);
  if (!hit.raw.trim()) return '（没取到这条的原文，没有动文件。）';

  // 归档按月聚：日块取它的年月，特殊块落到本月
  const month = hit.date && hit.date.length >= 7 ? hit.date.slice(0, 7) : today.slice(0, 7);
  const targetText = existsSync(targetFile) && statSync(targetFile).isFile() ? readText(targetFile) : '# 归档\n';
  const target = parseDoc(targetText, toRel, year);
  const ensured = ensureMonthBlock(target, month);
  const archived = appendRawLines(parseDoc(ensured.text, toRel, year), month, hit.raw.split('\n'));
  if ('error' in archived) return `（${archived.error}）`;

  const sourceAfter = parseDoc(hit.text, rel, year);
  const targetAfter = parseDoc(archived.text, toRel, year);
  if (sourceAfter.blocks.length !== source.blocks.length) return '（核对不通过：源文件块数变了，没有写盘。）';
  if (entriesCount(sourceAfter) !== entriesCount(source) - 1) return '（核对不通过：源文件不是正好少一条，没有写盘。）';
  if (entriesCount(targetAfter) !== entriesCount(target) + 1) return '（核对不通过：归档没有多出一条，没有写盘。）';

  // 先写归档：中间出事最坏是多一份（体检能看出来），不会两边都没有
  save(targetFile, archived.text, opts.backupDir());
  save(sourceFile, hit.text, opts.backupDir());

  return [
    `已从 ${rel}「${block}」移出 1 条「${hit.removed.slice(0, 30)}」`,
    `归档进 ${toRel}「${month}」；它不会再回到 ${rel}。`,
    `（归档不进前缀。要翻它，用 read_file 看 ${toRel}。）`,
    NO_COMMIT,
  ].join('\n');
}

export const LEDGER_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'ml_check',
    description: '体检：每份记忆几块、日期到哪、条目多少、哪一天缺、哪一天同时躺在两份文件里。只读。整理记忆之前先跑这个。',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'ml_recall',
    description: '跨文件召回：给几条最相关的旧条目（最多 5），每条带来源（哪天、哪份文件）。三档：`entity` 精确（人名 / 局号 / 项目名）、`days` 时间窗、`query` 自由文本。都不给就看最近 3 天和「还挂着」。它只给候选，要细节用 read_file。',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entity: { type: 'string', description: '精确找的词：人名（鲸鲸）、局号（`80be9f6c`）、项目名（鼠妇、星邮）。' },
        query: { type: 'string', description: '自由文本：把你想说的那句话原样放进来，它按字的重合找。' },
        days: { type: 'integer', minimum: 0, maximum: 3650, description: '只要最近这么多天的（含今天）；不给就不限。' },
      },
      required: [],
    },
  },
  {
    name: 'ml_add',
    description: '往某一天追加一条记忆。默认写今天的块、今天那份文件。一天里出过同类的事，用 again 把前几次的日期写上，例如 again=11-05,11-08；这一条会带上「（again: …）」。',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: `一条要说清的事，最多 ${TEXT_MAX} 字；超了拆两条。` },
        file: { type: 'string', description: '写进哪份，不写就是今天那份（设置里的「今天那份」）。' },
        block: { type: 'string', description: '写进哪一天，`YYYY-MM-DD` 或 `MM-DD`；默认今天。没有这一块时会按日期新建。' },
        again: { type: 'string', description: '同类事以前发生在哪天，逗号分隔，如 `11-05,11-08`。不写就是头一次。' },
        first: { type: 'boolean', description: '插到这一块的最前面。写「这一天的第一句话」时用它；不写就是追加到末尾。' },
      },
      required: ['text'],
    },
  },
  {
    name: 'ml_move',
    description: '把整块（一整天）从一份记忆搬到另一份，按日期插到正确位置。不要用 move_file 按行搬：算错一行会把下一天的头切走。同一天在目标里已有会被拒绝。目标是归档目录里的文件时自动建（折叠第一次落盘就是新建）。**归档是单向的**：可以搬进去，不搬出来。',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from: { type: 'string', description: '源文件，如 `超近期.md`。' },
        block: { type: 'string', description: '要搬的块，如 `11-08`。' },
        to: { type: 'string', description: '目标文件，如 `近期.md`。' },
      },
      required: ['from', 'block', 'to'],
    },
  },
  {
    name: 'ml_edit',
    description: '改某一块里的一处文字。改已有的内容用这个，不要用 edit_file 直接改记忆文件。`old` 在这一块里必须只出现一次，出现两次以上会拒绝并说明。文件头（第一个 `##` 之前那几行）用 block=`文件头`。',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: { type: 'string', description: '哪份文件，不写就是今天那份（设置里的「今天那份」）。' },
        block: { type: 'string', description: '哪一块，如 `还挂着`、`11-10`；文件头写 `文件头`。' },
        old: { type: 'string', description: '要改掉的那段原文，照抄，块里必须唯一。' },
        new: { type: 'string', description: '改成什么。要删一整条请用 ml_delete。' },
      },
      required: ['block', 'old', 'new'],
    },
  },
  {
    name: 'ml_delete',
    description: '删掉某一块里的一条（含它的续行）。`old` 只要写这条里的一小段就够，命中两条以上会拒绝。删完核对：块数不变、条目正好少一条。',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: { type: 'string', description: '哪份文件，不写就是今天那份（设置里的「今天那份」）。' },
        block: { type: 'string', description: '哪一块，如 `还挂着`、`11-10`。' },
        old: { type: 'string', description: '要删的那一条里的一小段原文。' },
      },
      required: ['block', 'old'],
    },
  },
  {
    name: 'ml_forget',
    description: '淘汰一条：从这份文件移出，整条（含续行）归档进另一份。和 ml_delete 不同——删是真没了，这条只是移走；归档不进前缀，也不再回到原文件。名额满了、要拿新的一条换掉旧的一条时用它。',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: { type: 'string', description: '从哪份文件移出，不写就是今天那份。' },
        block: { type: 'string', description: '哪一块，如 `2026-10`、`11-10`。' },
        old: { type: 'string', description: '要移走的那一条里的一小段原文；命中两条以上会拒绝。' },
        to: { type: 'string', description: '归档到哪份文件，不写就是设置里的归档文件（默认 `archive/大事记-归档.md`）。' },
      },
      required: ['block', 'old'],
    },
  },
  {
    name: 'ml_rename',
    description: '改一个块的标题（只动标题那一行，块里的条目一条不动）。整理旧记忆时用它把标题改成统一形状，例如 `## 当狼 · 八人 · 11-05`——以后按角色 / 人数取块就靠标题。`ml_edit` 改不到标题，所以有这个工具。',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: { type: 'string', description: '哪份文件，不写就是今天那份。' },
        block: { type: 'string', description: '改哪一块：写它现在的句柄，如 `还挂着`、`当狼那份（11-05 六人局…）`、`11-10`。' },
        new: { type: 'string', description: '新标题，`## ` 可写可不写。日块必须以原日期开头（换日期用 ml_move），月块必须原样，且不许和别的块重名。' },
      },
      required: ['block', 'new'],
    },
  },
];

/** 把声明和实现绑起来。 */
export function createLedgerTools(opts: LedgerToolOptions): ToolDef[] {
  return LEDGER_TOOL_DECLS.map((decl) => ({
    ...decl,
    handler: (args: Args) => {
      try {
        if (decl.name === 'ml_check') return check(opts);
        if (decl.name === 'ml_recall') return recallTool(args, opts);
        if (decl.name === 'ml_add') return add(args, opts);
        if (decl.name === 'ml_move') return move(args, opts);
        if (decl.name === 'ml_edit') return edit(args, opts);
        if (decl.name === 'ml_delete') return remove(args, opts);
        if (decl.name === 'ml_forget') return forget(args, opts);
        if (decl.name === 'ml_rename') return rename(args, opts);
        return `（没有这个工具：${decl.name}）`;
      } catch (err) {
        return `（出错了：${err instanceof Error ? err.message : String(err)}）`;
      }
    },
  }));
}

/** 供脚本用：把同样的入口暴露出来。 */
export function ledgerFor(
  folder: string,
  rules: string,
  backupDir: string,
  today: string,
  todayFile = DEFAULT_TODAY_FILE,
  archiveFile = DEFAULT_ARCHIVE_FILE,
): LedgerToolOptions {
  return {
    folder: () => folderOf('', folder),
    rules: () => rules,
    backupDir: () => backupDir,
    today: () => today,
    todayFile: () => todayFile,
    archiveFile: () => archiveFile,
  };
}
