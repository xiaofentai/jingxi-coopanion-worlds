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
    checkIdle: { title: string; description: string };
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
    /** 雷达那张卡片自己的标题与说明；`descriptionOff` 用在开关还没打开的时候。 */
    radarGroup: { title: string; description: string; descriptionOff: string };
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
    radarCooling: string;
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
    idleCross: (quiet: string) => string;
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
    radarCooling: string;
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
  /** 页头那排标签：`pill(label + value)`，和「联网 Pro」那种工具调用计数一个位置。 */
  badge: {
    radar: string;
    state: string;
    reading: string;
    connected: string;
    disconnected: string;
    centimetres: (cm: string) => string;
    none: string;
  };
  /** World 页里的「设置」面板：判定细节与雷达调参，各一张可折叠的卡。 */
  panel: {
    title: string;
    description: string;
    lockTitle: string;
    lockDescription: string;
    judgeTitle: string;
    judgeDescription: string;
    radarTitle: string;
    radarDescription: string;
    radarOff: string;
    status: string;
    /** 卡片底下那句：LD2402 自己的硬件延迟。 */
    radarLatency: (gone: string) => string;
    radarLatencyUnknown: string;
    /** 「多久有人才算回来」右上角那个小标：人回来后最迟多久推回来事件。 */
    radarTotal: (total: string) => string;
    /** 「多久没人算离开」那一行的提示：硬件延迟、推荐值、当前值与生效值。 */
    radarAbsentHint: (gone: string, recommended: string, current: string, effective: string) => string;
    present: string;
    absent: string;
    warming: string;
    cooling: string;
    stale: string;
    far: string;
    down: string;
    starting: string;
    fieldPollSeconds: string;
    fieldIdleMinutes: string;
    fieldCheckForeground: string;
    fieldMediaKeywords: string;
    fieldCheckScreen: string;
    fieldPort: string;
    fieldMaxDistance: string;
    fieldMaxDistanceHint: (recommended: string) => string;
    fieldMaxCm: string;
    fieldMaxCmHint: (recommended: string, minValid: string) => string;
    fieldAbsentSeconds: string;
    fieldBackSeconds: string;
    fieldPassByNotify: string;
    fieldQuietSeconds: string;
    saved: string;
    saveFailed: (reason: string) => string;
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
    groupDescription: '隔一会儿查一次屏幕锁没锁、键盘鼠标还有没有动静，把「ta 现在在不在桌前」放进环境提示。'
      + '更新扩展后若「细节设置」页签不见了或内容还是旧的：先按扩展页的「重启进程」，再刷新一次控制台页面'
      + '（Ctrl+R；样式没变就用 Ctrl+Shift+R 硬刷新）——页面清单只在开页时取。',
    pollSeconds: {
      title: '多久查一次',
      description: '单位秒，范围 5–300。连续两次读到同一结果才算数，所以状态变化最多慢两个间隔。',
      suffix: '秒',
    },
    checkIdle: {
      title: '键鼠判定',
      description: '键鼠久没动静算可能离开。打开雷达后这路自动停用。',
    },
    idleMinutes: {
      title: '空闲多久算离开',
      description:
        '键盘鼠标连续这么久没有输入就当作不在。0 表示不看空闲，只看锁屏。'
        + '看视频、读书这类长时间不碰键鼠的时候会误判，按自己的习惯调大。',
      suffix: '分钟',
    },
    checkLock: {
      title: '锁屏判定',
      description: '锁着就算离开。',
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
      title: '离开时推事件',
      description: '确认离开后推一条事件。',
    },
    notifyBack: {
      title: '回来时推事件',
      description: '确认回到桌前之后推一条事件，附上这次离开了多久。',
    },
    radarEnabled: {
      title: '雷达判定',
      description: '接了 HLK-LD2402（USB 转 TTL）就打开。串口与门限在「细节设置」里。',
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
      description:
        '单位秒，从雷达最后一次在桌前看到人到认定「没人」的总时长，默认 35 秒。'
        + '填得比模块硬件延迟短也没用，会按硬件延迟算。',
      suffix: '秒',
    },
    radarBackSeconds: {
      title: '雷达多久有人才算回来',
      description:
        '单位秒。这一项加上模块自己的目标消失延迟（默认 30 秒）就是回来观察窗口，默认合计 40 秒。'
        + '窗口内键鼠动过就立刻算回来；没动过就看是否跌落回没人——跌落算路过，持续有人到窗口结束才算回来。',
      suffix: '秒',
    },
    radarPassByNotify: {
      title: '有人经过时推事件',
      description: '判为离开期间，雷达短暂看到人就推一条「有人经过」，附上停留了多久。关掉就只在真的回来时出声。',
    },
    radarQuietSeconds: {
      title: '键鼠还热着就不信雷达',
      description:
        '单位秒：雷达报没人时，键鼠也要静默这么久才交叉成立。默认 35 秒，正好是模块 30 秒硬件延迟加 5 秒确认，'
        + '所以刚敲完字就被雷达误报走的情况不会发生。短暂动几秒不算数——静默够了照样判走。'
        + '0 表示完全听雷达的：它一报没人就算走。',
      suffix: '秒',
    },
    radarGroup: {
      title: '雷达',
      description: 'HLK-LD2402 挂在 USB 转 TTL 上，串口 115200 8N1。',
      descriptionOff: '没装硬件就别打开。打开后离开本页再进来，下面几项参数才会展开。',
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
    radarCooling: '，雷达很久没在范围内见到人，先不参与判定',
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
    idleCross: (quiet) => `键鼠只用于雷达交叉判定：要静默 ${quiet} 才和雷达一起判离开`,
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
    radarCooling: '很久没在范围内读到人了，旧读数不作数，先不参与判定',
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
    awayLocked: (clock) => `ta 离开了电脑：屏幕在 ${clock} 锁上了。`,
    awayIdle: (span, detail) => `ta 离开了桌前：键盘鼠标 ${span}没有动静${detail}。`,
    awayRadar: (span, cm) => `ta 离开了桌前：雷达 ${span}没测到人${cm}。`,
    back: (clock, span) => `ta 回来了：屏幕在 ${clock} 解锁，这次离开了 ${span}。`,
    backRadar: (clock, span) => `ta 回到了桌前：雷达在 ${clock} 又测到了人，这次离开了 ${span}。`,
    passBy: (span, cm) => `有人经过桌前（停留 ${span}${cm}）：不是 ta 回来，状态没变。`,
  },
  lamp: {
    radar: '雷达',
  },
  badge: {
    radar: '雷达',
    state: '状态',
    reading: '读数',
    connected: '已连接',
    disconnected: '未连接',
    centimetres: (cm) => `${cm} 厘米`,
    none: '—',
  },
  panel: {
    title: '细节设置',
    description: '配置页只放开关，这里放它们展开之后的参数。框的顺序与配置页的开关一致。',
    lockTitle: '锁屏检测',
    lockDescription: '多久看一次屏幕锁没锁。对应配置页的「锁屏判定」。',
    judgeTitle: '空闲判定',
    judgeDescription: '键鼠空闲到阈值后，先看一眼前台窗口，再看屏幕在不在变；两项都没认定才判离开。',
    radarOff: '没打开「雷达判定」，这里没有可调项。',
    status: '状态',
    radarLatency: (gone) => `LD2402 的硬件延迟是 ${gone}：它要连续这么久测不到人才会报「没人」；「回来观察窗口」要把这段加进去。`,
    radarLatencyUnknown: '读不到 LD2402 的硬件延迟（串口没连上时读不到），回来观察窗口按出厂 30 秒估算。',
    radarTotal: (total) => `人回来后最迟合计 ${total}推送人回来`,
    radarAbsentHint: (gone, recommended, current, effective) =>
      `雷达本身延迟 ${gone}，推荐填 ${recommended}；当前填 ${current}，实际按 ${effective} 算（低于硬件延迟时按硬件算）。`,
    fieldPollSeconds: '屏幕多久查一次',
    fieldIdleMinutes: '鼠标空闲判定时长',
    fieldCheckForeground: '空闲时看一眼前台窗口',
    fieldMediaKeywords: '认作「在看」的关键词',
    fieldCheckScreen: '空闲时比较两帧画面',
    radarTitle: '雷达',
    radarDescription: 'USB 串口上的那颗 HLK-LD2402：上面一行是它的状态，下面是它那几项调参。',
    present: '正常工作，有人',
    absent: '正常工作，无人',
    warming: '已连接，还没在范围内见到人',
    cooling: '旧读数已过期，暂不参与判定',
    stale: '串口开着，但收不到数据',
    far: '读到的距离都在范围之外',
    down: '未连接',
    starting: '正在找串口',
    fieldPort: '串口',
    fieldMaxDistance: '模块探测距离',
    fieldMaxDistanceHint: (recommended) => `推荐填 ${recommended}（2.0 米）：给模块足够量程，近处仍由下面那条过滤。`,
    fieldMaxCm: '只把这么近的人算作在桌前',
    fieldMaxCmHint: (recommended, minValid) =>
      `推荐填 ${recommended} 厘米：夹在本人稳定读数与空椅/旁人距离之间；${minValid} 厘米内的近场伪影会忽略。`,
    fieldAbsentSeconds: '多久没人算离开',
    fieldBackSeconds: '多久有人才算回来',
    fieldPassByNotify: '有人经过时推事件',
    fieldQuietSeconds: '键鼠还热着就不信雷达',
    saved: '已保存',
    saveFailed: (reason) => `保存失败：${reason}`,
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
    groupDescription: 'Checks the screen lock and whether the keyboard or mouse has been touched, and puts whether they are at the desk into the environment section. '
      + 'If the "Detailed settings" tab is missing or stale after an update, restart the process from the extensions page and then reload the console page '
      + '(Ctrl+R; Ctrl+Shift+R for a hard reload if styles still look old): the page list is fetched only when a page opens.',
    pollSeconds: {
      title: 'How often to check',
      description: 'Seconds, 5 to 300. Two readings in a row have to agree, so a change shows up at most two intervals late.',
      suffix: 's',
    },
    checkIdle: {
      title: 'Keyboard verdict',
      description: 'Idle mouse and keyboard count as possibly away. Disabled while the radar is on.',
    },
    idleMinutes: {
      title: 'Idle time that counts as away',
      description:
        'With no keyboard or mouse input for this long, they count as away. 0 means the idle signal is off and only the screen lock is used. '
        + 'Watching a video or reading for a long stretch will look like away, so raise this if that is common.',
      suffix: 'min',
    },
    checkLock: {
      title: 'Screen-lock verdict',
      description: 'A locked screen counts as away.',
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
      title: 'Away event',
      description: 'Push an event once they are confirmed away.',
    },
    notifyBack: {
      title: 'Raise an event when they come back',
      description: 'After a confirmed return, push an event with how long the person was away.',
    },
    radarEnabled: {
      title: 'Radar verdict',
      description: 'On when an HLK-LD2402 is wired through USB serial. Port and thresholds live under "Detailed settings".',
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
      description:
        'Seconds: the total wait from the last time the radar saw someone at the desk until it says nobody. 35 s by default. '
        + 'A value below the module hardware delay has no effect; the hardware value wins.',
      suffix: 's',
    },
    radarBackSeconds: {
      title: 'Radar presence that counts as back',
      description:
        'Seconds. This plus the module\'s target-gone delay (30 s by default) is the observation window, 40 s in total. '
        + 'Keyboard or mouse movement inside the window means back; otherwise a drop back to nobody counts as a pass-by, '
        + 'and only a continuous sighting to the end of the window counts as back.',
      suffix: 's',
    },
    radarPassByNotify: {
      title: 'Raise an event when someone passes by',
      description: 'While they are away, a brief radar sighting raises a "someone passed by" event with how long it lasted. Turned off, only a real return makes a sound.',
    },
    radarQuietSeconds: {
      title: 'Ignore the radar while the keyboard is warm',
      description:
        'Seconds: when the radar says nobody, the keyboard must also have been quiet this long before the two agree on away. '
        + '35 s by default, matching the module\'s 30 s hardware delay plus the 5 s confirmation, so a fresh keystroke cannot be '
        + 'overridden by a stale radar report. A brief blip does not count. 0 trusts the radar completely.',
      suffix: 's',
    },
    radarGroup: {
      title: 'Radar',
      description: 'An HLK-LD2402 on a USB serial adapter, 115200 8N1.',
      descriptionOff: 'Leave it off unless the hardware is plugged in. Once on, leave this page and come back: the rest of the settings appear then.',
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
    radarCooling: ', the last sighting is too old to trust, so the radar does not take part in the verdict',
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
    idleCross: (quiet) => `keyboard only cross-checks the radar: quiet for ${quiet} before they agree on away`,
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
    radarCooling: 'nobody in range for a long time; the old sighting is stale, so it does not take part in the verdict',
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
    awayLocked: (clock) => `They left the computer: the screen locked at ${clock}.`,
    awayIdle: (span, detail) => `They left the desk: no keyboard or mouse input for ${span}${detail}.`,
    awayRadar: (span, cm) => `They left the desk: no radar target for ${span}${cm}.`,
    back: (clock, span) => `They are back: the screen unlocked at ${clock}, after ${span} away.`,
    backRadar: (clock, span) => `They are back at the desk: the radar saw someone at ${clock}, after ${span} away.`,
    passBy: (span, cm) => `Someone passed by the desk (${span}${cm}): not them coming back, so nothing changed.`,
  },
  lamp: {
    radar: 'Radar',
  },
  badge: {
    radar: 'Radar',
    state: 'State',
    reading: 'Reading',
    connected: 'connected',
    disconnected: 'not connected',
    centimetres: (cm) => `${cm} cm`,
    none: '—',
  },
  panel: {
    title: 'Detailed settings',
    description: 'The config tab keeps the switches; this page holds their values, in the same order.',
    lockTitle: 'Screen-lock check',
    lockDescription: 'How often the screen lock is read. Matches the "Screen-lock verdict" switch.',
    judgeTitle: 'Idle verdict',
    judgeDescription: 'Once the keyboard and mouse reach the idle threshold, the foreground window is checked first and the screen second; only if neither counts as watching do they count as away.',
    radarOff: '"Use the mmWave radar" is off, so there is nothing to tune here.',
    status: 'State',
    radarLatency: (gone) => `The LD2402 has a hardware delay of ${gone}: it only reports nobody after that long without a target. The back observation window includes it.`,
    radarLatencyUnknown: 'The LD2402 hardware delay could not be read (it is unreadable while the port is down); the back window uses the factory 30 s.',
    radarTotal: (total) => `Back event is pushed at most ${total} after they return`,
    radarAbsentHint: (gone, recommended, current, effective) =>
      `Module delay ${gone}; ${recommended} is recommended. Current ${current}, effective ${effective} (a value below the module delay uses the module delay).`,
    fieldPollSeconds: 'How often to check the screen',
    fieldIdleMinutes: 'Mouse idle time',
    fieldCheckForeground: 'Look at the foreground window when idle',
    fieldMediaKeywords: 'Keywords that count as watching',
    fieldCheckScreen: 'Compare two frames when idle',
    radarTitle: 'Radar',
    radarDescription: 'The HLK-LD2402 on the USB serial port: the line on top is its state, below are its own settings.',
    present: 'Working, someone at the desk',
    absent: 'Working, nobody at the desk',
    warming: 'Connected, but nobody has been in range yet',
    cooling: 'Last sighting is too old; not used for the verdict',
    stale: 'The port is open but no data is arriving',
    far: 'Everything it reads is beyond the configured range',
    down: 'Not connected',
    starting: 'Looking for the serial port',
    fieldPort: 'Serial port',
    fieldMaxDistance: 'Module range',
    fieldMaxDistanceHint: (recommended) => `Recommended ${recommended} (2.0 m): enough range for the module; the field below still filters the desk area.`,
    fieldMaxCm: 'How close someone has to be',
    fieldMaxCmHint: (recommended, minValid) =>
      `Recommended ${recommended} cm: between your seated reading and the empty chair/neighbor; near-field frames under ${minValid} cm are ignored.`,
    fieldAbsentSeconds: 'Absence that counts as away',
    fieldBackSeconds: 'Presence that counts as back',
    fieldPassByNotify: 'Raise an event when someone passes by',
    fieldQuietSeconds: 'Ignore the radar while the keyboard is warm',
    saved: 'Saved',
    saveFailed: (reason) => `Could not save: ${reason}`,
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
