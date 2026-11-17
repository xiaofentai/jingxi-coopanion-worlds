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
    radarEnabled: { title: string; description: string };
    radarPort: { title: string; description: string };
    radarMaxDistance: { title: string; description: string; suffix: string };
    radarMaxCm: { title: string; description: string; suffix: string };
    radarAbsentSeconds: { title: string; description: string; suffix: string };
    radarBackSeconds: { title: string; description: string; suffix: string };
    radarPassByNotify: { title: string; description: string };
    radarQuietSeconds: { title: string; description: string; suffix: string };
  };
  /** 状态那几行，环境提示与工具回执共用。 */
  lines: {
    /** `since` 是 `MM-DD HH:MM`，`span` 是「17 分钟」。 */
    present: (since: string, span: string) => string;
    /** 屏幕锁着。 */
    awayLocked: (since: string, span: string) => string;
    /** 解锁着，但键盘鼠标久无输入。 */
    awayIdle: (since: string, span: string) => string;
    /** 雷达连续没测到人。 */
    awayRadar: (since: string, span: string) => string;
    /** 追在状态后面的一句雷达补充，没有可说的就是空串。 */
    radarPresent: (cm: string) => string;
    radarDown: string;
    radarWarming: string;
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
    radar: (line: string) => string;
    radarOff: string;
    radarNotWindows: string;
    radarDisconnected: (reason: string) => string;
    radarWarming: string;
    radarStale: string;
    radarSeen: (cm: string, at: string) => string;
    radarAbsent: (span: string, cm: string) => string;
    radarFar: (cm: string) => string;
    lampStarting: string;
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
  /** 状态灯：导航栏与 World 总览上那颗点，悬停时是「label 状态 · hint」。 */
  lamp: {
    radar: string;
  };
  /** World 页里的「雷达状态」面板：一颗点加一句话。 */
  panel: {
    radarTitle: string;
    radarDescription: string;
    present: string;
    absent: string;
    warming: string;
    stale: string;
    far: string;
    down: string;
    starting: string;
  };
  event: {
    changed: string;
    awayLocked: (clock: string) => string;
    awayIdle: (span: string, detail: string) => string;
    awayRadar: (span: string, cm: string) => string;
    back: (clock: string, span: string) => string;
    backRadar: (clock: string, span: string) => string;
    passBy: (span: string, cm: string) => string;
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
    radarEnabled: {
      title: '用毫米波雷达判定',
      description:
        '插了 HLK-LD2402（USB 转 TTL）就打开。它只看桌前这一小块：范围内有人就当作在、连续没人就判离开，'
        + '比键鼠空闲可靠得多——读书、看纸质材料、用手柄都不会被误判。没插硬件时打开只会一直提示没连上。',
    },
    radarPort: {
      title: '雷达串口',
      description: '`auto` 表示每次连接时自己枚举 USB 串口，拔掉插到别的口也能接上。也可以直接写 COM5 这类端口名。',
    },
    radarMaxDistance: {
      title: '模块探测距离',
      description:
        '0.1 米为单位，7–100。插件启动时读这个参数，和它不一致就写回去并保存，免得断电后恢复出厂值。'
        + '0 表示不动模块参数，只按下面那条过滤。',
      suffix: '0.1 米',
    },
    radarMaxCm: {
      title: '只把这么近的人算作在桌前',
      description:
        '单位厘米。雷达测到更远的人（比如房间另一头的家人）不算数。它同时是自检基线：如果雷达看到的人长期全在这个距离之外，'
        + '说明模块参数被重置或摆位变了，插件会忽略它并说明原因，而不是据此判你离开。',
      suffix: '厘米',
    },
    radarAbsentSeconds: {
      title: '雷达多久没人算离开',
      description: '单位秒。模块自己还有一段「目标消失延迟」（出厂 30 秒），实际延迟是两者之和。',
      suffix: '秒',
    },
    radarBackSeconds: {
      title: '雷达多久有人才算回来',
      description: '单位秒。雷达要连续测到人这么久才算「ta 回来了」；比这更短的算路过，只推一条经过事件，状态不变。默认 10 秒。',
      suffix: '秒',
    },
    radarPassByNotify: {
      title: '有人经过时推事件',
      description: '判为离开期间，雷达短暂看到人就推一条「有人经过」，附上停留了多久。关掉就只在真的回来时出声。',
    },
    radarQuietSeconds: {
      title: '键鼠还热着就不信雷达',
      description:
        '单位秒。雷达报没人、但键盘鼠标这么久之内还动过，就当作雷达漏检（人坐着没动、微动门限偏高），不判离开。'
        + '0 表示完全听雷达的：它一报没人就算走。',
      suffix: '秒',
    },
  },
  lines: {
    present: (since, span) => `在桌前（${since} 解锁，已 ${span}）`,
    awayLocked: (since, span) => `不在（${since} 锁屏，已 ${span}）`,
    awayIdle: (since, span) => `不在（${since} 键盘鼠标久无输入，已 ${span}）`,
    awayRadar: (since, span) => `不在（${since} 雷达没测到人，已 ${span}）`,
    radarPresent: (cm) => `，雷达在 ${cm} 厘米`,
    radarDown: '，雷达没连上',
    radarWarming: '，雷达还没在范围内见到人',
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
    radar: (line) => `雷达：${line}`,
    radarOff: '没打开（设置里勾上「用毫米波雷达判定」）',
    radarNotWindows: '只在 Windows 上能读',
    radarDisconnected: (reason) => `没连上（${reason}）`,
    radarWarming: '连上了，但还没在范围内读到人（先不参与判定）',
    radarSeen: (cm, at) => `${cm} 厘米有人（最近一帧 ${at}）`,
    radarAbsent: (span, cm) => `已经 ${span}没测到人，最近一次在 ${cm}`,
    radarFar: (cm) => `读到的人全在 ${cm} 之外，模块探测距离多半被重置了，先不参与判定`,
    radarStale: '串口开着，但已经收不到新数据了（多半被拔了）',
    lampStarting: '正在找串口',
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
    awayRadar: (span, cm) => `雷达已经 ${span}没测到人${cm}：ta 大概离开桌前了。`,
    back: (clock, span) => `屏幕在 ${clock}：ta 回来了，这次离开了 ${span}。`,
    backRadar: (clock, span) => `雷达在 ${clock} 又测到了人：ta 回到桌前，这次离开了 ${span}。`,
    passBy: (span, cm) => `雷达看到有人经过桌前（停留 ${span}${cm}）：大概不是 ta 回来，状态没变。`,
  },
  lamp: {
    radar: '雷达',
  },
  panel: {
    radarTitle: '雷达状态',
    radarDescription: 'USB 串口上的那颗 HLK-LD2402。没打开「用毫米波雷达判定」时，这里什么都不显示。',
    present: '正常工作，有人',
    absent: '正常工作，无人',
    warming: '已连接，还没在范围内见到人',
    stale: '串口开着，但收不到数据',
    far: '读到的距离都在范围之外',
    down: '未连接',
    starting: '正在找串口',
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
    radarEnabled: {
      title: 'Use the mmWave radar',
      description:
        'Turn on when an HLK-LD2402 is wired through a USB serial adapter. It only watches the desk: someone inside the range '
        + 'counts as present, nobody inside it counts as away. Far more reliable than an idle timer — reading a book, a paper '
        + 'handout or playing with a gamepad no longer looks like leaving. With no hardware attached, turning this on just '
        + 'reports that it is not connected.',
    },
    radarPort: {
      title: 'Radar serial port',
      description: '`auto` enumerates the USB serial ports on every connect, so unplugging and landing on another COM number still works. A concrete name like COM5 also works.',
    },
    radarMaxDistance: {
      title: 'Module range',
      description:
        'In 0.1 m units, 7 to 100. On start the plugin reads this parameter and writes it back (and saves it) when it differs, '
        + 'so a power cycle cannot silently restore the factory value. 0 leaves the module alone and only applies the filter below.',
      suffix: '0.1 m',
    },
    radarMaxCm: {
      title: 'How close someone has to be',
      description:
        'Centimetres. Someone further away, a family member across the room for instance, does not count. It doubles as the '
        + 'self-check baseline: when everything the radar sees stays beyond this distance, the module range or the mounting '
        + 'changed, so the plugin ignores the radar and says why instead of calling you away.',
      suffix: 'cm',
    },
    radarAbsentSeconds: {
      title: 'Radar absence that counts as away',
      description: 'Seconds. The module has a target-gone delay of its own (30 s from the factory), so the real delay is the sum of the two.',
      suffix: 's',
    },
    radarBackSeconds: {
      title: 'Radar presence that counts as back',
      description: 'Seconds. The radar has to see someone for this long before they count as back; anything shorter is a pass-by: one event, no state change. 10 s by default.',
      suffix: 's',
    },
    radarPassByNotify: {
      title: 'Raise an event when someone passes by',
      description: 'While they are away, a brief radar sighting raises a "someone passed by" event with how long it lasted. Turned off, only a real return makes a sound.',
    },
    radarQuietSeconds: {
      title: 'Ignore the radar while the keyboard is warm',
      description:
        'Seconds. When the radar reports nobody but the keyboard or mouse moved within this window, the radar is assumed to have missed them '
        + '(sitting still, a threshold that is set too high) and they are not called away. 0 trusts the radar completely.',
      suffix: 's',
    },
  },
  lines: {
    present: (since, span) => `At the desk (unlocked ${since}, ${span} so far)`,
    awayLocked: (since, span) => `Away (locked ${since}, ${span} so far)`,
    awayIdle: (since, span) => `Away (no keyboard or mouse input since ${since}, ${span} so far)`,
    awayRadar: (since, span) => `Away (no radar target since ${since}, ${span} so far)`,
    radarPresent: (cm) => `, radar at ${cm} cm`,
    radarDown: ', radar not connected',
    radarWarming: ', the radar has not seen anyone in range yet',
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
    radar: (line) => `Radar: ${line}`,
    radarOff: 'off (turn on "Use the mmWave radar")',
    radarNotWindows: 'only readable on Windows',
    radarDisconnected: (reason) => `not connected (${reason})`,
    radarWarming: 'connected, but nobody in range yet, so it does not take part in the verdict',
    radarSeen: (cm, at) => `someone at ${cm} cm (last frame ${at})`,
    radarAbsent: (span, cm) => `no target for ${span}, last seen at ${cm}`,
    radarFar: (cm) => `everything it sees is beyond ${cm}, the module range was probably reset, so it does not take part in the verdict`,
    radarStale: 'the port is open but no new frames are arriving (probably unplugged)',
    lampStarting: 'looking for the serial port',
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
    awayRadar: (span, cm) => `No radar target for ${span}${cm}: they are probably away from the desk.`,
    back: (clock, span) => `At ${clock} they were back, after ${span} away.`,
    backRadar: (clock, span) => `The radar saw someone again at ${clock}: back at the desk after ${span} away.`,
    passBy: (span, cm) => `The radar briefly saw someone pass the desk (${span}${cm}): probably not them coming back, so nothing changed.`,
  },
  lamp: {
    radar: 'Radar',
  },
  panel: {
    radarTitle: 'Radar status',
    radarDescription: 'The HLK-LD2402 on the USB serial port. Nothing shows here while "Use the mmWave radar" is off.',
    present: 'Working, someone at the desk',
    absent: 'Working, nobody at the desk',
    warming: 'Connected, but nobody has been in range yet',
    stale: 'The port is open but no data is arriving',
    far: 'Everything it reads is beyond the configured range',
    down: 'Not connected',
    starting: 'Looking for the serial port',
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
