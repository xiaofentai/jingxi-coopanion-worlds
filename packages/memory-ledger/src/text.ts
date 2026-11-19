/** 界面文案与提示词变量的说明。 */
import type { Language } from 'cortico/core/language.ts';

export type TextLanguage = 'zh' | 'en';

/**
 * 交给系统前缀的变量名。`ml.policy` 是从规则算出来的口径，改设置它就跟着变；
 * `ml.layers` 是三层各自的文件名（今天那份 / 再往前那份 / 归档）；
 * `ml.health` 是心跳：几份、覆盖到哪天——它变了说明有东西没读到。
 */
export const PROMPT_VARS = ['ml.health', 'ml.meta', 'ml.card', 'ml.index', 'ml.policy', 'ml.layers', 'ml.hint'] as const;

export function textLanguage(language: Language): TextLanguage {
  return language === 'en' ? 'en' : 'zh';
}

export function memoryLedgerText(language: Language) {
  return textLanguage(language) === 'en' ? EN : ZH;
}

const ZH = {
  label: '记忆树网',
  /** 只在这个实验开关打开时进前缀。 */
  hintRecall: '**开口前先查一次**：这句话里有人名、局号、项目名、约定过的时间，**或者他说的是他自己的状态**（累、困、烦、不舒服、心情不好、睡不着），先 `ml_recall(query=你打算说的那句)` 或 `ml_recall(entity=那个名字)`。回来的那条会带上它前后各几条，够看清语境；**想找某一天，把日期写进 query**（`ml_recall(query="11-14 那天")`），日期会被单独认出来。一轮查一次就够；他要是只说「嗯」「好」「在吗」这种，不用查。',
  /** 三层各自的文件名：改设置就跟着变，提示词里不再写死。 */
  layers: (today: string, past: string, archive: string) =>
    `三层：今天那份 \`${today}\`｜再往前那份 \`${past}\`｜归档 \`${archive}\`（\`ml_move\` 不写 \`to\` 就按这个走：给了新正文进第二层，没给就进归档）`,
  /**
   * 心跳：几份、覆盖到哪天、今天几号。
   *
   * 它不提供任何内容，只提供「系统还活着」。插件没启 → 整行消失；某份文件读不到 →
   * 份数掉；日志/记忆停了 → 覆盖日期不往前推。这是空前缀方案唯一的安全网。
   */
  health: (files: number, from: string | null, to: string | null, today: string) =>
    (from && to
      ? `记忆 ${files} 份｜覆盖 ${from.slice(5)} ~ ${to.slice(5)}｜今天 ${today.slice(5)}`
      : `记忆 ${files} 份｜覆盖 —｜今天 ${today.slice(5)}`),
  config: {
    group: '记忆树网',
    groupDescription: '把记忆文件折成「一行一块」的图谱交给前缀，并报出哪几天已在窗口外。只读，不写盘。',
    folder: { title: '目录', description: '记忆文件所在的目录；留空表示部署目录下的 workspace。' },
    todayFile: { title: '今天那份', description: '`ml_add` / `ml_edit` / `ml_delete` 不写 file 时写进哪一份；留空表示 超近期.md。改名后记得在这里改。' },
    pastFile: { title: '再往前那份', description: '存放「那么近，但又没那么远」的记忆的那一份。`ml_move` 不写 to、又给了新正文时压进这里；留空表示 近期.md。' },
    archiveFile: { title: '归档到哪', description: '`ml_delete(…, keep=true)` 移出的条目写进哪一份。留空表示 archive/大事记-归档.md。启用时若不存在会自动建一个。归档不进前缀，也不再回到原文件。' },

    recallOnSpeak: { title: '开口前召回', description: '打开后，前缀里会多一句「打算开口时先 ml_recall」。用来测她会不会真的在开口前查——**这不是常态，是实验**。改完要重启才生效。' },
    preactivate: { title: '预激活', description: '打开后，他刚说完一句，插件自己替她查一次，最多把两条「对得上」的旧事递到眼前（同一块两小时内不重复）。**不靠她自觉**，和上面那个实验是两条路。代价是每 30 秒看一眼事件库，偶尔会多一次注入。**改完下一拍（30 秒内）生效，不用重启。**' },
    preactivatePerDay: { title: '预激活每天最多几次', description: '一天最多把旧事递到她眼前几次，默认 6；0 表示不限。同一块另有 2 小时冷却，所以实际频率通常比这个数还低。**按次数记账，不是按概率抽签**——概率没法预测今天被打扰几回。改完下一拍生效，不用重启。' },
    gameRoute: { title: '开局时把游戏经验推给她', description: '打开后，检测到她进了一局（发牌之后），把 `games/那款游戏.md` 里的「读局」和**对应身份那一块**整段推给她一次，同一局不再重复。对应关系写在那个文件的**文件头**（`family: werewolf`、`wolf: 当狼`），所以新出一款游戏不用改插件。**走推送、不进前缀**：前缀在 session 开始时已经冻结，局中开局只能追加。改完下一拍生效，不用重启。' },
    rule: {
      title: (n: number) => `规则 ${n}`,
      description: '路径|模式|参数|上限。模式共六种：whole 整份、full 整份、marker 取到某标题之前、newest 只取最新几块、newest+pin 再固定带上标题含某个词的块、catalog 每块只出一行。选中的正文都不截断；其中 whole / marker / newest / newest+pin 的第四段是**字数**提醒线，`full` 的第四段是**条目上限**。newest 的「参数」写块数（默认 2），newest+pin 写「块数,固定块名」（如 `2,还挂着`）；没选上的块进「未上卡的块」。catalog 的「参数」= 保留几天、「上限」= 条目上限。条目上限一律按 80% 开始提醒、到 100% 拒绝写入。例：常驻.md|whole||1600 ／ 大事记.md|full||120 ／ 超近期.md|catalog|4|',
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
      'ml.layers': '三层各自的文件名（今天那份 / 再往前那份 / 归档），以及 ml_move 不写 to 时的默认去向。',
      'ml.health': '心跳：读到几份、记忆覆盖到哪天、今天几号。份数掉了或日期停住，就说明有文件没读到。',
    },
  },
} as const;

const EN = {
  label: 'Memory Graph',
  /** Only enters the prefix when the experiment switch is on. */
  hintRecall: '**Check once before you speak**: if the next sentence has a name, a game id, a project, or an agreed-upon time — **or if he is talking about his own state** (tired, sleepy, annoyed, unwell, low, can\'t sleep) — run `ml_recall(query=what you are about to say)` or `ml_recall(entity=the name)`. Each hit comes with the entries around it, so the context is right there; **to look up a particular day, put the date in the query** (`ml_recall(query="11-14 that day")`) and the date is pulled out separately. Once per turn is enough; a bare "mm", "ok" or "you there?" needs no lookup.',
  /** The three layer files; follows the settings, so the prompt never hardcodes them. */
  layers: (today: string, past: string, archive: string) =>
    `Three layers: today \`${today}\` | further back \`${past}\` | archive \`${archive}\` (\`ml_move\` without \`to\` follows this: with new text it goes one layer down, without it goes to the archive)`,
  /** Heartbeat: how many files, how far the memory reaches, what day it is. */
  health: (files: number, from: string | null, to: string | null, today: string) =>
    (from && to
      ? `Memory: ${files} files | covers ${from.slice(5)} to ${to.slice(5)} | today ${today.slice(5)}`
      : `Memory: ${files} files | covers — | today ${today.slice(5)}`),
  config: {
    group: 'Memory Graph',
    groupDescription: 'Folds the memory files into a one-line-per-block graph for the prefix, and reports which days are past their window. Read-only.',
    folder: { title: 'Folder', description: 'Where the memory files are; empty means the deployment\'s workspace.' },
    todayFile: { title: 'Today\'s file', description: 'Which file `ml_add` / `ml_edit` / `ml_delete` write to when `file` is left out; empty means 超近期.md. Change it here if you rename that file.' },
    pastFile: { title: 'One layer back', description: 'The file that holds what is near but no longer recent. `ml_move` without `to` but with new text distils into it; empty means 近期.md.' },
    archiveFile: { title: 'Archive to', description: 'Where `ml_delete(…, keep=true)` writes the entry it moves out. Empty means archive/大事记-归档.md, created on enable if missing. The archive never enters the prefix and never comes back.' },

    recallOnSpeak: { title: 'Recall before speaking', description: 'When on, the prefix gains one line telling her to run `ml_recall` before she speaks. This is an experiment, not the default. Takes a restart.' },
    preactivate: { title: 'Pre-activation', description: 'When on, the world looks up the memory itself right after he speaks and puts up to two matched old entries in front of her (the same block is not pushed twice within two hours). **This does not rely on her remembering to ask.** It checks the event store every 30 seconds. **Takes effect on the next tick — no restart.**' },
    preactivatePerDay: { title: 'Pre-activation pushes per day', description: 'How many times a day it may put something in front of her, 6 by default; 0 means no limit. Each block also has its own two-hour cooldown, so the real rate is usually lower. **A count, not a dice roll** — a probability cannot tell you how often you will be interrupted today. Applies on the next tick, no restart.' },
    gameRoute: { title: 'Push game notes when a round starts', description: 'When on, once she joins a round (after roles are dealt) it pushes that game\'s "读局" block plus the block for **her role**, once per round. The mapping lives in the file itself, in the header (`family: werewolf`, `wolf: 当狼`), so a new game needs no plugin change. **It is a push, not the prefix**: the prefix is frozen at session start, so a round starting mid-session can only be appended to. Applies on the next tick, no restart.' },
    rule: {
      title: (n: number) => `Rule ${n}`,
      description: 'path|mode|argument|limit. Six modes: whole and full take the whole file, marker takes everything before a heading, newest takes only the newest few blocks, newest+pin additionally keeps blocks whose title contains a fixed word, catalog prints one line per block. Chosen text is never truncated; for whole / marker / newest / newest+pin the fourth field is a **character** reminder line, for `full` it is the **entry cap**. For newest the argument is the block count (default 2); for newest+pin it is "count,fixed-word" (e.g. `2,还挂着`). Blocks not chosen are listed under "blocks not on the board". For catalog the argument is the day window and the fourth field the entry cap. Entry caps start reporting at 80% and refuse writes at 100%. Example: 常驻.md|whole||1600 ／ 大事记.md|full||120 ／ 超近期.md|catalog|4|',
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
      'ml.policy': 'The policy derived from the rules: days or entries kept per file. Follows the settings.',
      'ml.layers': 'The three layer files (today / one layer back / archive), and where `ml_move` goes when `to` is left out.',
      'ml.health': 'Heartbeat: how many files were read, how far the memory reaches, what day it is. A dropped count or a frozen date means something is not being read.',
    },
  },
} as const;
