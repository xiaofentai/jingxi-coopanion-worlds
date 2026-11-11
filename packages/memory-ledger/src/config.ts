/** 配置段 `worlds.memory-ledger`：读哪个目录、每份留多少、其余文件怎么列。 */
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { Language } from 'cortico/core/language.ts';
import type { WorldSection } from 'cortico/world.ts';
import { memoryLedgerText } from './text.ts';

export const MEMORY_LEDGER_ID = 'memory-ledger';

/** 设置页里能单独填的规则条数；更多的写进 `extraRules`。 */
export const RULE_SLOTS = 5;

/** `ml_add` / `ml_edit` / `ml_delete` 不写 `file` 时落在哪一份；默认值只在这里出现。 */
export const DEFAULT_TODAY_FILE = '超近期.md';

/**
 * `ml_forget` 不写 `to` 时归档到哪一份。归档不进前缀，也不再回到原文件。
 * 默认值只在这里出现。
 */
export const DEFAULT_ARCHIVE_FILE = 'archive/大事记-归档.md';

/** 归档文件自动生成时写的文件头：一句用途 + 一个指向。 */
export const ARCHIVE_FRONT = [
  '# 归档',
  '',
  '从其它文件淘汰下来的条目，按月聚。**不进前缀**，也不再回到原文件；要翻它用 `read_file`。',
  '',
].join('\n');



export interface MemoryLedgerConfigSection extends WorldSection {
  /** 目录：绝对路径，或相对部署目录；空表示 `workspace`。 */
  folder: string;
  /** 三个写入工具不写 `file` 时的默认文件；空表示 `DEFAULT_TODAY_FILE`。 */
  todayFile: string;
  /** `ml_forget` 的默认归档文件；空表示 `DEFAULT_ARCHIVE_FILE`。 */
  archiveFile: string;
  /** 一条规则，`路径|模式|参数|字数上限|方向`。设置页是单行输入，所以一条一行。 */
  rule1: string;
  rule2: string;
  rule3: string;
  rule4: string;
  rule5: string;
  /** 超出五个槽的规则，分号分隔，格式同上。 */
  extraRules: string;
  /** 没进规则的 `.md` 只列路径和首行。 */
  listOthers: boolean;
  listMax: number;
  /** 跳过的目录名或文件名，逗号分隔。 */
  exclude: string;
}

export const MEMORY_LEDGER_DEFAULTS: MemoryLedgerConfigSection = {
  enabled: false,
  folder: 'workspace',
  todayFile: DEFAULT_TODAY_FILE,
  archiveFile: DEFAULT_ARCHIVE_FILE,
  rule1: '',
  rule2: '',
  rule3: '',
  rule4: '',
  rule5: '',
  extraRules: '',
  listOthers: true,
  listMax: 12,
  exclude: '.git,node_modules,archive,handoffs,blobs,petdiary,PARTNER.md,CONSTITUTION.md',
};

/** 槽与追加行按顺序拼成 `board.ts` 认的一行一份格式。 */
export function rulesText(cfg: MemoryLedgerConfigSection): string {
  const slots = [cfg.rule1, cfg.rule2, cfg.rule3, cfg.rule4, cfg.rule5]
    .map((rule) => (rule ?? '').trim())
    .filter(Boolean);
  const extra = (cfg.extraRules ?? '')
    .split(/[;；\n]+/)
    .map((rule) => rule.trim())
    .filter(Boolean);
  return [...slots, ...extra].join('; ');
}

/** 这份 World 的配置页。每个键都在用的时候读，所以改完不用重启。 */
export function memoryLedgerConfigGroup(language: Language = 'zh'): ConfigGroup {
  const c = memoryLedgerText(language).config;
  const K = `worlds.${MEMORY_LEDGER_ID}`;
  const rule = (n: number) => ({
    type: 'string',
    title: c.rule.title(n),
    description: n === 1 ? c.rule.description : c.rule.more,
    'x-hot': true,
  });
  return {
    id: `world:${MEMORY_LEDGER_ID}`,
    owner: `world:${MEMORY_LEDGER_ID}`,
    schema: {
      type: 'object',
      title: c.group,
      description: c.groupDescription,
      properties: {
        [`${K}.folder`]: {
          type: 'string',
          title: c.folder.title,
          description: c.folder.description,
          'x-path': { kind: 'directory' },
          'x-hot': true,
        },
        [`${K}.todayFile`]: {
          type: 'string',
          title: c.todayFile.title,
          description: c.todayFile.description,
          'x-path': { kind: 'file', extensions: ['.md'] },
          'x-hot': true,
        },
        [`${K}.archiveFile`]: {
          type: 'string',
          title: c.archiveFile.title,
          description: c.archiveFile.description,
          'x-path': { kind: 'file', extensions: ['.md'] },
          'x-hot': true,
        },
        [`${K}.rule1`]: rule(1),
        [`${K}.rule2`]: rule(2),
        [`${K}.rule3`]: rule(3),
        [`${K}.rule4`]: rule(4),
        [`${K}.rule5`]: rule(5),
        [`${K}.extraRules`]: {
          type: 'string',
          title: c.extraRules.title,
          description: c.extraRules.description,
          'x-hot': true,
        },
        [`${K}.listOthers`]: {
          type: 'boolean',
          title: c.listOthers.title,
          description: c.listOthers.description,
          'x-hot': true,
        },
        [`${K}.listMax`]: {
          type: 'integer',
          title: c.listMax.title,
          description: c.listMax.description,
          minimum: 0,
          maximum: 100,
          'x-hot': true,
        },
        [`${K}.exclude`]: {
          type: 'string',
          title: c.exclude.title,
          description: c.exclude.description,
          'x-hot': true,
        },
      },
    },
  };
}

/** 配置里的逗号/换行分隔列表。 */
export function splitList(text: string): string[] {
  return text
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}
