/**
 * 这个 World 的文案：设置页、环境提示的标题与占位符说明。
 * 中文与英文两张表；其余语言读英文。模型读的模板在 `ENV_PROMPT.md` / `ENV_PROMPT.en.md`。
 */
import type { Language } from 'cortico/core/language.ts';

export type TextLanguage = 'zh' | 'en';

export const PROMPT_VARS = ['mc.meta', 'mc.card', 'mc.index'] as const;
export type PromptVar = (typeof PROMPT_VARS)[number];

export interface MemoryCardText {
  label: string;
  config: {
    group: string;
    groupDescription: string;
    folder: { title: string; description: string };
    rule: { title: (n: number) => string; description: string; more: string };
    extraRules: { title: string; description: string };
    totalChars: { title: string; description: string; suffix: string };
    listOthers: { title: string; description: string };
    listMax: { title: string; description: string };
    exclude: { title: string; description: string };
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
    folder: {
      title: '目录',
      description: '要读的文件夹。绝对路径，或相对部署目录（空 = workspace）。',
    },
    rule: {
      title: (n) => `规则 ${n}`,
      description:
        '分工后 card 只装三份整份文件，默认已填好：常驻.md|whole||2000、'
        + 'partner/偏好与习惯.md|whole||2000、记忆.md|whole||1600|tail。'
        + '格式是 路径|whole|（留空）|字数上限|截断关键词。'
        + '截断关键词只有 tail（留开头，默认）和 head（留结尾）；超过上限时卡上会写明还有多少字未载入。'
        + '流水、大事记、games/* 归 memory-ledger，不在这里按块索引。',
      more: '同上。留空就跳过。',
    },
    extraRules: {
      title: '更多规则',
      description: '五个槽不够时填这里，分号分隔，格式同上。',
    },
    totalChars: {
      title: '总字数上限',
      description: '整张卡的上限；超了从最后一条规则开始整份丢掉。',
      suffix: '字',
    },
    listOthers: {
      title: '列出没有载入的文件',
      description: '没进规则的 .md 只列路径和首行，让 bot 知道有事可以查。',
    },
    listMax: {
      title: '最多列几个',
      description: '未载入的文件最多列几条；超出的只报数量。',
    },
    exclude: {
      title: '跳过的目录或文件',
      description: '逗号分隔，大小写不敏感。这些目录下的 .md 不读也不列；写文件名则该项本身不列。',
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
    folder: {
      title: 'Folder',
      description: 'The folder to read. Absolute, or relative to the deployment directory (empty means workspace).',
    },
    rule: {
      title: (n) => `Rule ${n}`,
      description:
        'After the split, card loads three whole files; the defaults are already filled in: '
        + '常驻.md|whole||2000, partner/偏好与习惯.md|whole||2000, 记忆.md|whole||1600|tail. '
        + 'Format: path|whole|(empty)|character limit|cut keyword. '
        + 'Only tail (keep the beginning, default) and head (keep the end) are accepted; the card reports how many characters were left out. '
        + 'Streams, the milestone list and games/* belong to memory-ledger — no block index here.',
      more: 'Same as above. Empty fields are skipped.',
    },
    extraRules: {
      title: 'More rules',
      description: 'For anything past the five fields, semicolon separated, same format.',
    },
    totalChars: {
      title: 'Total limit',
      description: 'Limit for the whole card; over it, whole files are dropped from the last rule backwards.',
      suffix: 'chars',
    },
    listOthers: {
      title: 'List the files left out',
      description: 'Every .md not in the rules is listed by path and first line, so the bot knows what it can look up.',
    },
    listMax: {
      title: 'List at most',
      description: 'How many files left out to list; the rest are counted only.',
    },
    exclude: {
      title: 'Folders and files skipped',
      description: 'Comma separated, case-insensitive. Nothing under a listed folder is read or listed; a listed file is not listed either.',
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
