/** 配置段 `worlds.memory-card`：读哪个目录、每份留多少、其余文件怎么列。 */
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { Language } from 'cortico/core/language.ts';
import type { WorldSection } from 'cortico/world.ts';
import { memoryCardText } from './text.ts';

export const MEMORY_CARD_ID = 'memory-card';

/** 设置页里能单独填的规则条数；更多的写进 `extraRules`。 */
export const RULE_SLOTS = 5;

export interface MemoryCardConfigSection extends WorldSection {
  /** 目录：绝对路径，或相对部署目录；空表示 `workspace`。 */
  folder: string;
  /** 一条规则，`路径|模式|参数|字数上限`。设置页是单行输入，所以一条一行。 */
  rule1: string;
  rule2: string;
  rule3: string;
  rule4: string;
  rule5: string;
  /** 超出五个槽的规则，分号分隔，格式同上。 */
  extraRules: string;
  /** 整张卡的字数上限。 */
  totalChars: number;
  /** 没进规则的 `.md` 只列路径和首行。 */
  listOthers: boolean;
  listMax: number;
  /** 跳过的目录名或文件名，逗号分隔。 */
  exclude: string;
}

export const MEMORY_CARD_DEFAULTS: MemoryCardConfigSection = {
  enabled: false,
  folder: 'workspace',
  rule1: '',
  rule2: '',
  rule3: '',
  rule4: '',
  rule5: '',
  extraRules: '',
  totalChars: 6000,
  listOthers: true,
  listMax: 12,
  exclude: '.git,node_modules,archive,handoffs,blobs',
};

/** 槽与追加行按顺序拼成 `card.ts` 认的一行一份格式。 */
export function rulesText(cfg: MemoryCardConfigSection): string {
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
export function memoryCardConfigGroup(language: Language = 'zh'): ConfigGroup {
  const c = memoryCardText(language).config;
  const K = `worlds.${MEMORY_CARD_ID}`;
  const rule = (n: number) => ({
    type: 'string',
    title: c.rule.title(n),
    description: n === 1 ? c.rule.description : c.rule.more,
    'x-hot': true,
  });
  return {
    id: `world:${MEMORY_CARD_ID}`,
    owner: `world:${MEMORY_CARD_ID}`,
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
        [`${K}.totalChars`]: {
          type: 'integer',
          title: c.totalChars.title,
          description: c.totalChars.description,
          minimum: 0,
          maximum: 200_000,
          'x-suffix': c.totalChars.suffix,
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
