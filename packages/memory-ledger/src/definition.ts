import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { MEMORY_LEDGER_DEFAULTS, MEMORY_LEDGER_ID, type MemoryLedgerConfigSection } from './config.ts';
import { LEDGER_TOOL_DECLS } from './tools.ts';
import { MemoryLedgerWorld } from './world.ts';

export const MEMORY_LEDGER: WorldDefinition<MemoryLedgerConfigSection> = {
  id: MEMORY_LEDGER_ID,
  label: 'Memory Graph',
  defaults: () => ({ ...MEMORY_LEDGER_DEFAULTS }),
  configOptions: () => [],
  // `ctx.cfg` 是活的配置段，规则与目录每次构建前缀时现读
  create: (ctx) => new MemoryLedgerWorld({ cfg: ctx.cfg, botDir: ctx.botDir, timezone: ctx.timezone }),
  describe: {
    tools: describeTools(LEDGER_TOOL_DECLS, {
      ml_check: {
        zh: '体检：每份几块、日期到哪、哪一天缺、哪一天同时躺在两份文件里。只读。',
        en: 'Reports each file\'s blocks, date span, missing days and days that sit in two files. Read-only.',
      },
      ml_recall: {
        zh: '回忆旧事：给一句你说的话，返回命中的那一条加上它前后几条（▶ 标出命中那条）；一条都不像会明说「似乎之前没提到过」。entity 精确、days 时间窗；句子里的日期（11-06、11月6日、昨天）单独认，不参与字面比对。',
        en: 'Recalls old events: give a sentence you were about to say and it returns the matching entry plus the ones around it (▶ marks the hit); when nothing matches it says so. entity is exact, days is a window; dates in the sentence are pulled out separately instead of being matched as text.',
      },
      ml_add: {
        zh: '往某一天追加一条记忆；同类事以前发生过的日期直接写进正文。first=true 插到块首，写「这一天的一句话」时用它。',
        en: 'Appends one entry to a day; dates of earlier occurrences go into the text itself. first=true puts it at the front of the block, for the day\'s one line.',
      },
      ml_move: {
        zh: '把整块（一整天）搬到另一份文件，按日期插位；给了 text 就用新正文替换块内正文（压进下一层）。目标已有同一天会拒绝。',
        en: 'Moves a whole day block into another file in date order; with text it replaces the block\'s body (distilling into the next layer). Refuses when the target already has that day.',
      },
      ml_edit: {
        zh: '改某一块里的一处文字；原文在块内必须唯一。block 写「文件头」可改第一个标题之前那几行。',
        en: 'Changes one sentence inside a block; the original must be unique in that block. block="文件头" edits the lines before the first heading.',
      },
      ml_delete: {
        zh: '删掉某一块里的一条（含续行）；命中两条以上会拒绝。给了 keep 就「先整条归档再删」，那份文件不进前缀、也不再回来。',
        en: 'Removes one entry from a block with its continuation lines; two matches are refused. With keep=true the entry is archived whole first — the archive never enters the prefix and never comes back.',
      },
      ml_merge: {
        zh: '把同一份文件里的几块并成一块，条目一条不丢（核对条目数）。整理 games/* 用：不同局、同一身份并成一块。前缀里的文件不许合并。',
        en: 'Merges several blocks of one file into one, losing no entry (counts are checked). For tidying `games/*`: the same role across games becomes one block. Files that feed the prefix may not be merged.',
      },
      ml_block: {
        zh: '对整块做四件事：view 看原文（按条编号，不用读整份文件）、write 用新正文重写整块、delete 整块删掉（不进归档）、rename 只改标题。',
        en: 'Four things on a whole block: view its text (numbered, no need to read the file), write a new body over it, delete it (nothing kept), rename its heading.',
      },
    }),
  },
};
