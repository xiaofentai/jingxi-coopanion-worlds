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
        zh: '跨文件召回：给几条最相关的旧条目（最多 5），每条带来源。entity 精确、days 时间窗、query 自由文本。只给候选，要细节用 read_file。',
        en: 'Recalls the few most relevant older entries across files (5 at most), each with its source. entity is exact, days is a window, query is free text. Candidates only; use read_file for the detail.',
      },
      ml_add: {
        zh: '往某一天追加一条记忆；同类事以前发生过就用 again 写上那几个日期。first=true 插到块首，写「这一天的一句话」时用它。',
        en: 'Appends one entry to a day; when the same thing happened before, name those dates with again. first=true puts it at the front of the block, for the day\'s one line.',
      },
      ml_move: {
        zh: '把整块（一整天）搬到另一份文件，按日期插位；目标已有同一天会拒绝。',
        en: 'Moves a whole day block into another file in date order; refuses when the target already has that day.',
      },
      ml_edit: {
        zh: '改某一块里的一处文字；原文在块内必须唯一。block 写「文件头」可改第一个标题之前那几行。',
        en: 'Changes one sentence inside a block; the original must be unique in that block. block="文件头" edits the lines before the first heading.',
      },
      ml_delete: {
        zh: '删掉某一块里的一条（含续行）；命中两条以上会拒绝。',
        en: 'Removes one entry from a block with its continuation lines; two matches are refused.',
      },
      ml_rename: {
        zh: '改一个块的标题（只动标题行，条目一条不动）。ml_edit 碰不到标题，整理 games/* 时用它统一成「当狼 · 八人 · 11-05」这种形状。',
        en: 'Renames a block heading (the heading line only; entries stay untouched). `ml_edit` cannot reach the heading, so this is how `games/*` headings get unified into e.g. "wolf · eight players · 11-05".',
      },
      ml_forget: {
        zh: '淘汰一条：移出这份文件，整条归档进归档文件，不再回来。名额满了换掉旧的一条时用。',
        en: 'Retires one entry: it leaves this file, moves to the archive whole, and never comes back. Use it when a full file must give way to a newer entry.',
      },
    }),
  },
};
