/**
 * 在吗的 World：一个定时器、一次轮询、两行环境提示、一个只读工具。
 *
 * 宿主不给系统事件，只能自己隔一会儿看一眼锁屏。读数要连续两次一致才算数，读失败就保持原状——
 * 一次 `tasklist` 超时不等于 ta 回来了。状态变化时才写盘、才推事件。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import { isLanguage } from 'cortico/core/language.ts';
import type { ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { ARE_YOU_THERE_ID, areYouThereConfigGroup, clampedPollSeconds, type AreYouThereConfigSection } from './config.ts';
import { formatClock, formatDuration } from './format.ts';
import { applyLocked, emptyPresence, type PresenceChange, type PresenceState } from './presence.ts';
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

/** 这个 World 唯一的工具；`tools()` 绑上 handler。 */
export const ARE_YOU_THERE_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'here_status',
    description:
      'Report whether the person is at the desk now (a locked screen means away), how long that state has lasted, '
      + 'and when they were last away. Probes the screen lock once, live, and says whether it agrees with the record. Read only.',
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

  constructor(private readonly opts: AreYouThereWorldOptions) {
    this.state = readState(this.stateFile);
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
    // 第一次读数不等一个间隔：刚启动时最想知道 ta 在不在
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.armedMs = 0;
    this.host = null;
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

  private async tick(): Promise<void> {
    if (this.host === null || this.probing) return;
    this.probing = true;
    try {
      this.armTimer();
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
      this.debounce = feedReading(this.debounce, probe.locked);
      const reading = confirmedReading(this.debounce);
      if (reading === null) return;
      const { state, change } = applyLocked(this.state, reading, Date.now());
      if (change === null) return;
      this.state = state;
      this.save();
      this.announce(change);
    } finally {
      this.probing = false;
    }
  }

  /** 状态变化时推一条事件；第一次读到状态不喊，免得每次启动都来一句。 */
  private announce(change: PresenceChange): void {
    const host = this.host;
    if (host === null) return;
    const t = this.t;
    const clock = formatClock(this.opts.timezone, change.at);
    if (change.kind === 'first') return;
    if (change.kind === 'away') {
      if (!this.cfg.notifyAway) return;
      host.pushDeferred(
        { type: `${ARE_YOU_THERE_ID}.changed`, origin: 'internal', render: () => t.event.away(clock) },
        { trigger: 'flush' },
      );
      return;
    }
    if (!this.cfg.notifyBack) return;
    const span = formatDuration(change.awayMs, this.textLanguage);
    host.pushDeferred(
      { type: `${ARE_YOU_THERE_ID}.changed`, origin: 'internal', render: () => t.event.back(clock, span) },
      { trigger: 'flush' },
    );
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
    const { locked, since } = this.state;
    if (locked === null || since === null) return t.lines.unknown;
    const at = formatClock(this.opts.timezone, since);
    const span = formatDuration(now - since, this.textLanguage);
    return locked ? t.lines.away(at, span) : t.lines.present(at, span);
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

  /**
   * 工具回执：先报记录，再当场查一次做核对。
   *
   * 这次探针不写状态、不喂去抖——一次手动检查不该顶替两次确认，读到的差异只写进回执。
   */
  private async status(): Promise<string | ToolOutcome> {
    const t = this.t;
    const lines = [
      t.tool.now(this.stateLine(Date.now())),
      t.tool.lastAway(this.lastAwayLine()),
    ];
    const probe = await probeLocked(this.opts.runner ?? runTasklist);
    if (probe.locked === null) {
      lines.push(t.tool.live(probe.error === 'not windows' ? t.tool.notWindows : t.tool.failed(probe.error)));
    } else {
      const reading = probe.locked ? t.tool.readingLocked : t.tool.readingUnlocked;
      if (this.state.locked === null) {
        lines.push(t.tool.live(t.tool.notConfirmed(reading)));
      } else {
        const recorded = this.state.locked ? t.tool.readingLocked : t.tool.readingUnlocked;
        lines.push(t.tool.live(recorded === reading ? t.tool.agrees(reading) : t.tool.disagrees(recorded, reading)));
      }
    }
    if (this.failures > 0 && this.lastProbeAt !== null) {
      lines.push(t.tool.failures(this.failures, formatClock(this.opts.timezone, this.lastProbeAt), this.lastError));
    }
    return lines.join('\n');
  }
}
