/**
 * 在吗的 World：一个定时器、三个信号、一次判定、两行环境提示、一个只读工具。
 *
 * 宿主不给系统事件，只能自己隔一会儿看一眼：屏幕锁没锁（`tasklist`），键盘鼠标还有没有动静
 * （常驻 PowerShell 报空闲毫秒数），桌前有没有人（毫米波雷达按 165 ms 一帧报）。锁屏与雷达各自
 * 单独成立就够；键鼠空闲是弱信号，只在雷达没表态时才用，空闲到阈值还可以按配置再看一眼前台窗口
 * 或者比较两帧画面。读数连续两次一致才算数；读不到就保持原状。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import { isLanguage } from 'cortico/core/language.ts';
import type { ToolDef, ToolOutcome, World, WorldHost, WorldLamp, WorldWebUiDecl } from 'cortico/core/types.ts';
import {
  ARE_YOU_THERE_ID, areYouThereConfigGroup,
  MAX_RADAR_ABSENT_SECONDS, MAX_RADAR_BACK_SECONDS, MAX_RADAR_MAX_CM, MAX_RADAR_MAX_DISTANCE,
  MAX_RADAR_QUIET_SECONDS, MIN_POLL_SECONDS, MIN_RADAR_MAX_CM, MAX_POLL_SECONDS, MAX_IDLE_MINUTES,
  type AreYouThereConfigSection,
} from './config.ts';
import {
  SCREEN_CHANGED_PERCENT, defaultConfirmProbe, mediaMatch, splitKeywords,
  type ConfirmProbe,
} from './confirm.ts';
import { formatClock, formatDuration, formatSeconds } from './format.ts';
import { IdleTracker, type IdleReading, type IdleSource } from './idle.ts';
import {
  applyReading, decidePresence, emptyPresence,
  type AwayReason, type PresenceChange, type PresenceReading, type PresenceState,
} from './presence.ts';
import {
  confirmedReading, emptyDebounce, feedReading, probeLocked, runTasklist,
  type Debounce, type TasklistRunner,
} from './probe.ts';
import {
  RADAR_FAR_LIMIT_MS, RADAR_STALE_MS, RadarTracker, decideRadar, radarTrustExpired,
  type RadarDecision, type RadarReading, type RadarSource,
} from './radar.ts';
import {
  clampSettings, RADAR_GONE_FALLBACK_MS, readSettings, settingsAbsentMs, settingsBackWindowMs,
  settingsQuietMs, settingsThresholds, trackerSettings, writeSettings, type WorldSettings,
} from './settings.ts';
import { readState, writeState, STATE_FILE } from './state.ts';
import { PROMPT_VARS, areYouThereText, textLanguage, type TextLanguage } from './text.ts';

const ENV_PROMPT_FILES: Record<TextLanguage, string> = {
  zh: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)),
  en: fileURLToPath(new URL('./ENV_PROMPT.en.md', import.meta.url)),
};

/** 判定结果的保鲜期：一直空闲着的时候别每隔十几秒就截一回屏。 */
const VERDICT_TTL_MS = 5 * 60_000;

/** 这个 World 唯一的工具；`tools()` 绑上 handler。 */
export const ARE_YOU_THERE_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'here_status',
    description:
      'Report whether they are at the desk now, how long that state has lasted, when they were last away, how long the '
      + 'keyboard and mouse have been idle, and what the last idle verdict was (foreground window or screen change). '
      + 'Probes the screen lock once, live, and says whether it agrees with the record. Read only.',
    tags: ['read', 'presence'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
];

export interface AreYouThereWorldOptions {
  /** `worlds.are-you-there`，每次使用时读取。 */
  cfg: AreYouThereConfigSection;
  /** 回执与环境提示里的时刻用这个时区。 */
  timezone: string;
  /** 部署目录，用来读 `config.json` 里的语言。 */
  botDir: string;
  /** 运行记录 `are-you-there.json` 放这里。 */
  dataDir: string;
  /** 测试可以换掉真正跑 `tasklist` 的那一步。 */
  runner?: TasklistRunner;
  /** 测试可以换掉真正读空闲的那一步；给了就不会起 PowerShell。 */
  idle?: IdleSource;
  /** 测试可以换掉前台窗口与截图差分。 */
  confirm?: ConfirmProbe;
  /** 测试可以换掉毫米波雷达；给了就不会起 PowerShell。 */
  radar?: RadarSource;
  /** 测试可以冻结时钟，验证 40 秒回来窗口。 */
  now?: () => number;
}

/**
 * 雷达的一句话状态，World 页的面板与导航栏的状态灯共用。
 *
 * `tone`：`ok` 绿、`warn` 黄、`bad` 红、`off` 灰；`text` 是那句话，`hint` 是端口与读数这类细节。
 */
interface RadarStatusView {
  enabled: boolean;
  tone: 'ok' | 'warn' | 'bad' | 'off';
  text: string;
  hint: string;
}

/** 离开之后雷达第一次又看到人：先观察，不立刻翻状态。 */
interface BackCandidate {
  /** 第一帧近处有人。 */
  since: number;
  /** `radarBackSeconds` + 模块目标消失延迟。 */
  windowMs: number;
  /** 模块自己的延迟，用来从路过时长里扣掉。 */
  goneMs: number;
  /** 开始观察时的键鼠空闲读数，用来判断是否在这之后动过。 */
  idleAtStart: number | null;
}

/** 一次空闲判定的结果，留着给回执看。 */
interface Verdict {
  at: number;
  /** 判定后应该采用的状态。 */
  reading: PresenceReading;
  /** 哪一项认定「还在看」；都没认定就是 null。 */
  hit: 'foreground' | 'screen' | null;
  /** 读到的前台进程名；没读到或没开这项就是 null。 */
  foreground: string | null;
  /** 两帧差异百分比；没拍或拍失败就是 null。 */
  percent: number | null;
}

export class AreYouThereWorld implements World {
  readonly id = ARE_YOU_THERE_ID;
  private host: WorldHost | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 当前定时器的间隔，用来发现 `pollSeconds` 被改了。 */
  private armedMs = 0;
  private state: PresenceState = emptyPresence();
  private debounce: Debounce = emptyDebounce();
  /** 同一时间只跑一次探针，慢的 `tasklist` 不会堆积。 */
  private probing = false;
  private lastProbeAt: number | null = null;
  private failures = 0;
  private lastError = '';
  private languageCache: { at: number; value: Language } | null = null;
  private tracker: IdleTracker | null = null;
  private lastIdle: IdleReading | null = null;
  private verdict: Verdict | null = null;
  private radar: RadarTracker | null = null;
  /** 上一次用过的串口与模块距离；改了就在下一跳重连。 */
  private radarKey = '';
  private lastRadar: RadarReading | null = null;
  private lastRadarDecision: RadarDecision | null = null;
  /**
   * 什么时候撤销了对雷达的信任：旧读数 + 键鼠明明刚动过（人已回来），多半是关屏/休眠后
   * 雷达还拿着昨晚的 sighting 报 OFF。撤销后要等雷达重新看到近处的人才恢复。
   */
  private radarUntrustedAt: number | null = null;
  /** 离开之后正在观察的那次「有人」，还没决定是回来还是路过。 */
  private backCandidate: BackCandidate | null = null;
  /** 判定细节与雷达调参：存在 World 自己的文件里，由「设置」页签读写。 */
  private settings: WorldSettings;
  private readonly injectedIdle: IdleSource | null;
  private readonly injectedRadar: RadarSource | null;
  private readonly confirmProbe: ConfirmProbe;
  private readonly now: () => number;

  constructor(private readonly opts: AreYouThereWorldOptions) {
    this.state = readState(this.stateFile);
    this.settings = readSettings(this.opts.dataDir, this.opts.cfg);
    this.injectedIdle = opts.idle ?? null;
    this.injectedRadar = opts.radar ?? null;
    this.confirmProbe = opts.confirm ?? defaultConfirmProbe;
    this.now = opts.now ?? Date.now;
  }

  private get cfg(): AreYouThereConfigSection {
    return this.opts.cfg;
  }

  private get t() {
    return areYouThereText(this.language);
  }

  private get textLanguage(): TextLanguage {
    return textLanguage(this.language);
  }

  private get stateFile(): string {
    return join(this.opts.dataDir, STATE_FILE);
  }

  /** `config.json` 里的语言，文件变了再读一次。 */
  private get language(): Language {
    let at = 0;
    try {
      at = statSync(join(this.opts.botDir, 'config.json')).mtimeMs;
    } catch {
      // 默认中文
    }
    if (this.languageCache?.at !== at) {
      let value: Language = 'zh';
      try {
        const raw = JSON.parse(readFileSync(join(this.opts.botDir, 'config.json'), 'utf8')) as { language?: unknown };
        if (isLanguage(raw.language)) value = raw.language;
      } catch {
        // 默认中文
      }
      this.languageCache = { at, value };
    }
    return this.languageCache.value;
  }

  envPromptVars(): Record<string, string> {
    return {
      'here.state': this.stateLine(this.now()),
      'here.lastAway': this.lastAwayLine(),
    };
  }

  tools(): ToolDef[] {
    return [{ ...ARE_YOU_THERE_TOOL_DECLS[0]!, handler: () => this.status() }];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = areYouThereText(language);
    const chosen = ENV_PROMPT_FILES[this.textLanguage];
    const badges = this.badges(language);
    // `badges` 是页面声明里的一项（页头那排药丸），类型定义不在这个包能读到的地方，所以断言一下
    return {
      label: t.label,
      ...(badges.length > 0 ? { badges } : {}),
      lamps: this.lamps(language),
      panels: [{
        id: 'settings',
        title: t.panel.title,
        description: t.panel.description,
        getMethods: ['status', 'save'],
      }],
      invoke: (panel: string, method: string, args: unknown[]) => this.panelInvoke(panel, method, args, language),
      config: [areYouThereConfigGroup(language)],
      promptDocs: [{
        key: `worlds.${ARE_YOU_THERE_ID}.envPrompt`,
        title: t.envPrompt.title,
        description: t.envPrompt.description,
        path: existsSync(chosen) ? chosen : ENV_PROMPT_FILES.zh,
        role: 'envPrompt',
        vars: PROMPT_VARS.map((name) => ({
          name,
          description: t.envPrompt.vars[name],
          ...(name === 'here.state' ? { multiline: true } : {}),
        })),
      }],
    } as WorldWebUiDecl;
  }

  /**
   * 页头那排药丸，和「联网 Pro」的工具调用计数同一个位置（`page.badges`）。
   *
   * 只在打开雷达时给：没装硬件的人页头上多三颗灰药丸只是噪音。
   */
  private badges(language: Language): Array<{ label: string; value: string; tone: 'on' | 'off' | 'plain' }> {
    if (!this.cfg.radarEnabled) return [];
    const t = areYouThereText(language);
    const view = this.radarStatus(language);
    const reading = this.currentRadar();
    const linked = reading !== null && reading.linked && reading.at > 0
      && this.now() - reading.at <= RADAR_STALE_MS;
    const tone: 'on' | 'off' | 'plain' = view.tone === 'ok' ? 'on' : view.tone === 'off' ? 'off' : 'plain';
    const cm = linked ? reading?.cm ?? null : null;
    return [
      { label: t.badge.radar, value: linked ? t.badge.connected : t.badge.disconnected, tone },
      { label: t.badge.state, value: view.text || t.badge.none, tone },
      { label: t.badge.reading, value: cm === null ? t.badge.none : t.badge.centimetres(String(cm)), tone: 'plain' },
    ];
  }

  /**
   * 雷达当前的样子：一句话加一个语气。面板和状态灯都从这里取，免得两处判断走偏。
   *
   * `ok` 只说明硬件在正常工作，不代表人在——人走了雷达照常读数，还是 `ok`。
   */
  private radarStatus(language: Language): RadarStatusView {
    const t = areYouThereText(language);
    const lang = textLanguage(language);
    if (!this.cfg.radarEnabled) return { enabled: false, tone: 'off', text: '', hint: '' };
    const reading = this.currentRadar();
    if (reading === null || reading.at === 0) {
      return { enabled: true, tone: 'warn', text: t.panel.starting, hint: '' };
    }
    if (reading.problem === 'not-windows') {
      return { enabled: true, tone: 'off', text: t.panel.down, hint: t.tool.radarNotWindows };
    }
    if (!reading.linked) {
      return {
        enabled: true,
        tone: 'off',
        text: t.panel.down,
        hint: t.tool.radarDisconnected(reading.problem || 'unknown'),
      };
    }

    const port = reading.port;
    const hint = (text: string) => (port === '' ? text : `${port} · ${text}`);
    const now = this.now();
    if (now - reading.at > RADAR_STALE_MS) {
      return { enabled: true, tone: 'bad', text: t.panel.stale, hint: hint(t.tool.radarStale) };
    }
    if (this.radarUntrustedAt !== null) {
      return { enabled: true, tone: 'warn', text: t.panel.cooling, hint: hint(t.tool.radarCooling) };
    }

    const thresholds = settingsThresholds(this.settings, reading.goneMs);
    const decision = decideRadar(reading, now, thresholds);
    const cm = reading.cm !== null ? String(reading.cm) : '';
    if (decision !== null && decision.absent) {
      const span = formatSeconds(this.radarAwayMs(decision), lang);
      return { enabled: true, tone: 'ok', text: t.panel.absent, hint: hint(t.tool.radarAbsent(span, cm)) };
    }
    if (!reading.sawNear) {
      if (reading.farSince !== null && now - reading.farSince >= RADAR_FAR_LIMIT_MS) {
        return {
          enabled: true,
          tone: 'bad',
          text: t.panel.far,
          hint: hint(t.tool.radarFar(`${thresholds.maxCm}`)),
        };
      }
      return { enabled: true, tone: 'warn', text: t.panel.warming, hint: hint(t.tool.radarWarming) };
    }
    return {
      enabled: true,
      tone: 'ok',
      text: t.panel.present,
      hint: hint(t.tool.radarSeen(cm, formatClock(this.opts.timezone, reading.at))),
    };
  }

  /**
   * 导航栏与 World 总览上那颗灯。控制台每 500 ms 重新取一次，所以这里现算就行。
   *
   * 没打开雷达就一颗都不给：灰点表示「这条链路关着」，而没装硬件的人本来就不该看到它。
   */
  private lamps(language: Language): WorldLamp[] {
    const view = this.radarStatus(language);
    if (!view.enabled) return [];
    const state: WorldLamp['state'] = view.tone === 'ok'
      ? 'online'
      : view.tone === 'warn' ? 'loading' : view.tone === 'bad' ? 'error' : 'offline';
    return [{ label: areYouThereText(language).lamp.radar, state, hint: view.hint }];
  }

  /**
   * 面板上的表单。标签、单位、范围都由服务端算好，前端只管画，两边不会各写一套文案。
   *
   * 「关键词」只在「看前台窗口」打开时才给：没启用就折叠，这是平台本身给不了的。
   */
  private panelSections(language: Language): Array<Record<string, unknown>> {
    const t = areYouThereText(language);
    const c = t.config;
    const s = this.settings;
    const lang = textLanguage(language);
    // 模块自己的消失延迟；没连上时读不到，那就不给合计（卡片底下会解释）
    const gone = this.currentRadar()?.goneMs ?? null;
    const lock: Array<Record<string, unknown>> = [
      {
        key: 'pollSeconds', label: t.panel.fieldPollSeconds, kind: 'int',
        value: s.pollSeconds, min: MIN_POLL_SECONDS, max: MAX_POLL_SECONDS, suffix: c.pollSeconds.suffix,
        hint: c.pollSeconds.description,
      },
    ];
    const judge: Array<Record<string, unknown>> = [
      {
        key: 'idleMinutes', label: t.panel.fieldIdleMinutes, kind: 'int',
        value: s.idleMinutes, min: 0, max: MAX_IDLE_MINUTES, suffix: c.idleMinutes.suffix,
        hint: c.idleMinutes.description,
      },
      { key: 'checkForeground', label: t.panel.fieldCheckForeground, kind: 'bool', value: s.checkForeground, hint: c.checkForeground.description },
      ...(s.checkForeground
        ? [{ key: 'mediaKeywords', label: t.panel.fieldMediaKeywords, kind: 'text', value: s.mediaKeywords, hint: c.mediaKeywords.description }]
        : []),
      { key: 'checkScreen', label: t.panel.fieldCheckScreen, kind: 'bool', value: s.checkScreen, hint: c.checkScreen.description },
    ];
    const radar: Array<Record<string, unknown>> = this.cfg.radarEnabled
      ? [
        { key: 'radarPort', label: t.panel.fieldPort, kind: 'text', value: s.radarPort },
        {
          key: 'radarMaxDistance', label: t.panel.fieldMaxDistance, kind: 'int',
          value: s.radarMaxDistance, min: 0, max: MAX_RADAR_MAX_DISTANCE, suffix: c.radarMaxDistance.suffix,
        },
        {
          key: 'radarMaxCm', label: t.panel.fieldMaxCm, kind: 'int',
          value: s.radarMaxCm, min: MIN_RADAR_MAX_CM, max: MAX_RADAR_MAX_CM, suffix: c.radarMaxCm.suffix,
        },
        {
          key: 'radarAbsentSeconds', label: t.panel.fieldAbsentSeconds, kind: 'int',
          value: s.radarAbsentSeconds, min: 1, max: MAX_RADAR_ABSENT_SECONDS, suffix: c.radarAbsentSeconds.suffix,
          hint: t.panel.radarAbsentHint(
            formatSeconds(gone ?? RADAR_GONE_FALLBACK_MS, lang),
            formatSeconds((gone ?? RADAR_GONE_FALLBACK_MS) + 5_000, lang),
            formatSeconds(s.radarAbsentSeconds * 1000, lang),
            formatSeconds(settingsAbsentMs(s, gone), lang),
          ),
        },
        {
          key: 'radarBackSeconds', label: t.panel.fieldBackSeconds, kind: 'int',
          value: s.radarBackSeconds, min: 0, max: MAX_RADAR_BACK_SECONDS, suffix: c.radarBackSeconds.suffix,
          // 右上角小标：这一项加上模块硬件延迟，才是真正的回来观察窗口
          ...(gone === null ? {} : { badge: t.panel.radarTotal(formatSeconds(settingsBackWindowMs(s, gone), lang)) }),
        },
        { key: 'radarPassByNotify', label: t.panel.fieldPassByNotify, kind: 'bool', value: s.radarPassByNotify },
        {
          key: 'radarQuietSeconds', label: t.panel.fieldQuietSeconds, kind: 'int',
          value: s.radarQuietSeconds, min: 0, max: MAX_RADAR_QUIET_SECONDS, suffix: c.radarQuietSeconds.suffix,
        },
      ]
      : [];
    return [
      { id: 'lock', title: t.panel.lockTitle, description: t.panel.lockDescription, fields: lock },
      { id: 'judge', title: t.panel.judgeTitle, description: t.panel.judgeDescription, fields: judge },
      {
        id: 'radar',
        title: t.panel.radarTitle,
        description: t.panel.radarDescription,
        fields: radar,
        note: this.radarLatencyNote(language),
        status: this.radarStatus(language),
      },
    ];
  }

  /**
   * 雷达那张卡底下那句话：模块还有一个自己的消失延迟，所以「多久没人算离开」不是总时长。
   *
   * 串口没连上时读不到模块参数，这时只说明两者要相加，别编数字。
   */
  private radarLatencyNote(language: Language): string {
    const t = areYouThereText(language);
    if (!this.cfg.radarEnabled) return t.panel.radarOff;
    const gone = this.currentRadar()?.goneMs ?? null;
    if (gone === null) return t.panel.radarLatencyUnknown;
    return t.panel.radarLatency(formatSeconds(gone, textLanguage(language)));
  }

  /** 面板要的全部东西：三张卡（锁屏 / 空闲 / 雷达）、状态、提示文案。 */
  private panelPayload(language: Language): Record<string, unknown> {
    const t = areYouThereText(language);
    return {
      sections: this.panelSections(language),
      labels: { saved: t.panel.saved, failed: t.panel.saveFailed(''), status: t.panel.status },
    };
  }

  /**
   * World 页面板的方法。`status` 读一遍，`save` 收一部分改动。
   *
   * 串口或模块距离改了就把读串口的子进程重启一次，否则改完要等下一次 World 启动才生效。
   */
  private async panelInvoke(
    panel: string,
    method: string,
    args: unknown[],
    language: Language,
  ): Promise<unknown> {
    if (panel !== 'settings') throw new Error(`no such panel: ${panel}`);
    if (method === 'status') return this.panelPayload(language);
    if (method === 'save') {
      const next = clampSettings((args?.[0] ?? {}) as Partial<WorldSettings>, this.settings);
      writeSettings(this.opts.dataDir, next);
      const reconnect = next.radarPort !== this.settings.radarPort
        || next.radarMaxDistance !== this.settings.radarMaxDistance;
      this.settings = next;
      if (reconnect) {
        this.radar?.stop();
        this.radar = null;
        this.radarKey = '';
        this.ensureRadar();
      }
      return this.panelPayload(language);
    }
    throw new Error(`no such method: ${panel}.${method}`);
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.state = readState(this.stateFile);
    this.debounce = emptyDebounce();
    this.armTimer();
    this.ensureIdle();
    this.ensureRadar();
    // 第一次读数不等一个间隔：刚启动时最想知道 ta 在不在
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.armedMs = 0;
    this.host = null;
    this.tracker?.stop();
    this.tracker = null;
    this.lastIdle = null;
    this.radar?.stop();
    this.radar = null;
    this.radarKey = '';
    this.lastRadar = null;
    this.lastRadarDecision = null;
    this.radarUntrustedAt = null;
    this.backCandidate = null;
  }

  /** 「屏幕多久查一次」改了就在下一跳换掉定时器。 */
  private armTimer(): void {
    const ms = this.settings.pollSeconds * 1000;
    if (this.timer !== null && this.armedMs === ms) return;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.tick();
    }, ms);
    this.timer.unref();
    this.armedMs = ms;
  }

  /**
   * 键鼠读数什么时候需要：独立键鼠判定开着，或者雷达开着（要给雷达做交叉验证）。
   * 两者都关就把子进程停掉；雷达开着时即使独立那路停用了，读数仍然要留着。
   */
  private idleWanted(): boolean {
    return this.cfg.radarEnabled || (this.cfg.checkIdle !== false && this.settings.idleMinutes > 0);
  }

  /** 独立键鼠那一路的阈值；雷达打开时恒为 0，避免和雷达自带的键鼠判定打架。 */
  private standaloneIdleMs(): number {
    return this.cfg.radarEnabled || this.cfg.checkIdle === false ? 0 : this.settings.idleMinutes * 60_000;
  }

  private ensureIdle(): IdleSource | null {
    if (!this.idleWanted()) {
      this.tracker?.stop();
      this.tracker = null;
      this.lastIdle = null;
      return null;
    }
    if (this.injectedIdle !== null) return this.injectedIdle;
    if (this.tracker === null) {
      this.tracker = new IdleTracker();
      this.tracker.start();
    }
    return this.tracker;
  }

  /** 只读最近一次空闲读数，不顺手把子进程拉起来。 */
  private currentIdle(): IdleReading | null {
    if (!this.idleWanted()) return null;
    if (this.injectedIdle !== null) return this.injectedIdle.latest();
    return this.tracker?.latest() ?? null;
  }

  /** 雷达开关关掉就停子进程；串口或模块距离改了就在下一跳重连。 */
  private ensureRadar(): RadarSource | null {
    if (!this.cfg.radarEnabled) {
      this.radar?.stop();
      this.radar = null;
      this.radarKey = '';
      this.lastRadar = null;
      this.lastRadarDecision = null;
      this.radarUntrustedAt = null;
      return null;
    }
    if (this.injectedRadar !== null) return this.injectedRadar;
    const tracker = trackerSettings(this.settings);
    const key = `${tracker.port}|${tracker.maxDistance}`;
    if (this.radar !== null && this.radarKey !== key) {
      this.radar.stop();
      this.radar = null;
    }
    if (this.radar === null) {
      this.radar = new RadarTracker({
        port: tracker.port,
        maxDistance: tracker.maxDistance,
        maxCm: () => this.settings.radarMaxCm,
      });
      this.radarUntrustedAt = null;
      this.radar.start();
      this.radarKey = key;
    }
    return this.radar;
  }

  /** 只读最近一次雷达读数，不顺手把子进程拉起来。 */
  private currentRadar(): RadarReading | null {
    if (!this.cfg.radarEnabled) return null;
    if (this.injectedRadar !== null) return this.injectedRadar.latest();
    return this.radar?.latest() ?? null;
  }

  private async tick(): Promise<void> {
    if (this.host === null || this.probing) return;
    this.probing = true;
    try {
      this.armTimer();
      const threshold = this.standaloneIdleMs();
      const idle = this.ensureIdle()?.latest() ?? null;
      this.lastIdle = idle;

      let locked = false;
      if (this.cfg.checkLock) {
        const probe = await probeLocked(this.opts.runner ?? runTasklist);
        this.lastProbeAt = this.now();
        if (probe.locked === null) {
          // 读不到就说不知道：保持上一个状态，别把错误当成「ta 回来了」
          this.failures += 1;
          this.lastError = probe.error;
          return;
        }
        this.failures = 0;
        this.lastError = '';
        locked = probe.locked;
      }

      const radarSource = this.ensureRadar();
      const radarReading = radarSource !== null ? this.currentRadar() : null;
      const now = this.now();
      // 撤销信任是带闩锁的：一旦认定「人明明回来了，雷达还在拿昨晚的读数说没人」，
      // 就一直不采信它，直到它重新在 maxCm 以内看到人。否则键鼠一冷又会判走。
      if (this.radarUntrustedAt !== null && radarReading !== null
        && radarReading.lastPresentAt !== null && radarReading.lastPresentAt > this.radarUntrustedAt) {
        this.radarUntrustedAt = null;
      }
      const vetoMs = settingsQuietMs(this.settings);
      if (this.radarUntrustedAt === null && radarReading !== null
        && radarTrustExpired(radarReading, now)
        && idle !== null && idle.idleMs < vetoMs) {
        this.radarUntrustedAt = now;
      }
      const trustedReading = this.radarUntrustedAt === null ? radarReading : null;
      const radarDecision = decideRadar(
        trustedReading,
        now,
        settingsThresholds(this.settings, radarReading?.goneMs ?? null),
      );
      this.lastRadar = radarReading;
      this.lastRadarDecision = radarDecision;

      if (locked) this.backCandidate = null;
      // 离开之后第一次又看到近处的人：先观察，不立刻翻状态。
      if (!locked && this.state.away === true && this.backCandidate === null
        && radarReading !== null && radarReading.presentSince !== null
        && radarReading.lastPresentAt !== null && now - radarReading.lastPresentAt <= RADAR_STALE_MS) {
        this.backCandidate = {
          since: now,
          windowMs: settingsBackWindowMs(this.settings, radarReading.goneMs),
          goneMs: radarReading.goneMs ?? RADAR_GONE_FALLBACK_MS,
          idleAtStart: idle?.idleMs ?? null,
        };
      }

      let backNow = false;
      const candidate = this.backCandidate;
      if (candidate !== null && !locked && this.state.away === true) {
        const elapsed = now - candidate.since;
        // 从候选开始之后键鼠空闲读数变小，说明这 40 秒里动过——人回来了，不必再等
        const moved = idle !== null && candidate.idleAtStart !== null && idle.idleMs < elapsed;
        if (moved) {
          backNow = true;
          this.backCandidate = null;
        } else {
          const dropped = radarDecision !== null && radarDecision.absent;
          const unavailable = trustedReading === null || radarReading === null
            || now - radarReading.at > RADAR_STALE_MS;
          if (dropped || unavailable) {
            this.passBy(candidate, elapsed, radarDecision, radarReading);
            this.backCandidate = null;
          } else if (elapsed >= candidate.windowMs) {
            // 整个窗口都持续有人，也没动键鼠：雷达自己把人认回来了
            backNow = true;
            this.backCandidate = null;
          }
        }
      }

      // 雷达这一路自带键鼠交叉：报没人时要求键鼠也静默满这么久；0 表示完全听雷达。
      // 独立键鼠那一路在雷达打开时已被 standaloneIdleMs() 关掉，两边不会互相打架。
      let reading = decidePresence(locked, idle?.idleMs ?? null, threshold, radarDecision, vetoMs);
      if (this.state.away === true && backNow) reading = { away: false, reason: null };
      else if (this.state.away === true && this.backCandidate !== null) reading = { away: true, reason: 'radar' };
      if (reading.away && reading.reason === 'idle' && this.state.away !== true) {
        const verdict = await this.confirmIdle(reading);
        reading = verdict.reading;
        this.verdict = verdict;
      }

      this.debounce = feedReading(this.debounce, reading.away);
      // 雷达一秒六帧，读数本来就比一次 `tasklist` 结实，迟滞在 `decideRadar` 里已经做过了；
      // 再要求连续两次轮询一致，等于在模块那 30 秒之外又加一个轮询间隔。锁屏那条路照旧。
      // 但只在雷达的结论真的被采纳时走近路：`radarQuietSeconds` 这条宽限期会否掉它。
      const decidedByRadar = backNow || (radarDecision !== null && !locked && radarDecision.absent === reading.away);
      const confirmed = decidedByRadar ? reading.away : confirmedReading(this.debounce);
      if (confirmed === null) return;
      const effective = { away: confirmed, reason: confirmed ? reading.reason ?? 'lock' : null };
      // 回来的时候状态里已经没有原因了，先留一份给事件文案
      const wasReason = this.state.reason;
      const { state, change } = applyReading(this.state, effective, this.now());
      if (change === null) {
        this.state = state;
        return;
      }
      this.state = state;
      this.save();
      this.announce(change, wasReason);
    } finally {
      this.probing = false;
    }
  }

  /** 空闲到阈值时的额外判定：先看前台窗口，再看屏幕在不在变。都没认定就维持「不在」。 */
  private async confirmIdle(raw: PresenceReading): Promise<Verdict> {
    const now = this.now();
    if (this.verdict !== null && now - this.verdict.at < VERDICT_TTL_MS) return this.verdict;

    const settings = this.settings;
    const keywords = splitKeywords(settings.mediaKeywords);
    let foreground: string | null = null;
    let percent: number | null = null;

    if (settings.checkForeground) {
      const info = await this.confirmProbe.foreground();
      if (info !== null) {
        foreground = info.process;
        if (mediaMatch(info, keywords)) {
          return { at: now, reading: { away: false, reason: null }, hit: 'foreground', foreground, percent };
        }
      }
    }
    if (settings.checkScreen) {
      percent = await this.confirmProbe.screen();
      if (percent !== null && percent >= SCREEN_CHANGED_PERCENT) {
        return { at: now, reading: { away: false, reason: null }, hit: 'screen', foreground, percent };
      }
    }
    return { at: now, reading: raw, hit: null, foreground, percent };
  }

  /** 状态变化时推一条事件；第一次读到状态不喊，免得每次启动都来一句。 */
  private announce(change: PresenceChange, wasReason: AwayReason | null): void {
    const host = this.host;
    if (host === null || change.kind === 'first') return;
    const t = this.t;
    const lang = this.textLanguage;
    if (change.kind === 'away') {
      if (!this.cfg.notifyAway) return;
      const text = change.reason === 'radar'
        ? t.event.awayRadar(formatSeconds(this.radarAwayMs(this.lastRadarDecision), lang), this.radarDistance())
        : change.reason === 'idle'
          ? t.event.awayIdle(formatDuration(this.lastIdle?.idleMs ?? 0, lang), this.awayDetail())
          : t.event.awayLocked(formatClock(this.opts.timezone, change.at));
      host.pushDeferred(
        { type: `${ARE_YOU_THERE_ID}.changed`, origin: 'internal', render: () => text },
        { trigger: 'flush' },
      );
      return;
    }
    if (!this.cfg.notifyBack) return;
    const clock = formatClock(this.opts.timezone, change.at);
    const span = formatDuration(change.awayMs, lang);
    const text = wasReason === 'radar' ? t.event.backRadar(clock, span) : t.event.back(clock, span);
    host.pushDeferred(
      { type: `${ARE_YOU_THERE_ID}.changed`, origin: 'internal', render: () => text },
      { trigger: 'flush' },
    );
  }

  /**
   * 事件里的「雷达多久没测到人」：`absentMs` 现在就是从最后一次看见人起算的总时长，
   * 配置值和硬件延迟已经合并过，这里不再加第二次。
   */
  private radarAwayMs(decision: RadarDecision | null): number {
    return decision?.absentMs ?? 0;
  }

  /** 「，最近一次在 79 厘米」/「 (last seen at 79 cm)」；不知道距离就是空串。 */
  private radarDistance(cm?: number | null): string {
    const value = cm ?? this.lastRadarDecision?.cm ?? this.lastRadar?.cm ?? null;
    if (value === null) return '';
    return this.textLanguage === 'zh' ? `，最近一次在 ${value} 厘米` : `, last seen at ${value} cm`;
  }

  /**
   * 回来观察窗口里又掉回没人：这一小段算路过，状态不变。
   *
   * 模块报 `OFF` 之前等了硬件延迟，所以那段要扣掉，才是人真正停留的时长；
   * 距离跳远那一路模块没等，就不扣。
   */
  private passBy(
    candidate: BackCandidate,
    elapsed: number,
    decision: RadarDecision | null,
    reading: RadarReading | null,
  ): void {
    const host = this.host;
    if (host === null || !this.cfg.radarPassByNotify || this.state.away !== true) return;
    const delay = decision?.offFrame === true ? candidate.goneMs : 0;
    const stayed = Math.max(0, elapsed - delay);
    const text = this.t.event.passBy(
      formatDuration(stayed, this.textLanguage),
      this.radarDistance(reading?.cm),
    );
    host.pushDeferred(
      { type: `${ARE_YOU_THERE_ID}.changed`, origin: 'internal', render: () => text },
      { trigger: 'flush' },
    );
  }

  /** 「不在」那条事件里补一句：屏幕也看过，没在变。 */
  private awayDetail(): string {
    const verdict = this.verdict;
    if (verdict === null || verdict.percent === null) return '';
    return this.textLanguage === 'zh'
      ? `，屏幕也没在变（差 ${verdict.percent}%）`
      : `, and the screen was still (${verdict.percent}% difference)`;
  }

  private save(): void {
    try {
      writeState(this.stateFile, this.state);
    } catch (error) {
      console.warn('[are-you-there] could not save the record', this.stateFile, error);
    }
  }

  private stateLine(now: number): string {
    const t = this.t;
    const { away, since, reason } = this.state;
    if (away === null || since === null) return t.lines.unknown;
    const at = formatClock(this.opts.timezone, since);
    const span = formatDuration(now - since, this.textLanguage);
    if (!away) return t.lines.present(at, span) + this.radarNote();
    if (reason === 'radar') return t.lines.awayRadar(at, span);
    return (reason === 'idle' ? t.lines.awayIdle(at, span) : t.lines.awayLocked(at, span)) + this.radarNote();
  }

  /** 追在 `here.state` 后面的一句：雷达在多少厘米、还是根本没连上。 */
  private radarNote(): string {
    if (!this.cfg.radarEnabled) return '';
    const t = this.t;
    const reading = this.lastRadar ?? this.currentRadar();
    if (reading === null || !reading.linked) return t.lines.radarDown;
    if (this.radarUntrustedAt !== null) return t.lines.radarCooling;
    if (this.lastRadarDecision?.present === true && reading.cm !== null) {
      return t.lines.radarPresent(String(reading.cm));
    }
    return reading.sawNear ? '' : t.lines.radarWarming;
  }

  private lastAwayLine(): string {
    const t = this.t;
    const away = this.state.lastAway;
    if (away === null) return t.lines.noLastAway;
    return t.lines.lastAway(
      formatClock(this.opts.timezone, away.from),
      formatClock(this.opts.timezone, away.to),
      formatDuration(away.to - away.from, this.textLanguage),
    );
  }

  /** 回执里的雷达那行：连没连上、在多少厘米、还是已经很久没测到人。 */
  private radarLine(): string {
    const t = this.t;
    if (!this.cfg.radarEnabled) return t.tool.radarOff;
    const reading = this.currentRadar();
    if (reading === null || reading.at === 0) return t.tool.radarDisconnected(reading?.problem || 'starting');
    if (reading.problem === 'not-windows') return t.tool.radarNotWindows;
    if (!reading.linked) return t.tool.radarDisconnected(reading.problem || 'unknown');

    const now = this.now();
    if (this.radarUntrustedAt !== null) return t.tool.radarCooling;
    const thresholds = settingsThresholds(this.settings, reading.goneMs);
    const decision = decideRadar(reading, now, thresholds);
    const cm = reading.cm !== null ? String(reading.cm) : '';
    if (decision !== null && decision.absent) {
      // 报「离桌多久」而不是「插件等了多久」：模块自己的延迟也算进去
      return t.tool.radarAbsent(formatSeconds(this.radarAwayMs(decision), this.textLanguage), cm);
    }
    if (!reading.sawNear) {
      if (reading.farSince !== null && now - reading.farSince >= RADAR_FAR_LIMIT_MS) {
        return t.tool.radarFar(`${thresholds.maxCm}`);
      }
      return t.tool.radarWarming;
    }
    return t.tool.radarSeen(cm, formatClock(this.opts.timezone, reading.at));
  }

  private verdictLine(): string {
    const t = this.t;
    const verdict = this.verdict;
    if (!this.settings.checkForeground && !this.settings.checkScreen) return t.tool.verdictOff;
    if (verdict === null) return t.tool.verdictOff;
    if (verdict.hit === 'foreground' && verdict.foreground !== null) return t.tool.verdictForegroundHit(verdict.foreground);
    if (verdict.hit === 'screen' && verdict.percent !== null) return t.tool.verdictScreenChanged(`${verdict.percent}%`);
    if (verdict.percent !== null) return t.tool.verdictScreenStill(`${verdict.percent}%`);
    if (verdict.foreground !== null) return t.tool.verdictForegroundMiss(verdict.foreground);
    return this.settings.checkScreen ? t.tool.verdictScreenFailed : t.tool.verdictForegroundFailed;
  }

  /**
   * 工具回执：先报记录，再当场查一次锁屏做核对。
   *
   * 这次探针不写状态、不喂去抖——一次手动检查不该顶替两次确认，读到的差异只写进回执。
   */
  private async status(): Promise<string | ToolOutcome> {
    const t = this.t;
    const lang = this.textLanguage;
    const lines = [
      t.tool.now(this.stateLine(this.now())),
      t.tool.lastAway(this.lastAwayLine()),
    ];

    const threshold = this.standaloneIdleMs();
    const idle = this.currentIdle();
    if (this.cfg.radarEnabled) {
      lines.push(t.tool.idle(t.tool.idleCross(formatSeconds(settingsQuietMs(this.settings), lang))));
    } else if (threshold <= 0) lines.push(t.tool.idle(t.tool.idleOff));
    else if (idle === null) lines.push(t.tool.idle(t.tool.idleUnknown));
    else {
      lines.push(t.tool.idle(t.tool.idleLine(formatDuration(idle.idleMs, lang), formatDuration(threshold, lang))));
    }
    lines.push(t.tool.radar(this.radarLine()));
    lines.push(t.tool.verdict(this.verdictLine()));

    const probe = await probeLocked(this.opts.runner ?? runTasklist);
    if (probe.locked === null) {
      lines.push(t.tool.live(probe.error === 'not windows' ? t.tool.notWindows : t.tool.failed(probe.error)));
    } else {
      const reading = probe.locked ? t.tool.readingLocked : t.tool.readingUnlocked;
      if (this.state.away === null) {
        lines.push(t.tool.live(t.tool.notConfirmed(reading)));
      } else {
        // 记录里那个「锁屏」信号：因空闲判成不在时，锁其实是解锁的
        const recordedLocked = this.state.away && this.state.reason === 'lock';
        const recorded = recordedLocked ? t.tool.readingLocked : t.tool.readingUnlocked;
        lines.push(t.tool.live(recorded === reading ? t.tool.agrees(reading) : t.tool.disagrees(recorded, reading)));
      }
    }
    if (this.failures > 0 && this.lastProbeAt !== null) {
      lines.push(t.tool.failures(this.failures, formatClock(this.opts.timezone, this.lastProbeAt), this.lastError));
    }
    return lines.join('\n');
  }
}
