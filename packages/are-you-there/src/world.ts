/**
 * 在吗的 World：一个定时器、两个信号、一次判定、两行环境提示、一个只读工具。
 *
 * 宿主不给系统事件，只能自己隔一会儿看一眼：屏幕锁没锁（`tasklist`），键盘鼠标还有没有动静
 * （常驻 PowerShell 报空闲毫秒数）。键鼠空闲到阈值时，按配置再做一次判定——看前台窗口、比较两帧
 * 画面——确认「是在看视频」还是「真的走了」。读数连续两次一致才算数；读不到就保持原状。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import { isLanguage } from 'cortico/core/language.ts';
import type { ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import {
  ARE_YOU_THERE_ID, areYouThereConfigGroup, clampedPollSeconds, idleThresholdMs,
  type AreYouThereConfigSection,
} from './config.ts';
import {
  SCREEN_CHANGED_PERCENT, defaultConfirmProbe, mediaMatch, splitKeywords,
  type ConfirmProbe,
} from './confirm.ts';
import { formatClock, formatDuration } from './format.ts';
import { IdleTracker, type IdleReading, type IdleSource } from './idle.ts';
import {
  applyReading, decidePresence, emptyPresence,
  type PresenceChange, type PresenceReading, type PresenceState,
} from './presence.ts';
import {
  confirmedReading, emptyDebounce, feedReading, probeLocked, runTasklist,
  type Debounce, type TasklistRunner,
} from './probe.ts';
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
  private readonly injectedIdle: IdleSource | null;
  private readonly confirmProbe: ConfirmProbe;

  constructor(private readonly opts: AreYouThereWorldOptions) {
    this.state = readState(this.stateFile);
    this.injectedIdle = opts.idle ?? null;
    this.confirmProbe = opts.confirm ?? defaultConfirmProbe;
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
      'here.state': this.stateLine(Date.now()),
      'here.lastAway': this.lastAwayLine(),
    };
  }

  tools(): ToolDef[] {
    return [{ ...ARE_YOU_THERE_TOOL_DECLS[0]!, handler: () => this.status() }];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = areYouThereText(language);
    const chosen = ENV_PROMPT_FILES[this.textLanguage];
    return {
      label: t.label,
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
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.state = readState(this.stateFile);
    this.debounce = emptyDebounce();
    this.armTimer();
    this.ensureIdle();
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
  }

  /** `pollSeconds` 改了就在下一跳换掉定时器。 */
  private armTimer(): void {
    const ms = clampedPollSeconds(this.cfg) * 1000;
    if (this.timer !== null && this.armedMs === ms) return;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.tick();
    }, ms);
    this.timer.unref();
    this.armedMs = ms;
  }

  /** 空闲阈值改成 0 就把子进程停掉；改回来再起一个。 */
  private ensureIdle(): IdleSource | null {
    if (this.injectedIdle !== null) return idleThresholdMs(this.cfg) > 0 ? this.injectedIdle : null;
    if (idleThresholdMs(this.cfg) <= 0) {
      this.tracker?.stop();
      this.tracker = null;
      this.lastIdle = null;
      return null;
    }
    if (this.tracker === null) {
      this.tracker = new IdleTracker();
      this.tracker.start();
    }
    return this.tracker;
  }

  /** 只读最近一次空闲读数，不顺手把子进程拉起来。 */
  private currentIdle(): IdleReading | null {
    if (this.injectedIdle !== null) return idleThresholdMs(this.cfg) > 0 ? this.injectedIdle.latest() : null;
    return idleThresholdMs(this.cfg) > 0 ? this.tracker?.latest() ?? null : null;
  }

  private async tick(): Promise<void> {
    if (this.host === null || this.probing) return;
    this.probing = true;
    try {
      this.armTimer();
      const threshold = idleThresholdMs(this.cfg);
      const idle = this.ensureIdle()?.latest() ?? null;
      this.lastIdle = idle;

      let locked = false;
      if (this.cfg.checkLock) {
        const probe = await probeLocked(this.opts.runner ?? runTasklist);
        this.lastProbeAt = Date.now();
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

      let reading = decidePresence(locked, idle?.idleMs ?? null, threshold);
      if (reading.away && reading.reason === 'idle' && this.state.away !== true) {
        const verdict = await this.confirmIdle(reading);
        reading = verdict.reading;
        this.verdict = verdict;
      }

      this.debounce = feedReading(this.debounce, reading.away);
      const confirmed = confirmedReading(this.debounce);
      if (confirmed === null) return;
      const effective = { away: confirmed, reason: confirmed ? reading.reason ?? 'lock' : null };
      const { state, change } = applyReading(this.state, effective, Date.now());
      if (change === null) {
        this.state = state;
        return;
      }
      this.state = state;
      this.save();
      this.announce(change);
    } finally {
      this.probing = false;
    }
  }

  /** 空闲到阈值时的额外判定：先看前台窗口，再看屏幕在不在变。都没认定就维持「不在」。 */
  private async confirmIdle(raw: PresenceReading): Promise<Verdict> {
    const now = Date.now();
    if (this.verdict !== null && now - this.verdict.at < VERDICT_TTL_MS) return this.verdict;

    const cfg = this.cfg;
    const keywords = splitKeywords(cfg.mediaKeywords ?? '');
    let foreground: string | null = null;
    let percent: number | null = null;

    if (cfg.checkForeground) {
      const info = await this.confirmProbe.foreground();
      if (info !== null) {
        foreground = info.process;
        if (mediaMatch(info, keywords)) {
          return { at: now, reading: { away: false, reason: null }, hit: 'foreground', foreground, percent };
        }
      }
    }
    if (cfg.checkScreen) {
      percent = await this.confirmProbe.screen();
      if (percent !== null && percent >= SCREEN_CHANGED_PERCENT) {
        return { at: now, reading: { away: false, reason: null }, hit: 'screen', foreground, percent };
      }
    }
    return { at: now, reading: raw, hit: null, foreground, percent };
  }

  /** 状态变化时推一条事件；第一次读到状态不喊，免得每次启动都来一句。 */
  private announce(change: PresenceChange): void {
    const host = this.host;
    if (host === null || change.kind === 'first') return;
    const t = this.t;
    const lang = this.textLanguage;
    if (change.kind === 'away') {
      if (!this.cfg.notifyAway) return;
      const text = change.reason === 'idle'
        ? t.event.awayIdle(formatDuration(this.lastIdle?.idleMs ?? 0, lang), this.awayDetail())
        : t.event.awayLocked(formatClock(this.opts.timezone, change.at));
      host.pushDeferred(
        { type: `${ARE_YOU_THERE_ID}.changed`, origin: 'internal', render: () => text },
        { trigger: 'flush' },
      );
      return;
    }
    if (!this.cfg.notifyBack) return;
    const text = t.event.back(formatClock(this.opts.timezone, change.at), formatDuration(change.awayMs, lang));
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
    if (!away) return t.lines.present(at, span);
    return reason === 'idle' ? t.lines.awayIdle(at, span) : t.lines.awayLocked(at, span);
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

  /** 回执里的判定那行。 */
  private verdictLine(): string {
    const t = this.t;
    const verdict = this.verdict;
    if (!this.cfg.checkForeground && !this.cfg.checkScreen) return t.tool.verdictOff;
    if (verdict === null) return t.tool.verdictOff;
    if (verdict.hit === 'foreground' && verdict.foreground !== null) return t.tool.verdictForegroundHit(verdict.foreground);
    if (verdict.hit === 'screen' && verdict.percent !== null) return t.tool.verdictScreenChanged(`${verdict.percent}%`);
    if (verdict.percent !== null) return t.tool.verdictScreenStill(`${verdict.percent}%`);
    if (verdict.foreground !== null) return t.tool.verdictForegroundMiss(verdict.foreground);
    return this.cfg.checkScreen ? t.tool.verdictScreenFailed : t.tool.verdictForegroundFailed;
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
      t.tool.now(this.stateLine(Date.now())),
      t.tool.lastAway(this.lastAwayLine()),
    ];

    const threshold = idleThresholdMs(this.cfg);
    const idle = this.currentIdle();
    if (threshold <= 0) lines.push(t.tool.idle(t.tool.idleOff));
    else if (idle === null) lines.push(t.tool.idle(t.tool.idleUnknown));
    else {
      lines.push(t.tool.idle(t.tool.idleLine(formatDuration(idle.idleMs, lang), formatDuration(threshold, lang))));
    }
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
