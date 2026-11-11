/** 界面文案与提示词变量的说明。 */
import type { Language } from 'cortico/core/language.ts';

export type TextLanguage = 'zh' | 'en';

/** 交给系统前缀的变量名。`ml.policy` 是从规则算出来的口径，改设置它就跟着变。 */
export const PROMPT_VARS = ['ml.meta', 'ml.card', 'ml.index', 'ml.policy'] as const;

export function textLanguage(language: Language): TextLanguage {
  return language === 'en' ? 'en' : 'zh';
}

export function memoryLedgerText(language: Language) {
  return textLanguage(language) === 'en' ? EN : ZH;
}

const ZH = {
  label: '记忆板',
  config: {
    group: '记忆板',
    groupDescription: '把记忆文件裁成一段交给前缀，并在卡尾报出哪几天缺、哪天重复。只读，不写盘。',
    folder: { title: '目录', description: '记忆文件所在的目录；留空表示部署目录下的 workspace。' },
    todayFile: { title: '今天那份', description: '`ml_add` / `ml_edit` / `ml_delete` 不写 file 时写进哪一份；留空表示 超近期.md。改名后记得在这里改。' },
    archiveFile: { title: '归档到哪', description: '`ml_forget` 把条目移出后写进哪一份。留空表示 archive/大事记-归档.md。启用时若不存在会自动建一个。归档不进前缀，也不再回到原文件。' },

    rule: {
      title: (n: number) => `规则 ${n}`,
      description: '路径|模式|参数|提醒线（catalog 是条目上限）。whole 整份、marker 取到某标题之前、newest 最新几块、newest+pin 再带上某块：这几种**一律不截断**，第四段只是「超过这么多字就提一句」的提醒线，留空不提醒。catalog 每块只出一行、全部上卡，「参数」= 保留几天、「上限」= 最多几条（同样只报账，不裁剪）。例：常驻.md|whole||1600 ／ 超近期.md|catalog|4| ／ 大事记.md|catalog||120',
      more: '同上；留空表示这一槽不用。',
    },
    extraRules: { title: '更多规则', description: '分号分隔，格式同上。' },

    listOthers: { title: '列出其余文件', description: '没进规则的 .md 只列路径与首行。' },
    listMax: { title: '其余文件上限', description: '最多列几个；超出的只报数量。' },
    exclude: { title: '跳过的目录', description: '目录名或文件名，逗号分隔。' },
  },
  envPrompt: {
    title: '记忆板的提示词',
    description: '说明 ml.card / ml.index / ml.meta 分别是什么、什么时候要用。',
    vars: {
      'ml.card': '裁好的一页记忆：各份的正文，末尾附「未上卡的块」与「覆盖」。',
      'ml.index': '没进规则的 .md 清单，只有路径与首行。',
      'ml.meta': '一行摘要：读取几份、多少字、多少块未上卡、缺几天、生成时间。',
    },
  },
} as const;

const EN = {
  label: 'Memory board',
  config: {
    group: 'Memory board',
    groupDescription: 'Cuts the memory files into one page for the prefix, and reports which days are missing or duplicated. Read-only.',
    folder: { title: 'Folder', description: 'Where the memory files are; empty means the deployment\'s workspace.' },
    todayFile: { title: 'Today\'s file', description: 'Which file `ml_add` / `ml_edit` / `ml_delete` write to when `file` is left out; empty means 超近期.md. Change it here if you rename that file.' },
    archiveFile: { title: 'Archive to', description: 'Where `ml_forget` writes the entry it moves out. Empty means archive/大事记-归档.md, created on enable if missing. The archive never enters the prefix and never comes back.' },

    rule: {
      title: (n: number) => `Rule ${n}`,
      description: 'path|mode|argument|reminder line (for catalog it is the entry cap). whole, marker, newest, newest+pin are **never truncated**: the fourth field only prints a reminder once the text runs past it; leave it empty for no reminder. catalog: one line per block, everything on the board; the argument is the day window and the fourth field is the entry cap (again only reported, never enforced by dropping). Example: 常驻.md|whole||1600 ／ 超近期.md|catalog|4| ／ 大事记.md|catalog||120',
      more: 'Same as above; leave empty to skip this slot.',
    },
    extraRules: { title: 'More rules', description: 'Separated by semicolons, same format.' },

    listOthers: { title: 'List other files', description: 'Markdown files not in any rule: path and first line only.' },
    listMax: { title: 'Other files limit', description: 'How many to list; the rest are counted.' },
    exclude: { title: 'Skip', description: 'Directory or file names, comma separated.' },
  },
  envPrompt: {
    title: 'The memory board prompt',
    description: 'What ml.card, ml.index and ml.meta hold, and when to use them.',
    vars: {
      'ml.card': 'The cut page: each file\'s text, then blocks not on the board and the coverage line.',
      'ml.index': 'Files not in any rule: path and first line.',
      'ml.meta': 'One line: files, characters, blocks left off, days missing, when built.',
    },
  },
} as const;
