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
    notifyAway: { title: string; description: string };
    notifyBack: { title: string; description: string };
  };
  /** 状态那几行，环境提示与工具回执共用。 */
  lines: {
    /** `since` 是 `MM-DD HH:MM`，`span` 是「17 分钟」。 */
    present: (since: string, span: string) => string;
    away: (since: string, span: string) => string;
    unknown: string;
    lastAway: (from: string, to: string, span: string) => string;
    noLastAway: string;
  };
  tool: {
    description: string;
    now: (line: string) => string;
    lastAway: (line: string) => string;
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
    away: (clock: string) => string;
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
    groupDescription: '隔一会儿查一次屏幕锁没锁，把「ta 现在在不在桌前」放进环境提示。',
    pollSeconds: {
      title: '多久查一次',
      description: '单位秒，范围 5–300。连续两次读到同一结果才算数，所以状态变化最多慢两个间隔。',
      suffix: '秒',
    },
    notifyAway: {
      title: '锁屏时推事件',
      description: '确认锁屏后推一条事件，让桌宠知道你离开了。关掉后只能从环境提示里看出状态。',
    },
    notifyBack: {
      title: '解锁时推事件',
      description: '确认解锁后推一条事件，附上这次离开了多久。',
    },
  },
  lines: {
    present: (since, span) => `在桌前（${since} 解锁，已 ${span}）`,
    away: (since, span) => `不在（${since} 锁屏，已 ${span}）`,
    unknown: '还不知道（启动后还没读到一次成功的锁屏状态）',
    lastAway: (from, to, span) => `${from} → ${to}，${span}`,
    noLastAway: '还没记到过一次离开',
  },
  tool: {
    description:
      '报告 ta 现在在不在桌前（屏幕锁着就是离开了）、这个状态持续了多久、上一次离开了多久。'
      + '回复前会当场再查一次锁屏，并说明它与记录是否一致。只读。',
    now: (line) => `现在：${line}`,
    lastAway: (line) => `上次离开：${line}`,
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
    away: (clock) => `屏幕在 ${clock} 锁上了：ta 离开了电脑。`,
    back: (clock, span) => `屏幕在 ${clock} 解锁了：ta 回来了，这次离开了 ${span}。`,
  },
  envPrompt: {
    title: '在吗 · 环境提示',
    description: '把「ta 现在在不在」放进系统前缀，每次交接重建时刷新。',
    vars: {
      'here.state': '现在在不在、这个状态从什么时候开始，一行。',
      'here.lastAway': '上一次离开的起止时间与时长；还没记到过就说明这一点。',
    },
  },
};

const en: AreYouThereText = {
  label: 'Are you there',
  config: {
    group: 'Are you there',
    groupDescription: 'Checks the screen lock every so often and puts whether they are at the desk into the environment section.',
    pollSeconds: {
      title: 'How often to check',
      description: 'Seconds, 5 to 300. Two readings in a row have to agree, so a change shows up at most two intervals late.',
      suffix: 's',
    },
    notifyAway: {
      title: 'Raise an event on lock',
      description: 'After a confirmed lock, push an event so the pet knows you left. With this off, the state is only visible through the environment section.',
    },
    notifyBack: {
      title: 'Raise an event on unlock',
      description: 'After a confirmed unlock, push an event with how long the person was away.',
    },
  },
  lines: {
    present: (since, span) => `At the desk (unlocked ${since}, ${span} so far)`,
    away: (since, span) => `Away (locked ${since}, ${span} so far)`,
    unknown: 'Not known yet (no successful reading since start)',
    lastAway: (from, to, span) => `${from} to ${to}, ${span}`,
    noLastAway: 'No away period recorded yet',
  },
  tool: {
    description:
      'Report whether they are at the desk now (a locked screen means away), how long that state has lasted, '
      + 'and when they were last away. Probes the screen lock once, live, and says whether it agrees with the record. Read only.',
    now: (line) => `Now: ${line}`,
    lastAway: (line) => `Last away: ${line}`,
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
    away: (clock) => `The screen locked at ${clock}: they left the computer.`,
    back: (clock, span) => `The screen unlocked at ${clock}: they are back after ${span} away.`,
  },
  envPrompt: {
    title: 'Are you there: environment',
    description: 'Puts whether they are here into the system prefix, refreshed at every handoff.',
    vars: {
      'here.state': 'Whether they are here, and when that state began, on one line.',
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
