/** 界面文案与提示词变量的说明。 */
import type { Language } from 'cortico/core/language.ts';

export type TextLanguage = 'zh' | 'en';

/** 交给系统前缀的变量名。`ml.policy` 是从规则算出来的口径，改设置它就跟着变。 */
export const PROMPT_VARS = ['ml.meta', 'ml.card', 'ml.index', 'ml.policy', 'ml.hint'] as const;

export function textLanguage(language: Language): TextLanguage {
  return language === 'en' ? 'en' : 'zh';
}

export function memoryLedgerText(language: Language) {
  return textLanguage(language) === 'en' ? EN : ZH;
}

const ZH = {
  label: '记忆树网',
  /** 只在这个实验开关打开时进前缀。 */
  hintRecall: '**开口前先查一次**：如果接下来这句话里有人名、局号、项目名、约定过的事，先 `ml_recall(entity=那个名字)` 或 `ml_recall(query=你打算说的那句)`；回执里挑要不要改口。一轮查一次就够，查到「大概是新的」就照原样说。',
  config: {
    group: '记忆树网',
    groupDescription: '把记忆文件折成「一行一块」的图谱交给前缀，并报出哪几天已在窗口外。只读，不写盘。',
    folder: { title: '目录', description: '记忆文件所在的目录；留空表示部署目录下的 workspace。' },
    todayFile: { title: '今天那份', description: '`ml_add` / `ml_edit` / `ml_delete` 不写 file 时写进哪一份；留空表示 超近期.md。改名后记得在这里改。' },
    archiveFile: { title: '归档到哪', description: '`ml_forget` 把条目移出后写进哪一份。留空表示 archive/大事记-归档.md。启用时若不存在会自动建一个。归档不进前缀，也不再回到原文件。' },

    recallOnSpeak: { title: '开口前召回', description: '打开后，前缀里会多一句「打算开口时先 ml_recall」。用来测她会不会真的在开口前查——**这不是常态，是实验**。改完要重启才生效。' },
    rule: {
      title: (n: number) => `规则 ${n}`,
      description: '路径|模式|参数|上限。整体上卡的有三种：whole 整份、full 整份、marker 取到某标题之前（都不截断）。其中 whole / marker 的第四段是**字数**提醒线，`full` 的第四段是**条目上限**。catalog 每块只出一行、全部上卡，「参数」= 保留几天、「上限」= 条目上限。条目上限一律按 80% 开始提醒、到 100% 拒绝写入。例：常驻.md|whole||1600 ／ 大事记.md|full||120 ／ 超近期.md|catalog|4|',
      more: '同上；留空表示这一槽不用。',
    },
    extraRules: { title: '更多规则', description: '分号分隔，格式同上。' },

    listOthers: { title: '列出其余文件', description: '没进规则的 .md 只列路径与首行。' },
    listMax: { title: '其余文件上限', description: '最多列几个；超出的只报数量。' },
    exclude: { title: '跳过的目录', description: '目录名或文件名，逗号分隔。' },
  },
  envPrompt: {
    title: '记忆树网的提示词',
    description: '说明 ml.card / ml.index / ml.meta / ml.policy 分别是什么、什么时候要用。',
    vars: {
      'ml.card': '折好的一页：各份的正文，末尾附「该整理的」与「覆盖」。',
      'ml.index': '没进规则的 .md 清单，只有路径与首行。',
      'ml.meta': '一行摘要：读取几份、多少字、几处该整理、几份偏长、缺几天、生成时间。',
      'ml.policy': '从规则算出来的口径：各份留几天 / 几条，随设置变。',
    },
  },
} as const;

const EN = {
  label: 'Memory Graph',
  /** Only enters the prefix when the experiment switch is on. */
  hintRecall: '**Check once before you speak**: if the next sentence has a name, a game id, a project, or something you agreed on, run `ml_recall(entity=the name)` or `ml_recall(query=what you are about to say)` and decide from the receipt whether to change what you would say. Once per turn is enough; "probably new" means say it as planned.',
  config: {
    group: 'Memory Graph',
    groupDescription: 'Folds the memory files into a one-line-per-block graph for the prefix, and reports which days are past their window. Read-only.',
    folder: { title: 'Folder', description: 'Where the memory files are; empty means the deployment\'s workspace.' },
    todayFile: { title: 'Today\'s file', description: 'Which file `ml_add` / `ml_edit` / `ml_delete` write to when `file` is left out; empty means 超近期.md. Change it here if you rename that file.' },
    archiveFile: { title: 'Archive to', description: 'Where `ml_forget` writes the entry it moves out. Empty means archive/大事记-归档.md, created on enable if missing. The archive never enters the prefix and never comes back.' },

    recallOnSpeak: { title: 'Recall before speaking', description: 'When on, the prefix gains one line telling her to run `ml_recall` before she speaks. This is an experiment, not the default. Takes a restart.' },
    rule: {
      title: (n: number) => `Rule ${n}`,
      description: 'path|mode|argument|limit. Three modes put the file on the board whole: whole, full, marker (none of them truncate). For whole / marker the fourth field is a **character** reminder line; for `full` it is the **entry cap**. catalog prints one line per block, everything on the board: the argument is the day window, the fourth field the entry cap. Entry caps start reporting at 80% and refuse writes at 100%. Example: 常驻.md|whole||1600 ／ 大事记.md|full||120 ／ 超近期.md|catalog|4|',
      more: 'Same as above; leave empty to skip this slot.',
    },
    extraRules: { title: 'More rules', description: 'Separated by semicolons, same format.' },

    listOthers: { title: 'List other files', description: 'Markdown files not in any rule: path and first line only.' },
    listMax: { title: 'Other files limit', description: 'How many to list; the rest are counted.' },
    exclude: { title: 'Skip', description: 'Directory or file names, comma separated.' },
  },
  envPrompt: {
    title: 'The Memory Graph prompt',
    description: 'What ml.card, ml.index, ml.meta and ml.policy hold, and when to use them.',
    vars: {
      'ml.card': 'The folded page: each file\'s text, then overdue days and the coverage line.',
      'ml.index': 'Files not in any rule: path and first line.',
      'ml.meta': 'One line: files, characters, blocks left off, days missing, when built.',
    },
  },
} as const;
