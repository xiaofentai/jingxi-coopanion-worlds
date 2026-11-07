/**
 * What this World says: the receipts and the reminder for the bot, in the language the bot reads,
 * and the settings page in the language of the request. Settings and storage text is Chinese and
 * English; another request language reads English.
 */
import type { Language } from 'cortico/core/language.ts';

export type TextLanguage = 'zh' | 'en';

/** Placeholders the environment prompt template fills. */
export const PROMPT_VARS = ['mb.summary', 'mb.next', 'mb.scope', 'mb.location'] as const;
export type PromptVar = typeof PROMPT_VARS[number];

export interface MemoryBackupText {
  label: string;
  config: {
    group: string;
    groupDescription: string;
    schedule: { title: string; description: string };
    dailyAt: { title: string; description: string };
    intervalMinutes: { title: string; suffix: string; description: string };
    scope: { title: string; description: string };
    customRootDir: { title: string; description: string };
    backupDir: { title: string; description: string };
    maxBackups: { title: string; description: string };
    skipModels: { title: string; description: string };
    memoryDir: { title: string; description: string };
    options: { daily: string; interval: string; off: string; data: string; deployment: string; custom: string };
  };
  envPrompt: { title: string; description: string; vars: Record<PromptVar, string> };
  storage: {
    label: string;
    note: string;
    empty: string;
    stat: (count: number, size: string) => string;
    cleared: (count: number) => string;
  };
  /** The three lines the environment prompt and the reminder share. */
  summary: {
    memory: (dir: string, files: number, size: string) => string;
    memoryMissing: (dir: string) => string;
    lastTidy: (when: string | null) => string;
    lastSnapshot: (when: string | null, path: string | null) => string;
    lastRestore: (when: string | null, from: string | null) => string;
    nextDue: (when: string | null) => string;
    schedule: (kind: 'daily' | 'interval' | 'off', detail: string) => string;
  };
  restore: {
    targets: { memory: string; extensions: string; both: string };
    what: { mirror: string; overwrite: string };
    preview: (id: string, when: string, note: string, files: number, size: string) => string;
    willWrite: (target: string, what: string) => string;
    missing: (target: string) => string;
    confirmHint: string;
    memoryMirror: string;
    safetyFailed: string;
    extras: string;
    done: (files: number, size: string, removed: number, safety: string) => string;
    settings: (restored: number, removed: number) => string;
    partial: (failed: number) => string;
    fromElsewhere: (snapshotRoot: string, current: string) => string;
    unknown: (given: string) => string;
    notASnapshot: (path: string) => string;
    restartHint: string;
    restarting: string;
    unsupervised: string;
    online: string;
  };
  due: {
    head: (planned: string, missed: boolean) => string;
    ask: (scope: string, location: string) => string;
  };
  tools: {
    done: (path: string, files: number, size: string, took: string) => string;
    removed: (count: number) => string;
    repaired: (count: number) => string;
    changed: (count: number) => string;
    heldOpen: (count: number) => string;
    linked: (count: number) => string;
    tidy: (note: string) => string;
    listHead: string;
    listLine: (id: string, when: string, files: number, size: string, note: string) => string;
    none: string;
    failed: (tool: string, reason: string) => string;
    copyFailed: (reason: string) => string;
    busy: string;
    unknown: string;
    noteMissing: string;
    customRootMissing: string;
    scopeUnset: string;
    locationUnset: string;
    scope: { data: (dir: string) => string; deployment: (dir: string) => string; custom: (dir: string) => string };
  };
}

const zh: MemoryBackupText = {
  label: '记忆备份',
  config: {
    group: '记忆备份',
    groupDescription: '到点提醒它整理记忆,整理完把数据整份复制成一份带时间的备份。「记忆」是它工作区里的文本文件:CONSTITUTION.md、PARTNER.md 和日常笔记。',
    schedule: { title: '提醒时机', description: '「每天」在下面那个时刻提醒一次;「每隔一段时间」按间隔重复;「不提醒」时只有它主动调用工具才会备份。' },
    dailyAt: { title: '每天的提醒时间', description: '24 小时制,例如 21:00 或 23:30,按本机时区。应用关着时错过的那次,会在下次启动时补送。' },
    intervalMinutes: { title: '两次提醒的间隔', suffix: '分钟', description: '只在「每隔一段时间」时使用:两次提醒相隔多少分钟,30 到 43200(30 天)。' },
    scope: { title: '备份范围', description: '「整个数据目录」复制 home(记忆、对话、设置、密钥、语音模型)、extensions(装进来的插件)与 logs(日志),不复制应用自己的缓存;「只有这份部署」只复制 home 里它自己的目录;「自定义目录」见下一项。' },
    customRootDir: { title: '自定义目录', description: '备份范围选「自定义目录」时用:填一个绝对路径,整份复制,不做任何取舍。' },
    backupDir: { title: '备份目录', description: '每份备份是这里的一个文件夹。留空则放在用户主目录的 Coopanion\\memory-backups:在程序目录之外,卸载应用不会连备份一起删。' },
    maxBackups: { title: '保留份数', description: '超过这个数的旧备份会被自动删除;只删带自己清单的文件夹,别的文件不碰。' },
    skipModels: { title: '跳过模型与运行时', description: '「模型」是语音识别模型(home\\models,约 230 MB),「运行时」是桌宠独立运行用的运行时(home\\runtimes),都由应用按需下载。默认跳过,每份备份省几百 MB;关掉就每份都带上,换机器不用重新下载。' },
    memoryDir: { title: '记忆目录', description: '它写笔记的那个目录,相对它的部署目录,默认 workspace。只用于在提醒里报文件数与体积,不改变备份范围。' },
    options: { daily: '每天', interval: '每隔一段时间', off: '不提醒', data: '整个数据目录', deployment: '只有这份部署', custom: '自定义目录' },
  },
  envPrompt: {
    title: '记忆备份 · 环境提示',
    description: '这个世界提醒整理记忆、备份数据目录的那一段。',
    vars: {
      'mb.summary': '记忆目录的规模、上次整理与上次备份,多行。',
      'mb.next': '下一次提醒的时间,或提醒关着。',
      'mb.scope': '被备份的目录。',
      'mb.location': '备份目录。',
    },
  },
  storage: {
    label: '记忆备份',
    note: '删掉全部备份;备份目录本身保留。',
    empty: '还没有备份',
    stat: (count, size) => `${count} 份,共 ${size}`,
    cleared: (count) => `删掉了 ${count} 份备份。`,
  },
  summary: {
    memory: (dir, files, size) => `记忆目录 ${dir}:${files} 个文件,共 ${size}`,
    memoryMissing: (dir) => `记忆目录 ${dir} 不在`,
    lastTidy: (when) => (when ? `上次整理:${when}` : '上次整理:还没有记录'),
    lastSnapshot: (when, path) => (when && path ? `上次备份:${when} → ${path}` : '上次备份:还没有'),
    lastRestore: (when, from) => (when && from ? `上次回滚:${when} ← ${from}` : '上次回滚:还没有'),
    nextDue: (when) => (when ? `下一次提醒:${when}` : '提醒关着,只在调用 mb_run 或 mb_tidy_done 时备份'),
    schedule: (kind, detail) => (kind === 'off' ? '提醒:关着' : kind === 'daily' ? `提醒:每天 ${detail}` : `提醒:每隔 ${detail} 分钟`),
  },
  restore: {
    targets: { memory: '记忆', extensions: '插件', both: '记忆和插件' },
    what: { mirror: '以快照为准覆盖,快照里没有的文件删掉', overwrite: '覆盖同名文件,不删除任何东西' },
    preview: (id, when, note, files, size) => `快照 ${id}(${when})${note ? `:${note}` : ''},共 ${files} 个文件、${size}。这一步会写入:`,
    willWrite: (target, what) => `- ${target}:${what}`,
    missing: (target) => `- ${target}:这份快照里没有,跳过`,
    confirmHint: '执行前会先把现在的状态另存一份。要执行的话,带上 confirm: "restore" 再调一次 mb_restore;不再调用就是放弃。',
    memoryMirror: 'Memory 以快照为准:快照里没有的文件会被删掉(工作区的 .git 保留,历史接着走)。扩展目录只覆盖同名文件,不删除任何东西。',
    safetyFailed: '先给现在的状态做安全备份时失败了,这次没有回滚,文件一个都没动。检查备份目录能不能写。',
    extras: '插件的密钥(.env)、token 与运行时状态(data/ 下)一并回来;对话记录、会话与用量日志不动。',
    done: (files, size, removed, safety) => `已回滚:写入 ${files} 个文件,共 ${size}${removed ? `,删掉 ${removed} 个快照里没有的文件` : ''}。回滚前的状态另存在 ${safety}。`,
    settings: (restored, removed) => `设置:${restored} 个插件回到当时的样子${removed ? `,${removed} 个后来才装的设置被移除` : ''};本扩展自己的设置不变。`,
    partial: (failed) => `有 ${failed} 个文件没能写入,多半是被程序占着;清单在回执末尾,重启后可以再试一次。`,
    fromElsewhere: (snapshotRoot, current) => `这份快照是在 ${snapshotRoot} 上做的,这台机器的数据目录是 ${current}:按这里的布局写入,位置不一样不影响。`,
    unknown: (given) => `没有 ${given} 这份快照;mb_status 列出已有的。`,
    notASnapshot: (path) => `${path} 不是这个世界的快照:里面没有 .memory-backup.json。`,
    restartHint: '回滚的文件要重启 Core 才生效:先问对方一句,再调 mb_restart;在设置窗口的扩展页点「重启进程」也一样。',
    restarting: '正在重启 Core,桌宠会断开几秒再回来。',
    unsupervised: '这次运行没有监督进程,重启会让 Core 直接停下;请手动重启应用。',
    online: '对话记录、各 World 的运行时状态(data/ 下)和联机插件的服务器记录都没有动。',
  },
  due: {
    head: (planned, missed) => `[记忆备份] 该整理记忆了(原定 ${planned})。${missed ? '那时应用没开着,现在才送到。' : ''}`,
    ask: (scope, location) => `整理完调用 mb_tidy_done,用一两句写下改了什么;它记下这次整理,并把${scope}复制到 ${location}。`,
  },
  tools: {
    done: (path, files, size, took) => `已备份到 ${path}:${files} 个文件,共 ${size},用时 ${took}。`,
    removed: (count) => `删掉了 ${count} 份较旧的备份。`,
    repaired: (count) => `有 ${count} 个追加写的文件末尾半行被截掉。`,
    changed: (count) => `有 ${count} 个文件在复制时还在变,备份里是它们那一刻的样子。`,
    heldOpen: (count) => `有 ${count} 个文件被别的程序占着,没抄进这份备份。`,
    linked: (count) => `有 ${count} 个链接被展开成实体目录(恢复时不需要包管理器)。`,
    tidy: (note) => `记下这次整理:${note}`,
    listHead: '磁盘上的备份:',
    listLine: (id, when, files, size, note) => `- ${when}(${id}):${files} 个文件,${size}${note ? ` · ${note}` : ''}`,
    none: '还没有备份。',
    failed: (tool, reason) => `[${tool} 没执行] ${reason}`,
    copyFailed: (reason) => `复制失败:${reason}`,
    busy: '[备份没开始] 上一份备份还没做完。',
    unknown: '没有这个工具。',
    noteMissing: 'note 不能为空:用一两句写下这次改了什么。',
    customRootMissing: '备份范围是 custom,但自定义目录是空的。',
    scopeUnset: '备份范围还没有定下来。',
    locationUnset: '备份目录还没有定下来。',
    scope: {
      data: (dir) => `整个数据目录 ${dir}`,
      deployment: (dir) => `这份部署 ${dir}`,
      custom: (dir) => `目录 ${dir}`,
    },
  },
};

const en: typeof zh = {
  label: 'Memory backup',
  config: {
    group: 'Memory backup',
    groupDescription: 'Reminds the bot to tidy its memory and, once it is done, copies the data into a dated snapshot. "Memory" is the text files in its workspace: CONSTITUTION.md, PARTNER.md and the notes.',
    schedule: { title: 'When to remind', description: '"Daily" reminds once at the time below; "at an interval" repeats every so often; "no reminder" backs up only when it calls a tool itself.' },
    dailyAt: { title: 'Time of the daily reminder', description: '24-hour clock, such as 21:00 or 23:30, in this machine\'s time zone. One missed while the app was closed arrives at the next start.' },
    intervalMinutes: { title: 'Time between reminders', suffix: 'minutes', description: 'Only for "at an interval": 30 to 43200 minutes (30 days) between two reminders.' },
    scope: { title: 'What a snapshot copies', description: '"The whole data directory" copies home (memory, conversations, settings, keys, speech models), extensions (installed plugins) and logs, leaving the app\'s own caches out; "this deployment only" copies just its own folder inside home; "a directory of its own" is the next field.' },
    customRootDir: { title: 'Directory of its own', description: 'Used when the scope is "a directory of its own": an absolute path, copied whole with nothing left out.' },
    backupDir: { title: 'Where snapshots go', description: 'Each snapshot is one folder here. Empty puts them in Coopanion\\memory-backups under your home directory, outside the program folder, so uninstalling the app leaves them.' },
    maxBackups: { title: 'Snapshots kept', description: 'Older snapshots beyond this count are deleted; only folders carrying its own manifest, never anything else.' },
    skipModels: { title: 'Leave out models and runtimes', description: '"Models" is the speech recognition models (home\\models, about 230 MB); "runtimes" is the runtime the pet uses when it stands alone (home\\runtimes). Both download on demand. Left out by default, which saves a few hundred MB per snapshot; turn it off to carry them and skip the download on another machine.' },
    memoryDir: { title: 'Memory directory', description: 'The folder it writes its notes into, relative to its deployment, workspace by default. Used only to report how large the memory is; it does not change what a snapshot copies.' },
    options: { daily: 'Daily', interval: 'At an interval', off: 'No reminder', data: 'The whole data directory', deployment: 'This deployment only', custom: 'A directory of its own' },
  },
  envPrompt: {
    title: 'Memory backup: environment',
    description: 'The section that asks the bot to tidy its Memory and backs the data directory up.',
    vars: {
      'mb.summary': 'The Memory directory\'s size, the last tidy and the last snapshot, on several lines.',
      'mb.next': 'When the next reminder is due, or that there is none.',
      'mb.scope': 'The directory a snapshot copies.',
      'mb.location': 'Where snapshots go.',
    },
  },
  storage: {
    label: 'Memory backup',
    note: 'Deletes every snapshot; the backup directory itself stays.',
    empty: 'No snapshots yet',
    stat: (count, size) => `${count} snapshots, ${size}`,
    cleared: (count) => `Deleted ${count} snapshots.`,
  },
  summary: {
    memory: (dir, files, size) => `Memory directory ${dir}: ${files} files, ${size}`,
    memoryMissing: (dir) => `Memory directory ${dir} is not there`,
    lastTidy: (when) => (when ? `last tidy: ${when}` : 'last tidy: not recorded yet'),
    lastSnapshot: (when, path) => (when && path ? `last snapshot: ${when} → ${path}` : 'last snapshot: none yet'),
    lastRestore: (when, from) => (when && from ? `last restore: ${when} ← ${from}` : 'last restore: none yet'),
    nextDue: (when) => (when ? `next reminder: ${when}` : 'no reminder is scheduled; a snapshot comes only from mb_run or mb_tidy_done'),
    schedule: (kind, detail) => (kind === 'off' ? 'reminder: off' : kind === 'daily' ? `reminder: daily at ${detail}` : `reminder: every ${detail} minutes`),
  },
  restore: {
    targets: { memory: 'Memory', extensions: 'extensions', both: 'Memory and extensions' },
    what: { mirror: 'written over as the snapshot has it, extra files deleted', overwrite: 'the snapshot\'s files written over the existing ones, nothing deleted' },
    preview: (id, when, note, files, size) => `Snapshot ${id} (${when})${note ? `: ${note}` : ''}, ${files} files, ${size}. This would write:`,
    willWrite: (target, what) => `- ${target}: ${what}`,
    missing: (target) => `- ${target}: not in this snapshot, skipped`,
    confirmHint: 'The state as it is now is snapshotted before anything is written. To carry it out, call mb_restore again with confirm: "restore"; not calling again leaves everything as it is.',
    memoryMirror: 'Memory follows the snapshot: files the snapshot does not hold are deleted (the workspace\'s .git stays, so history goes on). Extension folders get the snapshot\'s files written over them; nothing is deleted there.',
    safetyFailed: 'Saving the present state first failed, so nothing was restored; not one file was touched. Check that the backup directory is writable.',
    extras: 'The plugins\' secrets (.env), tokens and runtime state under data/ come back too; conversations and the session and usage logs do not.',
    done: (files, size, removed, safety) => `Restored: ${files} files, ${size}${removed ? `, and ${removed} files that the snapshot did not hold were deleted` : ''}. The state before this was snapshotted to ${safety}.`,
    settings: (restored, removed) => `Settings: ${restored} plugins go back to how they were${removed ? `, and ${removed} added since are removed` : ''}; this World keeps its own.`,
    partial: (failed) => `${failed} files could not be written, most likely because something holds them open; they are listed at the end, and a restart lets you try again.`,
    fromElsewhere: (snapshotRoot, current) => `This snapshot was taken on ${snapshotRoot}, while this machine keeps its data in ${current}: it is written into the layout here, and the different location makes no difference.`,
    unknown: (given) => `There is no snapshot ${given}; mb_status lists the ones there are.`,
    notASnapshot: (path) => `${path} is not a snapshot of this World: it holds no .memory-backup.json.`,
    restartHint: 'Restored files take effect when Core restarts: ask the person first, then call mb_restart, or use "Restart process" on the Extensions page of the settings window.',
    restarting: 'Core is restarting; the pet disconnects for a few seconds and comes back.',
    unsupervised: 'this Core runs without a supervisor, so a restart would leave it stopped; restart the app by hand.',
    online: 'Conversations, the runtime state each World keeps under data/ and any record an online plugin holds on its server are untouched.',
  },
  due: {
    head: (planned, missed) => `[memory backup] Time to tidy the Memory (planned for ${planned}).${missed ? ' The app was not running then, so it arrives only now.' : ''}`,
    ask: (scope, location) => `When you are done, call mb_tidy_done with a line or two on what changed: it records the tidy and copies ${scope} to ${location}.`,
  },
  tools: {
    done: (path, files, size, took) => `Copied to ${path}: ${files} files, ${size}, in ${took}.`,
    removed: (count) => `Deleted ${count} older snapshots.`,
    repaired: (count) => `Cut the unfinished last line of ${count} append-only files.`,
    changed: (count) => `${count} files were still changing during the copy; the snapshot holds them as they were then.`,
    heldOpen: (count) => `${count} files were held open by another program and are not in this snapshot.`,
    linked: (count) => `${count} links were copied as the directories they point at, so restoring needs no package manager.`,
    tidy: (note) => `Tidy recorded: ${note}`,
    listHead: 'Snapshots on disk:',
    listLine: (id, when, files, size, note) => `- ${when} (${id}): ${files} files, ${size}${note ? ` · ${note}` : ''}`,
    none: 'No snapshots yet.',
    failed: (tool, reason) => `[${tool} did not run] ${reason}`,
    copyFailed: (reason) => `the copy failed: ${reason}`,
    busy: '[backup not started] the previous snapshot is still being copied.',
    unknown: 'No such tool.',
    noteMissing: 'note must not be empty: write a line or two on what changed.',
    customRootMissing: 'The scope is custom but no directory is set.',
    scopeUnset: 'The scope is not set.',
    locationUnset: 'The backup directory is not set.',
    scope: {
      data: (dir) => `the whole data directory ${dir}`,
      deployment: (dir) => `this deployment ${dir}`,
      custom: (dir) => `the directory ${dir}`,
    },
  },
};

const TABLES: Record<TextLanguage, MemoryBackupText> = { zh, en };

/** The table for an app language: Chinese for `zh` and `zh-Hant`, English for the rest. */
export function memoryBackupText(language: Language = 'zh'): MemoryBackupText {
  return TABLES[language === 'zh' || language === 'zh-Hant' ? 'zh' : 'en'];
}

export const textLanguage = (language: Language): TextLanguage =>
  language === 'zh' || language === 'zh-Hant' ? 'zh' : 'en';
