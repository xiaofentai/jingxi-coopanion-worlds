/**
 * 配置段 `worlds.memory-card`。
 *
 * 配置页只剩 `enabled` 一个开关；规则、目录、上限都搬进独立「设置」面板，
 * 和开关一起落盘在 `config.json` 的 `worlds.memory-card.settings` 段（见 `settings.ts`）。
 * 这里的旧字段只作为**首次迁移**的初值，改完设置之后不再读它们。
 */
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { Language } from 'cortico/core/language.ts';
import type { WorldSection } from 'cortico/world.ts';
import { memoryCardText } from './text.ts';

export const MEMORY_CARD_ID = 'memory-card';

/** 设置页里的规则条数；留空的那几条跳过。 */
export const RULE_SLOTS = 5;

export interface MemoryCardConfigSection extends WorldSection {
  /**
   * 旧配置：目录。
   * @deprecated 已搬到设置页；只在首次迁移时读。
   */
  folder: string;
  /**
   * 旧配置：一条规则，`路径|模式|参数|字数上限|方向`。
   * @deprecated 已搬到设置页；只在首次迁移时读。
   */
  rule1: string;
  /** @deprecated 同上。 */
  rule2: string;
  /** @deprecated 同上。 */
  rule3: string;
  /** @deprecated 同上。 */
  rule4: string;
  /** @deprecated 同上。 */
  rule5: string;
  /**
   * 旧配置：超出五个槽的规则，分号分隔。
   * @deprecated 已搬到设置页；只在首次迁移时读。
   */
  extraRules: string;
  /** @deprecated 已搬到设置页；只在首次迁移时读。 */
  totalChars: number;
  /** @deprecated 已搬到设置页；只在首次迁移时读。 */
  listOthers: boolean;
  /** @deprecated 已搬到设置页；只在首次迁移时读。 */
  listMax: number;
  /** @deprecated 已搬到设置页；只在首次迁移时读。 */
  exclude: string;
}

export const MEMORY_CARD_DEFAULTS: MemoryCardConfigSection = {
  // 分工定下来之后，这张卡是常驻的那一半；装完就开着，不用再点一次
  enabled: true,
  folder: 'workspace',
  // `marker+outline` 只把「按需」那节之前装进前缀，后面各块的块头与字数也列出来，
  // 正文仍留在磁盘上——她看到目录，按需自己 `read_file`。
  rule1: '常驻.md|whole||2000',
  rule2: 'partner/偏好与习惯.md|whole||2000',
  rule3: '记忆.md|marker+outline|## 按需|1600',
  rule4: '',
  rule5: '',
  extraRules: '',
  totalChars: 6000,
  listOthers: false,
  listMax: 12,
  exclude: '.git,node_modules,archive,handoffs,blobs',
};

/** 这份 World 的配置页：只有一个开关。其余设置在同页的「设置」面板。 */
export function memoryCardConfigGroup(language: Language = 'zh'): ConfigGroup {
  const c = memoryCardText(language).config;
  const K = `worlds.${MEMORY_CARD_ID}`;
  return {
    id: `world:${MEMORY_CARD_ID}`,
    owner: `world:${MEMORY_CARD_ID}`,
    schema: {
      type: 'object',
      title: c.group,
      description: c.groupDescription,
      properties: {
        [`${K}.enabled`]: {
          type: 'boolean',
          title: c.enabled.title,
          description: c.enabled.description,
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
