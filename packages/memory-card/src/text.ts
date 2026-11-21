/**
 * 这个 World 的文案：配置页、独立「设置」面板、环境提示的标题与占位符说明。
 * 中文与英文两张表；其余语言读英文。模型读的模板在 `ENV_PROMPT.md` / `ENV_PROMPT.en.md`。
 */
import type { Language } from 'cortico/core/language.ts';
import type { Cut, RuleMode } from './card.ts';

export type TextLanguage = 'zh' | 'en';

export const PROMPT_VARS = ['mc.meta', 'mc.card', 'mc.index'] as const;
export type PromptVar = (typeof PROMPT_VARS)[number];

export interface MemoryCardText {
  label: string;
  config: {
    group: string;
    groupDescription: string;
    enabled: { title: string; description: string };
  };
  panel: {
    title: string;
    description: string;
    saved: string;
    commonTitle: string;
    commonDescription: string;
    ruleTitle: (n: number) => string;
    ruleDescription: string;
    labels: {
      file: string;
      mode: string;
      arg: string;
      limit: string;
      cut: string;
      folder: string;
      totalChars: string;
      listOthers: string;
      listMax: string;
      exclude: string;
    };
    hints: {
      file: string;
      mode: string;
      arg: string;
      limit: string;
      cut: string;
      folder: string;
      totalChars: string;
      listOthers: string;
      listMax: string;
      exclude: string;
    };
    charsSuffix: string;
    modes: Record<RuleMode, string>;
    cuts: Record<Cut, string>;
  };
  envPrompt: {
    title: string;
    description: string;
    vars: Record<PromptVar, string>;
  };
}

const zh: MemoryCardText = {
  label: '记忆卡',
  config: {
    group: '记忆卡',
    groupDescription: '把目录里的 Markdown 按规则裁成一张卡，每次交接重建前缀时整段送进去。只读，不改文件。',
    enabled: {
      title: '启用记忆卡',
      description: '关掉就不再往前缀里放这张卡。目录、规则、上限都在同一页的「设置」面板里。'
        + '更新扩展后若看不到「设置」，先按扩展页的「重启进程」，再刷新一次控制台页面'
        + '（Ctrl+R；面板或样式还是旧的，就用 Ctrl+Shift+R 硬刷新）——页面清单只在开页时取。',
    },
  },
  panel: {
    title: '设置',
    description: '这里的设置不写进 config.json，落在 data 目录的 memory-card-settings.json；配置页只剩一个启用开关。',
    saved: '已保存',
    commonTitle: '总设置',
    commonDescription: '读哪个目录、整张卡的上限，以及没进规则的文件怎么列。',
    ruleTitle: (n) => `第 ${n} 条`,
    ruleDescription: '一条管一份文件：选文件、选取法、填参数。文件留空就跳过这一条。',
    labels: {
      file: '文件',
      mode: '取法',
      arg: '取法的参数',
      limit: '字数上限',
      cut: '超了切哪头',
      folder: '目录',
      totalChars: '整张卡上限',
      listOthers: '列出未载入的文件',
      listMax: '最多列几个',
      exclude: '跳过的目录或文件',
    },
    hints: {
      file: '相对上面那个目录，如 记忆.md、partner/偏好与习惯.md；留空就跳过这一条。',
      mode: '整份装入；到某标题之前；到某标题之前并列出后面的块；最近几块；最近几块加固定块。',
      arg: '到某标题之前 → 标题本身，如 ## 按需；最近几块 → 块数，如 2；最近几块加固定块 → 2,还挂着；整份 → 留空。',
      limit: '超过就截断，卡上写明还有多少字未载入；0 = 不单独限制，只受整张卡上限。',
      cut: '断尾留开头（默认）；日记这类新内容在最后的文件改用截头。',
      folder: '空 = 部署目录下的 workspace。',
      totalChars: '超过就从最后一条开始整份丢掉，并报「还有 N 份没载入」。',
      listOthers: '没进规则的 .md 只列路径和首行，让她知道有事可以查。',
      listMax: '未载入的文件、「未上卡的块」各最多列几条；超出的只报数量。',
      exclude: '逗号分隔，大小写不敏感。这些目录下的 .md 不读也不列。',
    },
    charsSuffix: '字',
    modes: {
      whole: '整份装入',
      marker: '到某标题之前',
      'marker+outline': '到某标题之前 + 后面的块目录',
      newest: '最近几块',
      'newest+pin': '最近几块 + 固定块',
    },
    cuts: {
      tail: '断尾（留开头）',
      head: '截头（留结尾）',
    },
  },
  envPrompt: {
    title: '记忆卡 · 环境提示',
    description: '这段把裁剪好的记忆放进系统前缀，并在每次交接时重建。',
    vars: {
      'mc.meta': '读取了几份、多少字、几块未上卡、生成时间，一行。',
      'mc.card': '裁剪后的正文，带文件名与修改时间。',
      'mc.index': '没有载入的文件清单，每行「路径：首行」。',
    },
  },
};

const en: MemoryCardText = {
  label: 'Memory card',
  config: {
    group: 'Memory card',
    groupDescription: 'Cuts the Markdown in a folder into one card and puts it in the system prefix at every handoff. Read only.',
    enabled: {
      title: 'Enable the memory card',
      description: 'Turned off, the card is not built into the prefix. Folder, rules and limits live in the Settings panel on the same page. '
        + 'If Settings is missing after an update, restart the process from the extensions page and then reload the console page '
        + '(Ctrl+R; Ctrl+Shift+R for a hard reload if panels or styles still look old): the page list is fetched only when a page opens.',
    },
  },
  panel: {
    title: 'Settings',
    description: 'These settings do not go into config.json; they are kept in memory-card-settings.json under the data directory. The config page has only the enable switch.',
    saved: 'Saved',
    commonTitle: 'General',
    commonDescription: 'Which folder to read, the limit for the whole card, and how files outside the rules are listed.',
    ruleTitle: (n) => `Rule ${n}`,
    ruleDescription: 'One rule per file: pick the file, the mode and its argument. An empty file skips the rule.',
    labels: {
      file: 'File',
      mode: 'Mode',
      arg: 'Argument',
      limit: 'Character limit',
      cut: 'Cut side',
      folder: 'Folder',
      totalChars: 'Card limit',
      listOthers: 'List the files left out',
      listMax: 'List at most',
      exclude: 'Folders and files skipped',
    },
    hints: {
      file: 'Relative to the folder above, e.g. 记忆.md or partner/偏好与习惯.md. Empty skips the rule.',
      mode: 'The whole file; up to a heading; up to a heading plus an outline of the blocks after it; the newest blocks; the newest blocks plus a pinned one.',
      arg: 'Up to a heading: the heading itself, e.g. ## 按需. Newest blocks: the count, e.g. 2. Newest plus pinned: 2,name. Whole file: leave empty.',
      limit: 'Over it the text is cut and the card says how much is missing; 0 means the card limit only.',
      cut: 'tail keeps the beginning (default); head keeps the end, for files whose newest lines are at the bottom.',
      folder: 'Empty means workspace under the deployment directory.',
      totalChars: 'Over it, whole rules are dropped from the last one backwards, and the card says how many did not fit.',
      listOthers: 'Every .md outside the rules is listed by path and first line, so she knows what she can look up.',
      listMax: 'How many files left out and blocks not on the card to list; the rest are counted only.',
      exclude: 'Comma separated, case-insensitive. Nothing under a listed folder is read or listed.',
    },
    charsSuffix: 'characters',
    modes: {
      whole: 'The whole file',
      marker: 'Up to a heading',
      'marker+outline': 'Up to a heading + block outline',
      newest: 'The newest blocks',
      'newest+pin': 'The newest blocks + a pinned one',
    },
    cuts: {
      tail: 'Keep the beginning',
      head: 'Keep the end',
    },
  },
  envPrompt: {
    title: 'Memory card: environment',
    description: 'This section puts the trimmed memory into the system prefix, rebuilt at every handoff.',
    vars: {
      'mc.meta': 'How many files, how many characters, how many blocks are not on the card, when it was built, on one line.',
      'mc.card': 'The trimmed text, with each file name and modification time.',
      'mc.index': 'The files left out, one line each as path: first line.',
    },
  },
};

export function memoryCardText(language: Language = 'zh'): MemoryCardText {
  return textLanguage(language) === 'zh' ? zh : en;
}

export function textLanguage(language: Language): TextLanguage {
  return language.startsWith('zh') ? 'zh' : 'en';
}
