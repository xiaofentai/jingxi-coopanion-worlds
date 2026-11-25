/**
 * 小纸条 World：一个定时器、两套判据、最多一条事件。
 *
 * 三个约定（沿用 cache-keepalive，被它的注释骂过一轮才定下来的）：
 * 1. **定时器自排期**，间隔每拍现读；只在 start() 里读一次的话，设置页改完就白改。
 * 2. **心跳的空档用 usage.jsonl 的 mtime**——宿主每轮都写账，mtime 就是上次调用时刻；
 *    纸条的钟**不看 mtime**（后台信息会一直刷新它），只看自己的 lastNoteAt 和时段。
 * 3. **推的是 flush，不是 piggyback**——这版宿主不认 piggyback；flush 等这一轮跑完才送，
 *    不打断正在说的话。
 *
 * 同一拍两套判据都通过时纸条优先：纸条那一拍也唤醒了模型，缓存照样续上，
 * 所以把 lastBeatAt 记成现在，不再补一条心跳让她一次收到两句。
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import {
  clampIdleMinutes, clampMaxPerDay, clampTickSeconds, decideBeat, formatClock,
  localDay, localMinuteOfDay, minutesOf, renderHeartbeat,
} from './beat.ts';
import { IDLE_NUDGE_ID, idleNudgeConfigGroup, type IdleNudgeConfigSection } from './config.ts';
import { decideNote, renderNote } from './note.ts';
import {
  DEFAULT_NOTE_TEXT, DEFAULT_HEARTBEAT_TEXT, readSettings, writeSettings, clampSettings,
  slotRangeText, parseSlotPair, type NudgeSettings,
} from './settings.ts';

export interface IdleNudgeWorldOptions {
  /** `worlds.idle-nudge`，每次使用时读取。 */
  cfg: IdleNudgeConfigSection;
  timezone: string;
  botDir: string;
  dataDir: string;
  /** 测试换掉「读上一次调用时刻」。 */
  usageMtime?: () => number | null;
  /** 测试换掉推送那一步。返回 event.type，便于断言先推了谁。 */
  push?: (type: string, text: string) => Promise<boolean>;
  clock?: () => number;
}

/** 设置页 / 日志里看的现状。 */
export interface NudgeStatus {
  on: boolean;
  lastTickAt: number | null;
  lastBeatAt: number | null;
  lastCallAt: number | null;
  lastNoteAt: number | null;
  beatToday: number;
  noteToday: number[];
  beatNote: string;
  noteNote: string;
}

export class IdleNudgeWorld implements World {
  readonly id = IDLE_NUDGE_ID;
  private host: WorldHost | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private working = false;
  private settings: NudgeSettings;

  // ---- 运行时状态：都是会话内的，重启就清。这些是节奏，不是记忆，不落盘 ----
  private lastTickAt: number | null = null;
  private lastBeatAt: number | null = null;
  private lastCallAt: number | null = null;
  private lastNoteAt: number | null = null;
  private beatToday = 0;
  private noteToday: number[] = [0, 0, 0];
  private countedDay = '';
  private beatNote = '还没跑过第一拍';
  private noteNote = '还没跑过第一拍';
  private languageCache: { at: number; value: 'zh' | 'en' } | null = null;
  private readonly opts: IdleNudgeWorldOptions;

  constructor(opts: IdleNudgeWorldOptions) {
    this.opts = opts;
    this.settings = readSettings(opts.botDir);
  }

  private get cfg(): IdleNudgeConfigSection {
    return this.opts.cfg;
  }

  private now(): number {
    return this.opts.clock ? this.opts.clock() : Date.now();
  }

  /** 不往前缀加一个字：它的价值全在「推对了那一拍」。 */
  envPromptVars(): Record<string, string> | null {
    return null;
  }

  /** 一个工具都不给：她没有理由知道有这个插件。 */
  tools(): ToolDef[] {
    return [];
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.stopped = false;
    this.settings = readSettings(this.opts.botDir);
    this.armTimer();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.host = null;
  }

  /** 交接刚结束：前缀是新建的，让出一个阈值再补拍（和 cache-keepalive 一样）。 */
  onHandoffEnded(): void {
    this.lastBeatAt = this.now();
  }

  private armTimer(): void {
    if (this.timer !== null || this.stopped) return;
    const step = (): void => {
      // 每拍现读设置：间隔和所有参数改完下一拍生效，不用重启
      this.settings = readSettings(this.opts.botDir);
      const ms = clampTickSeconds(this.settings.tickSeconds) * 1000;
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.tick().finally(step);
      }, ms);
      (this.timer as unknown as { unref?: () => void }).unref?.();
    };
    step();
  }

  /** usage.jsonl 的修改时间 = 上一次模型调用时刻。读不到就返回 null（当作很久没调用）。 */
  private readUsageMtime(): number | null {
    if (this.opts.usageMtime) return this.opts.usageMtime();
    for (const file of [join(this.opts.dataDir, 'usage.jsonl'), join(this.opts.botDir, 'data', 'usage.jsonl')]) {
      try {
        return statSync(file).mtimeMs;
      } catch {
        // 换下一个位置
      }
    }
    return null;
  }

  private async tick(): Promise<void> {
    const now = this.now();
    this.lastTickAt = now;
    if (!this.cfg.enabled) {
      this.beatNote = this.noteNote = '开关关着';
      return;
    }
    if (this.working || this.host === null) {
      this.beatNote = this.noteNote = this.host === null ? '还没挂到宿主上' : '上一拍还没走完';
      return;
    }

    this.working = true;
    try {
      const day = localDay(this.opts.timezone, now);
      if (this.countedDay !== day) {
        this.countedDay = day;
        this.beatToday = 0;
        this.noteToday = this.settings.slots.map(() => 0);
      }

      // ---- 纸条优先：它有自己的钟，和 usage 的 mtime 无关 ----
      const noteDecision = this.settings.noteEnabled
        ? decideNote(
          {
            now,
            minuteOfDay: localMinuteOfDay(this.opts.timezone, now),
            day,
            lastNoteAt: this.lastNoteAt,
            slotPushedToday: this.noteToday,
          },
          { slots: this.settings.slots, gapMinutes: this.settings.noteGapMinutes },
        )
        : { fire: false as const, note: '小纸条已关' };

      if (noteDecision.fire) {
        const clock = formatClock(this.opts.timezone, now);
        const text = renderNote(this.settings.noteText, clock, DEFAULT_NOTE_TEXT);
        const sent = await this.push('note', text);
        if (!sent) {
          this.noteNote = '推送失败（宿主的 pushDeferred 没接住）';
          return;
        }
        this.lastNoteAt = now;
        this.noteToday[noteDecision.slot] = (this.noteToday[noteDecision.slot] ?? 0) + 1;
        // 这一拍唤醒了模型，缓存已续；别再补心跳
        this.lastBeatAt = now;
        this.noteNote = `已递纸条（今天 ${this.noteToday.reduce((a, b) => a + b, 0)} 张）`;
        this.beatNote = '这一拍递了纸条，缓存已续';
        return;
      }
      this.noteNote = noteDecision.note;

      // ---- 心跳：全天，看 usage 的空档 ----
      const lastCallAt = this.readUsageMtime();
      this.lastCallAt = lastCallAt;
      const beatDecision = this.settings.heartbeatEnabled
        ? decideBeat(
          { now, lastCallAt, lastBeatAt: this.lastBeatAt, pushedToday: this.beatToday },
          { idleMinutes: this.settings.idleMinutes, maxPerDay: this.settings.maxPerDay },
        )
        : { fire: false as const, note: '静默心跳已关' };
      if (!beatDecision.fire) {
        this.beatNote = beatDecision.note;
        return;
      }

      const clock = formatClock(this.opts.timezone, now);
      const fallback = this.language === 'zh' ? DEFAULT_HEARTBEAT_TEXT
        : '(Silent heartbeat at {time}. No reply needed.)';
      const text = renderHeartbeat(this.settings.heartbeatText, clock, fallback);
      const sent = await this.push('beat', text);
      if (!sent) {
        this.beatNote = '推送失败（宿主的 pushDeferred 没接住）';
        return;
      }
      this.lastBeatAt = now;
      this.beatToday += 1;
      this.beatNote = `已补一拍（今天 ${this.beatToday} 拍）`;
    } catch (error) {
      this.beatNote = `出错：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.working = false;
    }
  }

  /** 推到下一轮。两个 type 分开声明（见 definition.ts），宿主才知道是插件发的。 */
  private async push(kind: 'beat' | 'note', text: string): Promise<boolean> {
    const type = `${IDLE_NUDGE_ID}.${kind}`;
    if (this.opts.push) return this.opts.push(type, text);
    const host = this.host as unknown as {
      pushDeferred?: (event: unknown, opts?: unknown) => Promise<unknown> | unknown;
    } | null;
    const fn = host?.pushDeferred;
    if (typeof fn !== 'function') return false;
    try {
      await fn.call(host, { type, origin: 'internal', render: () => text }, { trigger: 'flush' });
      return true;
    } catch {
      return false;
    }
  }

  status(): NudgeStatus {
    return {
      on: this.cfg.enabled,
      lastTickAt: this.lastTickAt,
      lastBeatAt: this.lastBeatAt,
      lastCallAt: this.lastCallAt,
      lastNoteAt: this.lastNoteAt,
      beatToday: this.beatToday,
      noteToday: [...this.noteToday],
      beatNote: this.beatNote,
      noteNote: this.noteNote,
    };
  }

  /** 只用来挑心跳默认模板的中/英；不依赖 cortico 的 isLanguage（vendor 没 checkout 时那是个坏 import）。 */
  private get language(): 'zh' | 'en' {
    let at = 0;
    try {
      at = statSync(join(this.opts.botDir, 'config.json')).mtimeMs;
    } catch {
      // 默认中文
    }
    if (this.languageCache?.at !== at) {
      let value: 'zh' | 'en' = 'zh';
      try {
        const raw = JSON.parse(readSettingsText(this.opts.botDir)) as { language?: unknown };
        if (raw.language === 'en') value = 'en';
      } catch {
        // 默认中文
      }
      this.languageCache = { at, value };
    }
    return this.languageCache.value;
  }

  // ---- 设置页 ----

  private panelSections(): Array<Record<string, unknown>> {
    const s = this.settings;
    const beatDefault = DEFAULT_HEARTBEAT_TEXT.replace('{time}', '<当前时刻>');
    const noteDefault = DEFAULT_NOTE_TEXT.replace('{time}', '<当前时刻>');
    return [
      {
        id: 'note',
        title: '小纸条（白天的三个时段）',
        description: '在安静的空档里递一句带动作的话。它不看 usage 的 mtime，所以后台推再多信息也挡不住它；只按自己的钟和时段走。去不去做由她定。',
        fields: [
          { key: 'noteEnabled', label: '启用小纸条', kind: 'bool', value: s.noteEnabled, hint: '关掉就一张都不推；不影响静默心跳。' },
          { key: 'noteGapMinutes', label: '两张间隔', kind: 'int', value: s.noteGapMinutes, min: 0, max: 1440, suffix: '分钟', hint: '两张纸条之间至少隔多久（三段共用），防止挨着推。默认 120。' },
          ...s.slots.map((slot, index) => ({
            key: `slot${index}`,
            label: `时段 ${index + 1}`,
            kind: 'slot',
            value: { range: slotRangeText(slot), perDay: slot.perDay },
            hint: '左边填时段（如 9-12 / 14:30-18 / 22-2 跨零点），右边填每天几张。时段留空＝不启用；右端时刻不含。',
          })),
          { key: 'noteText', label: '纸条正文', kind: 'text', value: s.noteText, hint: `留空用默认：${noteDefault}` },
        ],
      },
      {
        id: 'heartbeat',
        title: '静默心跳（全天）',
        description: '空档变长就补一条不要求回应的内部事件，让上游前缀缓存不过期。它不说话、不调用工具。⚠️ 不确定就别启用：① 命中不够便宜时补拍反而增加费用；② 有些模型的缓存有效期并不稳定，固定阈值要么白补、要么来不及，这时它帮不上忙只会花钱。换上游前先跑 measure 脚本量一遍，量不出稳定区间就保持关。',
        fields: [
          { key: 'heartbeatEnabled', label: '启用静默心跳', kind: 'bool', value: s.heartbeatEnabled, hint: '默认关。缓存命中不够便宜、或有效期忽长忽短，开了反而更贵。关掉不影响小纸条。' },
          { key: 'idleMinutes', label: '空档阈值', kind: 'int', value: s.idleMinutes, min: 1, max: 1440, suffix: '分钟', hint: '距上次模型调用超过这么久才补一拍。默认 40 是 LongCat-2.5 的值；TTL 不稳的模型填多少都不准——量不出稳定区间就别开这个开关。' },
          { key: 'maxPerDay', label: '每日上限', kind: 'int', value: s.maxPerDay, min: 0, max: 240, suffix: '拍', hint: '一天最多补几拍；0 = 不限。安全阀，防配置写错一直叫醒模型。' },
          { key: 'tickSeconds', label: '看表间隔', kind: 'int', value: s.tickSeconds, min: 5, max: 300, suffix: '秒', hint: '多久查一次上次调用时刻。改完下一拍生效。' },
          { key: 'heartbeatText', label: '心跳正文', kind: 'text', value: s.heartbeatText, hint: `留空用默认：${beatDefault}` },
        ],
      },
      {
        id: 'status',
        title: '现状',
        description: '为什么这一拍没推，都写在这里。心跳和小纸条各记各的，互不影响。',
        fields: [
          { key: 'stBeat', label: '心跳', kind: 'text', value: this.status().beatNote, readonly: true, hint: `今天 ${this.beatToday} 拍` },
          { key: 'stNote', label: '纸条', kind: 'text', value: this.status().noteNote, readonly: true, hint: `今天 ${this.noteToday.reduce((a, b) => a + b, 0)} 张` },
        ],
      },
    ];
  }

  private panelPayload(): Record<string, unknown> {
    return {
      sections: this.panelSections(),
      labels: { saved: '已保存', failed: '保存失败' },
    };
  }

  private panelInvoke(panel: string, method: string, args: unknown[]): Record<string, unknown> {
    if (panel !== 'settings') throw new Error(`no such panel: ${panel}`);
    if (method === 'status') return this.panelPayload();
    if (method === 'save') {
      const incoming = (args?.[0] ?? {}) as Record<string, unknown>;
      const text = (key: string, fallback: string) =>
        typeof incoming[key] === 'string' ? (incoming[key] as string) : fallback;
      const number = (key: string, fallback: number) =>
        typeof incoming[key] === 'number' && Number.isFinite(incoming[key] as number)
          ? incoming[key] as number : fallback;
      const bool = (key: string, fallback: boolean) =>
        typeof incoming[key] === 'boolean' ? incoming[key] as boolean : fallback;
      const next: NudgeSettings = {
        heartbeatEnabled: bool('heartbeatEnabled', this.settings.heartbeatEnabled),
        noteEnabled: bool('noteEnabled', this.settings.noteEnabled),
        idleMinutes: number('idleMinutes', this.settings.idleMinutes),
        maxPerDay: number('maxPerDay', this.settings.maxPerDay),
        tickSeconds: number('tickSeconds', this.settings.tickSeconds),
        heartbeatText: text('heartbeatText', this.settings.heartbeatText),
        slots: this.settings.slots.map((slot, index) =>
          parseSlotPair(incoming[`slot${index}`], slot)),
        noteGapMinutes: number('noteGapMinutes', this.settings.noteGapMinutes),
        noteText: text('noteText', this.settings.noteText),
      };
      this.settings = clampSettings(next, this.settings);
      writeSettings(this.opts.botDir, this.settings);
      return this.panelPayload();
    }
    throw new Error(`no such method: ${panel}.${method}`);
  }

  webUi(): WorldWebUiDecl {
    const st = this.status();
    const gap = st.lastCallAt === null ? '还没读到使用账'
      : `距上次调用 ${minutesOf(this.now() - st.lastCallAt)} 分钟`;
    const nextNote = st.noteToday.reduce((a, b) => a + b, 0);
    // 页头那排药丸（page.badges）：一眼看出两个功能各自开着没、今天各推了多少。
    // 类型定义不在包能读到的地方，和 are-you-there 一样断言一下。
    const on = this.cfg.enabled;
    const badges = [
      {
        label: '心跳',
        value: !on || !this.settings.heartbeatEnabled ? '关'
          : (this.host === null ? '载入中' : `今天 ${st.beatToday} 拍`),
        tone: (on && this.settings.heartbeatEnabled ? 'on' : 'off') as 'on' | 'off',
      },
      {
        label: '纸条',
        value: !on || !this.settings.noteEnabled ? '关'
          : (this.host === null ? '载入中' : `今天 ${nextNote} 张`),
        tone: (on && this.settings.noteEnabled ? 'on' : 'off') as 'on' | 'off',
      },
      { label: '缓存', value: gap.replace('距上次调用 ', ''), tone: 'plain' as const },
    ];
    return {
      label: '小纸条',
      badges,
      panels: [{
        id: 'settings',
        title: '设置',
        description: '静默心跳（全天）与小纸条（三个时段）。参数改完下一拍生效，不用重启。',
        getMethods: ['status', 'save'],
      }],
      invoke: (panel: string, method: string, args: unknown[]) => this.panelInvoke(panel, method, args),
      config: [idleNudgeConfigGroup()],
      lamps: [
        {
          label: '心跳',
          state: !on || !this.settings.heartbeatEnabled ? 'offline'
            : (this.host === null ? 'loading' : 'online'),
          hint: `${st.beatNote}｜阈值 ${clampIdleMinutes(this.settings.idleMinutes)} 分钟｜${gap}`,
        },
        {
          label: '纸条',
          state: !on || !this.settings.noteEnabled ? 'offline'
            : (this.host === null ? 'loading' : 'online'),
          hint: `${st.noteNote}｜今天 ${nextNote} 张`,
        },
      ],
    };
  }
}

/** language 读 config.json 用；单独抽出来是因为 settings.ts 只管自己的段。 */
function readSettingsText(botDir: string): string {
  // eslint 不 complain：这里就是要读整份文件，settings.ts 的 readSettings 只返回自己的段
  return readFileSync(join(botDir, 'config.json'), 'utf8');
}

