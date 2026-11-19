/**
 * 工具：记忆的写入与搬家都从这里过，不再由文件工具直接改。
 *
 * 三条规矩：
 * - 只对块操作，调用方给的是块句柄，不是行号；
 * - 写之前先备份、写之后重新解析核对，数目对不上就不落盘；
 * - 搬家先写目标再改源——中途出事最多是多出一份（能被体检发现），不会少一份。
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { ToolDef } from 'cortico/core/types.ts';
import { audit, auditLines, folderOf, readDoc, readRuleDocs } from './audit.ts';
import { parseRules, SOFT_RATIO } from './board.ts';
import { DEFAULT_ARCHIVE_FILE, DEFAULT_PAST_FILE, DEFAULT_TODAY_FILE } from './config.ts';
import { extractDates, recall, type RecallHit } from './recall.ts';
import type { RecentSay } from './recent.ts';
import { firstLine, parseDoc, type Block, type Doc } from './parse.ts';
import { appendBullets, appendRawLines, deleteInBlock, dropBlock, editInBlock, ensureBlock, ensureDayBlock, ensureMonthBlock, findBlocks, handleOf, mergeBlocks, moveBlock, regionsOf, renameInBlock, rewriteBlock } from './write.ts';

/** 一条记忆最多这么长；超了说明该拆成两条，而不是让它继续长。 */
const TEXT_MAX = 600;


/** 备份留这么多份。 */
const BACKUP_KEEP = 30;
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
  /** 第二层流水（那么近、但又没那么远）；`ml_move` 带新正文又不写 `to` 时压进这一份。 */
  pastFile: () => string;
  /** `ml_delete(…, keep=true)` / `ml_move` 不给新正文又不写 `to` 时归档到哪一份；空表示 `DEFAULT_ARCHIVE_FILE`。 */
  archiveFile: () => string;
  /**
   * 「对方刚说的最后一句」——预激活和路由的入口。没接（比如脚本、测试）就不提供，
   * 依赖它的那几行输出自然消失，不影响别的工具。
   *
   * `undefined` = 这个宿主没有事件库；`null` = 有库但十分钟内没人说话。
   */
  recent?: () => RecentSay | null | undefined;
  /**
   * 预激活的状态。没接就不报这条。
   *
   * `lastTick` 是唯一能证明「定时器在跑」的东西——`recent` 只能证明事件库可读。
   */
  prime?: () => { on: boolean; lastTick: number | null; pushed: number; today: number; cap: number; note: string };
  /**
   * 这一轮他说的那句、她查了没有。
   *
   * 判断「她会不会在开口前查」全靠这个：他说话的时间在插件手里，
   * `ml_recall` 的调用也在插件手里——两边一合，不用问她也不用读会话日志。
   */
  ask?: () => { at: number; text: string; checkedAt: number | null } | null;
  /** 召回被调用时通知一声，用来把这一轮标成「查过了」。 */
  onRecall?: () => void;
  /**
   * 到期提醒的闸：传进「到期几块」，返回今天还能不能提。
   *
   * 由世界实现「一天一次」——工具是纯函数，记不住日子。没接就不提醒。
   */
  dueNotice?: (overdue: number) => boolean;
  /** 游戏路由的状态：开关、上一拍、推过几局。 */
  route?: () => { on: boolean; note: string; games: number };
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
  // 和 `audit.ts` / `board.ts` 一样：先 resolve 再比，否则 `/` 与 `\` 混用时会静默返回 null
  const base = resolve(folder);
  const full = resolve(base, clean);
  return full.startsWith(`${base}${sep}`) ? full : null;
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

function docOf(folder: string, rel: string, year: number, today: string): Doc | null {
  return readDoc(folder, rel, year, today);
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

/**
 * 一条候选写成回执里的一行：带来源 **+ 全文**。
 *
 * 以前只给 50 字摘要，于是她为了看完整一句去 `read_file` 整份文件——
 * `超近期.md` 有八万多字，一次就抵掉一整天的前缀预算。摘要省的那点字，是假省。
 */
function hitLine(hit: RecallHit): string {
  return `· ${hit.handle}（${hit.file.replace(/\.md$/, '')}）${hit.text}`;
}

/** 块在回执 / 召回里的短名：日块 `11-07`、月块 `2026-10`、特殊块原名。 */
function shortHandle(block: Block): string {
  if (block.kind === 'special') return block.title;
  return block.kind === 'day' ? (block.date ?? block.title).slice(5) : (block.date ?? block.title);
}

/** 规则里的文件当成召回范围；归档不在规则里，也就不在召回范围里。 */
function recallDocs(opts: LedgerToolOptions) {
  const today = opts.today();
  const year = Number(today.slice(0, 4));
  return readRuleDocs(opts.folder(), opts.rules(), year, today).map(({ doc }) => doc);
}

/**
 * 召回留一行账：什么时候、她问什么、命中几条、第一名是谁。
 *
 * 会话日志一重启就清空，`「她会不会查」` 这件事没法累计；这条账是唯一能攒下来的。
 * 写不进去就算了——埋点失败不该让工具跟着失败。
 */
function logRecall(opts: LedgerToolOptions, entry: Record<string, unknown>): void {
  try {
    const dir = opts.backupDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'recall.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // 埋点失败不影响召回
  }
}

/**
 * 召回：跨文件挑出最相关的几条。
 *
 * 它比 `read_file` 多的只有两件——**跨文件**和**排序**。所以每条都带来源，
 * 她照着来源去 `read_file` 取全文；一条都没有就说「似乎之前没提到过」，别硬凑。
 */
/**
 * 命中那一条 + 它前面一条、后面两条。
 *
 * 为什么不给整块：一天十几条、三千字，全给等于让她读一篇；她要判断的其实只有
 * 「这句话在什么语境里说的」。四条足够了，多了反而是噪音。
 * 两条命中落在同一块且窗口重叠时合并，避免同一段说两遍。
 */
function windowLines(docs: readonly Doc[], hits: readonly RecallHit[]): string[] {
  const groups = new Map<string, { file: string; block: Block; marks: Set<number> }>();
  for (const hit of hits) {
    if (hit.index < 0) continue;
    const block = docs.find((doc) => doc.path === hit.file)?.blocks.find((item) => item.title === hit.title);
    if (!block) continue;
    const key = `${hit.file}\u0000${hit.title}`;
    const group = groups.get(key) ?? { file: hit.file, block, marks: new Set<number>() };
    group.marks.add(hit.index);
    groups.set(key, group);
  }

  const out: string[] = [];
  for (const { file, block, marks } of groups.values()) {
    const name = file.replace(/\.md$/, '');
    // 清单文件的块名就是文件名，别念两遍
    out.push(name === block.title ? name : `${block.title}（${name}）`);
    const wanted = new Set<number>();
    for (const at of marks) {
      // 只有日块有「上下文」这回事：那一天是连着过的。
      // 月块（大事记）一行一件事，前后两件不相干，给了反而是噪音——只给命中的那条。
      const from = block.kind === 'day' ? at - 1 : at;
      const to = block.kind === 'day' ? at + 2 : at;
      for (let i = from; i <= to; i += 1) {
        if (i >= 0 && i < block.entries.length) wanted.add(i);
      }
    }
    for (let i = 0; i < block.entries.length; i += 1) {
      if (!wanted.has(i)) continue;
      out.push(`${marks.has(i) ? '▶' : ' '} ${block.entries[i].text}`);
    }
    out.push('');
  }
  // 命中没有位置（按块比出来的）时退回单条
  if (!out.length) for (const hit of hits) out.push(hitLine(hit));
  return out;
}

function recallTool(args: Args, opts: LedgerToolOptions): string {
  const today = opts.today();
  const docs = recallDocs(opts);
  const daysRaw = args.days;
  const days = typeof daysRaw === 'number' && Number.isFinite(daysRaw) ? Math.max(0, Math.trunc(daysRaw)) : 0;
  const query = str(args, 'query');

  const hits = recall(docs, {
    query,
    entity: str(args, 'entity'),
    days,
    today,
    limit: 8,
  });
  const strong = hits.filter((hit) => hit.tier === 'strong').slice(0, 2);
  const weak = hits.filter((hit) => hit.tier === 'weak');

  logRecall(opts, {
    at: new Date().toISOString(),
    kind: 'recall',
    query,
    entity: str(args, 'entity'),
    days,
    hits: hits.length,
    strong: strong.length,
    top: strong[0] ? `${strong[0].file}#${strong[0].handle}` : '',
  });
  // 告诉她「这一轮查过了」——预激活靠它避免重复投喂，统计靠它算呼出率
  opts.onRecall?.();

  if (!strong.length) return '（似乎之前没提到过。）';

  const seen = extractDates(query, today).dates;
  const lines: string[] = [];
  // 日期是从句子摘出来单独走的：说清认成了哪天，免得她以为在比字
  if (seen.length) lines.push(`（日期按 ${seen.map((date) => date.slice(5)).join('、')} 找）`);
  lines.push('你想到了这些（▶ 是那条，前后各是它的上下文）：');
  lines.push(...windowLines(docs, strong));
  // 最多带一条「有点像」：给发散留个口子，又不至于把噪音铺满
  if (weak[0]) lines.push(`（还有点像：${weak[0].handle}（${weak[0].file.replace(/\.md$/, '')}）${clip(weak[0].text, 50)}）`);
  return lines.join('\n').trimEnd();
}

/** 体检：每份几块、日期到哪、缺哪天。`file` 只看一份，`all` 把待整理全列出来。 */
function check(args: Args, opts: LedgerToolOptions): string {
  const today = opts.today();
  const report = audit(opts.folder(), opts.rules(), today, Number(today.slice(0, 4)), opts.archiveFile());
  const lines = auditLines(report, today, {
    file: str(args, 'file'),
    limit: args.all === true ? 0 : undefined,
  });
  // 体检只说「哪块该搬」；原文按需看（ml_block），不然回执会变成几千字的正文
  if (report.overdue.length) {
    const first = report.overdue[0];
    const tip = `  （原文用 ml_block(action="view", block="${first.handle.slice(5)}") 看，不用读整份文件。）`;
    const at = lines.findIndex((line) => line.startsWith('该整理'));
    let insert = at + 1;
    while (insert < lines.length && lines[insert].startsWith('  - ')) insert += 1;
    lines.splice(at >= 0 ? insert : lines.length, 0, tip);
  }
  // 体检顺带说一句「系统认为你刚说了什么」：预激活和路由都要靠它，
  // 放在这里能一眼看出那一层读没读到东西，不用等它们做出来。
  if (opts.recent) {
    const recent = opts.recent();
    if (recent === undefined) {
      lines.push('最近一句：（这个宿主没有事件库）');
    } else if (recent === null) {
      lines.push('最近一句：（十分钟内没人说话）');
    } else {
      const minutes = Math.max(0, Math.round((Date.now() - recent.at) / 60_000));
      lines.push(`最近一句：${clip(recent.text, 40)}（${minutes} 分钟前）`);
    }
  }
  // 预激活的状态：只看「上次检查」走不走。它不走，就是定时器没在跑，别的都不用猜。
  if (opts.prime) {
    const state = opts.prime();
    if (!state.on) {
      lines.push('预激活：关（设置里打开，下一分钟生效，不用重启）');
    } else if (state.lastTick === null) {
      lines.push('预激活：开｜还没跑过第一拍（起来后一分钟内会跑）');
    } else {
      const minutes = Math.max(0, Math.round((Date.now() - state.lastTick) / 60_000));
      const note = state.note ? `｜上一拍：${state.note}` : '';
      // 当天计数在前、会话累计在后：预算只认当天那个数，别让累计数看着像超标
      lines.push(
        `预激活：开｜上次检查 ${minutes} 分钟前｜今天 ${state.today}/${state.cap} 次｜本次会话共 ${state.pushed} 次${note}`,
      );
    }
  }
  // 游戏路由：她进了一局没有、推没推、上一拍卡在哪
  if (opts.route) {
    const r = opts.route();
    if (!r.on) {
      lines.push('游戏路由：关');
    } else {
      const note = r.note ? `｜上一拍：${r.note}` : '';
      lines.push(`游戏路由：开｜已推 ${r.games} 局${note}`);
    }
  }
  // 开口召回：这一轮他说的那句、她查了没有。
  if (opts.ask) {
    const ask = opts.ask();
    if (!ask) {
      lines.push('开口召回：（还没听到他说话）');
    } else {
      const hhmm = (ms: number) => {
        const at = new Date(ms);
        return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
      };
      const said = clip(ask.text, 24);
      if (ask.checkedAt === null) {
        lines.push(`开口召回：${hhmm(ask.at)} 他「${said}」→ 还没查`);
      } else {
        const sec = Math.max(0, Math.round((ask.checkedAt - ask.at) / 1000));
        lines.push(`开口召回：${hhmm(ask.at)} 他「${said}」→ ${hhmm(ask.checkedAt)} 查了（${sec} 秒）`);
      }
    }
  }
  return lines.join('\n');
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

  const blockArg = str(args, 'block');
  const line = text;

  // 她以为「把 `## 当守卫` 写进 text 就能开一块」，实测试了六次（11-19）。
  // 那只会把标题当成一条正文写进去，块照样不存在——所以在这里拦下来并指路。
  const asHeading = /^\s*#{1,6}\s+(.+)/.exec(text);
  if (asHeading) {
    const want = asHeading[1].trim();
    return [
      `（text 开头是「## ${want}」——那不是开块，只会被当成一条正文写进去，块还是不存在。）`,
      `要开一块就叫这个名：ml_add(file="${rel}", block="${want}", text="第一条内容")`,
      '  —— 这块不存在时它会自己新建（游戏角色块就是这么来的）。',
    ].join('\n');
  }

  const before = parseDoc(fresh ? '# 归档\n' : readText(file), rel, year, today);

  // 清单型文件（大事记）：整份一块、日期写在条目里。判据是「这份文件没有日块」，
  // 不写 block 时追加到最后一块，别在这儿生出 `## 11-15` 的日块——那是流水的形状。
  // 旧格式还留着月份标题时也走这条（追加到 `## 2026-11` 下），总之不造日块。
  const listBlock = before.blocks.some((item) => item.kind === 'day')
    ? undefined
    : before.blocks.filter((item) => item.kind !== 'day').at(-1);
  const block = blockArg || (listBlock ? handleOf(listBlock) : today);

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
      `① 换掉一条 → ml_delete(file="${rel}", block=…, old=…, keep=true) 再 ml_add`,
      `② 这条不如旧的 → ml_add(file="${archive}", …)：同样记下来，只进归档、不进前缀，${rel} 一个字不动`,
      brief ? `现在有：${brief}` : '',
      sample,
    ].filter(Boolean).join('\n');
  }

  // `2026-11` 是月块（归档用得最多），`11-10` 是日块；
  // 不在规则里的文件（`games/*`）允许开新块——`## 当守卫` 这种标题算不出日期，
  // 但那是她第一次打一个新身份时唯一该写的地方。
  const inRules = parseRules(opts.rules()).rules.some((rule) => rule.path === rel);
  const created = /^\d{4}-\d{2}$/.test(block)
    ? ensureMonthBlock(before, block)
    : /^\d{1,2}-\d{2}$/.test(block) || /^\d{4}-\d{2}-\d{2}$/.test(block)
      ? ensureDayBlock(before, block, year, today)
      : inRules
        ? { text: before.text, created: false }
        : ensureBlock(before, block);
  const staged = parseDoc(created.text, rel, year, today);
  const first = args.first === true;
  const added = appendBullets(staged, block, [line], first);
  if ('error' in added) return `（${added.error}）`;

  // 核对：只多一条，块数最多多一个
  const after = parseDoc(added.text, rel, year, today);
  const entriesAfter = entriesCount(after);
  if (entriesAfter !== entriesBefore + 1) {
    // 最常见的成因是 text 里写了多条（带 `- ` 的几行）：一次只能加一条。
    // 只说「108 → 111」她看不出是自己写成了三条，会以为是系统坏了。
    const bullets = line.split('\n').filter((item) => /^\s*[-*]\s+/.test(item)).length;
    if (bullets > 1) {
      return [
        `（这次 text 里有 ${bullets} 条（${bullets} 个 \`- \` 开头），而 ml_add 一次只加一条——没有写盘。）`,
        `要么拆成 ${bullets} 次调用；要么用 ml_edit 把新内容并进已有的那一条。`,
      ].join('\n');
    }
    return `（核对不通过：条目 ${entriesBefore} → ${entriesAfter}，没有写盘。）`;
  }
  if (after.blocks.length !== before.blocks.length && after.blocks.length !== before.blocks.length + 1) {
    return '（核对不通过：块数不对，没有写盘。）';
  }

  save(file, added.text, opts.backupDir());

  const lines = [`已记进 ${rel}「${block}」，第 ${after.blocks.length} 块`];
  if (created.created) lines.push(`（新建了「${block}」这一块）`);
  // 单块超 2500 也在这儿提一句：她是靠一条条 `ml_add` 把块堆大的，
  // 只有 `write` / `merge` 报的话，她永远收不到这个信号（当狼那块 3155 字就是这么来的）
  if (!inRules) {
    const landed = after.blocks.find((item) => handleOf(item) === block);
    const hint = landed ? sizeHint(landed.body.length) : '';
    if (hint) lines.push(hint);
  }
  if (first) lines.push('（写在块首——这一行就是这一天的「一句话」）');
  if (fresh) lines.push(`（${rel} 原来没有，这次建起来了）`);
  // 到上限的 80% 就提醒（软限），不拦写入
  if (entryCap > 0 && entriesAfter >= entryCap * SOFT_RATIO && entriesAfter <= entryCap) {
    lines.push(`（${rel} 现在 ${entriesAfter}/${entryCap} 条，到 ${Math.round((entriesAfter / entryCap) * 100)}% 了：整理时挑最旧的几条 ml_delete(…, keep=true) 到归档。没空就 alarm_set 30 分钟后提醒自己。）`);
  }
  // 写入时算关联：只递「别处也写过」的那一条。刚写的这一块里的旧条目她本来就看得见，
  // 拿刚写的那句话去比对又必然命中，于是回执永远跟着三行凑数的「可能相关」——那不是线索，是噪音。
  const writtenBlock = after.blocks.find((item) => item.entries.some((entry) => entry.text === line));
  const writtenId = writtenBlock ? shortHandle(writtenBlock) : block;
  const related = recall(recallDocs(opts), {
    query: text,
    today,
    limit: 3,
    skip: (hit) => hit.text.trim() === line.trim() || (hit.file === rel && hit.handle === writtenId),
  })
    // 只递「真对得上」的：沾边的那种递过来就是噪音，还会让回执看起来永远有话可说
    .filter((hit) => hit.tier === 'strong')
    .slice(0, 1);
  if (related.length) {
    lines.push('别处也写过同一件事（不是这一天；不一定要接上）：');
    for (const hit of related) lines.push(hitLine(hit));
  }
  lines.push(NO_COMMIT);
  const tip = overdueTip(opts);
  if (tip) lines.push(tip);
  return lines.join('\n');
}

/** 到期提醒的门槛：到期的块到这个数才提。只差一天的，她自己会等到。 */
const OVERDUE_TIP_MIN = 2;

/**
 * 到期提醒：挂在**写盘回执**上。
 *
 * 判据用「到期块数」，不是总块数：到期数光靠时间就会涨（她一个字不写也涨），
 * 也会因为她整理而回落——所以这个提醒**自抑制**：整理过就不响，没整理才响。
 * 别的插件也在催的时候，她照做 → 到期数回落 → 这里永远不触发，重复提醒这件事
 * 由机制本身解决，不用两个插件互相知道。
 *
 * 一天只放行一次（`dueNotice` 说了算），否则她写十条就念叨十遍。
 */
function overdueTip(opts: LedgerToolOptions): string {
  if (!opts.dueNotice) return '';
  const today = opts.today();
  const report = audit(opts.folder(), opts.rules(), today, Number(today.slice(0, 4)), opts.archiveFile());
  const list = report.overdue;
  if (list.length < OVERDUE_TIP_MIN) return '';
  if (!opts.dueNotice(list.length)) return '';
  // 不写嵌套括号：外面已经是一层圆括号了，里面再用会读着别扭
  const names = list.slice(0, 3).map((item) => `${item.handle.slice(5)} 第 ${item.days} 天`).join('、');
  const rest = list.length > 3 ? ` 等 ${list.length} 天` : '';
  return `（${names}${rest} 到期没搬——\`ml_move\` 搬走，\`ml_check\` 看全。）`;
}

/** `view` 一次最多贴这么多字；超了给 offset，让她接着看。 */
const BLOCK_VIEW_MAX = 6000;

/**
 * `games/*` 里单块的字数上限。
 *
 * 不拦写入，只在回执里提一句——因为这个数不是为了省前缀（路由是推送、不占前缀），
 * 而是为了**能一口气读完**：一局开局时会把「读局 + 角色块」整段推给她，两块加起来
 * 控制在五千字以内，她才真的读得进去。
 */
const GAMES_BLOCK_MAX = 2500;

/** 超过上面的线时补的那句话；没超就返回空串。 */
function sizeHint(chars: number): string {
  return chars > GAMES_BLOCK_MAX
    ? `（这块 ${chars} 字，超过 ${GAMES_BLOCK_MAX} 了：开局时会整块推给你，太长就读不进去。压一压——同一类并成一条，只留能复用的。）`
    : '';
}

/**
 * 对整块做两件事：`view` 看原文、`delete` 删掉。
 *
 * 为什么把「看块」从 `ml_check` 里拆出来：体检是看**结构**（几块、覆盖、该整理哪几处），
 * 贴几千字原文会把它变成另一件事，而且每次体检都贴一遍是浪费。看块是搬运时按需的动作。
 *
 * 为什么也放进来一个 `delete`：它们挨着——「看这一块 → 决定不要了 → 删掉」是同一次操作。
 * 但**写入**没放进来：那和 `ml_add(block=…)` 是同一件事，两个入口迟早漂。
 */
function blockTool(args: Args, opts: LedgerToolOptions): string {
  const action = (str(args, 'action') || 'view').trim();
  const folder = opts.folder();
  const today = opts.today();
  const year = Number(today.slice(0, 4));
  const rel = str(args, 'file') || todayFileOf(opts);
  const handle = str(args, 'block');
  if (!handle) return '（要写清 block：看/删哪一块。）';

  const file = fileOf(folder, rel);
  if (!file || !existsSync(file)) return `（${rel} 不存在。）`;

  // 改标题只动标题那一行，和「看块 / 删块」是同一族的操作
  if (action === 'rename') return rename(args, opts);

  const before = parseDoc(readText(file), rel, year, today);

  // 整块重写：把几十条重复的教训归并成十来条。这是唯一能把块压小又不断章取义的动作
  if (action === 'write') {
    const original = findBlocks(before, handle)[0];
    const result = rewriteBlock(before, handle, str(args, 'text'));
    if ('error' in result) return `（${result.error}）`;
    const after = parseDoc(result.text, rel, year, today);
    if (after.blocks.length !== before.blocks.length) return '（核对不通过：块数变了，没有写盘。）';
    const id = handleOf(original);
    const landed = after.blocks.find((item) => handleOf(item) === id);
    if (!landed) return '（核对不通过：改完找不到这块，没有写盘。）';
    save(file, result.text, opts.backupDir());
    return [
      `已重写 ${rel}「${id}」：${result.beforeChars} 字 → ${result.afterChars} 字（${original.entries.length} 条 → ${landed.entries.length} 条）`,
      sizeHint(result.afterChars),
      NO_COMMIT,
    ].filter(Boolean).join('\n');
  }

  if (action === 'view') {
    const offset = typeof args.offset === 'number' ? Math.max(0, Math.trunc(args.offset)) : 0;
    // 她自己会传 limit（想要「一页 10 条」），那就得认——不认就只剩按字数截断，
    // 她以为看完了，其实后面还有
    const limit = typeof args.limit === 'number' ? Math.max(0, Math.trunc(args.limit)) : 0;
    return viewBlock(before, handle, offset, limit);
  }

  if (action !== 'delete') return `（action 只有 view / write / delete / rename，收到的是「${action}」。）`;

  const result = dropBlock(before, handle);
  if ('error' in result) return `（${result.error}）`;

  // 核对：块数只少一个。对不上就不落盘
  const after = parseDoc(result.text, rel, year, today);
  if (after.blocks.length !== before.blocks.length - 1) {
    return '（核对不通过：块数不对，没有写盘。）';
  }

  save(file, result.text, opts.backupDir());
  return [
    `已删掉 ${rel}「${result.handle}」整块：${result.entries} 条 / ${result.chars} 字，没有进归档。`,
    '（想留底的话，下次先用 ml_move 搬到归档；备份目录里还能捞回删之前的那一份。）',
    NO_COMMIT,
  ].join('\n');
}

/** 一块的原文，按条编号；超预算（条数或字数）就停在整条上，并告诉她下一段从哪看。 */
function viewBlock(doc: Doc, handle: string, offset: number, limit = 0): string {
  const found = findBlocks(doc, handle);
  if (found.length !== 1) {
    const names = doc.blocks.map(handleOf).join('、');
    const why = found.length ? `「${handle}」匹配到 ${found.length} 块，写清楚一点` : `${doc.path} 里没有「${handle}」`;
    return `（${why}。这份文件有：${names}）`;
  }
  const block = found[0];
  const head = firstLine(block);
  const out = [`${doc.path}「${handleOf(block)}」· ${block.entries.length} 条 / ${block.body.length} 字`];
  // 首行可能不是条目（写成裸行的那种），那它不在 entries 里，得单独给
  if (head && block.entries[0]?.text !== head) out.push(`首行：${head}`);

  const from = Math.min(offset, block.entries.length);
  const cap = limit > 0 ? limit : Number.POSITIVE_INFINITY;
  let used = 0;
  let shown = 0;
  for (let i = from; i < block.entries.length && shown < cap; i += 1) {
    const text = block.entries[i].text;
    if (shown > 0 && used + text.length > BLOCK_VIEW_MAX) break;
    out.push(`${i + 1}. ${text}`);
    used += text.length;
    shown += 1;
  }
  const rest = block.entries.length - from - shown;
  if (rest > 0) out.push(`（还有 ${rest} 条，用 offset=${from + shown} 接着看。）`);
  return out.join('\n');
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
  const asked = str(args, 'to');
  const handle = str(args, 'block');
  // 给了 text 就是「换正文搬过去」：压进下一层时用，原文不留底
  const rewrite = str(args, 'text');
  if (!from || !handle) return '（要写清 from、block：从哪份、搬哪一块。）';
  // 给了 text 却是空的：那不是「原样搬」，是把整块搬成空壳
  if (args.text !== undefined && args.text !== null && !rewrite) {
    return '（新的正文是空的：那会把整块搬成空壳，没有动文件。）';
  }
  // 不写 to：给了新正文就压进第二层（这条不用记路径）。没给新正文时不给默认——
  // 归档有两份（大事记的、流水的），猜错就扔进单向的口子里，那一步必须她自己点明。
  const to = asked || (rewrite ? (opts.pastFile().trim() || DEFAULT_PAST_FILE) : '');
  if (!to) return '（要写清 to：没给新正文时，搬到哪一份得你定；给了 text 才默认压进「再往前那份」。）';
  if (from === to) return '（源和目标是同一份文件。）';

  const archiveDir = archiveDirOf(opts);
  if (inArchive(from, archiveDir) && !inArchive(to, archiveDir)) {
    return `（${from} 在归档里，不再搬出来——归档是单向的：可以搬进去，不搬出来。要恢复请人工从备份捞。）`;
  }

  const source = docOf(folder, from, year, today);
  if (!source) return `（读不到 ${from}）`;
  // 目标是归档里的新文件时先建：折叠第一次落盘必然是新建
  const target = docOf(folder, to, year, today)
    ?? (inArchive(to, archiveDir) ? parseDoc('# 归档\n', to, year, today) : null);
  if (!target) return `（读不到 ${to}）`;

  const result = moveBlock(source, handle, target, rewrite || undefined);
  if ('error' in result) return `（${result.error}）`;

  const sourceFile = fileOf(folder, from);
  const targetFile = fileOf(folder, to);
  if (!sourceFile || !targetFile) return '（路径不对，没有动文件。）';

  // 先写目标：这一步之后即使出错，最坏是多一份，体检能看出来，不会少
  const targetAfter = parseDoc(result.target, to, year, today);
  if (targetAfter.blocks.length !== target.blocks.length + 1) {
    return '（核对不通过：目标没有多出一块，没有写盘。）';
  }
  if (rewrite && !targetAfter.blocks.some((item) => item.body.trim() === rewrite.trim())) {
    return '（核对不通过：新正文没落盘，没有写盘。）';
  }
  save(targetFile, result.target, opts.backupDir());

  const sourceAfter = parseDoc(result.source, from, year, today);
  if (sourceAfter.blocks.length !== source.blocks.length - 1) {
    return `（目标已写入，但源核对不通过：块数 ${source.blocks.length} → ${sourceAfter.blocks.length}。请用 ml_check 看一遍。）`;
  }
  save(sourceFile, result.source, opts.backupDir());

  const byLayer = asked || !rewrite ? '' : '（没写 to：按「再往前那份」压进第二层）';
  if (!rewrite) {
    return [`已把「${result.handle}」（${result.chars} 字）从 ${from} 搬到 ${to}`, byLayer, NO_COMMIT].filter(Boolean).join('\n');
  }
  const ratio = Math.round((result.chars / Math.max(1, result.beforeChars)) * 100);
  return [
    `已把「${result.handle}」压缩后从 ${from} 搬到 ${to}：${result.beforeChars} 字 → ${result.chars} 字（${ratio}%）`,
    byLayer,
    ratio > 30 ? `（压得还不够：只删掉了时刻吧？${from} 那一层要的是「发生了什么、留下什么」，不是时间线。）` : '',
    NO_COMMIT,
  ].filter(Boolean).join('\n');
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
  const today = opts.today();
  const year = Number(today.slice(0, 4));
  const rel = str(args, 'file') || todayFileOf(opts);
  const file = fileOf(folder, rel);
  if (!file || !existsSync(file) || !statSync(file).isFile()) return `（${rel} 不存在，没有动文件。）`;
  const block = str(args, 'block');
  const old = str(args, 'old');
  const next = str(args, 'new');
  if (!block || !old || !next) return '（要写清 block、old、new：哪一块、改哪段、改成什么。）';

  const before = parseDoc(readText(file), rel, year, today);
  const result = editInBlock(before, block, old, next);
  if ('error' in result) return miss(result);

  const after = parseDoc(result.text, rel, year, today);
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
  const today = opts.today();
  const year = Number(today.slice(0, 4));
  const rel = str(args, 'file') || todayFileOf(opts);
  const file = fileOf(folder, rel);
  if (!file) return `（路径不对：${rel}）`;
  if (!existsSync(file) || !statSync(file).isFile()) return `（${rel} 不存在，没有动文件。）`;

  const block = str(args, 'block');
  if (!block) return '（要写清改哪一块（block）。）';

  const before = parseDoc(readText(file), rel, year, today);
  const hit = renameInBlock(before, block, str(args, 'new'));
  if ('error' in hit) return miss(hit);

  const after = parseDoc(hit.text, rel, year, today);
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

/**
 * 把同一份文件里的几块并成一块。整理 `games/*` 用：不同局、同一身份并成一块。
 *
 * 只做机械部分（拼接、换标题、删掉其余块），条目一条不动——「同类教训留一条」
 * 是她的判断，拼完她自己删。前缀里的文件不许合并：日期归属一变，覆盖就数不准。
 */
function merge(args: Args, opts: LedgerToolOptions): string {
  const folder = opts.folder();
  const today = opts.today();
  const year = Number(today.slice(0, 4));
  const rel = str(args, 'file') || todayFileOf(opts);
  const file = fileOf(folder, rel);
  if (!file || !existsSync(file) || !statSync(file).isFile()) return `（${rel} 不存在，没有动文件。）`;

  const raw = args.blocks;
  const list = (Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split(/[|\n]+/))
    .map((item) => item.trim())
    .filter(Boolean);
  if (list.length < 2) return '（至少写两块，用 | 分隔。）';
  const into = str(args, 'into');
  if (!into) return '（要写清合并后的标题（into）。）';

  const before = parseDoc(readText(file), rel, year, today);
  const inRules = parseRules(opts.rules()).rules.some((rule) => rule.path === rel);
  const result = mergeBlocks(before, list, into, { allowDateChange: !inRules });
  if ('error' in result) return miss(result);

  const after = parseDoc(result.text, rel, year, today);
  const merged = new Set(result.titles);
  const removed = before.blocks.filter((block) => merged.has(block.title)).length;
  if (after.blocks.length !== before.blocks.length - (removed - 1)) {
    return '（核对不通过：块数不对，没有写盘。）';
  }
  if (entriesCount(after) !== entriesCount(before)) {
    return `（核对不通过：条目 ${entriesCount(before)} → ${entriesCount(after)}，没有写盘。）`;
  }

  save(file, result.text, opts.backupDir());

  const landed = after.blocks.find((block) => block.heading.trim() === result.heading);
  return [
    `已把 ${removed} 块并成一块「${into}」：${before.blocks.length} → ${after.blocks.length} 块，条目 ${entriesCount(after)} 条一条没动`,
    `（现在 ${result.chars} 字；同类教训要删重复，用 ml_delete 一条一条收）`,
    sizeHint(result.chars),
    landed ? `（以后用「${landed.title}」找它）` : '',
    NO_COMMIT,
  ].filter(Boolean).join('\n');
}

/**
 * 删块里的一条。
 *
 * 给了 `to` 就是「删之前先整条归档」——那原来是独立的留底版删除工具。合并的理由：
 * 它是同一个动作的留底版，两个工具名只差一个词，却一个删没了一个还留着，
 * 选错的代价是内容永久丢失。现在只差一个参数。
 */
function remove(args: Args, opts: LedgerToolOptions): string {
  // `keep` 或 `to` 任一给了就归档；不写就是真删
  if (args.keep === true || str(args, 'to')) return forget(args, opts);
  const folder = opts.folder();
  const today = opts.today();
  const year = Number(today.slice(0, 4));
  const rel = str(args, 'file') || todayFileOf(opts);
  const file = fileOf(folder, rel);
  if (!file || !existsSync(file) || !statSync(file).isFile()) return `（${rel} 不存在，没有动文件。）`;
  const block = str(args, 'block');
  const old = str(args, 'old');
  if (!block || !old) return '（要写清 block 和 old：哪一块、删哪一条。）';

  const before = parseDoc(readText(file), rel, year, today);
  const result = deleteInBlock(before, block, old);
  if ('error' in result) return miss(result);

  const after = parseDoc(result.text, rel, year, today);
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

  const source = parseDoc(readText(sourceFile), rel, year, today);
  const hit = deleteInBlock(source, block, old);
  if ('error' in hit) return miss(hit);
  if (!hit.raw.trim()) return '（没取到这条的原文，没有动文件。）';

  // 归档按月聚：日块取它的年月，特殊块落到本月
  const month = hit.date && hit.date.length >= 7 ? hit.date.slice(0, 7) : today.slice(0, 7);
  const targetText = existsSync(targetFile) && statSync(targetFile).isFile() ? readText(targetFile) : '# 归档\n';
  const target = parseDoc(targetText, toRel, year, today);
  const ensured = ensureMonthBlock(target, month);
  const archived = appendRawLines(parseDoc(ensured.text, toRel, year, today), month, hit.raw.split('\n'));
  if ('error' in archived) return `（${archived.error}）`;

  const sourceAfter = parseDoc(hit.text, rel, year, today);
  const targetAfter = parseDoc(archived.text, toRel, year, today);
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
    description: '体检：每份记忆几块、日期到哪、条目多少、哪一天缺、哪一天同时躺在两份文件里，外加「该整理的」清单。只读。整理记忆之前先跑这个。默认只列前 12 处，`all=true` 全列，`file` 只看一份。',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: { type: 'string', description: '只看这一份的待整理项，如 `超近期.md`。不写就是全部。' },
        all: { type: 'boolean', description: '把待整理项全列出来（默认只列前 12 处，其余只报个数）。' },
      },
      required: [],
    },
  },
  {
    name: 'ml_recall',
    description: '回忆旧事：给一句你说的话（`query`），它找出最像的那一条，**连同它前面一条、后面两条**一起给你（▶ 标的是命中的那条）——四条够看清语境，又不用读整篇。一条都不像会明说「似乎之前没提到过」。也可以用 `entity`（人名 / 局号 / 项目名）精确找，`days` 限最近几天。句子里的日期（`11-06`、`11 月 6 日`、`昨天`）会被认出来单独走日期，不参与字面比对。',
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
    description: '往某一天追加一条记忆。默认写今天的块、今天那份文件。同类的事以前发生过，就把那几个日期直接写进正文（日期通道能认出来）；写「这一天的一句话」用 `first=true`。',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: `一条要说清的事，最多 ${TEXT_MAX} 字；超了拆两条。` },
        file: { type: 'string', description: '写进哪份，不写就是今天那份（设置里的「今天那份」）。' },
        block: { type: 'string', description: '写进哪一块：日期块写 `11-10`；**`games/*` 这类文件可以直接写身份名**（`当守卫`），那块不存在会新建。不写就是今天那一块。' },

        first: { type: 'boolean', description: '插到这一块的最前面。写「这一天的第一句话」时用它；不写就是追加到末尾。' },
      },
      required: ['text'],
    },
  },
  {
    name: 'ml_move',
    description: '把整块（一整天）从一份记忆搬到另一份，按日期插到正确位置。给了 `text` 就用它换掉块内正文（压进下一层：今天那份 → 再往前那份），标题不动；**这时不写 `to` 就默认压进「再往前那份」**。没给 `text` 时必须写 `to`（归档有两份，不替你猜）。不要用 move_file 按行搬：算错一行会把下一天的头切走。同一天在目标里已有会被拒绝。目标是归档目录里的文件时自动建。**归档是单向的**：可以搬进去，不搬出来。',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from: { type: 'string', description: '源文件，如 `超近期.md`。' },
        block: { type: 'string', description: '要搬的块，如 `11-08`。' },
        to: { type: 'string', description: '目标文件，如 `近期.md`。给了 text 时可以不写（默认进「再往前那份」）；没给 text 时必写。' },
        text: { type: 'string', description: '压好的正文（多行用换行）。给了就是「换正文搬过去」：原文不留底，回执会报压缩比。不给就是原样搬。' },
      },
      required: ['from', 'block'],
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
        block: { type: 'string', description: '哪一块：日期块写 `11-10`；特殊块写它现在的标题（自己起的名字也算）；文件头写 `文件头`。' },
        old: { type: 'string', description: '要改掉的那段原文，照抄，块里必须唯一。' },
        new: { type: 'string', description: '改成什么。要删一整条请用 ml_delete。' },
      },
      required: ['block', 'old', 'new'],
    },
  },
  {
    name: 'ml_delete',
    description: '删掉某一块里的一条（含它的续行）。`old` 只要写这条里的一小段就够，命中两条以上会拒绝。**给了 `to` 就先把这条整条归档进那份文件再删**（归档不进前缀、不再回来）——名额满了、要拿新的换掉旧的时用它。删完核对：块数不变、条目正好少一条。',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: { type: 'string', description: '哪份文件，不写就是今天那份（设置里的「今天那份」）。' },
        block: { type: 'string', description: '哪一块：日期块写 `11-10`；特殊块写它现在的标题。' },
        old: { type: 'string', description: '要删的那一条里的一小段原文。' },
        keep: { type: 'boolean', description: '`true` = 先整条归档再删（进设置里的归档文件，不进前缀、不再回来）。不写就是真删。' },
        to: { type: 'string', description: '配合 keep：归档到这一份。不写就用设置里的归档文件。单独给 to 也会走归档。' },
      },
      required: ['block', 'old'],
    },
  },
  {
    name: 'ml_merge',
    description: '把同一份文件里的几块并成一块：按文件里的先后顺序拼正文，标题换成 into，其余块删掉，条目一条不丢（回执会核对条目数）。整理 `games/*` 用——不同局、同一身份并成一块，标题只写身份（`## 当狼`）。前缀里的文件不许合并：那会改掉日期归属，覆盖就数不准。',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: { type: 'string', description: '哪份文件，不写就是今天那份。' },
        blocks: { type: 'string', description: '要合并的块，用 `|` 分隔（块名里可能带逗号，所以不用逗号分）。' },
        into: { type: 'string', description: '合并后的标题，只写文字，如 `当狼`。' },
      },
      required: ['blocks', 'into'],
    },
  },
  {
    name: 'ml_block',
    description: '对**整块**做四件事：`view` 看原文（按条编号，不用读整份文件）；`write` 用新正文**重写整块**（标题不动，条目按你写的来）；`delete` 整块删掉（**不进归档**）；`rename` 只改标题、条目一条不动。加一条用 `ml_add`，删一条用 `ml_delete`，整块搬到另一份用 `ml_move`。',
    tags: ['read', 'write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['view', 'write', 'delete', 'rename'], description: '`view` 看原文；`write` 重写正文；`delete` 删整块；`rename` 改标题。' },
        file: { type: 'string', description: '哪一份，不写就是今天那份（设置里的「今天那份」）。' },
        block: { type: 'string', description: '哪一块：日期块写 `11-11`；特殊块写它现在的标题。' },
        offset: { type: 'number', description: '`view` 用：从第几条开始看（0 起）。块太长、上次只看到一半时接着看。' },
        limit: { type: 'number', description: '`view` 用：这一页最多几条。和 `offset` 一起用就是一页一页翻；不写就按字数（约 6000 字）截。' },
        text: { type: 'string', description: '`write` 用：整块的新正文（多行用换行，每条以 `- ` 开头）。这是**替换**，不是追加——旧的正文会被它完全取代。' },
        new: { type: 'string', description: '`rename` 用：新标题，`## ` 可写可不写。日块必须以原日期开头（换日期用 `ml_move`），月块必须原样，不许和别的块重名。' },
      },
      required: ['action', 'block'],
    },
  },
];

/** 把声明和实现绑起来。 */
export function createLedgerTools(opts: LedgerToolOptions): ToolDef[] {
  return LEDGER_TOOL_DECLS.map((decl) => ({
    ...decl,
    handler: (args: Args) => {
      try {
        if (decl.name === 'ml_check') return check(args, opts);
        if (decl.name === 'ml_recall') return recallTool(args, opts);
        if (decl.name === 'ml_add') return add(args, opts);
        if (decl.name === 'ml_move') return move(args, opts);
        if (decl.name === 'ml_edit') return edit(args, opts);
        if (decl.name === 'ml_delete') return remove(args, opts);
        if (decl.name === 'ml_merge') return merge(args, opts);
        if (decl.name === 'ml_block') return blockTool(args, opts);
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
  pastFile = DEFAULT_PAST_FILE,
): LedgerToolOptions {
  return {
    folder: () => folderOf('', folder),
    rules: () => rules,
    backupDir: () => backupDir,
    today: () => today,
    todayFile: () => todayFile,
    pastFile: () => pastFile,
    archiveFile: () => archiveFile,
  };
}
