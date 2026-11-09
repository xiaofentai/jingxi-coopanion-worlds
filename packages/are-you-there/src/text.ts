/**
 * 这个 World 的文案：设置页、事件、工具回执、环境提示的标题与占位符说明。
 * 中文与英文两张表；其余语言读英文。模型读的模板在 `ENV_PROMPT.md` / `ENV_PROMPT.en.md`。
 */
import type { Language } from 'cortico/core/language.ts';

export type TextLanguage = 'zh' | 'en';

export const PROMPT_VARS = ['here.state', 'here.lastAway'] as const;
export type PromptVar = (typeof PROMPT_VARS)[number];

export interface AreYouThereText {
  label: string;
  config: {
    group: string;
    groupDescription: string;
    pollSeconds: { title: string; description: string; suffix: string };
    idleMinutes: { title: string; description: string; suffix: string };
    checkLock: { title: string; description: string };
    checkForeground: { title: string; description: string };
    mediaKeywords: { title: string; description: string };
    checkScreen: { title: string; description: string };
    notifyAway: { title: string; description: string };
    notifyBack: { title: string; description: string };
  };
  /** 状态那几行，环境提示与工具回执共用。 */
  lines: {
    /** `since` 是 `MM-DD HH:MM`，`span` 是「17 分钟」。 */
    present: (since: string, span: string) => string;
    /** 屏幕锁着。 */
    awayLocked: (since: string, span: string) => string;
    /** 解锁着，但键盘鼠标久无输入。 */
    awayIdle: (since: string, span: string) => string;
    unknown: string;
    lastAway: (from: string, to: string, span: string) => string;
    noLastAway: string;
  };
  tool: {
    description: string;
    now: (line: string) => string;
    lastAway: (line: string) => string;
    idle: (line: string) => string;
    /** 两个信号都读不到时，`idle` 那行说什么。 */
    idleOff: string;
    idleUnknown: string;
    idleLine: (span: string, threshold: string) => string;
    verdict: (line: string) => string;
    verdictOff: string;
    verdictForegroundHit: (process: string) => string;
    verdictForegroundMiss: (process: string) => string;
    verdictForegroundFailed: string;
    verdictScreenChanged: (percent: string) => string;
    verdictScreenStill: (percent: string) => string;
    verdictScreenFailed: string;
    live: (line: string) => string;
    readingLocked: string;
    readingUnlocked: string;
    agrees: (reading: string) => string;
    disagrees: (recorded: string, reading: string) => string;
    notConfirmed: (reading: string) => string;
    failed: (reason: string) => string;
    notWindows: string;
    failures: (count: number, at: string, reason: string) => string;
  };
  event: {
    changed: string;
    awayLocked: (clock: string) => string;
    awayIdle: (span: string, detail: string) => string;
    back: (clock: string, span: string) => string;
  };
  envPrompt: {
    title: string;
    description: string;
    vars: Record<PromptVar, string>;
  };
}

const zh: AreYouThereText = {
  label: '在吗',
  config: {
    group: '在吗',
    groupDescription: '隔一会儿查一次屏幕锁没锁、键盘鼠标还有没有动静，把「ta 现在在不在桌前」放进环境提示。',
    pollSeconds: {
      title: '多久查一次',
      description: '单位秒，范围 5–300。连续两次读到同一结果才算数，所以状态变化最多慢两个间隔。',
      suffix: '秒',
    },
    idleMinutes: {
      title: '空闲多久算离开',
      description:
        '键盘鼠标连续这么久没有输入就当作不在。0 表示不看空闲，只看锁屏。'
        + '看视频、读书这类长时间不碰键鼠的时候会误判，按自己的习惯调大。',
      suffix: '分钟',
    },
    checkLock: {
      title: '用锁屏判定',
      description: '锁着就算不在。关掉后完全忽略锁屏，只看键鼠动静与下面的确认。',
    },
    checkForeground: {
      title: '空闲时看一眼前台窗口',
      description: '键鼠空闲到阈值后，读一次前台进程名与窗口标题；命中关键词就当作在看东西，不判离开。只看名字，不拍画面。',
    },
    mediaKeywords: {
      title: '认作「在看」的关键词',
      description: '逗号分隔，匹配进程名或窗口标题，大小写不敏感。默认是常见的视频与直播站。',
    },
    checkScreen: {
      title: '空闲时比较两帧画面',
      description: '键鼠空闲到阈值后，隔约两秒截两帧缩略图做像素比较；画面在变就当作在看东西。画面只在内存里，不落盘、不发出去。',
    },
    notifyAway: {
      title: '判为离开时推事件',
      description: '确认离开后推一条事件，让桌宠知道你走开了。锁屏与空闲两种原因都会推；关掉后只能从环境提示里看出状态。',
    },
    notifyBack: {
      title: '回来时推事件',
      description: '确认回到桌前之后推一条事件，附上这次离开了多久。',
    },
  },
  lines: {
    present: (since, span) => `在桌前（${since} 解锁，已 ${span}）`,
    awayLocked: (since, span) => `不在（${since} 锁屏，已 ${span}）`,
    awayIdle: (since, span) => `不在（${since} 键盘鼠标久无输入，已 ${span}）`,
    unknown: '还不知道（启动后还没读到一次成功的读数）',
    lastAway: (from, to, span) => `${from} → ${to}，${span}`,
    noLastAway: '还没记到过一次离开',
  },
  tool: {
    description:
      '报告 ta 现在在不在桌前（屏幕锁着、或键盘鼠标很久没动，都算不在）、这个状态持续了多久、上一次离开了多久。'
      + '回复前会当场再查一次锁屏，并说明它与记录是否一致。只读。',
    now: (line) => `现在：${line}`,
    lastAway: (line) => `上次离开：${line}`,
    idle: (line) => `空闲：${line}`,
    idleOff: '不看空闲（设置里为 0）',
    idleUnknown: '读不到键盘鼠标的空闲时间',
    idleLine: (span, threshold) => `${span}没有输入（阈值 ${threshold}）`,
    verdict: (line) => `判定：${line}`,
    verdictOff: '空闲时不做额外判定',
    verdictForegroundHit: (process) => `前台是 ${process}，算作在看`,
    verdictForegroundMiss: (process) => `前台是 ${process}，不在名单里`,
    verdictForegroundFailed: '读不到前台窗口',
    verdictScreenChanged: (percent) => `两帧差 ${percent}，屏幕在变，算作在看`,
    verdictScreenStill: (percent) => `两帧差 ${percent}，屏幕没在变`,
    verdictScreenFailed: '截图失败',
    live: (line) => `刚刚复查：${line}`,
    readingLocked: '锁屏',
    readingUnlocked: '解锁',
    agrees: (reading) => `${reading}，与记录一致`,
    disagrees: (recorded, reading) => `${reading}，记录里是${recorded}；再查一次就会按新的来`,
    notConfirmed: (reading) => `${reading}，还没有确认过`,
    failed: (reason) => `没读到（${reason}）`,
    notWindows: '只在 Windows 上能读（锁屏时 Windows 会拉起 LogonUI.exe）',
    failures: (count, at, reason) => `最近一次 ${at} 起连续 ${count} 次没读到：${reason}`,
  },
  event: {
    changed: 'ta 离开电脑或回来了。',
    awayLocked: (clock) => `屏幕在 ${clock} 锁上了：ta 离开了电脑。`,
    awayIdle: (span, detail) => `键盘鼠标已经 ${span}没有动静${detail}：ta 大概不在屏幕前了。`,
    back: (clock, span) => `屏幕在 ${clock}：ta 回来了，这次离开了 ${span}。`,
  },
  envPrompt: {
    title: '在吗 · 环境提示',
    description: '把「ta 现在在不在」放进系统前缀，每次交接重建时刷新。',
    vars: {
      'here.state': '现在在不在、从什么时候开始、为什么判成不在，一行。',
      'here.lastAway': '上一次离开的起止时间与时长；还没记到过就说明这一点。',
    },
  },
};

const en: AreYouThereText = {
  label: 'Are you there',
  config: {
    group: 'Are you there',
    groupDescription: 'Checks the screen lock and whether the keyboard or mouse has been touched, and puts whether they are at the desk into the environment section.',
    pollSeconds: {
      title: 'How often to check',
      description: 'Seconds, 5 to 300. Two readings in a row have to agree, so a change shows up at most two intervals late.',
      suffix: 's',
    },
    idleMinutes: {
      title: 'Idle time that counts as away',
      description:
        'With no keyboard or mouse input for this long, they count as away. 0 means the idle signal is off and only the screen lock is used. '
        + 'Watching a video or reading for a long stretch will look like away, so raise this if that is common.',
      suffix: 'min',
    },
    checkLock: {
      title: 'Use the screen lock',
      description: 'A locked screen counts as away. Turned off, the lock is ignored entirely and only keyboard and mouse activity (plus the checks below) is used.',
    },
    checkForeground: {
      title: 'Look at the foreground window when idle',
      description: 'Once the keyboard and mouse reach the idle threshold, read the foreground process and window title; a keyword hit counts as watching something, so they are not away. Names only, no picture.',
    },
    mediaKeywords: {
      title: 'Keywords that count as watching',
      description: 'Comma separated, matched against the process name or the window title, case-insensitive. The default list is common video and streaming sites.',
    },
    checkScreen: {
      title: 'Compare two frames when idle',
      description: 'Once the keyboard and mouse reach the idle threshold, capture two downscaled frames about two seconds apart and compare pixels; a changing screen counts as watching something. The frames stay in memory: not saved, not sent anywhere.',
    },
    notifyAway: {
      title: 'Raise an event when they leave',
      description: 'After a confirmed absence, push an event so the pet knows. Both the lock and the idle signal raise it; with this off, the state is only visible through the environment section.',
    },
    notifyBack: {
      title: 'Raise an event when they come back',
      description: 'After a confirmed return, push an event with how long the person was away.',
    },
  },
  lines: {
    present: (since, span) => `At the desk (unlocked ${since}, ${span} so far)`,
    awayLocked: (since, span) => `Away (locked ${since}, ${span} so far)`,
    awayIdle: (since, span) => `Away (no keyboard or mouse input since ${since}, ${span} so far)`,
    unknown: 'Not known yet (no successful reading since start)',
    lastAway: (from, to, span) => `${from} to ${to}, ${span}`,
    noLastAway: 'No away period recorded yet',
  },
  tool: {
    description:
      'Report whether they are at the desk now (a locked screen, or no keyboard or mouse input for a long time, both mean away), '
      + 'how long that state has lasted, and when they were last away. Probes the screen lock once, live, and says whether it agrees '
      + 'with the record. Read only.',
    now: (line) => `Now: ${line}`,
    lastAway: (line) => `Last away: ${line}`,
    idle: (line) => `Idle: ${line}`,
    idleOff: 'not watched (set to 0)',
    idleUnknown: 'keyboard and mouse idle time could not be read',
    idleLine: (span, threshold) => `no input for ${span} (threshold ${threshold})`,
    verdict: (line) => `Verdict: ${line}`,
    verdictOff: 'no extra check while idle',
    verdictForegroundHit: (process) => `the foreground is ${process}, counted as watching`,
    verdictForegroundMiss: (process) => `the foreground is ${process}, not on the list`,
    verdictForegroundFailed: 'the foreground window could not be read',
    verdictScreenChanged: (percent) => `the two frames differ by ${percent}, the screen is changing, counted as watching`,
    verdictScreenStill: (percent) => `the two frames differ by ${percent}, the screen is still`,
    verdictScreenFailed: 'the frames could not be captured',
    live: (line) => `Live check: ${line}`,
    readingLocked: 'locked',
    readingUnlocked: 'unlocked',
    agrees: (reading) => `${reading}, agrees with the record`,
    disagrees: (recorded, reading) => `${reading}, the record says ${recorded}; the next polls will follow the new reading`,
    notConfirmed: (reading) => `${reading}, not confirmed yet`,
    failed: (reason) => `could not be read (${reason})`,
    notWindows: 'only readable on Windows, where LogonUI.exe runs while the screen is locked',
    failures: (count, at, reason) => `${count} failed reads in a row since ${at}: ${reason}`,
  },
  event: {
    changed: 'They left the computer, or came back.',
    awayLocked: (clock) => `The screen locked at ${clock}: they left the computer.`,
    awayIdle: (span, detail) => `No keyboard or mouse input for ${span}${detail}: they are probably not at the screen.`,
    back: (clock, span) => `At ${clock} they were back, after ${span} away.`,
  },
  envPrompt: {
    title: 'Are you there: environment',
    description: 'Puts whether they are here into the system prefix, refreshed at every handoff.',
    vars: {
      'here.state': 'Whether they are here, since when, and which signal says they are away, on one line.',
      'here.lastAway': 'When the last away period started and ended, and how long it lasted.',
    },
  },
};

export function areYouThereText(language: Language = 'zh'): AreYouThereText {
  return textLanguage(language) === 'zh' ? zh : en;
}

export function textLanguage(language: Language): TextLanguage {
  return language.startsWith('zh') ? 'zh' : 'en';
}
