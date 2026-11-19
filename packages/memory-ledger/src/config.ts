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
 * 第二层流水：存放「那么近，但又没那么远」的记忆。
 * `ml_move` 不写 `to`、又给了新正文时压进这一份。默认值只在这里出现。
 */
export const DEFAULT_PAST_FILE = '近期.md';

/**
 * `ml_delete(…, keep=true)` 不写 `to` 时归档到哪一份。归档不进前缀，也不再回到原文件。
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
  /**
   * 第二层流水：存放「那么近，但又没那么远」的记忆。
   * `ml_move` 不写 `to`、又给了新正文时压进这一份；空表示 `DEFAULT_PAST_FILE`。
   */
  pastFile: string;
  /** `ml_delete(…, keep=true)` 的默认归档文件；空表示 `DEFAULT_ARCHIVE_FILE`。 */
  archiveFile: string;
  /**
   * 开口前召回：开的时候前缀里会多一句「打算开口先 ml_recall」。
   * 默认关——它是用来测「她会不会真的在开口前查」的，不是常态。
   */
  recallOnSpeak: boolean;
  /**
   * 预激活：他刚说完一句，插件替她召回一次，把最多两条旧事递到眼前。
   *
   * 和 `recallOnSpeak` 是两条路：那个靠她自觉，这个不靠。开了之后每 30 秒看一眼
   * 事件库，只在「十分钟内有人说话」时动手，同一块两小时内不重复。
   */
  preactivate: boolean;
  /**
   * 预激活一天最多推几次。0 = 不限。
   *
   * 用预算而不是概率：概率每轮独立，聊五十句期望五次，今天被打扰几回没法预测；
   * 预算可数、可解释、可调。
   */
  preactivatePerDay: number;
  /**
   * 游戏路由：开局时把「读局 + 对应角色块」推给她一次。
   *
   * 走推送不走前缀——前缀在 session 开始时冻结，局中开局改不了它。
   * 文件与身份的对应写在 `games/*.md` 的文件头（`family:` / `wolf: 当狼`），
   * 所以新出一款游戏不用改插件。
   */
  gameRoute: boolean;
  /**
   * 旧配置里的规则槽，仅供首次迁移到 `memory-ledger-settings.json` 时读取。
   * 新配置页不再显示它们；同一个文件不能在两个地方各有一套判据。
   */
  rule1: string;
  rule2: string;
  rule3: string;
  rule4: string;
  rule5: string;
  /** 超出五个槽的规则，分号分隔，格式同上。 */
  extraRules: string;
  /** 其余文件不进 ledger 的索引；整份文件由 memory-card 负责。 */
  listOthers: boolean;
  listMax: number;
  /** 跳过的目录名或文件名，逗号分隔；包含交给 card 的那三份。 */
  exclude: string;
}

export const MEMORY_LEDGER_DEFAULTS: MemoryLedgerConfigSection = {
  enabled: false,
  folder: 'workspace',
  todayFile: DEFAULT_TODAY_FILE,
  pastFile: DEFAULT_PAST_FILE,
  archiveFile: DEFAULT_ARCHIVE_FILE,
  recallOnSpeak: false,
  preactivate: false,
  preactivatePerDay: 6,
  gameRoute: false,
  rule1: '',
  rule2: '',
  rule3: '',
  rule4: '',
  rule5: '',
  extraRules: '',
  listOthers: false,
  listMax: 12,
  exclude: '.git,node_modules,archive,handoffs,blobs,petdiary,PARTNER.md,CONSTITUTION.md,常驻.md,记忆.md,partner',
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
        [`${K}.pastFile`]: {
          type: 'string',
          title: c.pastFile.title,
          description: c.pastFile.description,
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
        [`${K}.recallOnSpeak`]: {
          type: 'boolean',
          title: c.recallOnSpeak.title,
          description: c.recallOnSpeak.description,
          'x-hot': true,
        },
        [`${K}.preactivate`]: {
          type: 'boolean',
          title: c.preactivate.title,
          description: c.preactivate.description,
          'x-hot': true,
        },
        [`${K}.preactivatePerDay`]: {
          type: 'integer',
          title: c.preactivatePerDay.title,
          description: c.preactivatePerDay.description,
          minimum: 0,
          maximum: 20,
          'x-hot': true,
        },
        [`${K}.gameRoute`]: {
          type: 'boolean',
          title: c.gameRoute.title,
          description: c.gameRoute.description,
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
